# VIDAR Engine — Deep Dive Technical Article

**Audience:** Programmers new to this codebase who need to understand how the engine works at a low level.
**Scope:** Everything from HTTP request to final error report. No concept is left unexplained.

---

## Table of Contents

1. [What This System Does](#1-what-this-system-does)
2. [How It Boots Up](#2-how-it-boots-up)
3. [The API Layer](#3-the-api-layer)
4. [Rule Loading](#4-rule-loading)
5. [Strategy Selection](#5-strategy-selection)
6. [The Database Layer](#6-the-database-layer)
7. [Base Strategy — Shared Infrastructure](#7-base-strategy--shared-infrastructure)
8. [MasterStrategy — Row-by-Row with Worker Threads](#8-masterstrategy--row-by-row-with-worker-threads)
9. [TransactionStrategy — Group-Based Streaming](#9-transactionstrategy--group-based-streaming)
   - Group pagination mode (`use_group_pagination`)
   - Row fingerprint diff
10. [TransactionStrategy — Composite Key Mode](#10-transactionstrategy--composite-key-mode)
11. [MultipleStrategy — N Sources to 1 Target](#11-multiplestrategy--n-sources-to-1-target)
12. [UnionStrategy — Multiple Sources Same Schema](#12-unionstrategy--multiple-sources-same-schema)
13. [SplitStrategy — Value Set Validation](#13-splitstrategy--value-set-validation)
14. [HeaderStrategy — Long-to-Wide Pivot](#14-headerstrategy--long-to-wide-pivot)
15. [Mapping Types — The Full Reference](#15-mapping-types--the-full-reference)
16. [Def Rules — Business Logic Layer](#16-def-rules--business-logic-layer)
17. [The Expression Engine](#17-the-expression-engine)
18. [Transform Utilities](#18-transform-utilities)
19. [Worker Thread Pool](#19-worker-thread-pool)
20. [Aggregate SUM Cross-Check](#20-aggregate-sum-cross-check)
21. [Error Types Reference](#21-error-types-reference)
22. [Complete Data Flow — End to End](#22-complete-data-flow--end-to-end)
23. [Known Limitations](#23-known-limitations)

---

## 1. What This System Does

This is a **post-migration data validation engine**. The NCS banking system was migrated from an old database (`ncs-conv-aging`) to a new database (`ncs-npl-aging`). After migration, we need proof that all data landed correctly.

The engine compares the two databases — old vs new — table pair by table pair, column by column, row by row (or group by group, depending on how the data was restructured). It produces a report listing every discrepancy found.

**The key insight:** the data was not just copied. It was often restructured:
- Columns were renamed (`systemreferencenumber` → `systemreferenceno`)
- Columns were split (one old column became two new columns)
- Columns were merged (two old columns concatenated into one new column)
- N rows per transaction in old → 2 rows per transaction in new (H-table pivot)
- Multiple old tables merged into one new table

The validation rules that describe all these transformations are written as YAML files, not hardcoded. This means a developer can add a new rule or fix a mapping without touching any TypeScript.

---

## 2. How It Boots Up

The service is a **NestJS** application (`src/app.module.ts`). When `npm run start:prod` is called, NestJS initializes all modules and injects dependencies.

**Key startup events:**

**DatabaseService.onModuleInit()** runs first. It:
1. Reads `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` from environment variables.
2. Creates an `mssql.ConnectionPool` with these settings:
   - `pool.max = 10` connections, `pool.min = 2`
   - `readOnlyIntent = true` — all queries are read-only
   - `requestTimeout = 1800000` (30 minutes) — needed for large table scans
   - `trustServerCertificate = true` — required for private SQL Server instances
3. Calls `pool.connect()` and waits. If this fails, the app crashes with an explicit error.

**WorkerPoolService.onModuleInit()** runs after. It:
1. Reads `MAX_WORKER_THREADS` from env. If not set, defaults to `os.cpus().length - 1`.
2. Spawns that many `Worker` threads running `compare.worker.js` (or `.ts` in dev).
3. All workers sit idle until work arrives.

**RuleLoaderService** initializes lazily — it reads YAML files on first request, then caches them in memory.

---

## 3. The API Layer

There is one primary endpoint that starts a validation job:

```
POST /validation/run
{
  "job_name": "optional label",
  "tables": [
    {
      "table_name": "lahistloantransactionhistory",
      "rule_path": "rights_npa/lahistloantransactionhistory",
      "def_list": ["def001"]
    }
  ]
}
```

There is also `POST /validation/run-preset` which reads a preset YAML file (e.g. `presets/invest/lv.yaml`) that expands into a list of tables. Internally it builds the same DTO and calls the same code path.

**The controller** calls `ValidationService.startJob(dto)`.

**`startJob()`** does the following:
1. Calls `jobService.createJob()` which assigns a UUID job ID and registers it in an in-memory job store.
2. Calls `this.runJob(jobId, dto)` — but does **not await** it. The function is fire-and-forget.
3. Returns the `jobId` immediately to the HTTP client.

The client can then poll `GET /validation/jobs/:jobId` to check progress and get the report path when done.

**`runJob()`** is the core orchestrator. It iterates over each table in the request and for each one:
1. Loads the rule YAML files.
2. Picks a strategy based on `table_type`.
3. Runs the strategy.
4. Runs an independent aggregate SUM check.
5. Aggregates errors into a result.
6. When all tables are done, writes CSV/JSON reports and marks the job complete.

---

## 4. Rule Loading

All validation logic lives in YAML files under `rules/`. The `RuleLoaderService` is responsible for reading them.

### Directory structure

```
rules/
  global/
    affect_codes.json          <- all known affect codes + descriptions
    defs/
      def001.yaml              <- global def rule (applies to all tables)
  rights_npa/
    lahistloantransactionhistory/
      common.yaml              <- the main rule file for this table pair
      def/
        def001.yaml            <- table-specific def rule (overrides global)
```

The `rule_path` in the API request (e.g. `rights_npa/lahistloantransactionhistory`) is appended to `./rules/` to find the directory.

### common.yaml structure

This is the main rule file. It tells the engine:
- `table_info.source` — old table reference (e.g. `[ncs-conv-aging].dbo.[conv$vinpahistory]`)
- `table_info.target` — new table reference (e.g. `[ncs-npl-aging].dbo.[la$lahistloantransactionhistory]`)
- `table_info.table_type` — which strategy to use (`MASTER`, `TRANSACTION`, `MULTIPLE`, `UNION`, `SPLIT`, `HEADER`)
- `table_info.source_filter` — optional SQL WHERE clause to restrict old rows (e.g. `invaccounttype = 'TF'`)
- `anchor_key.old` / `anchor_key.new` — the unique monotonic column used for keyset pagination
- `transaction_grouping` — (TRANSACTION/MULTIPLE only) how to group rows for aggregate comparison
- `schema_mappings` — the full column mapping definition (see section 15)
- `defaults.tolerance` — floating point tolerance for numeric comparisons (e.g. `0.01`)

### def*.yaml structure

Def rules describe business-logic checks that go beyond simple column comparison. They operate on groups of rows (e.g. all old rows sharing the same sysref) and can check:
- That certain amounts were correctly pivoted (H-table checks)
- That certain codes were converted to new-system values

### Caching

Both `commonRule` and `defRules` are cached in-memory Maps after first load. Repeated API calls for the same rule path pay no file I/O cost.

### Global affect codes

`rules/global/affect_codes.json` maps each affect code (like `PP`, `I1`, `QQ`) to a description. This is loaded once per process and used throughout all strategies to resolve affect code names.

---

## 5. Strategy Selection

`ValidationService` calls `strategyFactory.create(tableType)`. The factory is a simple switch:

```
MASTER     → MasterStrategy
TRANSACTION→ TransactionStrategy
SPLIT      → SplitStrategy
HEADER     → HeaderStrategy
UNION      → UnionStrategy
MULTIPLE   → MultipleStrategy
ASSOCIATE  → MasterStrategy (same as MASTER)
```

All strategies share the same interface: `validate(ctx: ValidationContext)` which receives:
- `commonRule` — parsed common.yaml
- `defRules` — parsed def*.yaml files for this table
- `affectCodeMap` — the global affect codes map

And returns `{ errors: ValidationError[], rowsChecked: number }`.

---

## 6. The Database Layer

`DatabaseService` wraps the `mssql` connection pool. It provides a set of methods that all strategies use. Understanding these methods is critical to understanding how the engine works at a low level.

### `fetchChunk(table, anchorColumn, chunkSize, lastKey, extraFilter?)`

This is the core pagination method. It executes:

```sql
SELECT * FROM [table] WITH (NOLOCK)
WHERE [anchorColumn] > @lastKey   -- or IS NOT NULL if first call
AND (extraFilter)
ORDER BY [anchorColumn]
OFFSET 0 ROWS FETCH NEXT @chunkSize ROWS ONLY
```

**Key design decisions:**
- Uses **keyset pagination** (cursor-based), not OFFSET/FETCH. This is critical for performance on large tables. With OFFSET pagination, each page requires SQL Server to scan and discard all prior pages. With keyset pagination, SQL Server seeks directly to `lastKey` using the index and reads forward. On 15M rows, this is the difference between minutes and seconds per chunk.
- Uses `WITH (NOLOCK)` — no shared locks are acquired. Reads do not block writes. Acceptable because this is a validation tool reading a migration snapshot, not live transactional data.
- `bindLastKey()` preserves the native JS type of `lastKey`. If the anchor key is an integer column, `lastKey` is a JavaScript `number`, and the method binds it as `sql.BigInt`. If it is a string column, it binds as `sql.NVarChar`. This matters because SQL Server uses different comparison ordering for strings vs numbers. Binding an integer anchor key as a string causes string comparison (`'9' > '10'`), which breaks pagination.

### `streamRowsByKeys(table, keyColumn, keys, callback)`

Fetches all rows where `keyColumn IN (keys)` and calls `callback(row)` for each row as it arrives. The stream is set to `request.stream = true`, which means the mssql driver emits rows one at a time rather than buffering everything in memory.

**The 2000-key batch limit:** SQL Server supports at most 2100 parameters per query. If `keys` has more than 2000 entries, this method splits them into 2000-element batches and issues one query per batch. All callbacks still go to the same `callback` function.

**Why not just use `IN (SELECT ...)` subquery?** Because the group keys come from the application layer (the in-memory group key set). SQL Server would need those values as literals or parameters. A subquery would require the values to already be in a DB table.

### `fetchChunkKeys(table, keyColumn, chunkSize, lastKey)`

Like `fetchChunk` but uses `SELECT [keyColumn]` instead of `SELECT *`. Used by the reverse scan in MasterStrategy. On a 15M row table with 50 columns, `SELECT *` per chunk would transfer ~50x more data than `SELECT [keyColumn]`. Since the reverse scan only needs the key values to check existence, this is a pure bandwidth optimization.

### `getDistinctKeys(table, keyColumn, batchSize, lastKey, filter?)`

Returns a paginated page of `DISTINCT` key values. Used by composite key validation to iterate sysrefs. Returns plain `string[]`.

### `batchLookup(table, lookupCol, resultCol, values)`

Translates a list of old account numbers to new account numbers by querying a translation table (e.g. `conv$vinpllvcithistory`). Returns a `Map<string, string>`. Handles the 2000-param SQL Server limit the same way as `streamRowsByKeys`.

### `createTargetCache(sourceTable, tempName, primaryIndexCol, secondaryIndexCol)` / `dropTargetCache(tempName)`

Creates a global temp table (`##name`) that is a full copy of `sourceTable`, then builds a clustered index on `(primaryIndexCol, secondaryIndexCol)`.

**Why this exists:** The table `lv$lvhisthsum` has no index on `systemreferenceno`. Without an index, every `WHERE systemreferenceno IN (...)` query against it is a full table scan. For a table with 16,000+ unique sysrefs, each batch of 50 sysrefs would trigger a full scan — that is 320 full scans per validation run, which is extremely slow.

**The fix:** Before the loop starts, copy the entire table into a global temp table once (one full scan). Then build a clustered index on `(systemreferenceno, lvaccountno)`. All subsequent queries against the temp table are index seeks. The temp table name includes the process PID and a timestamp to prevent conflicts if multiple runs happen simultaneously. The `finally` block in `validateCompositeKey` guarantees the temp table is dropped even if validation throws.

### `query<T>(sql_query, inputs?)`

Generic parameterized query. Returns `T[]`. Used for one-off queries like `COUNT(*)`, schema checks, and aggregate sums.

### `sampleRows(table, sampleSize = 1000)`

`SELECT TOP 1000 * FROM table`. Used before validation loops to detect noisy columns.

---

## 7. Base Strategy — Shared Infrastructure

`BaseStrategy` is an abstract class that all strategies extend. It contains logic that is shared across all strategies so it is not duplicated.

### Schema check and resilient fallback

`checkMissingColumns(source, target, expectedMappings)` queries `INFORMATION_SCHEMA.COLUMNS` for both tables and checks that every column referenced in the mappings actually exists in the DB.

If a column is missing, it does **not** abort. `filterMappingsAfterSchemaCheck()` removes any mapping that references a missing column and returns the reduced mapping set. The strategy continues validating with whatever columns do exist. This is called "resilient schema check".

**Why not abort?** Because real-world migration scenarios often have partial column differences. Aborting on a single missing column would prevent validation of all other correctly migrated columns in that table.

The cross-database reference parser handles table names like `[ncs-conv-aging].dbo.[conv$vinpahistory]` by extracting the database name and schema and querying `[ncs-conv-aging].INFORMATION_SCHEMA.COLUMNS` with `TABLE_SCHEMA = 'dbo'` filtering. Without the schema filter, tables that exist in multiple schemas return duplicate column names.

### Noisy column detection

Before the main validation loop, the strategy samples 1000 rows from the source table (`sampleRows`). For each column that appears in the mappings, it classifies the column:
- `NULL` — every sampled value is `null` or `undefined`
- `ZERO` — every sampled value is `0`, `'0'`, `null`, or `undefined`
- `BOOLEAN` — every non-null sampled value is `0` or `1`
- `NORMAL` — anything else

If a column is classified as `NULL`, `ZERO`, or `BOOLEAN`, the strategy skips the **value comparison** for that column. It still validates that the column exists in both tables (name-only match). This prevents false positives from columns that contain only placeholder data in the migration snapshot.

### Anchor key uniqueness check

`checkAnchorKeyUnique(table, anchorKey)` runs:

```sql
SELECT TOP 1 [anchorKey] as dupe_key
FROM [table]
GROUP BY [anchorKey]
HAVING COUNT(*) > 1
```

If any duplicate exists, it pushes a `TRANSFORM_ERROR`. Duplicate anchor keys break keyset pagination because `WHERE anchorKey > lastKey` can skip rows that have the same key value as the cursor. The `TOP 1` ensures the query short-circuits immediately on the first duplicate found.

### Fallback auto-matching

`findFallbackMappings()` is called by MasterStrategy only. It identifies source and target columns that are not covered by any explicit mapping in common.yaml. For each unmapped source column, it finds the best-matching unmapped target column using **Levenshtein string similarity** (normalized to 0–1 range). If similarity ≥ 0.9, the pair is added as an auto-matched exact mapping with a warning log.

This handles minor column renames that were not yet added to common.yaml.

### Unmapped column reporting

`reportUnmappedColumns()` is different from fallback — it reports (without comparison) which columns exist in either table but are not covered by any mapping. This is an audit trail: it tells you which columns you have not yet written rules for.

### Def rule runner

`runDefRules(groupKey, oldGroup, newGroup, defRules, affectCodeMap, tolerance)` is the entry point for business logic checks. It is called once per transaction group. See section 16 for full details.

### `sumColumn(rows, col)`

A utility used by all strategies. Extracts the values of `col` from all rows in `rows`, filters out nulls/undefineds, parses them as floats, and sums them. Returns `null` if there are no valid numeric values. This is used everywhere for group-level aggregation — instead of comparing individual rows, the strategy compares the sum of a column across the group on the old side vs the sum on the new side.

---

## 8. MasterStrategy — Row-by-Row with Worker Threads

**Use case:** Simple 1:1 table comparison where each old row has exactly one corresponding new row with the same anchor key value.

**Table type:** `MASTER` or `ASSOCIATE`

### Phase 1: Schema check

Calls `checkMissingColumns` for all mappings. If any columns are missing, filters them out and continues.

### Phase 2: Anchor key uniqueness

Checks both source and target. Both sides need unique anchor keys because:
- Source drives the keyset stream (duplicates skip rows in the forward scan)
- Target is looked up by key in the worker (duplicates would match the wrong new row)

### Phase 3: Row count check

Runs `SELECT COUNT(*) as cnt` on both tables in parallel. If they differ, pushes a `ROW_MISSING` error immediately. This is a fast early signal before row-level comparison.

### Phase 4: Noisy column detection

Samples 1000 rows from the source. Classifies each source column as `NORMAL`, `NULL`, `ZERO`, or `BOOLEAN`.

### Phase 5: Fallback auto-matching

Finds unmapped columns that have ≥90% name similarity and adds them to the exact match list with a warning log.

### Phase 6: Forward scan with worker threads

This is the main loop.

```
while true:
  oldChunk = db.fetchChunk(source, anchorKeyOld, chunkSize, lastOldKey)
  if empty → break

  oldKeyValues = oldChunk.map(row → row[anchorKeyOld])  // extract anchor key values
  newRows = []
  db.streamRowsByKeys(target, anchorKeyNew, oldKeyValues, row → newRows.push(row))

  result = workerPool.run({
    oldChunk,
    newRows,
    anchorKeyOld, anchorKeyNew,
    exactMatches, splitMatches, transformedMatches, concatMatches, formulaMatches,
    tolerance, noisyColumns, baseIndex
  })

  errors.push(...result.errors)
  lastOldKey = oldChunk.last[anchorKeyOld]
  if chunk.length < chunkSize → break (last chunk)
```

The worker thread receives the old chunk and the corresponding new rows, builds a `Map<anchorKeyNew, newRow>` for O(1) lookup, then iterates over each old row, finds its new row by key, and compares every mapped column. The worker runs in a separate OS thread so the comparison does not block the event loop.

**Why use worker threads?** Row-by-row comparison is CPU-bound (many string comparisons, parseFloat calls, regex operations). Node.js is single-threaded by default. Pushing each chunk to a worker thread allows the main thread to immediately fetch the next chunk from the DB while the previous chunk is being compared in parallel.

### Phase 7: Reverse scan

The forward scan can only detect old rows that are missing in new. It cannot detect new rows that have no counterpart in old (extra rows injected during migration).

The reverse scan iterates through the target table's anchor keys in pages using `fetchChunkKeys` (key-only, no `SELECT *`). For each page of new key values, it checks which of them exist in the old table using a batch `WHERE anchorKeyOld IN (...)` query. Any new key that does not exist in old is reported as a `ROW_MISSING` extra row error.

The reverse scan is capped at 1000 extra-row errors (`EXTRA_ROW_CAP`) to prevent flooding the report when the tables are catastrophically mismatched.

---

## 9. TransactionStrategy — Group-Based Streaming

**Use case:** The data was regrouped during migration. Many old rows with the same `systemreferencenumber` map to many new rows with the same `systemreferenceno`. The correct comparison is not row-by-row but group-by-group — compare the SUM of each column per group.

**Table type:** `TRANSACTION`

### The grouping problem

The old table might have 5 rows for sysref `ABC` and the new table might have 3 rows for sysref `ABC`. Individual row counts differ, but if `SUM(transactionamount)` is the same on both sides, the migration is correct.

### Simple key streaming

When `tg.composite_key` is not set, the simple key path runs.

```
while true:
  oldChunk = db.fetchChunk(source, anchorKeyOld, chunkSize, lastAnchorKey, sourceFilter)
  if empty → break

  // Collect unique group key values from this chunk, excluding keys already in carryNew
  // (those were fully fetched in the previous chunk and must not be re-fetched)
  groupKeyVals = unique values of oldChunk[oldKeyCol], excluding keys in carryNew

  newRows = []
  db.streamRowsByKeys(target, targetFetchKey, groupKeyVals, row → newRows.push(row))

  // Build group maps, seeded with carry-over from previous chunk
  oldGroupMap = new Map(carryOld)
  newGroupMap = new Map(carryNew)
  reset carryOld, carryNew to empty

  for each row in oldChunk:
    key = normalize(row[oldKeyCol])
    oldGroupMap[key].push(row)

  for each row in newRows:
    key = normalize(row[newKeyCol])
    newGroupMap[key].push(row)

  isLastChunk = oldChunk.length < chunkSize

  // Carry the last group forward if more chunks remain
  // (its rows might continue in the next chunk)
  carryKey = isLastChunk ? undefined : last key in oldGroupMap
  if carryKey:
    carryOld.set(carryKey, oldGroupMap[carryKey])
    carryNew.set(carryKey, newGroupMap[carryKey])

  // Compare all "committed" groups (all except the carry key)
  for each (groupKey, oldGroup) in oldGroupMap:
    if groupKey == carryKey → skip
    newGroup = newGroupMap[groupKey] ?? []
    if newGroup empty → ROW_MISSING error
    else:
      validateGroup(groupKey, oldGroup, newGroup, sm, tolerance, noisyMap)
      runDefRules(groupKey, oldGroup, newGroup, defRules, affectCodeMap, tolerance)

  // Check for extra groups in target
  for each (groupKey) in newGroupMap:
    if groupKey == carryKey → skip
    if not in oldGroupMap → ROW_MISSING error

  lastAnchorKey = last row of oldChunk[anchorKeyOld]
  if isLastChunk → break

// Flush carry (the last group held back from the last full-sized chunk)
for each (groupKey, oldGroup) in carryOld:
  validate as normal...
```

### The carry-over problem explained

Consider a table with groups A, B, C where A and B fit entirely in chunk 1, but C has rows in both chunk 1 and chunk 2.

Without carry-over:
- Chunk 1 compares C with only the rows from chunk 1 → wrong SUM → false `VALUE_MISMATCH`
- Chunk 2 fetches C's new rows again → double-counted → wrong SUM → more false errors

With carry-over:
- Chunk 1 detects that C is the last group and holds it back
- Chunk 2 seeds its maps with C's partial rows from chunk 1
- When collecting new group keys for chunk 2, C is excluded (already fetched)
- Chunk 2 then completes C's old rows and compares the full group

### `targetFetchKey` vs `keys.new`

Some tables have an indexed column (e.g. `journalseqno`) that stores the same value as the join key (`systemreferenceno`) but has an actual index on it. Using the indexed column in the `WHERE` clause turns a full table scan into an index seek. The `target_fetch_key` setting in common.yaml enables this optimization.

### Key normalization

`normalizeKey(value, transformRule)` applies a `TransformRule` (like `STRIP_LEADING_ZEROS`) to the group key value before using it as a Map key. This handles cases where the old system stored keys as `"00123"` and the new system stores them as `"123"`.

### Group pagination mode (`use_group_pagination: true`)

When a source table is **scattered** (a group's rows are spread across many non-contiguous IDs), the carry-over approach described above breaks down. A group that spans 20 chunks only ever carries the last partial chunk forward — the 19 preceding partials are each compared against the full new-side group, producing false `VALUE_MISMATCH` errors on every one.

Setting `use_group_pagination: true` switches to a completely different fetch strategy:

```
GROUP_BATCH = 200

while true:
  groupKeys = db.getDistinctKeys(source, oldKeyCol, GROUP_BATCH, lastGroupKey, sourceFilter)
  if empty → break

  oldRows = []
  db.streamRowsByKeys(source, oldKeyCol, groupKeys, row → oldRows.push(row))

  newRows = []
  db.streamRowsByKeys(target, targetFetchKey, groupKeys, row → newRows.push(row))

  // Build group maps directly — no carry-over needed
  oldGroupMap = group oldRows by normalizeKey(row[oldKeyCol])
  newGroupMap = group newRows by normalizeKey(row[newKeyCol])

  for each (groupKey, oldGroup) in oldGroupMap:
    newGroup = newGroupMap[groupKey] ?? []
    if newGroup empty → ROW_MISSING
    else:
      validateGroup(groupKey, oldGroup, newGroup, ...)
      if errors found && row_fingerprint defined → fingerprintDiff(...)
      runDefRules(groupKey, oldGroup, newGroup, ...)

  // Check for extra groups in target
  for each (groupKey) in newGroupMap:
    if not in oldGroupMap → ROW_MISSING

  lastGroupKey = groupKeys[last]
  if groupKeys.length < GROUP_BATCH → break
```

Because `getDistinctKeys()` paginates over **distinct group key values** (not over individual row IDs), every iteration fetches 200 complete, non-overlapping groups. The `streamRowsByKeys()` call on the source table pulls ALL rows for those 200 keys at once — so a scattered group that spans 5 million IDs is still fetched completely in a single query. No carry-over is needed.

**Trade-off:** Instead of one large sequential scan (fast I/O), this does many targeted `IN (...)` lookups (more round-trips, requires indexes on the target fetch key). This is why `target_fetch_key` should always point to an indexed column.

### Row fingerprint diff

When `validateGroup()` finds errors in a group and the rule defines `row_fingerprint`, `fingerprintDiff()` runs as a secondary pass to identify **which specific rows** are mismatched, not just that the group totals differ.

`fingerprintDiff()` builds a multiset (a `Map<string, count>`) for both old and new groups. Each row's fingerprint is a `|`-joined string of its fingerprint column values, normalized by `normalizeFingerprint()`:
- `Date` object → `YYYY-MM-DD` (strips time)
- ISO nvarchar `"2024-01-15T..."` → `"2024-01-15"` (strips time)
- Numeric string `"50000.00"` → `"50000"` (parseFloat strips trailing zeros)
- Other → trim to string

After building both multisets, it diffs old vs new: any fingerprint that exists more times in old than new is emitted as a `ROW_MISSING [FP]` error (and vice versa for extra new rows). This gives the report reader a row-level description of exactly which values are present in one side but not the other.

```yaml
transaction_grouping:
  ...
  row_fingerprint:
    - old: affectcode
      new: affectcode
    - old: transactionamount
      new: transactionamount
    - old: transactiondate
      new: transactiondate
```

The normalization step is critical because old tables often store dates as ISO nvarchar strings and amounts as nvarchar `"50000.00"`, while new tables use `datetime2` (JS `Date` objects) and `decimal`. Without normalization, every row would appear as a fingerprint mismatch even when the values are semantically identical.

---

## 10. TransactionStrategy — Composite Key Mode

**Use case:** CE% and RQ% sysrefs are "batch" sysrefs — one sysref covers many accounts. The correct group is `(sysref, accountno)`, not just `sysref`.

When `tg.composite_key` is set in common.yaml, `validateCompositeKey()` runs instead.

### The problem this solves

For a normal sysref, there are a few rows in old and a few in new. For a CE batch sysref, there can be hundreds of accounts. Without the composite key, all accounts under the same CE sysref would be grouped together and compared as one group. SUM(transactionamount) would be the total across all accounts — unhelpful if one account is wrong and another is compensating.

With composite key `(sysref, accountno)`, each account is validated independently.

### Account number translation

The old system stored old account numbers. The new system uses new account numbers. The mapping table `conv$vinpllvcithistory` translates `invaccountno → newinvaccountno`. The composite key mode uses `batchLookup()` to translate all account numbers in a batch before comparing.

### The temp table caching engine

Before the loop starts:

```
tempName = ##dv_ck_{PID}_{timestamp}
db.createTargetCache(target, tempName, targetFetchKey, ck.new_col)
```

Inside the loop, new rows are fetched from `tempName` (the temp table) instead of from `target` (the real table). Because the temp table has a clustered index on `(targetFetchKey, ck.new_col)`, every `WHERE targetFetchKey IN (...)` query is an index seek.

The `try/finally` block guarantees `dropTargetCache(tempName)` runs even if the loop throws.

### Composite key loop

```
while true:
  sysrefs = db.getDistinctKeys(source, oldKeyCol, 50, lastSysref, sourceFilter)
  if empty → break

  // a. Fetch all old rows for this batch of 50 sysrefs
  oldRows = db.streamRowsByKeys(source, oldKeyCol, sysrefs)

  // b. Group old rows by composite key: "sysref::accountno"
  oldGroupMap: Map<"sysref::acct", rows[]>

  // c. Translate all account numbers via cithistory
  allAccts = distinct values of old[ck.old_col]
  acctMap = db.batchLookup(cithistory, invaccountno, newinvaccountno, allAccts)

  // d. Fetch all new rows from TEMP TABLE (index seek)
  newRows = db.streamRowsByKeys(tempName, targetFetchKey, sysrefs)

  // e. Group new rows by composite key: "sysref::lvaccountno"
  newGroupMap: Map<"sysref::lvacct", rows[]>

  // f. Compare old composite groups to new composite groups
  for each (ckOld, oldGroup) in oldGroupMap:
    sysref, acct = ckOld.split("::")
    newAcct = acctMap[acct]   // translate to new account number
    if no mapping → ROW_MISSING
    ckNew = sysref + "::" + newAcct
    newGroup = newGroupMap[ckNew]
    if empty → ROW_MISSING
    else:
      validateGroup(ckNew, oldGroup, newGroup, ...)
      runDefRules(...)

  // report extra new groups not present in old
  ...

  lastSysref = last sysref in batch
  if batch.length < 50 → break
```

---

## 11. MultipleStrategy — N Sources to 1 Target

**Use case:** Multiple old tables were merged into one new table. Example: 3 old NPA history tables → 1 new history table.

**Table type:** `MULTIPLE`

### Pair routing

When multiple source tables are listed (comma-separated in `table_info.source`), the engine groups mappings by `(src_table, tgt_table)` pair. Each mapping in common.yaml can optionally specify `src_table` and `tgt_table`. Mappings without explicit tables are assigned to the first (default) source/target pair.

This allows you to say "compare `transactionamount` from source 1 to target, AND compare `transactionamount` from source 2 to target" as separate operations.

### Group mode (when `transaction_grouping` is defined)

Group mode iterates over each source table in the pair map. For each source table it streams rows, fetches matching target rows by group key, builds group maps, and compares groups.

**Two sub-modes**, identical to TransactionStrategy:
- **Carry-over streaming** (default) — anchored by `id`, carries the last partial group into the next chunk. Works correctly only when groups are NOT scattered (rows contiguous in ID order).
- **Group pagination** (`use_group_pagination: true`) — paginates over distinct group keys (200 per batch), fetches all rows for those keys in one shot. Groups are always complete. Required when the source table is scattered. Also calls `fingerprintDiff()` when errors are found and `row_fingerprint` is defined.

The `source_key_aliases` setting handles the case where different old sources name the group key column differently. For example, if source 1 calls it `systemreferencenumber` and source 2 calls it `sysrefno`:

```yaml
transaction_grouping:
  keys:
    old: systemreferencenumber
  source_key_aliases:
    "[ncs-conv-aging].dbo.[conv$source2]": sysrefno
```

Group mode calls `runDefRules()` after each group comparison, exactly like TransactionStrategy does.

### Row mode (when `transaction_grouping` is NOT defined)

Falls back to a 1:1 anchor key lookup. Identical in principle to MasterStrategy's forward scan but without worker threads and without reverse scan.

---

## 12. UnionStrategy — Multiple Sources Same Schema

**Use case:** The old data was split across multiple tables that have the exact same schema (columns and meaning are identical). The new system combined them into one table.

**Table type:** `UNION`

This is simpler than MULTIPLE because all sources share the same mapping definition. The engine iterates over each source table and runs the same group-based comparison (same carry-over logic as TransactionStrategy) for each one against the common target.

The key difference from MULTIPLE: all mappings apply to all sources. There is no per-pair routing.

---

## 13. SplitStrategy — Value Set Validation

**Use case:** Validate that a set of values from one column in old exists in the corresponding column in new. No row-level anchor key exists — just check that the value sets match.

**Table type:** `SPLIT`

The strategy works on the `exact_matches` only. For each mapping:

1. Stream all new column values into a `Set<string>` using `streamAllRows`.
2. Stream all old column values using `streamAllRows`, and for each old value, check if it exists in the new Set.
3. After the old stream is done, check the new Set for values that were never matched by old.

Both directions are checked (old → new and new → old).

Memory usage: `O(distinct values)` — only the column value is stored in the Set, not full row objects.

---

## 14. HeaderStrategy — Long-to-Wide Pivot

**Use case:** The old table has one row per (identity, attribute_type) pair. The new table has one row per identity with each attribute_type value as a separate column. This is a classic database "pivot" transformation.

**Table type:** `HEADER`

### Configuration

```yaml
pivot_config:
  identity_key:
    old: contract_id    # the common identity column
    new: contract_id
  pivot_key: header_type   # old column whose values become column names in new

schema_mappings:
  pivot_matches:
    - pivot_key_value: "INTEREST"   # WHERE header_type = 'INTEREST'
      value_col: amount             # read this old column
      new_col: interest_amount      # compare to this new column
```

### Algorithm

```
while true:
  identityKeys = db.getGroupKeys(source, oldIdCol, chunkSize, lastIdentityKey)
  if empty → break

  oldChunkRows = db.streamRowsByKeys(source, oldIdCol, identityKeys)
  newChunkRows = db.streamRowsByKeys(target, newIdCol, identityKeys)

  // Build old pivot map: identity → pivotKeyValue → valueCol → value
  oldMap: Map<identity, Map<pivotKeyValue, Map<valueCol, value>>>

  // Build new map: identity → row
  // Detect duplicates in new (migration bug)
  newMap: Map<identity, row>

  for each identity in oldMap:
    newRow = newMap[identity]
    if not found → ROW_MISSING

    for each pivotMatch in pivot_matches:
      oldVal = oldMap[identity][pivotMatch.pivot_key_value][pivotMatch.value_col]
      newVal = newRow[pivotMatch.new_col]
      if not equal (within tolerance) → VALUE_MISMATCH
```

---

## 15. Mapping Types — The Full Reference

All mapping types are defined in `schema_mappings` in common.yaml. Each type is processed differently depending on the strategy.

### `exact_matches`

Direct column comparison. Old column value must equal new column value (after optional transform).

```yaml
exact_matches:
  - old: systemreferencenumber
    new: systemreferenceno
    transform_rule: NONE   # optional
```

In group mode (TRANSACTION/MULTIPLE): compares `SUM(old.col)` vs `SUM(new.col)` per group. For non-numeric columns (strings, dates), `sumColumn` returns `null` and the comparison is skipped — no false errors.

In row mode (MASTER): compares value row-by-row via worker thread.

### `transformed_matches`

Like `exact_matches` but explicitly applies a transform rule before comparison.

```yaml
transformed_matches:
  - old: transactiondate
    new: transactiondate
    transform_rule: DATE_TO_DATETIME
```

Available transform rules: `NONE`, `STRIP_LEADING_ZEROS`, `STRIP_SPECIAL_CHARS`, `DATE_TO_DATETIME`, `SPLIT_FIRST`, `SPLIT_SECOND`, `CONCAT`.

### `split_matches`

One old column maps to multiple new columns. The combination of new columns must equal the old column via a formula.

```yaml
split_matches:
  - old: totalamount
    new_cols: [debitamount, creditamount]
    formula: SUM    # debitamount + creditamount must equal totalamount
```

Formulas: `SUM` (add all), `SUBTRACT` (first minus rest), `EXACT` (pass through single value).

### `concat_matches`

Multiple old columns concatenated become one new column.

```yaml
concat_matches:
  - old_cols: [billno, newaccountno]
    new: billno
    separator: ""   # empty string = no separator
```

In group mode: collects distinct concatenated values from old group, compares to distinct new values. Order-independent (both sets are sorted before joining with `|`).

### `formula_matches`

Multiple old columns combined via arithmetic formula produce one new column.

```yaml
formula_matches:
  - old_cols: [creditprincipleamount, debitprincipleamount]
    formula: SUBTRACT
    new: billprinciple
    # creditprincipleamount - debitprincipleamount must equal billprinciple
```

### `filtered_sum_matches`

Sum a source column filtered by specific condition combinations, compare to one new column. This is used for `lv$lvhisthsum` where each new column (e.g. `lvcreditprincipleamount`) is derived from summing old rows that match specific `affectcode` and `debitcredit` values.

```yaml
filtered_sum_matches:
  - old: transactionamount
    old_filter:
      affectcode_in: [PP]
      debitcredit: "C"
      loantranshostcode_not_in: [82100, 99000]
    new: lvcreditprincipleamount
```

The filter is applied in memory after the rows are fetched. `affectcode_in` restricts to rows where the affect code is in the given list. `debitcredit` restricts to rows where debitcredit equals the given value. `loantranshostcode_not_in` excludes rows whose loan transaction host code is in the exclusion list.

### `pivot_matches`

For HEADER type only. Described in section 14.

---

## 16. Def Rules — Business Logic Layer

Def rules are YAML files in `def/` that define business logic checks that go beyond column comparison. They are evaluated per transaction group after the column comparison is done.

### Structure

```yaml
def_id: def001
target_scope: transaction_group

trigger_condition:
  must_have_any: [PP, I1, QQ]    # only run this rule if the group contains these affect codes

actions:
  - step: "1"
    check_type: ROW_LEVEL_COHESION
    trigger_condition:
      must_have_any: [PP]   # sub-condition: only run step 1 if PP is present
    variables:
      val_pp_credit: "SUM(old.transactionamount[affectcode=PP][debitcredit=C])"
      val_credit_principle: "SUM(new.creditprincipleamount)"
    condition: "val_pp_credit == val_credit_principle"
    error_message: "PP/C not correctly pivoted. old={val_pp_credit}, new={val_credit_principle}."
```

### `runDefRules()` execution flow

For each def rule:
1. Check the **def-level `trigger_condition`**. Extract affect codes from the old group rows by looking for columns named `affectcode`, `affect_code`, `afcode`, etc. (checked case-insensitively). If the condition is not met, skip this entire def rule.
2. For each action in the def rule:
   a. Check the **action-level `trigger_condition`** (optional). Each individual step can declare its own `must_have_all` / `must_have_any`. If not met, skip this step only (other steps in the same def still run).
   b. Call `evaluateDefAction()`.

This two-level gating allows a def rule to have mixed steps — some that run for all groups matching the def, and others that only fire when specific affect codes are present:

```yaml
def_id: def001
trigger_condition:
  must_have_any: [PP, I1]    # skip this entire def if group has neither

actions:
  - step: "1"
    check_type: ROW_LEVEL_COHESION
    trigger_condition:
      must_have_all: [PP]    # only run step 1 if PP is present
    ...

  - step: "2"
    check_type: ROW_LEVEL_COHESION
    # no step-level trigger — runs for all groups that passed the def-level gate
    ...
```

### Check type: `ROW_LEVEL_COHESION`

1. Evaluate all `variables` expressions using `evaluateExpression()`. Each variable becomes a number. If expression evaluation fails, push a `TRANSFORM_ERROR` and skip remaining actions.
2. Evaluate the `condition` string using `evaluateCondition()`. This performs variable substitution and tolerance-aware arithmetic evaluation.
3. If the condition is false, interpolate `{variable_name}` placeholders in `error_message` with their resolved values and push a `DEFECT_VIOLATION` error.

### Check type: `FIELD_VALUE_CHECK`

Validates that specific field values were correctly converted during migration.

Variables:
- `new_col` — which new column to check
- `old_col` — which old column to look at for the skip logic
- `skip_if_old_equals` — if an old row's `old_col` equals this value, it "permits" one matching bad new row (for CONV→CONV conversions that are expected)
- `fail_if_new_matches` — regex pattern; any new row whose `new_col` matches this fails

Logic:
1. Count old rows where `old_col == skip_if_old_equals` → `skipCount`
2. Find all new rows where `new_col` matches the regex → `badNewRows`
3. `excessBad = badNewRows.length - skipCount`
4. If `excessBad > 0`, push `DEFECT_VIOLATION` with a detailed message listing the old and new values that did not convert correctly.

### Loading priority

Table-specific defs take priority over global defs. If `rules/rights_npa/lahisthloantransactionhistoryh/def/def001.yaml` exists, it overrides `rules/global/defs/def001.yaml` for that table.

---

## 17. The Expression Engine

`evaluateExpression(expr, oldRows, newRows)` parses and evaluates a string expression against two arrays of row objects.

### Supported expression formats (in parse priority order)

**1. SUM with WHERE clause (legacy syntax)**
```
SUM(old.col) WHERE filterCol == 'value'
```
Filters old rows where `filterCol` equals `value` (case-insensitive), then sums `col`.

**2. SUM with bracket filters (preferred syntax)**
```
SUM(old.col[f1=v1][f2=v2])
```
Extracts filter conditions from bracket notation using regex `\[(\w+)=([^\]]+)\]`. Each bracket is a separate AND condition. All conditions must be met for a row to be included.

Example: `SUM(old.transactionamount[affectcode=PP][debitcredit=C])` filters rows where affectcode is PP AND debitcredit is C, then sums transactionamount.

**3. SUM over all old rows**
```
SUM(old.col)
```

**4. SUM over all new rows**
```
SUM(new.col)
```

**5. COUNT**
```
COUNT(old)    → number of old rows in this group
COUNT(new)    → number of new rows in this group
```

### `evaluateCondition(condition, vars, tolerance)`

After all variables are resolved to numbers, the condition string is evaluated.

1. Substitute all variable names with their numeric values using word-boundary regex replacement (so `val_credit` does not accidentally replace part of `val_credit_interest`).
2. If the condition contains `==` (and it is a standalone `==`, not `!=`, `<=`, `>=`), split into left and right operands.
3. Use `new Function(...)` to evaluate both sides as JavaScript expressions (e.g. `val_a + val_b` where the variable names have been replaced with numbers).
4. Return `Math.abs(left - right) <= tolerance`.
5. If no `==`, evaluate the entire expression as a boolean JavaScript expression.

**Why `new Function()`?** It allows arbitrary arithmetic in conditions without writing a full expression parser. The input is only the condition string from a YAML file in the repo, not from user input — so the eval risk is acceptable.

---

## 18. Transform Utilities

`TransformUtils` is a static utility class used across all strategies and the worker thread.

### `apply(value, rule)`

Applies a transform rule to normalize a value before comparison:
- `NONE` — trim whitespace, return as string
- `STRIP_LEADING_ZEROS` — remove leading zeros, but keep at least `"0"` if all zeros
- `STRIP_SPECIAL_CHARS` — keep only alphanumeric characters
- `DATE_TO_DATETIME` — normalize various date formats to `YYYY-MM-DD`. Handles ISO dates, ISO datetimes, and Thai banking `dd/mm/yyyy` format (day-first).
- `SPLIT_FIRST` — take all but the last 4 characters of the string (composite key prefix)
- `SPLIT_SECOND` — take the last 4 characters (composite key suffix)
- `CONCAT` — identity (single-value concat; multi-column concat is handled at strategy level via `concat_matches`)

Returns `null` for null/undefined/empty-string inputs.

### `isEqual(oldVal, newVal, tolerance)`

Tolerance-aware equality:
1. Normalizes: empty string, null, and undefined are all treated as `null`.
2. If both are null → equal.
3. If one is null and the other is not → not equal.
4. If both parse as floats → compare with `Math.abs(a - b) <= tolerance`.
5. Otherwise → case-insensitive string comparison.

### `evaluateFormula(formula, values)`

- `SUM` → sum of all values
- `SUBTRACT` → values[0] - values[1] - values[2] - ...
- `EXACT` → values[0] (pass through)

### Noisy column classifiers

- `isNullColumn(values)` → true if every value is null/undefined
- `isZeroColumn(values)` → true if every value is 0, '0', null, or undefined
- `isBooleanColumn(values)` → true if every non-null value is 0 or 1

### `stringSimilarity(a, b)`

Levenshtein distance normalized to 0–1: `1 - distance / maxLength`. Used for fallback column auto-matching in MasterStrategy.

---

## 19. Worker Thread Pool

`WorkerPoolService` manages a pool of `worker_threads.Worker` instances that each run `compare.worker.js`.

### Pool size

`Math.max(1, os.cpus().length - 1)` unless overridden by `MAX_WORKER_THREADS`. One CPU is left for the main Node.js event loop. In a Docker container, `os.cpus()` returns the host CPU count, not the container's, so `MAX_WORKER_THREADS` should be set in the k8s deployment manifest.

### Task dispatch

`workerPool.run(task)` returns a `Promise<CompareResult>`:
- If there is an idle worker, dispatch immediately.
- If all workers are busy, push to a queue.
- When a worker completes and the queue is non-empty, immediately dispatch the next queued task.

### Crash resilience

If a worker crashes (uncaught exception), the `'error'` event handler:
1. Resolves the pending task with a `TRANSFORM_ERROR` error (instead of rejecting, which would abort the whole table run).
2. Spawns a fresh replacement worker.
3. Dispatches the next queued task to the fresh worker.

This means a crashing worker on one chunk does not stop validation of other chunks.

### The worker itself (`compare.worker.ts`)

When the worker receives a `CompareTask` message via `parentPort`, it calls `compareChunk()`:

1. Build `newMap: Map<anchorKeyNew, newRow>` from `newRows` array.
2. Track `matchedNewKeys: Set<string>`.
3. For each old row:
   a. Look up the new row by `anchorKeyOld` value → `newMap.get(key)`.
   b. If not found → `ROW_MISSING`.
   c. For each mapping type: compare old value to new value. Skip noisy columns. Push `VALUE_MISMATCH` if not equal within tolerance.
4. After all old rows: iterate `newMap`, report any key that was never matched as a `ROW_MISSING` extra row.
5. Post `CompareResult` back to the main thread via `parentPort.postMessage()`.

---

## 20. Aggregate SUM Cross-Check

After strategy validation completes, `ValidationService.runAggregateSumCheck()` runs independently. This is a sanity check that does not depend on the row comparison result.

**Logic:**
1. Find any column mapping where both `old` and `new` column names contain the word `amount`.
2. If found, and if the table has `transaction_grouping` (meaning affect codes exist), run:
   ```sql
   SELECT affectcode, SUM(CAST(amount AS FLOAT)) AS total
   FROM [table]
   WHERE amount IS NOT NULL AND affectcode IS NOT NULL
   GROUP BY affectcode
   ```
   on both old and new tables.
3. Compare the SUM per affect code. If they differ by more than tolerance (default 0.01), push a `VALUE_MISMATCH` error with prefix `[AGGREGATE]`.

For UNION tables (multiple sources), the old-side sums are aggregated across all source tables before comparison.

The affect code column name is auto-detected by trying `affectcode`, `affect_code`, `afcode`, etc. until one succeeds.

**Why this is useful:** The row comparison tells you which specific groups or rows differ. The aggregate SUM check tells you if the overall financial totals are off — a useful double-check even if all individual row comparisons pass.

---

## 21. Error Types Reference

| `errorType` | Meaning |
|---|---|
| `VALUE_MISMATCH` | A column value on the old side differs from the new side (row level or group level). |
| `ROW_MISSING` | A row (or group) exists in one table but not the other. Applies in both directions — old missing from new, or new extra in old. |
| `COLUMN_MISSING` | A column referenced in common.yaml does not exist in the actual DB table. |
| `DATA_MISSING` | A column exists in the DB but is not covered by any mapping in common.yaml (unmapped column warning). Also used if a rule directory is not found. |
| `DEFECT_VIOLATION` | A def rule condition evaluated to false — the business logic check failed. |
| `TRANSFORM_ERROR` | The engine encountered an unexpected technical error: expression parse failure, worker thread crash, duplicate anchor key, etc. |

`ValidationError` object fields:
- `errorType` — one of the above
- `message` — human-readable description
- `oldColumn`, `newColumn` — which columns were compared (optional)
- `oldValue`, `newValue` — the actual values (optional)
- `groupKey` — the transaction group key (TRANSACTION/MULTIPLE/UNION only)
- `rowIdentifier` — the anchor key of the row (MASTER/SPLIT/HEADER only)
- `defId` — which def rule triggered the error (def rules only)

---

## 22. Complete Data Flow — End to End

Here is a full trace of what happens when you call:

```
POST /validation/run
{
  "tables": [{
    "table_name": "lahistloantransactionhistory",
    "rule_path": "rights_npa/lahistloantransactionhistory",
    "def_list": ["def001"]
  }]
}
```

```
ValidationController.run(dto)
  → ValidationService.startJob(dto)
      → jobService.createJob()  → jobId = "a1b2c3..."
      → runJob(jobId, dto) [fire-and-forget, no await]
      → return jobId  [HTTP 202 response returned immediately]

─── background ──────────────────────────────────────────────────

runJob(jobId, dto):
  1. ruleLoader.loadGlobalAffectCodes()
     → reads rules/global/affect_codes.json
     → returns Map<"PP" → "Principle Payment", "I1" → "Interest", ...>

  2. For table "lahistloantransactionhistory":

     a. ruleLoader.loadCommonRule("...", "rights_npa/lahistloantransactionhistory")
        → reads rules/rights_npa/lahistloantransactionhistory/common.yaml
        → parses YAML → CommonRule object
        → caches result

     b. ruleLoader.loadDefRules("...", ["def001"], "rights_npa/lahistloantransactionhistory")
        → reads rules/rights_npa/lahistloantransactionhistory/def/def001.yaml
        → also checks rules/global/defs/def001.yaml (table-specific wins if both exist)
        → returns DefRule[]

     c. strategyFactory.create("MULTIPLE")
        → returns new MultipleStrategy(db)

     d. strategy.validate({ commonRule, defRules, affectCodeMap })
        → MultipleStrategy.validate() runs:

          i. Parse source tables (3 sources, comma-separated)
          ii. Route mappings to (src, tgt) pairs
          iii. Schema check for each pair (query INFORMATION_SCHEMA)
          iv. Noisy column detection (SELECT TOP 1000 * FROM source)
          v. Anchor key uniqueness check (GROUP BY anchorKey HAVING COUNT > 1)
          vi. GROUP MODE streaming loop (because transaction_grouping is defined):

              For each source table (vinpahistory, vinpalrentalhistory, vinpalrtrespasserhist):
                → fetch chunk of old rows (5000 rows)
                → collect unique group keys
                → fetch matching new rows from target by group key
                → build oldGroupMap, newGroupMap with carry-over
                → compare each committed group:
                    validateGroup() → compare SUM per column per group
                    runDefRules() → evaluate def001.yaml per group

          vii. Return { errors, rowsChecked }

     e. runAggregateSumCheck():
        → finds transactionamount mapping
        → SELECT affectcode, SUM(transactionamount) GROUP BY affectcode on all 3 sources
        → SELECT affectcode, SUM(transactionamount) GROUP BY affectcode on target
        → compare per affectcode

     f. Categorize errors:
        → valueErrors = VALUE_MISMATCH + DEFECT_VIOLATION
        → missingErrors = ROW_MISSING + COLUMN_MISSING + DATA_MISSING

     g. Push TableResult to results[]
     h. jobService.incrementDone(jobId)

  3. reportService.writeReports(jobId, results)
     → writes reports/job_a1b2c3.csv + .json
     → returns file paths

  4. jobService.complete(jobId, reportPaths)
     → job status = "COMPLETED"
     → client can now GET /validation/jobs/a1b2c3 to get results
```

---

## Summary

The engine is built around three fundamental abstractions:

1. **Rules as data** — all comparison logic lives in YAML files. The TypeScript code is a generic execution engine. Adding a new table pair requires only a new YAML file.

2. **Keyset streaming** — no table is fully loaded into memory. All strategies page through data using cursor-based keyset pagination (`WHERE anchorKey > lastKey`). Memory usage is bounded by `chunkSize` (default 5000 rows) regardless of table size.

3. **Strategy polymorphism** — the `table_type` field in common.yaml selects which strategy runs. Each strategy encapsulates a different comparison algorithm (1:1, group-based, pivot, set-based) without the caller needing to know which one was selected.

These three abstractions together allow the engine to handle tables ranging from a few hundred rows to 15 million rows using the same code path, with the only difference being the YAML configuration file.

---

## 23. Known Limitations

### 23.1 String Columns Are Silently Skipped in Group Mode

**Problem:** In both `use_group_pagination` and composite-key mode, the engine compares columns by calling `sumColumn()` on each group's row set. `sumColumn()` casts values to numbers. If a column contains non-numeric strings, `sumColumn()` returns `null`. The guard `if (oldTotal !== null && newTotal !== null)` then skips the comparison entirely — no error is raised, no `VALUE_MISMATCH` is recorded. The column is **silently not validated**.

This affects columns declared in `exact_matches` and `transformed_matches` that contain string data, for example: `affectcode`, `debitcredit`, `accountno`, `loantranshostcode`, `remark`.

**Fix:** Declare string identity columns in `concat_matches` instead of (or in addition to) `exact_matches`. `concat_matches` collects the **distinct value set** per group (sorted, joined with `|`), then compares old vs new as strings. It is immune to the numeric-cast issue.

```yaml
concat_matches:
  - old_cols: [affectcode]
    new: affectcode        # scalar string, NOT new_cols: [...]

  - old_cols: [debitcredit]
    new: debitcredit

  - old_cols: [newaccountno]
    new: accountno
```

> **Warning:** The field is `new: <string>` (scalar), not `new_cols: [...]`. Using `new_cols` causes `mapping.new = undefined`, which makes every comparison fail with a false `COLUMN_MISSING` on a column literally named `"undefined"`.

Keeping the same columns in `exact_matches` is harmless — they serve as column-existence documentation (schema mismatch will still be caught) even though the value comparison is skipped.

**Affected modes:** `use_group_pagination: true`, `composite_key` mode.
**Not affected:** MASTER strategy (compares rows 1:1, no `sumColumn` grouping).

---

### 23.2 `use_group_pagination` Required for Scattered TRANSACTION Tables

**Problem:** The default anchor-key streaming mode paginates by `id` in ascending order and groups rows in memory. Carry-over logic holds the **last group per chunk** to the next chunk, but it only handles groups that straddle a single chunk boundary. A **scattered group** — one whose member rows are spread across many non-contiguous IDs — can span dozens of chunks. Only the final partial chunk is carried over; all preceding partial chunks are compared against complete new-side groups → **false VALUE_MISMATCH errors for every scattered group**.

A group is "scattered" if `MAX(id) - MIN(id) >> COUNT(*)` for the same group-key value (e.g. BF-00001 in `conv$vinpllvhistory` has id_range/count ratio ≈ 27,479×; 83.7% of all groups in that table are scattered).

**Fix:** Set `use_group_pagination: true` under `transaction_grouping` in the rule YAML. This switches to `getDistinctKeys()` pagination — the engine fetches `GROUP_BATCH` (200) distinct group-key values per iteration, then pulls **all** rows for those keys from both old and new in one shot. Groups are always complete; no carry-over is needed.

```yaml
transaction_grouping:
  keys:
    old: systemreferencenumber
    new: systemreferenceno
  target_fetch_key: journalseqno
  use_group_pagination: true      # rows are SCATTERED — must use this flag
```

**Constraint:** When `use_group_pagination: true` is set, any `source_filter` in `table_info` **must filter on the group key column itself** (e.g. `systemreferenceno LIKE 'P%'`). The filter is applied to `getDistinctKeys()` but is **not** re-applied to `streamRowsByKeys()`. A filter on a non-key column (e.g. `tellerid = 'CONV'`) would correctly restrict which group keys are fetched but then pull all rows for those keys, including rows that don't match the filter — causing spurious VALUE_MISMATCHes.

**Tables confirmed scattered (all use `use_group_pagination: true`):**

| Rule | Source table | Ratio (avg) | % scattered |
|---|---|---|---|
| invest_lv / lvhistinvtransactionhistory | conv$vinpllvhistory | ~27,000× | 83.7% |
| invest_lv / lvhisthinvtransactionhistoryh | conv$vinpllvcithistory | ~46,000,000× | 100% |
| invest_lv / lvhisthsum | conv$vinpllvhistory (P%/ADC%) | ~5,000,000× | 100% |
| eir_npa / lshistinvtransactionhistory | conv$vinpainvesthist | ~11,000,000× | 100% |
| eir_npa / lshisthinvtransactionhistoryh | conv$vinpainvesthist | ~11,000,000× | 100% |
| rights_npl / lnhistloantransactionhistory | conv$vinplhistory | ~2,282× | ~100% |
| rights_npl / lnhisthloantransactionhistoryh | conv$vinplsbthistory + conv$vinplhistory | same source | assumed |
| rights_npl / lnhisthloantransactionhistoryh_adj | conv$vinplsbthistory + conv$vinplhistory | same source | assumed |
| rights_npl / lnhistloantransactionhistory_bfcal | conv$vinplhistory | — | only 3 groups |
| rights_npa / lahistloantransactionhistory | conv$vinpahistory | ~176,000,000× | 99.8% |
| rights_npa / lahisthloantransactionhistoryh | conv$vinpahistory | ~176,000,000× | 99.8% |
| rights_npa / lahistloantransactionhistory_crosscheck | la$lahisthloantransactionhistoryh | — | 47.5% |

**Not affected:** MASTER strategy (1:1 keyed), composite-key mode (already group-paginated), tiny tables where all rows fit in a single chunk (<5000 rows).
