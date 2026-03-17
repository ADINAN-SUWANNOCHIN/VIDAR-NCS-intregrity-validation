# VIDAR Engine — Deep Dive Technical Reference

**Audience:** Anyone who needs to understand exactly how this engine works — from first HTTP request to final report line.
**Level:** Low-level code logic is explained, but each concept is introduced in plain language first so you don't need to be a database expert to follow along.
**Scope:** Everything. No black boxes.

---

## Table of Contents

1. [What This System Does](#1-what-this-system-does)
2. [How It Boots Up](#2-how-it-boots-up)
3. [The API Layer and Preset System](#3-the-api-layer-and-preset-system)
4. [Rule Loading](#4-rule-loading)
5. [Strategy Selection](#5-strategy-selection)
6. [The Database Layer](#6-the-database-layer)
7. [Base Strategy — Shared Infrastructure](#7-base-strategy--shared-infrastructure)
8. [MasterStrategy — Row-by-Row with Worker Threads](#8-masterstrategy--row-by-row-with-worker-threads)
9. [TransactionStrategy — Default Anchor-Key Streaming](#9-transactionstrategy--default-anchor-key-streaming)
10. [TransactionStrategy — Sysref-Sort Mode (use_sysref_sort)](#10-transactionstrategy--sysref-sort-mode)
11. [TransactionStrategy — Group-Pagination Mode (use_group_pagination)](#11-transactionstrategy--group-pagination-mode)
12. [TransactionStrategy — Composite Key Mode](#12-transactionstrategy--composite-key-mode)
13. [MultipleStrategy — N Sources to 1 Target](#13-multiplestrategy--n-sources-to-1-target)
14. [UnionStrategy — Non-Overlapping Source Split](#14-unionstrategy--non-overlapping-source-split)
15. [SplitStrategy — 1 Old Column to N New Columns](#15-splitstrategy--1-old-column-to-n-new-columns)
16. [Mapping Types — Complete Reference](#16-mapping-types--complete-reference)
17. [Def Rules — Business Logic Layer](#17-def-rules--business-logic-layer)
18. [The Expression Engine](#18-the-expression-engine)
19. [Transform Utilities](#19-transform-utilities)
20. [Noisy Column Detection](#20-noisy-column-detection)
21. [Row Fingerprint Diff](#21-row-fingerprint-diff)
22. [Aggregate SUM Cross-Check](#22-aggregate-sum-cross-check)
23. [Worker Thread Pool](#23-worker-thread-pool)
24. [Job Lifecycle](#24-job-lifecycle)
25. [Report Writing](#25-report-writing)
26. [Temp Table Caching — Source and Target](#26-temp-table-caching--source-and-target)
27. [Known Design Constraints and Trade-offs](#27-known-design-constraints-and-trade-offs)

---

## 1. What This System Does

BAM migrated loan and investment data from a legacy system (`ncs-conv-aging`) into a new core system (`ncs-npl-aging`). The migration involved table renames, column renames, data type changes, currency format changes, timezone conversions, row restructuring, and table splits/merges.

**VIDAR's job** is to answer one question: *did all the data land correctly?*

It does this by reading both databases in parallel, comparing them group by group and column by column according to hand-authored rules in YAML files, and producing CSV/JSON reports listing every discrepancy found.

The system does **not** fix data. It does not write to either database. It reads only (`NOLOCK` hints everywhere). Its sole output is a report.

### What "comparison" means

For numeric columns: `SUM(old group) == SUM(new group)` within a floating-point tolerance (default 0.01).

For string/code columns: the **set** of distinct values in the old group must equal the set in the new group (sorted and joined with `|`).

For date columns: old values are normalized (strip timezone, extract date part) then compared as strings.

For filtered columns: only old rows matching specific `affectcode`, `debitcredit`, or `loantranshostcode` conditions are summed.

For formula columns: a formula (SUM, SUBTRACT) is applied across multiple old columns and the result is compared to one new column.

---

## 2. How It Boots Up

The entry point is `src/main.ts`. NestJS bootstraps the app, attaches a global `ValidationPipe` (handles DTO validation and transformation for all API requests), then mounts Swagger UI at `/api`.

The pool connects at `onModuleInit` in `DatabaseService`. If any required env var is missing (`DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`), it throws immediately and the pod crashes with a clear message — deliberately, because silently starting with no DB connection would produce confusing errors later.

Connection pool settings:
- `max: 10` connections
- `min: 2` always alive
- `idleTimeoutMillis: 30000` — idle connections closed after 30s
- `requestTimeout: 1800000` — 30 minutes per query (necessary for large table scans)
- `readOnlyIntent: true` — tells SQL Server this is a read-only connection
- `trustServerCertificate: true` + `minVersion: 'TLSv1'` — required for older SQL Server instances

The global affect codes file (`rules/global/affect_codes.json`) is loaded once at startup and passed to every validation run as a `Map<string, string>` (code → description). This avoids re-reading the file for every table.

---

## 3. The API Layer and Preset System

### Controller routes

All routes are under the `ValidationController`:

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/validation/run` | Manual run — caller specifies tables + rule paths directly |
| `POST` | `/validation/run/all` | Run everything — all modules, all categories |
| `POST` | `/validation/run/preset/:module` | Run all categories for one module |
| `POST` | `/validation/run/preset/:module/:category` | Run one category with optional filters |
| `GET` | `/validation/status/:jobId` | Poll job progress |
| `GET` | `/validation/report/:jobId` | Get report file paths once DONE |
| `GET` | `/validation/presets` | List all presets (discovery endpoint) |

Every run endpoint is `@HttpCode(202)` — it returns immediately with a `jobId`. The actual validation runs in the background (fire-and-forget via `.catch()`).

### Preset YAML structure

Presets live at `presets/{module}/{category}.yaml`. A preset groups multiple validation cases for one API call. Example:

```yaml
name: Rights NPA
module: npa
cases:
  - name: lahistloantransactionhistory
    rule_path: rights_npa/lahistloantransactionhistory
    tables:
      - conv$vinpahistory

  - name: lahisthloantransactionhistoryh
    rule_path: rights_npa/lahisthloantransactionhistoryh
    tables:
      - conv$vinpahistory
      - conv$vinpainvcithistoryh
      - conv$vinpainvhistoryh
```

`tables` lists the **source** table names. For each `(table_name, rule_path)` pair, the engine creates one `TableConfig` entry in the job's `tables` array.

### PresetService resolution chain

`resolveAllTables()` → calls `resolveTablesForModule()` for each module dir → calls `resolveTablesForRun()` for each category YAML → returns flat array of `{ table_name, rule_path }`.

Results are **cached** in a `Map` after first load — the YAML files are only read from disk once per process lifetime.

---

## 4. Rule Loading

`RuleLoaderService` is responsible for loading the YAML files that define how each table should be validated.

For each table in the job, the engine calls:
1. `hasRuleDirectory(tableName, rulePath)` — checks if `rules/{rulePath}/` exists.
2. `loadCommonRule(tableName, rulePath)` — reads and parses `rules/{rulePath}/common.yaml`.
3. `loadDefRules(tableName, defList, rulePath)` — reads all YAML files in `rules/{rulePath}/def/` (or only those named in `defList`).

`common.yaml` defines:
- `table_info`: source table, target table, table type (MASTER/TRANSACTION/etc.), optional `source_filter`
- `anchor_key`: old and new column names used as the keyset pagination cursor (must be unique + monotonic)
- `transaction_grouping`: defines how groups are formed and which streaming mode to use
- `defaults`: tolerance value
- `schema_mappings`: all column comparison rules (see §16)

`def/*.yaml` files define business rule checks that run after column comparison (see §17).

---

## 5. Strategy Selection

`StrategyFactory.create(tableType)` returns the correct strategy object based on `table_type` in `common.yaml`:

| `table_type` | Strategy class | Used for |
|---|---|---|
| `MASTER` | `MasterStrategy` | 1:1 row-by-row comparison — IDs preserved through migration |
| `TRANSACTION` | `TransactionStrategy` | Group-based comparison — IDs NOT preserved, grouped by sysref |
| `MULTIPLE` | `MultipleStrategy` | N old source tables → 1 new target table |
| `UNION` | `UnionStrategy` | Multiple old sources, each maps to a disjoint subset of the new target |
| `SPLIT` | `SplitStrategy` | 1 old table → split across N new tables |
| `HEADER` | `HeaderStrategy` | Long-to-wide pivot (H-table suffix format) |

After the strategy runs, `ValidationService` runs an **independent aggregate SUM cross-check** on top (§22). This is separate from and does not depend on the strategy.

---

## 6. The Database Layer

`DatabaseService` wraps the `mssql` connection pool and provides all SQL primitives used by strategies. All queries use `WITH (NOLOCK)` on source tables.

### Key helper: `tableRef(t)`

```typescript
export function tableRef(t: string): string {
  return t.includes('[') || t.includes('.') ? t : `[${t}]`;
}
```

If the table name already contains `[` or `.` (e.g. `[ncs-conv-aging].dbo.[conv$vinpahistory]`), it is used as-is. Otherwise it is wrapped in brackets. This allows cross-database references to pass through unchanged.

### `fetchChunk(table, anchorColumn, chunkSize, lastKey, extraFilter?)`

The fundamental pagination primitive. Issues:
```sql
SELECT * FROM [table] WITH (NOLOCK)
WHERE [anchorCol] > @lastKey   -- OR IS NOT NULL if lastKey is null
  AND (extraFilter)            -- only if provided
ORDER BY [anchorCol]
OFFSET 0 ROWS FETCH NEXT @chunkSize ROWS ONLY
```

The `lastKey` is bound with correct SQL type via `bindLastKey()` — if it is a JavaScript `number` it uses `BigInt` or `Float`, otherwise `NVarChar`. This is critical: if a numeric anchor key (e.g. `id INT`) is bound as `NVarChar`, SQL Server performs **string comparison** and `'9' > '10'` is true (wrong ordering), causing rows to be silently skipped.

Returns `Record<string, unknown>[]` — all rows in the chunk as raw JS objects.

### `fetchChunkKeys(table, keyColumn, chunkSize, lastKey)`

Identical to `fetchChunk` but selects only the key column (`SELECT [keyColumn]` not `SELECT *`). Used by MasterStrategy's reverse scan where only key existence matters — at 15M rows this reduces bandwidth by ~100× per chunk.

### `streamRowsByKeys(table, keyColumn, keys, callback)`

Fetches all rows where `keyColumn IN (keys)`. Keys are parameterized (SQL injection-safe). Because SQL Server has a hard limit of 2100 parameters per query, keys are batched in groups of 2000. Uses streaming mode (`request.stream = true`) and delivers rows via callback rather than accumulating all rows in memory first.

### `getDistinctKeys(table, keyColumn, pageSize, lastKey, filter?)`

Paginates through `DISTINCT` values of a column. Used by composite-key and group-pagination modes to iterate group keys page by page without loading all rows.

### `querySumByGroup(table, amountColumn, groupColumn)`

Issues `SUM(CAST([amount] AS FLOAT)) GROUP BY [groupCol]` against the full table. Returns a `Map<string, number>`. Used only by the aggregate SUM cross-check (§22).

### `batchLookup(table, lookupCol, resultCol, values)`

Fetches `SELECT lookupCol, resultCol FROM table WHERE lookupCol IN (values)` and returns a `Map<string, string>`. Used by composite-key mode to translate old account numbers to new account numbers via the cithistory table.

### `createSourceCache(sourceTable, tempName, sysrefCol, idCol, filter?)`

Creates a global temp table containing a copy of the source table, clustered-indexed on `(sysrefCol, idCol)`. This is the core of the scatter fix — see §26 for the full explanation.

```sql
-- Step 1: Clean up any leftover from a crashed previous run
IF OBJECT_ID('tempdb..[##dv_src_...]') IS NOT NULL DROP TABLE [##dv_src_...]

-- Step 2: Copy source table (one upfront full scan)
SELECT * INTO [##dv_src_...] FROM [sourceTable] WITH (NOLOCK) WHERE filter

-- Step 3: Create clustered index (server-side sort, one time)
CREATE CLUSTERED INDEX [ix_dv_src] ON [##dv_src_...] ([sysrefCol], [idCol])
```

Both the INSERT and CREATE INDEX use `(req as any).timeout = 0` to override the pool's 30-minute limit — large tables can take longer.

### `createTargetCache(targetTable, tempName, fetchKey, compositeKey)`

Same pattern for the target table, used by composite-key mode. Clustered on `(fetchKey, compositeKey)`.

### `dropSourceCache(tempName)` / `dropTargetCache(tempName)`

Called in `finally` blocks to clean up temp tables even if validation fails. Wrapped in try/catch — if the drop fails (e.g. the table already got cleaned up), it logs a warning rather than crashing.

### Temp table naming: `##dv_src_{pid}_{seq}`

Global temp tables (prefixed `##`) are visible across sessions in the same SQL Server instance. Two concurrent validation jobs on the same server would collide if they used the same temp table name.

`Date.now()` alone is insufficient — two jobs started in the same millisecond get the same timestamp. The fix is a **static monotonic counter**:

```typescript
private static cacheSeq = 0;
static nextCacheSeq(): number { return ++DatabaseService.cacheSeq; }
```

Combined with `process.pid`, this guarantees uniqueness: `##dv_src_12345_1`, `##dv_src_12345_2`, etc.

---

## 7. Base Strategy — Shared Infrastructure

`BaseStrategy` is an abstract class that all strategies extend. It contains every piece of logic that is shared across strategies.

### Schema check: `checkMissingColumns()`

Before any data comparison, the engine checks that every column referenced in `common.yaml` actually exists in both tables. It queries `INFORMATION_SCHEMA.COLUMNS` for each table.

For cross-database references like `[ncs-conv-aging].dbo.[conv$vinpahistory]`, the query is issued against `[ncs-conv-aging].INFORMATION_SCHEMA.COLUMNS` with `TABLE_SCHEMA = 'dbo'` filter — this prevents false positives when the same table name exists in multiple schemas.

**Resilient handling:** Missing columns do NOT abort validation. `filterMappingsAfterSchemaCheck()` removes any mapping that references a missing column, then validation continues with whatever mappings remain. The missing column is reported as a `COLUMN_MISSING` error in the report.

### Unmapped column reporting: `reportUnmappedColumns()`

After the schema check, the engine compares all columns that exist in each table against all columns referenced by any mapping. Columns that exist in the DB but are not covered by any mapping are reported as a `DATA_MISSING` warning — a reminder that they might need validation rules added.

### Noisy column detection: `detectNoisyColumns()`

Before comparing values, the engine checks whether each source column is "noisy" — contains data that would produce meaningless comparisons. Three noisy types:

- **NULL**: every row in the column is null. Comparing SUM(null) = SUM(null) always passes trivially — the column might be unmigrated data, not a true match.
- **ZERO**: every non-null value is `0` or `''`. Same problem — SUM(0) = SUM(0) always passes.
- **BOOLEAN**: all values are `0` or `1` only. Summing booleans produces the count of `true` rows, which is meaningful for count checks but not for amount comparisons.

For each noisy column, the comparison step is **skipped** (name-only match — registered as mapped, avoids `DATA_MISSING` in report, but value not checked). This prevents a flood of false positives for columns where the migration intentionally changed the structure.

The detection logic for each column:
1. `SELECT TOP 1 [col] WHERE [col] IS NOT NULL` — if 0 rows → NULL
2. `SELECT TOP 1 [col] WHERE [col] IS NOT NULL AND CAST([col] AS NVARCHAR) NOT IN ('0', '')` — if 0 rows → ZERO
3. `SELECT TOP 1 [col] WHERE [col] IS NOT NULL AND CAST([col] AS NVARCHAR) NOT IN ('0', '1', 'true', 'false')` — if 0 rows → BOOLEAN
4. Otherwise → NORMAL

### Anchor key uniqueness: `checkAnchorKeyUnique()`

The anchor key is the keyset pagination cursor. If it has duplicates, keyset pagination silently skips rows (the `WHERE key > @lastKey` clause jumps past duplicates when the last row of one chunk and first row of the next chunk share the same key value).

```sql
SELECT TOP 1 [anchorKey] as dupe_key
FROM [table]
GROUP BY [anchorKey]
HAVING COUNT(*) > 1
```

Uses `TOP 1` so it short-circuits at the first duplicate found, not scanning the entire table. Returns `TRANSFORM_ERROR` if duplicates exist. Failures (e.g. permission errors) are silently swallowed — better to continue with a warning than to abort.

### Fallback auto-match: `findFallbackMappings()`

For MASTER tables, columns not covered by any explicit mapping are auto-matched by name similarity. The similarity algorithm is normalized Levenshtein distance:

```
similarity = 1 - levenshtein(a.lower(), b.lower()) / max(len(a), len(b))
```

Threshold: 0.90 — only columns that are ≥90% similar by name get auto-matched. Levenshtein uses two rolling arrays (O(n) memory) to avoid O(m×n) space cost.

### `sumColumn(rows, col)`

Sums a column across a group of rows:
1. Filter out null/undefined values.
2. If all remaining values are NaN after `parseFloat()`, return `null` (non-numeric column — comparison skipped).
3. Otherwise return the sum.

Returns `null` for string columns (dates, codes). `null` from either old or new side causes the comparison to be **silently skipped** — this is how date columns in `transformed_matches` are handled: `sumColumn` returns `null` because date strings are not numeric, so the sum comparison is skipped without raising an error.

### `extractAffectCodes(rows, affectCodeMap)`

Finds which affect codes are present in a group of rows. Handles multiple possible column names (`affectcode`, `affect_code`, `afcode`, etc.) by checking all variants against the actual row keys at runtime. Used by `trigger_condition` in def rules to decide whether a rule applies to this group.

---

## 8. MasterStrategy — Row-by-Row with Worker Threads

Used for tables where IDs are preserved through migration (anchor_key old = anchor_key new, one row maps to exactly one row).

### Step 1: Schema check + noisy column detection

Same as described in §7.

### Step 2: Fallback auto-match

Any source column not covered by any explicit mapping is auto-matched by name similarity ≥0.90. Fallback matches are added to `exactMatches` in the worker task.

### Step 3: Row count check

```sql
SELECT COUNT(*) FROM [source]
SELECT COUNT(*) FROM [target]
```

Both run in parallel. If counts differ, a `ROW_MISSING` error is added — this flags a structural problem before any row comparison happens.

### Step 4: Forward scan — chunk comparison via worker threads

The main loop paginates old rows in chunks of `CHUNK_SIZE` (default 5000) ordered by `anchorKeyOld`. For each chunk:

1. Extract the anchor key values from the old chunk.
2. Fetch matching new rows by those same keys using `streamRowsByKeys`.
3. Send both sets to a **worker thread** (§23) for comparison.
4. Collect errors from the worker result.

Worker threads avoid blocking the Node.js event loop during CPU-intensive column comparison.

### Step 5: Reverse scan — detect extra rows in target

The forward scan only fetches new rows for keys seen in old chunks. If the target has rows whose keys don't exist in old at all, the forward scan never sees them.

The reverse scan paginates target **key values only** (`fetchChunkKeys` — `SELECT [key]` not `SELECT *`) and batch-checks each page against the source:

```sql
SELECT [anchorKeyOld] FROM [source] WITH (NOLOCK) WHERE [anchorKeyOld] IN (@k0, @k1, ...)
```

Keys absent from old are reported as `ROW_MISSING` (extra rows). Errors are capped at 1000 to prevent report flooding on catastrophic mismatches. If the cap is hit, a summary error is added with the total excess count.

**Performance note:** `fetchChunkKeys` selects only the key column, not `SELECT *`. At 15M rows with ~100 columns, this is approximately 100× less data transferred per chunk.

---

## 9. TransactionStrategy — Default Anchor-Key Streaming

Used when `table_type: TRANSACTION`, no special mode flags set. Appropriate for tables where transaction group rows are **contiguous** in ID order (i.e., all rows for `sysref=X` have consecutive IDs with no gaps caused by other sysrefs).

### Core concept: carry-over

Transaction rows are paginated from old ordered by `anchorKey` (typically `id`). Groups are formed in memory by the group key (`systemreferencenumber`). Problem: a group might be split across a chunk boundary — some rows land in chunk N, the rest in chunk N+1.

The solution is **carry-over**:
- After processing each chunk, identify the last group key seen in the old group map.
- Do not compare that group yet — it might not be complete.
- Carry its old rows and new rows forward into the next chunk's group maps.
- In the next chunk, merge the carry rows with any new rows for the same key.

At the end of the last chunk, flush any remaining carry group (compare it normally).

### Chunk processing — step by step

```
Chunk N arrives with 5000 old rows.

1. Seed oldGroupMap and newGroupMap from carryOld / carryNew (rows from the last group
   of the previous chunk).

2. Compute group key values from this chunk's rows.
   Exclude keys already in newGroupMap (avoid re-fetching — would double the sums).

3. Fetch new rows for those group keys via streamRowsByKeys.

4. Group old rows by groupKey into oldGroupMap.
   Group new rows by groupKey into newGroupMap.

5. If this is NOT the last chunk:
   carryKey = the last key in oldGroupMap (may have more rows in chunk N+1).

6. Compare all groups EXCEPT carryKey:
   - If newGroup is empty → ROW_MISSING error.
   - Otherwise → validateGroup() for column comparison, then fingerprintDiff() if errors.
   - Then runDefRules() for business rule checks.

7. Report any groups in newGroupMap with no corresponding old group (extra rows in target).

8. Move to chunk N+1 with carryOld = {carryKey: rows}, carryNew = {carryKey: rows}.
```

### What "group sum comparison" means

For numeric mappings, the engine does not compare individual rows — it compares `SUM(all old rows for this group, column X)` vs `SUM(all new rows for this group, column Y)`. This handles cases where the ETL split one old row into multiple new rows or merged multiple old rows into one — as long as the totals match, the group passes.

For example: old has 1 row with `transactionamount=1000`, new has 2 rows with `transactionamount=600` and `transactionamount=400`. SUM comparison: 1000 == 1000 ✓.

---

## 10. TransactionStrategy — Sysref-Sort Mode

Activated by `use_sysref_sort: true` in `transaction_grouping`.

### Why this mode exists

The default mode streams old rows ordered by `id`. It relies on the assumption that all rows for the same sysref have **contiguous** IDs. For many of the old conv tables, this assumption is false — a sysref's rows are **scattered** across the entire table.

Example: `conv$vinplhistory` has 15M rows. A single sysref (e.g. `P6303-001234`) might have rows at IDs 50, 2000000, 8000000, 14000000. The default mode would carry that group forward through ~3000 chunks before all its rows arrived. Each chunk would see a partial group, keep extending the carry — until the carry grows to cover the entire table in memory.

Even worse: `ORDER BY sysref` on an unindexed 15M-row column is a **blocking sort operator** in SQL Server. The server must sort all 15M rows before returning row 1. At 3000+ paginated chunks, this is re-sorted for every single chunk. At typical SIT server speeds, this took hours per chunk, eventually causing the connection to appear idle → SQL Server kills it → ECONNRESET.

### The source cache solution

Before the main loop, the engine creates a global temp table:

```sql
-- One full table scan — happens once (~5-20 min for 15M rows)
SELECT * INTO [##dv_src_{pid}_{seq}]
FROM [conv$vinplhistory] WITH (NOLOCK)
WHERE (source_filter)   -- baked in at cache creation time

-- One server-side sort — happens once
CREATE CLUSTERED INDEX [ix_dv_src]
ON [##dv_src_{pid}_{seq}] ([systemreferenceno], [id])
```

After that, the main loop paginates against `##dv_src_...` ordered by sysref:

```sql
-- Each chunk: O(1) index seek — milliseconds
SELECT * FROM [##dv_src_...] WITH (NOLOCK)
WHERE [systemreferenceno] > @lastSysref
ORDER BY [systemreferenceno]
OFFSET 0 ROWS FETCH NEXT 5000 ROWS ONLY
```

Because rows are ordered by sysref, all rows for the same sysref are contiguous in the temp table — the carry-over logic works perfectly, and the chunk boundary splits at most one group per chunk.

The `finally` block always drops the temp table:
```typescript
finally {
  await this.db.dropSourceCache(tempName);
}
```

This runs even if validation throws mid-way through. Without this, crashed temp tables pile up in tempdb until the SQL Server instance is restarted.

### Scatter statistics (confirmed on live DB)

For `conv$vinplhistory`:
- Total rows: 15,496,410
- Distinct sysrefs: 1,596,410
- Scattered sysrefs (id_range > row_count): 1,579,010 = **98.91%**
- Most extreme: one sysref spanning 27,000× its row count in ID space

Without sysref-sort mode, the default anchor-key carry-over would produce catastrophic false mismatches for 98.91% of groups.

---

## 11. TransactionStrategy — Group-Pagination Mode

Activated by `use_group_pagination: true` in `transaction_grouping`.

This is the original scatter solution, before sysref-sort mode was added. It is simpler to reason about but ~10× slower in practice.

### How it works

Instead of streaming rows ordered by ID, it paginates **distinct group key values** and fetches all rows for each batch:

```
Loop:
  1. getDistinctKeys(source, oldKeyCol, 200, lastKey, sourceFilter)
     → returns 200 sysref values alphabetically
  2. streamRowsByKeys(source, oldKeyCol, 200_sysrefs) → all old rows for these groups
  3. streamRowsByKeys(target, targetFetchKey, 200_sysrefs) → all new rows for these groups
  4. Group both sets in memory, compare each group.
  5. lastKey = last sysref in batch.
```

Because all rows for each sysref are fetched in one shot (not streamed in order by ID), groups are always complete — no carry-over needed.

### Why it is slower

Two DB round-trips per 200 groups (one for old, one for new) vs one DB round-trip per 5000 rows in sysref-sort mode. For a 15M-row table with 1.5M groups, group-pagination issues ~15,000 total DB requests vs sysref-sort's ~3000.

Use `use_group_pagination` if sysref-sort mode's large upfront temp table copy is unacceptable (e.g. the table changes frequently during validation). Use `use_sysref_sort` otherwise.

---

## 12. TransactionStrategy — Composite Key Mode

Activated by `composite_key` in `transaction_grouping`. Used when two old rows with the same sysref represent different accounts that map to different rows in the new table.

### When a simple sysref group key is not enough

Some LV investment tables: one sysref can cover multiple investment accounts. Old table has rows with `(sysref=X, invaccountno=11041000001)` and `(sysref=X, invaccountno=11041000002)`. New table has separate rows for each `(sysref=X, lvaccountno=22001000001)` and `(sysref=X, lvaccountno=22001000002)`.

If we group only by sysref, we get one combined group with mixed account data and incorrect sums. We need `(sysref, accountno)` as the composite group key.

Additionally, the old account number format (`invaccountno`) is different from the new account number format (`lvaccountno`) — there is an account translation table (`cithistory`) that maps old to new.

### Step by step

```
Loop over batches of SYSREF_BATCH=50 sysrefs:

  a. getDistinctKeys(source, sysref, 50, lastSysref, sourceFilter)

  b. streamRowsByKeys(source, sysref, 50_sysrefs)
     → all old rows for these sysrefs

  c. Group old rows by composite key: "sysref::invaccountno"
     Skip rows where invaccountno is blank.

  d. batchLookup(cithistory, invaccountno, newinvaccountno, allOldAccts)
     → Map: old account → new account
     If no account_mapping configured, use identity map (old account = new account).

  e. streamRowsByKeys(##dv_ck_temp, fetchKey, 50_sysrefs)
     → fetch from TARGET CACHE (not live target — fast indexed seek)

  f. Group new rows by composite key: "sysref::lvaccountno"

  g. For each old composite group (sysref::invAcct):
       translate invAcct → newAcct via acctMap
       look up newGroup = newGroupMap["sysref::newAcct"]
       if not found → ROW_MISSING
       else → validateGroup() + runDefRules()

  h. Report any new composite groups with no corresponding old group.
```

### Target cache

For composite-key mode, the bottleneck is repeated `IN (50_sysrefs)` queries against the target table. For some modules (CE%, RQ%), there are 16,000+ sysref batches. Without caching, this is 16,000 full scans (or at best 16,000 index seeks on a non-clustered index).

`createTargetCache()` copies the entire target table into a global temp table with a clustered index on `(targetFetchKey, compositeKeyNewCol)`. Every subsequent `streamRowsByKeys(##dv_ck_temp, ...)` is an O(1) index seek regardless of batch count.

---

## 13. MultipleStrategy — N Sources to 1 Target

Used when multiple old source tables all migrate into one new target table.

Example: `conv$vinpahistory` and `conv$vinpahistoryarchive` both migrate into `la$lahistloantransactionhistory`.

### How it works

For each source in the `source` field (comma-separated), the strategy independently validates that source against the shared target. The source field supports:

```yaml
source: "[ncs-conv-aging].dbo.[conv$vinpahistory],[ncs-conv-aging].dbo.[conv$vinpahistoryarchive]"
```

For each source, the strategy applies the same `source_filter` and the same `schema_mappings`. Errors from all sources are accumulated and returned together.

### Sysref-sort for MULTIPLE

When `use_sysref_sort: true` is set, MultipleStrategy creates a **separate source cache per source table** and runs the sysref-sort carry-over loop for each independently. Each source gets its own `##dv_src_{pid}_{seq}` name (the `nextCacheSeq()` counter increments for each).

---

## 14. UnionStrategy — Non-Overlapping Source Split

Used when the data in the new target comes from multiple old sources, but each old source maps to a **disjoint** subset of the new target — the new rows from source A don't overlap with the new rows from source B.

This differs from MultipleStrategy where all sources are compared against the full target. In UnionStrategy, each source is compared against only its own subset.

The subset is identified by a `source_filter` on the target side that corresponds to each source.

---

## 15. SplitStrategy — 1 Old Column to N New Columns

Used when one old column is split into multiple new columns during migration.

Example: old has `interest` (total interest), new has `debitinterest` and `creditinterest`. The rule says `formula: SUM` meaning `interest == debitinterest + creditinterest`.

The `validateGroup` call uses `TransformUtils.evaluateFormula()` to compute the formula result and compares it to the old column sum.

---

## 16. Mapping Types — Complete Reference

All mapping types live in `schema_mappings` in `common.yaml`.

### `exact_matches`

```yaml
- old: systemreferenceno
  new: systemreferenceno
```

SUM comparison with tolerance. For numeric columns: `SUM(old group) == SUM(new group)`. For non-numeric (string, date) columns: `sumColumn` returns `null` → comparison **silently skipped** — column is registered as mapped to avoid `DATA_MISSING` warnings. Column renames are supported (old name ≠ new name).

**Important:** `exact_matches` does NOT do row-level equality. It is a group-level sum. Two groups with different distributions but the same total will pass.

### `transformed_matches`

```yaml
- old: transactiondate
  new: transactiondate
  transform_rule: DATE_TO_DATETIME
```

Same as `exact_matches` but with a transform rule applied to old values before comparison. Since `sumColumn` returns `null` for non-numeric strings, date columns in `transformed_matches` are effectively name-registered but not sum-compared. The transform rules matter more for MasterStrategy where individual row values are compared by the worker thread.

Available `transform_rule` values — see §19.

### `concat_matches`

```yaml
- old_cols: [newaccountno]
  new: lvaccountno
  separator: ""
```

For string identity columns that sumColumn can't handle. Builds the **set** of distinct values per group:
- Old: for each row, join `old_cols` values with `separator`, collect distinct results, sort, join with `|`
- New: collect distinct values of `new` column, sort, join with `|`
- Compare as strings.

Example: old group has rows with `newaccountno` = `[11041000023, 11041000023, 11041000023]`. Distinct set = `{11041000023}`. New group has `lvaccountno` = `{11041000023}`. Match ✓.

This catches wrong/missing string values without requiring numeric summing. Essential for group-mode validation of code and ID columns.

Multiple `old_cols` are concatenated per row (with separator) before deduplication — useful for composite string keys.

### `formula_matches`

```yaml
- old_cols: [debitamount, creditamount]
  new: netamount
  formula: SUBTRACT
```

Applies a formula across `old_cols` and compares the result to `new`:
- `SUM`: sum all old_cols → compare to new
- `SUBTRACT`: `old_cols[0] - old_cols[1] - ...` → compare to new
- `EXACT`: use `old_cols[0]` directly → compare to new

If any source column is entirely null in the group (`sumColumn` returns null), the comparison is skipped for that group.

### `filtered_sum_matches`

```yaml
- old: transactionamount
  new: lvdebit001
  old_filter:
    affectcode_in: [A1, BC]
    debitcredit: D
    loantranshostcode_not_in: [82100, 99000]
```

The most precise mapping type. Sums only old rows that pass **all** filter conditions:
- `affectcode_in`: old row's affectcode must be in the given list
- `debitcredit`: old row's debitcredit must equal this value
- `loantranshostcode_not_in`: old row's loantranshostcode must NOT be in this list
- `loantranshostcode_in`: old row's loantranshostcode must be in this list (alternative)

All filters are AND-ed. The filtered old sum is compared to `SUM(new group, new_col)`.

Used heavily for lv$lvhisthsum where one new column (e.g. `lvdebit001`) is defined as `SUM(transactionamount WHERE affectcode=A1 AND debitcredit=D)`.

### `split_matches`

```yaml
- old: interest
  new_cols: [debitinterest, creditinterest]
  formula: SUM
```

Inverse of formula_matches — one old column maps to multiple new columns. The formula is applied to the new columns and compared to the old column sum. Formula options: `SUM`, `SUBTRACT`, `EXACT`.

### `pivot_matches`

Used by HeaderStrategy for H-table pivot validation. A single old `value_col` column maps to different `new_col` values depending on the row's header code column. Each old code maps to a specific new column name.

---

## 17. Def Rules — Business Logic Layer

Def rules live in `rules/{rule_path}/def/*.yaml`. They run **after** column comparison, per group, and check business logic relationships that can't be expressed as simple column comparisons.

### Structure

```yaml
def_id: def001
trigger_condition:
  must_have_any: [PP, RP]   # only evaluate this rule if group contains PP or RP codes

actions:
  - check_type: ROW_LEVEL_COHESION
    trigger_condition:           # per-action condition (optional)
      must_have_all: [PP]
    variables:
      val_debit:  "SUM(new.lvdebit001)"
      val_credit: "SUM(new.lvcredit001)"
    condition: "val_debit == val_credit"
    error_message: "debit and credit must balance for PP transactions"

  - check_type: FIELD_VALUE_CHECK
    variables:
      new_col: tellerid
      old_col: tellerid
      skip_if_old_equals: CONV
      fail_if_new_matches: "^[0-9]+$"
    error_message: "tellerid must be an AD username (non-numeric) in new system"
```

### `trigger_condition`

Both the def-level and action-level `trigger_condition` check what affect codes are present in the group's old rows:
- `must_have_all`: every listed code must be present
- `must_have_any`: at least one listed code must be present

If the condition is not met, the def rule (or action) is skipped entirely for this group.

### `ROW_LEVEL_COHESION`

Evaluates numeric expressions against the group and checks a condition.

1. **Evaluate variables**: each variable is assigned the result of an expression (see §18).
2. **Evaluate condition**: substitute variable values, then evaluate as JavaScript with tolerance-aware `==`.
3. If condition is **false**: push `DEFECT_VIOLATION` with the error_message (with `{var_name}` placeholders interpolated).

The `==` operator in conditions is tolerance-aware — `Math.abs(left - right) <= tolerance` rather than strict equality. This handles floating-point arithmetic errors in large sums.

### `FIELD_VALUE_CHECK`

Validates that new column values match an expected format.

Variables:
- `new_col`: column in new rows to check
- `fail_if_new_matches`: regex pattern — any new row whose `new_col` matches this pattern is considered bad
- `old_col` + `skip_if_old_equals`: for each old row where `old_col == skip_value`, one bad new row is "permitted" (one-to-one skip allowance)

Example use case: `tellerid` in old system is a numeric employee ID (`2174`). In new system it should be an AD username (`anupong`). `fail_if_new_matches: "^[0-9]+$"` catches rows where the migration failed to convert the numeric ID.

If old had some rows with `tellerid = CONV` (a migration placeholder), then `skip_if_old_equals: CONV` permits one matching numeric value in new per such old row — these are legacy migration rows that deliberately keep the old format.

The error report includes both the unconverted old values and the bad new values — making it clear exactly which records need fixing.

---

## 18. The Expression Engine

`BaseStrategy.evaluateExpression(expr, oldRows, newRows)` parses and evaluates expression strings used in def rule variables. Supported formats:

### `SUM(old.col)`
Sum of `col` across all old rows in the group.
```
SUM(old.transactionamount) → 1234.56
```

### `SUM(new.col)`
Sum of `col` across all new rows in the group.
```
SUM(new.lvdebit001) → 1234.56
```

### `SUM(old.col[f1=v1][f2=v2]...)`
Sum of `col` only for old rows where all filter conditions are met. Conditions are AND-ed. Filter values are case-insensitive.
```
SUM(old.transactionamount[affectcode=A1][debitcredit=D])
```
This is the bracket-filter syntax. The legacy WHERE syntax `SUM(old.col) WHERE f == 'v'` is also supported for backwards compatibility but only supports a single condition.

### `COUNT(old)` / `COUNT(new)`
Number of rows in the old or new group.
```
COUNT(old) → 5
COUNT(new) → 5
```

### Condition evaluation

After variables are resolved to numbers, the `condition` string undergoes:
1. Variable name substitution (whole-word matching via `\b` regex boundaries — `val_credit` won't accidentally replace inside `val_credit_interest`).
2. The `==` operator is rewritten as a tolerance-aware comparison: split on `==`, evaluate both sides as JavaScript expressions via `new Function(...)`, return `Math.abs(left - right) <= tolerance`.
3. Other boolean expressions (`>`, `<`, `!=`) are evaluated directly as JavaScript.

---

## 19. Transform Utilities

`TransformUtils.apply(value, rule)` transforms old values before comparison. Used in `transformed_matches` and key normalization.

| Rule | What it does | Example |
|---|---|---|
| `DATE_TO_DATETIME` | Extract date part only. Handles ISO (`2024-01-15T00:00:00.000+07:00`), dd/mm/yyyy, dd-mm-yyyy. Returns `YYYY-MM-DD`. | `"2024-01-15T08:09:00+07:00"` → `"2024-01-15"` |
| `STRIP_LEADING_ZEROS` | Remove leading zeros from numeric strings. Handles rate columns stored as `.0235` (leading dot). | `"0.0235"` → `".0235"`, `"00012"` → `"12"` |
| `STRIP_SPECIAL_CHARS` | Remove all non-alphanumeric characters. | `"P6303-001234"` → `"P6303001234"` |
| `SPLIT_FIRST` | Take all but last 4 characters. For composite key splitting. | `"123450002"` → `"12345"` |
| `SPLIT_SECOND` | Take last 4 characters. | `"123450002"` → `"0002"` |
| `CONCAT` | Identity (actual concat handled at strategy level). | `"abc"` → `"abc"` |
| `NONE` | String trim only. Used for nvarchar amount columns that need whitespace removal. | `" 1234.56 "` → `"1234.56"` |

### `isEqual(oldVal, newVal, tolerance)`

Comparison function used by worker threads for MasterStrategy:
1. Normalize: `null`, `undefined`, `''` all become `null`. If both are null → equal.
2. If both parse as numbers → `Math.abs(a - b) <= tolerance`.
3. Otherwise → case-insensitive string comparison.

### `evaluateFormula(formula, values)`

Arithmetic operations on an array of numbers:
- `SUM`: `values[0] + values[1] + ...`
- `SUBTRACT`: `values[0] - values[1] - ...`
- `EXACT`: `values[0]`

---

## 20. Noisy Column Detection

Described in §7 under BaseStrategy. Quick summary:

| Type | Meaning | Action taken |
|---|---|---|
| `NULL` | All values null | Skip comparison — name-only match |
| `ZERO` | All values `0` or `''` | Skip comparison — name-only match |
| `BOOLEAN` | All values `0` or `1` | Skip comparison — name-only match |
| `NORMAL` | Has meaningful non-zero values | Proceed with sum comparison |

Detection is done against the **source** (old) table. If old has all zeros for a column, the new column is not checked — the assumption is that a zero-source column has no meaningful data to validate.

This design decision means: if old genuinely has all zeros AND new has non-zero data, the engine will NOT catch it. But in practice, such cases indicate a data restructuring decision that should be handled explicitly in the YAML (exclude the column and add a comment).

---

## 21. Row Fingerprint Diff

`BaseStrategy.fingerprintDiff(groupKey, oldGroup, newGroup, fpCols)` — called by TransactionStrategy **after** `validateGroup()` finds errors. It provides more detail about exactly which rows are missing or extra.

### How it works

For each row in old and new, build a fingerprint string by joining the values of `row_fingerprint` columns with `|`:

```yaml
row_fingerprint:
  - old: transactiondate
    new: transactiondate
  - old: transactionamount
    new: transactionamount
```

Old row: `transactiondate=2024-01-15, transactionamount=1000.00` → fingerprint: `"2024-01-15|1000"`
New row: `transactiondate=2024-01-15, transactionamount=1000.00` → fingerprint: `"2024-01-15|1000"`

Build **multisets** (bags with counts) for both old and new fingerprints, then diff them:
- Old has 3 rows with fingerprint X, new has 2 → 1 missing → `ROW_MISSING` with `[FP]` prefix
- New has 2 rows with fingerprint Y, old has 0 → 2 extra → `ROW_MISSING` with `[FP] extra` prefix

Using multisets (not sets) handles duplicates correctly — if a transaction legitimately appears 3 times, the engine expects exactly 3 matching fingerprints on both sides.

### Value normalization for fingerprints

`normalizeFingerprint(v)`:
- `Date` object (mssql `datetime2` → JS Date) → `toISOString().slice(0, 10)` (date part only)
- ISO string `"2024-01-15T..."` → extract before T → `"2024-01-15"`
- Numeric string/number → `parseFloat` (strips trailing zeros: `"1000.00"` → `"1000"`)
- Other → trim to string

This normalization ensures old (stored as nvarchar date string) and new (stored as datetime2, returned as JS Date) produce the same fingerprint string.

---

## 22. Aggregate SUM Cross-Check

Runs **independently** of the strategy, after the strategy completes. It checks whether the total transaction amount adds up correctly at the module level, grouped by affect code.

### Why it exists

The per-group comparison in strategies is thorough but operates at the group level. An aggregate check provides a second, orthogonal verification: even if every individual group passes, the overall total should still match.

More importantly, during early testing when ECONNRESET was killing validations mid-run, the aggregate check still ran (it's a single SQL query, not a 3000-chunk loop) and confirmed that `calprovisionamount` totals matched perfectly — ruling out data corruption and confirming the mismatches were engine artifacts.

### When it runs

Only for tables that have:
1. At least one mapping (in `exact_matches` or `transformed_matches`) where both `old` and `new` column names contain `amount`.
2. `transaction_grouping` defined (so `affectcode` makes sense).

### How it works

1. Auto-detect the affect code column name by trying known variants (`affectcode`, `affect_code`, etc.) until one doesn't throw.
2. For each source (UNION tables have multiple), run:
   ```sql
   SELECT [affectcode], SUM(CAST([amount] AS FLOAT)) AS total
   FROM [source]
   WHERE [amount] IS NOT NULL AND [affectcode] IS NOT NULL
   GROUP BY [affectcode]
   ```
3. Aggregate across all sources (sum per affect code).
4. Run the same query against the target.
5. Compare per affect code: `|old_total - new_total| > tolerance` → `VALUE_MISMATCH` with `[AGGREGATE]` prefix.

The `[AGGREGATE]` prefix makes these errors visually distinct from per-group errors in the report.

---

## 23. Worker Thread Pool

`WorkerPoolService` manages a pool of Node.js worker threads (`worker_threads` module) for CPU-intensive per-row comparisons in MasterStrategy.

### Why workers?

Node.js is single-threaded. A 15M-row comparison loop in the main thread would block the event loop — no other HTTP requests could be handled, and the server would appear hung.

Worker threads run in separate V8 isolates and can execute CPU-bound code in parallel without blocking the main thread.

### Pool design

The pool maintains N worker threads (N = CPU count or configured maximum). Each worker runs `compare.worker.ts` and waits for `CompareTask` messages.

A `CompareTask` contains:
- `oldChunk`: array of old rows
- `newRows`: array of new rows (pre-fetched by key)
- `anchorKeyOld` / `anchorKeyNew`
- `exactMatches`, `splitMatches`, `transformedMatches`, `concatMatches`, `formulaMatches`
- `tolerance`, `noisyColumns`
- `baseIndex`: the global row index of the first row in this chunk (for row-number reporting)

The worker:
1. Builds a `Map<anchorKey, newRow>` from `newRows`.
2. For each old row, looks up the corresponding new row by anchor key.
3. For each mapping, compares old and new values using `TransformUtils.isEqual()`.
4. Returns `{ errors: ValidationError[] }`.

### `WorkerPoolService.run(task)`

Returns a Promise that resolves when a worker completes the task. Tasks are queued if all workers are busy — no task is ever dropped.

---

## 24. Job Lifecycle

`JobService` maintains an in-memory map of all jobs. Jobs are not persisted to disk — a server restart loses all job records.

### States

```
PENDING → RUNNING → DONE
                  → FAILED
```

- `createJob(totalTables, label)`: creates record in `PENDING`, returns UUID jobId.
- `start(jobId)`: transitions to `RUNNING`, records `startedAt`.
- `incrementDone(jobId)`: increments `doneTables` counter (called after each table completes).
- `complete(jobId, reportPaths)`: transitions to `DONE`, records `finishedAt`, stores report paths.
- `fail(jobId, message)`: transitions to `FAILED`, stores error message.

### Job record fields

```typescript
interface JobRecord {
  jobId: string;
  label?: string;           // human-readable name from job_name in request
  status: JobStatus;
  createdAt: Date;
  totalTables: number;
  doneTables: number;       // increments as each table finishes
  startedAt?: Date;
  finishedAt?: Date;
  reportPaths?: string[];   // populated on DONE
  errorMessage?: string;    // populated on FAILED
}
```

### Background execution

`ValidationService.startJob()` fires `runJob()` without `await`:

```typescript
this.runJob(jobId, dto).catch((err) => {
  this.jobService.fail(jobId, err.message);
});
return jobId;  // returned immediately — job runs in background
```

The `.catch()` handles the case where `runJob` throws — transitions job to FAILED. Any unhandled error in a table's strategy is caught inside the loop and pushed as a `TRANSFORM_ERROR`, so `runJob` itself almost never throws.

---

## 25. Report Writing

`ReportService.writeReports(jobId, results)` writes two files per job:

1. **`reports/{jobId}/errors.csv`** — one row per error, columns: `tableName`, `errorType`, `groupKey`, `oldColumn`, `newColumn`, `oldValue`, `newValue`, `message`
2. **`reports/{jobId}/summary.json`** — aggregated per-table stats: `rowsChecked`, `pass`, `fail`, `missing`, `timeSpent`

Reports are written to the local filesystem. The paths are stored in the job record and returned by `GET /validation/report/{jobId}`.

---

## 26. Temp Table Caching — Source and Target

Two types of global temp table caches are used by the engine. Both use the same naming convention and lifecycle management.

### Source cache (`##dv_src_{pid}_{seq}`)

Used by `use_sysref_sort` mode in TransactionStrategy and MultipleStrategy.

**Lifecycle:**
1. Created before the main validation loop starts.
2. Source table is copied into it with `source_filter` applied (so only relevant rows are cached).
3. Clustered index created on `(sysrefCol, idCol)`.
4. All `fetchChunk` calls in the main loop target the temp table, not the original source.
5. Dropped in `finally` after the loop completes or throws.

**tempdb space:** 207 GB available on the SIT server. A 15M-row table with ~30 columns uses approximately 2-5 GB. Multiple concurrent jobs would need proportionally more, but the server has ample headroom.

**DBA note:** We cannot add indexes to the live conv tables (read-only, production-adjacent). The temp table pattern circumvents this — temp tables are always in tempdb which is writable by any session.

### Target cache (`##dv_ck_{pid}_{seq}`)

Used by composite-key mode in TransactionStrategy.

**Why:** The CE% and RQ% sysref batches for `lv$lvhisthsum` involve 16,000+ `IN (50 sysrefs)` queries against the target. Without a cache, each query must scan or partially scan the full target table. With a clustered-indexed temp table, each query is an O(1) index seek — reducing hours-long runs to minutes.

**Lifecycle:** Same as source cache — created before the sysref loop, dropped in `finally`.

### Uniqueness guarantee

The naming scheme `##dv_{type}_{pid}_{seq}` guarantees no collision:
- `pid` (process ID) separates different server instances running concurrently.
- `seq` (monotonic counter) separates different tables validated within the same process at the same millisecond.
- The `IF OBJECT_ID(...) IS NOT NULL DROP TABLE` at the start of creation handles any leftover tables from previous crashed runs with the same pid (process restart would give a new pid, but re-runs within the same process lifetime would reuse pids without the seq increment — the counter prevents collision there).

---

## 27. Known Design Constraints and Trade-offs

### IDs are not preserved through migration

Old `id` (auto-increment) is not the same as new `id`. `anchor_key` in YAML marks the old `id` as a pagination cursor only — it is never used as a join key to match rows. The actual join happens on `transaction_grouping.keys` (the business key, e.g. `systemreferencenumber`).

### Group sum ≠ row equality

The engine compares `SUM(group)` for numeric columns, not individual row values. This means: a group where old has `[500, 500]` and new has `[1000]` passes (both sum to 1000). This is intentional — the ETL often consolidates rows. Row-level equality checking would require stable row ordering, which doesn't exist when IDs are regenerated.

The `row_fingerprint` mechanism partially fills this gap by identifying which specific transactions (by date + amount) are missing or extra, but only when `validateGroup()` already found a mismatch.

### String columns in group mode

`sumColumn()` returns `null` for string values (non-parseable as float). This means date columns, code columns, and reference columns in `transformed_matches` or `exact_matches` are **name-registered** but not value-compared in group mode. Use `concat_matches` for string columns that must have their values verified.

### Single transaction queue

All tables in a job run sequentially (one after another in the `for` loop in `ValidationService.runJob`). There is no parallel table processing at the job level. This is safe (no resource contention) but means a 14-table job takes the sum of all table processing times, not the maximum.

### In-memory job registry

Job records are stored in a `Map` in memory. A server restart loses all records. There is no persistence. If the server restarts mid-job, the job disappears from the status endpoint. The report files (if any were written before the crash) remain on disk but are inaccessible through the API.

### DEF rules not supported in MasterStrategy

Worker threads handle row comparison in MasterStrategy and do not return old+new row pairs back to the main thread. `runDefRules` requires access to full row data. The workaround is to use `TRANSACTION` table_type for any table that needs DEF rule evaluation (even if it's technically a master table by structure).

### Noisy column detection queries source only

The zero/null/boolean check runs only against the old (source) table. If old is all zeros but new has data, the column is classified as `ZERO` and skipped — the missing new data is not caught. This is correct for the migration context (old zeros = no data was migrated = correct). If this assumption doesn't hold for a specific column, exclude it from noisy detection by setting a non-zero sample filter in the rule YAML.
