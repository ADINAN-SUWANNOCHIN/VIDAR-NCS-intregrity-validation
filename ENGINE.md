# VIDAR — Data Validation Engine

**Purpose:** Post-migration data validation. Compares Legacy DB tables against New Core DB tables after ETL and reports every mismatch in a structured Excel report.

**Audience:** Any developer who needs to understand, maintain, or extend this engine.

---

## Table of Contents

1. [Project Layout](#1-project-layout)
2. [How It Works — Big Picture](#2-how-it-works--big-picture)
3. [API Endpoints](#3-api-endpoints)
4. [Preset System](#4-preset-system)
5. [Rule Files](#5-rule-files)
6. [Strategy Selection](#6-strategy-selection)
7. [Data Pulling — How the Engine Reads from SQL Server](#7-data-pulling--how-the-engine-reads-from-sql-server)
8. [Processing Pipeline — TransactionStrategy Step by Step](#8-processing-pipeline--transactionstrategy-step-by-step)
9. [Processing Pipeline — MasterStrategy Step by Step](#9-processing-pipeline--masterstrategy-step-by-step)
10. [Processing Pipeline — Other Strategies](#10-processing-pipeline--other-strategies)
11. [Group Comparison — validateGroup in Detail](#11-group-comparison--validategroup-in-detail)
12. [Pre-Processing Checks (Schema, Noisy Columns, Fallback)](#12-pre-processing-checks-schema-noisy-columns-fallback)
13. [Def Rules — Business Logic](#13-def-rules--business-logic)
14. [Report Output](#14-report-output)
15. [Job Management](#15-job-management)
16. [Adding a New Rule](#16-adding-a-new-rule)

---

## 1. Project Layout

```
data-validation-service/
│
├── src/                              # All TypeScript source code
│   ├── main.ts                       # App entry point — starts NestJS, Swagger, global pipes
│   ├── app.module.ts                 # Root NestJS module — wires all services together
│   │
│   ├── validation/
│   │   ├── validation.controller.ts  # HTTP endpoints (POST /run, GET /status, GET /download, etc.)
│   │   ├── validation.service.ts     # Core job runner — loads rules, picks strategy, runs comparison
│   │   └── preset.service.ts         # Reads preset YAMLs, resolves table+rule_path pairs for API
│   │
│   ├── job/
│   │   ├── job.service.ts            # Job state machine — create/start/complete/fail + persist to disk
│   │   └── job.types.ts             # TypeScript types: JobRecord, JobStatus, TableSummary
│   │
│   ├── rules/
│   │   ├── rule-loader.service.ts    # Reads common.yaml and def/*.yaml from disk, caches in memory
│   │   └── rule.types.ts            # TypeScript interfaces for CommonRule, DefRule, SchemaMappings, etc.
│   │
│   ├── strategies/
│   │   ├── strategy.factory.ts       # Maps table_type string → Strategy class instance
│   │   ├── base.strategy.ts          # Abstract base — shared: schema check, noisy columns, def eval, fingerprint
│   │   ├── transaction.strategy.ts   # TRANSACTION: group-based comparison, 4 modes (main strategy)
│   │   ├── master.strategy.ts        # MASTER: row-by-row key comparison via worker threads
│   │   ├── other.strategies.ts       # SPLIT, HEADER, UNION, MULTIPLE strategies
│   │   ├── compare.worker.ts         # Worker thread code — runs MASTER row comparison in parallel
│   │   ├── worker-pool.service.ts    # Thread pool manager — queues tasks for compare.worker.ts
│   │   └── transform.utils.ts        # Value transforms: strip zeros, date normalize, formula eval
│   │
│   ├── reports/
│   │   └── report.service.ts         # Writes Validation_Report.xlsx (4 sheets via ExcelJS)
│   │
│   ├── database/
│   │   └── database.service.ts       # ALL SQL Server I/O — every query the engine makes lives here
│   │
│   ├── dto/
│   │   └── validation-request.dto.ts # Shape of POST /validation/run request body
│   │
│   └── schema/                       # Schema discovery tools (separate feature, not part of validation)
│       ├── schema.controller.ts
│       ├── schema.service.ts
│       ├── column-matcher.ts
│       ├── yaml-generator.ts
│       └── excel-report.ts
│
├── rules/                            # Rule files — one folder per validation case
│   ├── global/
│   │   ├── affect_codes.json         # Master list of all valid affect codes (PP, A1, BC, ...)
│   │   └── defs/                     # Global def rules shared across all tables
│   ├── rights_npa/
│   │   ├── lahistloantransactionhistory/
│   │   │   ├── common.yaml           # Column mappings + comparison config for this case
│   │   │   └── def/                  # Table-specific def rules (override global defs with same ID)
│   │   │       └── def001.yaml
│   │   └── lahisthloantransactionhistoryh/
│   │       └── common.yaml
│   ├── rights_npl/
│   ├── eir_npa/
│   └── invest_lv/
│
├── presets/                          # Preset configs — groups tables into runnable cases
│   ├── npa/
│   │   ├── rights.yaml               # NPA rights module: cases + source tables
│   │   └── eir.yaml
│   ├── npl/
│   │   └── rights.yaml
│   └── invest/
│       └── lv.yaml
│
├── kubernetes/sit/                   # K8s manifests for SIT environment
│   ├── deploy-sit.yaml
│   ├── service-sit.yaml
│   └── ingress-sit.yaml
│
├── Dockerfile                        # Multi-stage build: compile TS → lean production image
└── ENGINE.md                         # This file
```

---

## 2. How It Works — Big Picture

```
HTTP Request (POST /validation/run/preset/npa/rights)
     │
     ▼
ValidationController                  src/validation/validation.controller.ts
  reads module + category from URL
     │
     ▼
PresetService                         src/validation/preset.service.ts
  reads presets/npa/rights.yaml
  resolves → [{ table_name: "conv$vinpahistory", rule_path: "rights_npa/lahistloantransactionhistory" }]
     │
     ▼
ValidationService.startJob()          src/validation/validation.service.ts
  creates Job record → returns jobId immediately (HTTP 202)
  fires runJob() in background (no await)
     │
     ▼  [background]
ValidationService.runJob()
  for each table:
     │
     ├─► RuleLoaderService            src/rules/rule-loader.service.ts
     │     reads rules/{rule_path}/common.yaml   → CommonRule
     │     reads rules/{rule_path}/def/*.yaml    → DefRule[]
     │     reads rules/global/affect_codes.json → affectCodeMap
     │
     ├─► StrategyFactory              src/strategies/strategy.factory.ts
     │     reads commonRule.table_info.table_type
     │     returns correct Strategy instance
     │
     ├─► Strategy.validate()          src/strategies/*.strategy.ts
     │     pulls data from SQL Server  ← see Section 7
     │     compares data               ← see Section 8/9/10/11
     │     returns { errors, rowsChecked, passCount, failCount }
     │
     ├─► AggregateSumCheck            src/validation/validation.service.ts
     │     independently checks SUM(amount) per affectcode
     │     adds errors to same list
     │
     └─► ReportService                src/reports/report.service.ts
           writes reports/{jobId}/Validation_Report.xlsx

Client polls GET /validation/status/:jobId until status = DONE
Client calls GET /validation/download/:jobId to get the Excel file
```

**Key design: fire-and-forget jobs.**
POST returns `jobId` immediately (HTTP 202). Validation runs in the background. This prevents HTTP timeouts on large tables (some run 30+ minutes). Poll `/status/:jobId` to track progress.

---

## 3. API Endpoints

**File:** `src/validation/validation.controller.ts`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/validation/run` | Manual run — supply tables + rule_paths directly |
| `POST` | `/validation/run/all` | Run every preset in one shot |
| `POST` | `/validation/run/preset/:module` | Run all categories for a module (e.g. `npa`) |
| `POST` | `/validation/run/preset/:module/:category` | Run one category, optionally filtered |
| `GET`  | `/validation/jobs` | List all jobs (most recent first) |
| `GET`  | `/validation/status/:jobId` | Job status + inline summary when DONE |
| `GET`  | `/validation/download/:jobId` | Download `Validation_Report.xlsx` |
| `GET`  | `/validation/presets` | List all presets, cases, and source tables |

**Swagger UI** available at `/api`.

**Example — run a specific case:**
```
POST /validation/run/preset/npa/rights
{ "case_name": "lahistloantransactionhistory" }
```

---

## 4. Preset System

**Files:** `presets/{module}/{category}.yaml`
**Code:** `src/validation/preset.service.ts`

Presets map human-readable case names to the exact table and rule folder the engine needs.

```yaml
# presets/npa/rights.yaml
name: Rights NPA
module: npa
cases:
  - name: lahistloantransactionhistory          # filter value for case_name in API
    rule_path: rights_npa/lahistloantransactionhistory  # → rules/ folder path
    tables:
      - "conv$vinpahistory"                     # source table(s) to submit
```

Use `GET /validation/presets` to see all loaded cases and valid `case_name` values.

---

## 5. Rule Files

**Location:** `rules/{module_category}/{case_name}/`
**Loader:** `src/rules/rule-loader.service.ts`
**Types:** `src/rules/rule.types.ts`

Each case has one folder with:
- `common.yaml` — required. Column mappings and all comparison config.
- `def/*.yaml` — optional. Business logic checks beyond column mappings.

### common.yaml structure

```yaml
table_info:
  source: "conv$vinpahistory"
  target: "la$lahistloantransactionhistory"
  table_type: MULTIPLE
  source_filter: "successlv2 = 1"   # SQL WHERE applied when pulling old rows

anchor_key:
  old: id       # column for keyset pagination on old table (must be unique + monotonic)
  new: id       # column for keyset pagination on new table

transaction_grouping:               # required for TRANSACTION, MULTIPLE, HEADER
  keys:
    old: systemreferencenumber      # group key on old table
    new: systemreferenceno          # group key on new table
  use_sysref_sort: true             # optional mode flags — see Section 8
  row_fingerprint:                  # optional — row-level diff on mismatch
    - { old: transactiondate, new: transactiondate }

schema_mappings:
  exact_matches:
    - { old: accountno, new: accountno }
  transformed_matches:
    - { old: transactiondate, new: transactiondate, transform_rule: DATE_TO_DATETIME }
  filtered_sum_matches:
    - old: transactionamount
      old_filter: { affectcode_in: ["PP"], debitcredit: "C" }
      new: lvcreditprincipleamount

defaults:
  tolerance: 0.01
```

---

## 6. Strategy Selection

**File:** `src/strategies/strategy.factory.ts`

The `table_type` field in `common.yaml` selects the strategy:

| `table_type` | Strategy class | When to use |
|-------------|----------------|-------------|
| `TRANSACTION` | `TransactionStrategy` | Default. 1 or N old rows → 1 new row per sysref group |
| `MASTER` | `MasterStrategy` | Reference table. 1 old row → 1 new row, matched by anchor key |
| `MULTIPLE` | `MultipleStrategy` | N old source tables merge into 1 new table |
| `UNION` | `UnionStrategy` | 1 old table splits into N non-overlapping new tables |
| `SPLIT` | `SplitStrategy` | 1 old column splits into N new columns |
| `HEADER` | `HeaderStrategy` | Long→Wide pivot (many old rows per account → one new row with pivoted columns) |
| `ASSOCIATE` | _(uses MasterStrategy)_ | Same as MASTER |

---

## 7. Data Pulling — How the Engine Reads from SQL Server

**File:** `src/database/database.service.ts`

This is the single file that owns all SQL Server I/O. No strategy or service runs SQL directly — everything goes through these methods. Understanding them is the key to understanding the engine's performance characteristics.

### Connection Setup

```
DB_HOST / DB_USER / DB_PASSWORD / DB_NAME  (env vars, see secret.template.yaml)
```

One shared connection pool (max 10 connections). Both old and new tables are in the same SQL Server instance (different databases). `requestTimeout = 30 minutes` per query. TCP keepAlive is enabled to prevent ECONNRESET on long-running server operations (large SELECT INTO can take 5–30 min).

---

### Method 1 — `fetchChunk()` — Keyset Pagination

**Used by:** TransactionStrategy (default mode), MasterStrategy, SysrefSort mode setup

```typescript
fetchChunk(table, anchorColumn, chunkSize, lastKey, extraFilter?)
```

**What it does:** Fetches the next N rows from a table, starting after `lastKey`. This is the core mechanism for streaming large tables without loading them all into memory at once.

**SQL it runs:**
```sql
SELECT * FROM [conv$vinpahistory] WITH (NOLOCK)
WHERE [id] > @lastKey         -- skip rows already processed
ORDER BY [id]
OFFSET 0 ROWS FETCH NEXT 5000 ROWS ONLY
```

On the first call, `lastKey = null` so the WHERE becomes `WHERE [id] IS NOT NULL` (i.e. start from the beginning).

**Why keyset (not OFFSET N)?**
Using `OFFSET 150000 ROWS FETCH NEXT 5000` makes SQL Server scan and discard the first 150,000 rows every time — O(n²) for a full table scan. Keyset pagination (`WHERE id > lastKey`) uses the index to seek directly to the next chunk — O(1) per chunk. On a 15M-row table, the difference is hours vs minutes.

**Important:** The anchor key column (`anchor_key.old` in common.yaml) MUST be unique and monotonically increasing (like an `id` column). Duplicate anchor keys break pagination — rows get skipped silently. The engine checks this upfront with `checkAnchorKeyUnique()`.

**`extraFilter`** applies `source_filter` from common.yaml:
```sql
WHERE [id] > @lastKey AND (successlv2 = 1)
```

---

### Method 2 — `streamRowsByKeys()` — Target Table Fetch by Group Keys

**Used by:** TransactionStrategy, MultipleStrategy (to fetch new rows matching old group keys)

```typescript
streamRowsByKeys(table, keyColumn, keys[], callback)
```

**What it does:** Given a list of sysref values (group keys), fetches all matching rows from the new table. Uses OPENJSON to pass the keys as a single JSON array instead of 2000+ individual parameters.

**SQL it runs:**
```sql
SELECT * FROM [la$lahistloantransactionhistory] WITH (NOLOCK)
WHERE [systemreferenceno] IN (
  SELECT [value] COLLATE DATABASE_DEFAULT
  FROM OPENJSON(@keys)       -- @keys = JSON string: ["P6303-001", "P6303-002", ...]
)
```

**Why OPENJSON instead of `IN (@k0, @k1, @k2, ...)`?**
SQL Server has a 2100 parameter limit per query. With the old approach, batches were capped at 2000 keys (one parameter per key). With OPENJSON, the entire list is one parameter (a JSON string), so batch size can go up to 10,000 — 5× fewer round-trips for the same data.

**Streaming mode:** `request.stream = true`. Rows arrive one-by-one via the `row` event and are passed directly to the callback, so the engine never holds all new rows in memory at once.

**COLLATE DATABASE_DEFAULT:** Required for cross-database queries where the two DBs might have different collations (e.g. Thai_CI_AS vs SQL_Latin1_General). Without it, SQL Server throws a collation conflict error.

---

### Method 3 — `fetchChunkKeys()` — Key-Only Keyset Pagination

**Used by:** MasterStrategy reverse scan (detect extra rows in target)

```typescript
fetchChunkKeys(table, keyColumn, chunkSize, lastKey)
```

**What it does:** Exactly like `fetchChunk()` but `SELECT [keyColumn]` only instead of `SELECT *`. Used by the MASTER reverse scan to page through the new table and check which keys are absent from old — without loading full rows.

**SQL it runs:**
```sql
SELECT [id]
FROM [la$targetTable] WITH (NOLOCK)
WHERE [id] > @lastKey
ORDER BY [id]
OFFSET 0 ROWS FETCH NEXT 5000 ROWS ONLY
```

**Why this exists:** At 15M rows, `SELECT *` per chunk transfers ~100× more data than `SELECT [keyCol]`. For the reverse scan (which only needs to check key existence), `SELECT *` would be wasteful and slow.

---

### Method 4 — `getDistinctKeys()` — Paginate Unique Group Key Values

**Used by:** TransactionStrategy group-pagination mode, composite-key mode

```typescript
getDistinctKeys(table, keyColumn, batchSize, lastKey, filter?)
```

**What it does:** Paginates through DISTINCT values of a column (e.g. sysref), not rows.

**SQL it runs:**
```sql
SELECT DISTINCT [systemreferenceno]
FROM [conv$vinpllvhistory] WITH (NOLOCK)
WHERE [systemreferenceno] > @lastKey
ORDER BY [systemreferenceno]
OFFSET 0 ROWS FETCH NEXT 500 ROWS ONLY
```

**When to use:** When group rows are scattered across the table (not contiguous by id), you can't use anchor-key streaming with carry-over. Instead, paginate DISTINCT sysref values and fetch all rows for each sysref batch. This guarantees each group is always complete before comparison.

---

### Method 5 — `getGroupKeys()` — Distinct Group Keys with Cursor

**Used by:** Older group-pagination path in TransactionStrategy

```typescript
getGroupKeys(table, groupKeyColumn, chunkSize, lastKey)
```

Similar to `getDistinctKeys()` but simpler — no filter support. Fetches next N distinct group key values after lastKey.

---

### Method 6 — `querySumByGroup()` — Aggregate SUM Check

**Used by:** ValidationService aggregate SUM cross-check (runs independently of row comparison)

```typescript
querySumByGroup(table, amountColumn, groupColumn)
```

**What it does:** Returns a Map of `affectcode → SUM(amount)` for an entire table in one query.

**SQL it runs:**
```sql
SELECT [affectcode], SUM(CAST([transactionamount] AS FLOAT)) AS total
FROM [conv$vinpahistory]
WHERE [transactionamount] IS NOT NULL AND [affectcode] IS NOT NULL
GROUP BY [affectcode]
```

**Why:** This is a global sanity check that runs after the per-group comparison. Even if every group passes individually, if `SUM(old.transactionamount WHERE affectcode=PP) ≠ SUM(new.transactionamount WHERE affectcode=PP)` across the whole table, there is a data problem. This catches any missing rows whose group key might not have surfaced in the per-group scan.

---

### Method 7 — `createSourceCache()` + `dropSourceCache()` — Sysref-Sort Temp Table

**Used by:** TransactionStrategy sysref-sort mode

```typescript
createSourceCache(sourceTable, tempName, sysrefCol, idCol, filter?)
dropSourceCache(tempName)
```

**The problem it solves:** In sysref-sort mode, the engine needs to stream old rows ordered by sysref (not by id). On a 15M-row unindexed table, `ORDER BY sysref` forces SQL Server to sort the entire table for every chunk (O(n) per chunk = O(n²) total). At 3000 chunks, this takes hours — and the long-idle connection triggers ECONNRESET from the firewall.

**What it does:**

Step 1 — Copy the source table into a global temp table in SQL Server's tempdb (one full scan, server-side only, no data transfer to Node.js):
```sql
SELECT * INTO [##vidar_src_ABC123]
FROM [conv$vinpllvhistory] WITH (NOLOCK)
WHERE (successlv2 = 1)        -- source_filter applied here
```

Step 2 — Normalize sysref column type so it can be indexed (NVARCHAR(MAX) cannot be a key):
```sql
ALTER TABLE [##vidar_src_ABC123]
ALTER COLUMN [systemreferenceno] NVARCHAR(450)
```

Step 3 — Build a clustered index on (sysref, id):
```sql
CREATE CLUSTERED INDEX [ix_dv_src]
ON [##vidar_src_ABC123] ([systemreferenceno], [id])
```

After this one-time setup (5–30 min for 15M rows), every subsequent `fetchChunk` on the temp table uses the clustered index — O(1) seek per chunk, milliseconds each.

**`##` (double hash) = global temp table** — visible to all connections in the pool, not just the one that created it. Name includes process PID + monotonic counter to prevent collisions between concurrent jobs.

**Always dropped in a `finally` block** so it is cleaned up even if validation throws.

---

### Method 8 — `createTargetCache()` + `dropTargetCache()` — Composite Key Temp Table

**Used by:** TransactionStrategy composite-key mode

```typescript
createTargetCache(sourceTable, tempName, primaryIndexCol, secondaryIndexCol)
dropTargetCache(tempName)
```

**Why:** Composite-key validation needs to look up rows in the new table by (sysref + accountno). If the new table has no index on these columns, every lookup is a full table scan. With 15M rows and thousands of sysrefs, this is prohibitively slow.

**What it does:** Same pattern as `createSourceCache` — copies the new table to tempdb with a clustered index on (sysref, accountno), then all lookups are O(1) seeks.

```sql
SELECT * INTO [##vidar_tgt_ABC123]
FROM [lv$lvhisthsum] WITH (NOLOCK)

CREATE CLUSTERED INDEX [ix_dv_ck]
ON [##vidar_tgt_ABC123] ([systemreferenceno], [lvaccountno])
```

---

### Method 9 — `batchLookup()` — Account Number Translation

**Used by:** TransactionStrategy composite-key mode (translate old accountno → new accountno)

```typescript
batchLookup(table, lookupCol, resultCol, values[])
```

**What it does:** Given a list of old account numbers, returns a Map of `oldAccountNo → newAccountNo` by querying a translation/mapping table. Batched at 2000 values per query (SQL Server's 2100 parameter limit).

---

### Method 10 — `sampleRows()` — Noisy Column Detection Sample

**Used by:** BaseStrategy `detectNoisyColumns()`

```typescript
sampleRows(table, sampleSize = 1000)
```

Fetches `TOP 1000` rows for sampling. Used to determine whether a column is all-NULL, all-zero, or boolean-only before the main loop starts. If a column is all-NULL in the source, comparing it would produce thousands of false mismatches.

---

### Method 11 — `streamAllRows()` — Full Table Stream (HEADER/MASTER fallback)

**Used by:** HeaderStrategy and other strategies that need to load all rows into memory

```typescript
streamAllRows(table, anchorColumn, callback, chunkSize = 5000)
```

Streams all rows via keyset pagination, calling `callback` for each row. Internally loops `fetchChunk` until no more rows. Used by HEADER strategy to build the pivot map in memory.

---

## 8. Processing Pipeline — TransactionStrategy Step by Step

**File:** `src/strategies/transaction.strategy.ts`

This is the most common strategy. Used when multiple old rows per sysref map to multiple new rows per sysref and you validate by comparing aggregates per group.

### Step 0 — Pick the right mode

When `validate()` is called, the first thing it does is check which mode to use:

```
composite_key defined?      → validateCompositeKey()   (Section 8D)
use_group_pagination: true? → validateGroupPagination() (Section 8C)
use_sysref_sort: true?      → validateSysrefSort()      (Section 8B)
otherwise                   → default anchor-key mode   (Section 8A)
```

### Pre-loop setup (all modes)

Before any data is pulled, the engine does:

1. **Schema check** (`checkMissingColumns`) — queries `INFORMATION_SCHEMA.COLUMNS` for both source and target tables, verifies every column referenced in `schema_mappings` actually exists. Missing columns are reported as `COLUMN_MISSING` errors and those mappings are silently skipped (validation continues with what remains).

2. **Unmapped column report** (`reportUnmappedColumns`) — finds columns in the DB tables that aren't covered by any mapping. Reported as `DATA_MISSING` warnings in the report (informs the rule writer that something was missed).

3. **Noisy column detection** (`detectNoisyColumns`) — samples 1000 rows from the source table. For each mapped column, determines if it is:
   - `NULL` — all values are NULL (skip comparison entirely)
   - `ZERO` — all values are 0 or empty string (skip comparison)
   - `BOOLEAN` — all values are 0/1/true/false (skip comparison)
   - `NORMAL` — has real data (compare normally)
   This prevents thousands of false mismatches on columns that are intentionally empty post-migration.

4. **Fallback auto-match** (`findFallbackMappings`) — finds source/target columns not covered by any mapping and attempts fuzzy name matching (≥90% string similarity). Auto-matched columns are added to exact_matches for comparison. A warning is logged so the rule writer knows to add them to common.yaml properly.

5. **Anchor key uniqueness check** (`checkAnchorKeyUnique`) — verifies the anchor key column has no duplicates. Duplicate anchor keys break keyset pagination silently (rows are skipped without error). Reported as `TRANSFORM_ERROR` if found.

---

### 8A — Default Mode: Anchor-Key Streaming with Carry-Over

**Used when:** No special flags are set. Group rows are contiguous in id order (each group's rows sit together in the table).

#### The chunk loop

```
while (true):
  1. fetchChunk(source, anchorKey, 5000, lastKey)    → old rows (next 5000 by id)
  2. extract group keys from old rows
  3. streamRowsByKeys(target, sysrefNew, groupKeys)  → matching new rows
  4. group old rows by sysref → oldGroupMap
  5. group new rows by sysref → newGroupMap
  6. identify carry key (last group in chunk — may continue in next chunk)
  7. for each group except carry: validateGroup() + runDefRules()
  8. lastKey = last row's anchor key
  9. if chunk < 5000 rows: break (end of table)
```

#### The Carry-Over mechanism — why it exists

Imagine a group (sysref `P6303-005209`) has 7 rows, and the chunk size is 5000. If rows 4998, 4999, 5000 are the first 3 rows of this group, and rows 5001–5004 are the remaining 4 rows:

- Chunk 1 returns rows 1–5000, including the first 3 rows of `P6303-005209`
- Without carry-over: `P6303-005209` would be compared with only 3 rows from old → wrong sum → false mismatch
- With carry-over: the last group of chunk 1 is held back, merged with the matching rows from chunk 2, then compared

```
Chunk 1:
  oldGroupMap: { ..., "P6303-005209": [row4998, row4999, row5000] }
  carryKey = "P6303-005209"
  → carry P6303-005209 forward, skip comparison for it

Chunk 2:
  oldGroupMap is pre-seeded with carry: { "P6303-005209": [row4998, row4999, row5000] }
  → fetchChunk adds: row5001, row5002, row5003, row5004 to the same group
  → P6303-005209 now has all 7 rows → compare correctly
```

Only the LAST group of each chunk is carried. All other groups are safe to compare because their rows are fully contained within the chunk.

#### New row deduplication

When the engine pre-seeds `newGroupMap` from the carry, it excludes the carry key from the OPENJSON fetch:

```typescript
const groupKeyVals = [...new Set(oldChunk.map(r => r[sysref]))]
  .filter(k => k !== '' && !newGroupMap.has(k));  // ← skip carry key
```

Without this, the carry group's new rows would be fetched again and counted twice, doubling the group sum → false VALUE_MISMATCH.

#### Per-group comparison result

For each group:
- `newGroup.length === 0` → `ROW_MISSING` error + `failCount += oldGroup.length`
- `validateGroup()` returns errors → `failCount += oldGroup.length`
- `validateGroup()` returns no errors AND `runDefRules()` returns no errors → `passCount += oldGroup.length`

---

### 8B — Sysref-Sort Mode (`use_sysref_sort: true`)

**Used when:** Group rows are scattered in id order (rows for the same sysref are spread across the whole table, not contiguous).

**The problem:** The default carry-over mechanism only protects the last group at a chunk boundary. If a group's rows are spread across 50 chunks (e.g. 3 rows in chunk 1, 2 rows in chunk 500, 1 row in chunk 2000), the group gets compared 3 separate times with partial data — producing false mismatches on every comparison.

**Example:** `conv$vinpllvhistory` has 83.7% scattered groups. The id_range / row_count ratio for most groups is ~27,000×.

**The fix:**
1. `createSourceCache()` — copies the entire source table to tempdb with a clustered index on (sysref, id). **One-time operation (5–30 min for 15M rows).**
2. All subsequent `fetchChunk()` calls target the temp table with `ORDER BY sysref` — because the clustered index sorts by sysref first, rows are now contiguous per group.
3. Carry-over works correctly again (each group's rows are adjacent in the sorted order).

**SQL difference:**
```sql
-- Default mode: sort by id (anchor key)
SELECT * FROM [##vidar_src_XYZ] WITH (NOLOCK)
WHERE [id] > @lastKey
ORDER BY [id]
FETCH NEXT 5000 ROWS ONLY

-- Sysref-sort mode: sort by sysref (group key)
SELECT * FROM [##vidar_src_XYZ] WITH (NOLOCK)
WHERE [systemreferenceno] > @lastSysref
   OR ([systemreferenceno] = @lastSysref AND [id] > @lastId)
ORDER BY [systemreferenceno], [id]
FETCH NEXT 5000 ROWS ONLY
```

The `OR` clause handles the boundary: when the last sysref of chunk N continues into chunk N+1, we need all rows with the same sysref AND a higher id.

---

### 8C — Group-Pagination Mode (`use_group_pagination: true`)

**Used when:** Same scatter problem as sysref-sort, but the sysref column has an index.

**How it works:**
1. `getDistinctKeys()` — paginate through DISTINCT sysref values (500 at a time)
2. For each batch of 500 sysrefs, `streamRowsByKeys()` fetches ALL old rows matching those sysrefs (one OPENJSON query)
3. Similarly fetch all new rows for the same sysrefs
4. Compare each group — no carry-over needed because all rows per group are fetched at once

**Why sysref-sort is usually better:**
Group-pagination does 2 full scans per batch (one for old, one for new). Sysref-sort does 1 full scan (the CREATE INDEX) then O(1) seeks per chunk. For unindexed columns, sysref-sort is ~2× cheaper.

---

### 8D — Composite Key Mode (`composite_key` defined)

**Used when:** One sysref covers many accounts — you need (sysref + accountno) as the combined key, not just sysref.

**Example:** In invest_lv, one `systemreferenceno` can cover 50 accounts. Each (sysref, accountno) pair maps to one new row with its own set of amount columns.

**Steps:**
1. `createTargetCache()` — copies new table to tempdb with clustered index on (sysref, accountno)
2. Load account mapping if needed: `batchLookup()` — translates old accountno → new accountno via a mapping table
3. `getDistinctKeys()` — paginate sysrefs
4. For each sysref batch:
   - Fetch all old rows via `streamRowsByKeys()`
   - Group old by `(sysref + accountno)`
   - Fetch new rows by sysref from temp cache
   - Group new by `(sysref + new_accountno)`
   - Compare each `(sysref, account)` pair using `validateGroup()`

---

## 9. Processing Pipeline — MasterStrategy Step by Step

**File:** `src/strategies/master.strategy.ts`

Used for MASTER/ASSOCIATE tables — reference data where each old row has exactly one matching new row by key.

### Steps

**Step 1 — Schema check**
Same as TransactionStrategy — verify all mapped columns exist, filter out missing ones, report unmapped columns.

**Step 2 — Anchor key uniqueness check**
Checks BOTH source and target tables. Duplicate anchor keys in either table break keyset pagination.

**Step 3 — Row count check**
```sql
SELECT COUNT(*) as cnt FROM [source]
SELECT COUNT(*) as cnt FROM [target]
```
If counts differ → `ROW_MISSING` error is added immediately (before row comparison).

**Step 4 — Noisy column detection**
Same as TransactionStrategy — skip NULL/ZERO/BOOLEAN columns to avoid false mismatches.

**Step 5 — Fallback auto-match**
Fuzzy-match unmapped columns (≥90% similarity).

**Step 6 — Forward scan: key-based chunk comparison via worker threads**

```
while (true):
  1. fetchChunk(source, anchorKey, 5000, lastKey)  → old rows
  2. extract anchor key values from old chunk
  3. streamRowsByKeys(target, anchorKeyNew, oldKeyValues) → new rows
  4. send { oldChunk, newRows } to WorkerPool → compare.worker.ts runs in a worker thread
  5. collect errors from worker
  6. lastKey = last row's anchor key
```

Worker threads (`src/strategies/compare.worker.ts`) run the actual row-by-row comparison in parallel on separate CPU threads. This avoids blocking the Node.js event loop during heavy comparisons of large chunks.

**Step 7 — Reverse scan: detect extra rows in target**

After the forward scan (which only fetches new rows whose keys appear in old), there may be new rows whose keys are entirely absent from old. These would never be found in the forward direction.

```
while (true):
  1. fetchChunkKeys(target, anchorKeyNew, 5000, lastKey)  → new keys only
  2. batch-check: which of these new keys exist in old?
     SELECT [anchorKeyOld] FROM [source] WHERE [anchorKeyOld] IN (@k0,@k1,...)
     (batched at 2000 keys due to SQL Server param limit)
  3. keys absent from old → ROW_MISSING errors
  4. cap at 1000 extra-row errors to avoid flooding the report
```

**passCount/failCount for MASTER:** Computed post-hoc from distinct failing `rowIdentifier` values (unlike TransactionStrategy which tracks them per group during the loop).

---

## 10. Processing Pipeline — Other Strategies

**File:** `src/strategies/other.strategies.ts`

### MultipleStrategy (MULTIPLE)

N old source tables → 1 new target table. Group keys must be mutually exclusive across sources (each sysref appears in exactly one old table).

```
for each source table in table_info.source (comma-separated):
  → same anchor-key streaming loop as TransactionStrategy
  → same validateGroup() comparison
  → results merged into one error list
```

Supports all TransactionStrategy modes (sysref-sort, group-pagination, composite-key) per source.

### HeaderStrategy (HEADER)

Long→Wide pivot. Old table has N rows per account (one per `pivot_key` value). New table has one row per account with each value as its own column.

```
1. streamAllRows(source)     → load all old rows into memory, group by identity_key
2. streamAllRows(target)     → load all new rows into memory, key by identity_key
3. for each identity_key:
   - for each pivot_match:
     - filter old rows WHERE pivot_key = pivot_key_value
     - sum(value_col) from filtered rows
     - compare to new_row[new_col]
```

### UnionStrategy (UNION)

Old table rows split into multiple non-overlapping new tables. Each segment of old is validated against its corresponding new table separately.

### SplitStrategy (SPLIT)

1 old column splits into N new columns. Validates that formula applied to new columns equals old column value.

---

## 11. Group Comparison — validateGroup in Detail

**File:** `src/strategies/transaction.strategy.ts` — `validateGroup()` method

This method is the heart of the engine. It receives:
- `oldGroup` — all old rows for one sysref
- `newGroup` — all new rows for the same sysref
- `sm` — schema_mappings from common.yaml
- `tolerance` — numeric comparison tolerance (default 0)
- `noisyMap` — which columns to skip

It runs each mapping type in sequence:

---

### exact_matches comparison

**Question: does the set of values in old match the set of values in new?**

```typescript
const oldVals = [...new Set(oldGroup.map(r => String(r[mapping.old] ?? '').trim()))]
  .filter(v => v !== '').sort().join('|');
const newVals = [...new Set(newGroup.map(r => String(r[mapping.new] ?? '').trim()))]
  .filter(v => v !== '').sort().join('|');

if (oldVals !== newVals) → VALUE_MISMATCH
```

**Why distinct sets, not SUM?**
In a row-split migration, 1 old row becomes N new rows all with the same accountno (e.g. `A001`). If we summed:
- `SUM(old.accountno)` = `A001` (1 row)
- `SUM(new.accountno)` = `A001 A001 A001` = wrong

With distinct sets: `{A001}` == `{A001}` → correctly passes.

**Noisy columns are skipped** (NULL/ZERO/BOOLEAN columns are excluded from comparison).

---

### transformed_matches comparison

**Question: does SUM(old column) equal SUM(new column)?**

For amount-type columns (e.g. `transactionamount`) that may have a transform rule applied. The engine sums all values per group and compares with tolerance.

```typescript
const oldTotal = sumColumn(oldGroup, mapping.old);
const newTotal = sumColumn(newGroup, mapping.new);
if (Math.abs(oldTotal - newTotal) > tolerance) → VALUE_MISMATCH
```

Note: if the column contains non-numeric values (dates, strings), `sumColumn()` returns `null` and the comparison is skipped gracefully.

---

### filtered_sum_matches comparison

**Question: does the filtered SUM of old rows equal the new column value?**

Used for invest_lv tables where new columns (`lvcreditprincipleamount`) are pre-aggregated in the new DB. The engine re-derives the expected value by summing old rows with matching filters.

```typescript
const filteredOld = oldGroup.filter(row => {
  if (filter.affectcode_in && !filter.affectcode_in.includes(row.affectcode)) return false;
  if (filter.debitcredit && row.debitcredit !== filter.debitcredit) return false;
  if (filter.loantranshostcode_not_in?.includes(row.loantranshostcode)) return false;
  return true;
});
const oldSum = sumColumn(filteredOld, mapping.old) ?? 0;
const newTotal = sumColumn(newGroup, mapping.new) ?? 0;
if (Math.abs(oldSum - newTotal) > tolerance) → VALUE_MISMATCH
```

---

### formula_matches comparison

**Question: does the arithmetic expression applied to old columns equal the new column?**

```typescript
// SUBTRACT example: creditprincipleamount - debitprincipleamount → billprinciple
const oldInputs = mapping.old_cols.map(c => sumColumn(oldGroup, c));
const oldComputed = evaluateFormula(mapping.formula, oldInputs);
// formula = SUBTRACT: oldInputs[0] - oldInputs[1] - ...
// formula = SUM: sum of all oldInputs
const newTotal = sumColumn(newGroup, mapping.new);
if (Math.abs(oldComputed - newTotal) > tolerance) → VALUE_MISMATCH
```

---

### concat_matches comparison

**Question: does concatenating old columns produce the same distinct values as the new column?**

```typescript
const oldVals = [...new Set(oldGroup.map(r =>
  mapping.old_cols.map(c => String(r[c] ?? '').trim()).join(separator)
))].sort().join('|');
const newVals = [...new Set(newGroup.map(r => String(r[mapping.new] ?? '').trim()))].sort().join('|');
if (oldVals !== newVals) → VALUE_MISMATCH
```

---

### Row Fingerprint (post-mismatch detail)

**File:** `src/strategies/base.strategy.ts` — `fingerprintDiff()`

If `row_fingerprint` is configured in common.yaml AND `validateGroup()` found errors, the engine runs an additional row-level diff:

1. For each old row: join the fingerprint column values with `|` → one fingerprint string per row
2. Build a multiset (counts of each unique fingerprint) for old and new
3. Diff the multisets → report unmatched fingerprints as ROW_MISSING

```
old fingerprints: { "2024-01-15|1000.00": 2, "2024-01-16|500.00": 1 }
new fingerprints: { "2024-01-15|1000.00": 1, "2024-01-16|500.00": 1 }
→ ROW_MISSING: "1x in source not in target — 2024-01-15|1000.00"
```

This tells the engineer exactly which transaction is missing, not just "group X has a sum mismatch".

**Uses multisets, not sets:** If old has 3 rows with the same fingerprint and new has 2, the diff correctly reports 1 missing (not 0, which a plain set comparison would give).

**normalizeFingerprint()** ensures dates compare correctly across different DB representations:
- `Date object` → `"2024-01-15"` (ISO date string)
- `"2024-01-15T00:00:00.000Z"` → `"2024-01-15"`
- `"2024-01-15 00:00:00.000"` (SQL datetime) → `"2024-01-15"` (**must check before parseFloat**, which would truncate `"2009-03-30 00:00:00"` to `2009`)
- Numbers → `String(parseFloat(v))` (strips trailing zeros)

---

## 12. Pre-Processing Checks (Schema, Noisy Columns, Fallback)

**File:** `src/strategies/base.strategy.ts`

These checks run before the main loop in every strategy.

### Schema Check — `checkMissingColumns()`

Queries `INFORMATION_SCHEMA.COLUMNS` for both source and target tables. Verifies every column referenced in schema_mappings exists. Missing columns → `COLUMN_MISSING` errors.

**Cross-database support:** Parses `[db].[schema].[table]` format and queries the correct database's INFORMATION_SCHEMA with `AND TABLE_SCHEMA = '...'` to avoid false positives when the same table name exists in multiple schemas.

**Resilient handling:** Missing columns do not abort validation. `filterMappingsAfterSchemaCheck()` removes any mapping that references a missing column. Validation continues with the remaining mappings.

### Unmapped Column Report — `reportUnmappedColumns()`

After the schema check, finds DB columns not covered by any mapping. Reported as `DATA_MISSING` in the Remarks column of the Summary sheet. This tells the rule writer that some columns were not validated.

### Noisy Column Detection — `detectNoisyColumns()`

For each mapped source column, runs up to 3 small queries:

```sql
SELECT TOP 1 [col] FROM [table] WHERE [col] IS NOT NULL
-- → NULL if no non-null values exist

SELECT TOP 1 [col] FROM [table] WHERE [col] IS NOT NULL
  AND CAST([col] AS NVARCHAR(MAX)) NOT IN ('0', '')
-- → ZERO if no non-zero values exist

SELECT TOP 1 [col] FROM [table] WHERE [col] IS NOT NULL
  AND CAST([col] AS NVARCHAR(MAX)) NOT IN ('0', '1', 'true', 'false')
-- → BOOLEAN if all values are 0/1/true/false
```

Any column classified as NULL, ZERO, or BOOLEAN is skipped in `validateGroup()`. This prevents thousands of false mismatches on columns that are intentionally empty post-migration.

### Fallback Auto-Match — `findFallbackMappings()`

After the schema check, any column in either table not covered by a mapping is a candidate for auto-matching. The engine computes string similarity (edit distance ratio) between all unmapped old columns and all unmapped new columns. If the best match has ≥90% similarity, it is added as an `exact_match` for this run.

```
old: [receiptnumber]       new: [receiptno]        similarity: 92% → auto-matched
old: [calculaterate]       new: [calculateintrate]  similarity: 88% → not matched
```

A warning is logged with all auto-matched pairs so the rule writer can add them to common.yaml properly.

---

## 13. Def Rules — Business Logic

**Files:** `rules/{rule_path}/def/*.yaml`, `rules/global/defs/*.yaml`
**Evaluator:** `src/strategies/base.strategy.ts` — `runDefRules()`, `evaluateDefAction()`

Def rules check business conditions that can't be expressed as column mappings — for example, "the sum of all PP debit amounts must equal the sum of all PP credit amounts within this group."

**Table-specific defs override global defs with the same `def_id`.**

### def.yaml structure

```yaml
def_id: def001
target_scope: transaction_group

trigger_condition:
  must_have_any: ["PP"]    # only run if this group contains any PP rows

actions:
  - step: "1"
    check_type: ROW_LEVEL_COHESION
    variables:
      val_debit:  "SUM(old.debitamount[affectcode=PP])"
      val_credit: "SUM(old.creditamount[affectcode=PP])"
    condition: "val_debit == val_credit"
    error_message: "PP debit/credit not balanced: debit={val_debit} credit={val_credit}"
```

### Expression syntax (evaluateExpression)

| Expression | Meaning |
|-----------|---------|
| `SUM(old.col)` | Sum of `col` across all old rows in the group |
| `SUM(new.col)` | Sum of `col` across all new rows in the group |
| `SUM(old.col[affectcode=PP])` | Sum of `col` where `affectcode == PP` |
| `SUM(old.col[affectcode=PP][debitcredit=C])` | Multiple filters (AND-ed) |
| `COUNT(old)` | Number of old rows in the group |
| `COUNT(new)` | Number of new rows in the group |

### Condition evaluation (evaluateCondition)

Variables are substituted, then the condition is evaluated as JavaScript arithmetic. `==` is tolerance-aware: `Math.abs(left - right) <= tolerance`.

```
"val_debit == val_credit"
→ Math.abs(1500.00 - 1500.00) <= 0.01
→ true (PASS)
```

### check_type: FIELD_VALUE_CHECK

Validates that new rows don't contain forbidden field values. Example: ensure `loantranshostcode` was converted from old format to new format.

```yaml
check_type: FIELD_VALUE_CHECK
variables:
  new_col: loantranshostcode
  old_col: loantransaction
  skip_if_old_equals: "CONV"         # old=CONV → new=CONV is acceptable (not a migration error)
  fail_if_new_matches: "^(OLD_CODE)" # any new row matching this regex is a failure
```

---

## 14. Report Output

**File:** `src/reports/report.service.ts`
**Output:** `reports/{jobId}/Validation_Report.xlsx`

Single Excel file, 4 sheets.

### Sheet 1 — Summary

| Column | Description |
|--------|-------------|
| Rule | `table_name` label |
| Source Table | DB source table from `common.yaml` |
| Target Table | DB target table from `common.yaml` |
| Rows Checked | Total source rows processed |
| Pass (rows) | Source rows in groups where all checks passed |
| Fail (rows) | Source rows in groups where at least one check failed |
| Skipped | `Rows Checked - Pass - Fail`. Should always be 0. >0 = engine bug |
| Total Errors | Total error records generated |
| Missing | ROW_MISSING + COLUMN_MISSING + DATA_MISSING count |
| Time (sec) | Wall-clock time for this table |
| Status | **PASS** (green) or **FAIL** (red). FAIL if `fail > 0 OR missing > 0 OR skipped > 0` |
| Remarks | Messages from COLUMN_MISSING / DATA_MISSING / TRANSFORM_ERROR errors |

### Sheet 2 — Value_Mismatch
All `VALUE_MISMATCH` errors: which column, old value, new value, group key.

### Sheet 3 — Row_Missing
All `ROW_MISSING` errors: group key and message (missing from source, extra in target, or fingerprint diff).

### Sheet 4 — Def_Violation
All `DEFECT_VIOLATION` errors from def rule checks.

**Download:** `GET /validation/download/:jobId` — no query params needed, serves `Validation_Report.xlsx` automatically.

---

## 15. Job Management

**File:** `src/job/job.service.ts`, `src/job/job.types.ts`

Jobs are persisted to `reports/jobs.json` after every state change. They survive pod restarts as long as the `reports/` directory persists. In k8s with `emptyDir`, jobs are lost on pod restart — a PVC is required for full persistence.

### Job states

```
PENDING → RUNNING → DONE
                  → FAILED
```

### GET /validation/status/:jobId response

```json
{
  "jobId": "abc123",
  "label": "NPA_RIGHTS",
  "status": "DONE",
  "totalTables": 1,
  "doneTables": 1,
  "reportPaths": ["./reports/abc123/Validation_Report.xlsx"],
  "summary": [
    {
      "tableName": "conv$vinpahistory",
      "rowsChecked": 2776891,
      "pass": 2776891,
      "fail": 0,
      "skipped": 0,
      "totalErrors": 0,
      "status": "PASS",
      "timeSpentSec": 312.4
    }
  ]
}
```

---

## 16. Adding a New Rule

### Step 1 — Create the rule folder

```
rules/{module}_{category}/{case_name}/
└── common.yaml
```

### Step 2 — Write common.yaml

Minimum:
```yaml
table_info:
  source: "conv$sourceTable"
  target: "new$targetTable"
  table_type: TRANSACTION

anchor_key:
  old: id
  new: id

transaction_grouping:
  keys:
    old: systemreferencenumber
    new: systemreferenceno

schema_mappings:
  exact_matches:
    - { old: accountno, new: accountno }
```

See [Section 6](#6-strategy-selection) to pick `table_type` and [Section 11](#11-group-comparison--validategroup-in-detail) for all mapping types.

### Step 3 — Add to a preset

```yaml
# presets/{module}/{category}.yaml
cases:
  - name: mynewcase
    rule_path: rights_npa/mynewcase
    tables:
      - "conv$sourceTable"
```

### Step 4 — Test

```
POST /validation/run/preset/npa/rights
{ "case_name": "mynewcase" }
```

Poll `GET /validation/status/:jobId` → download `GET /validation/download/:jobId`.

---

## Error Types Reference

| Error Type | Meaning |
|------------|---------|
| `VALUE_MISMATCH` | A mapped column or aggregate differs between old and new |
| `ROW_MISSING` | A row/group exists in old but not in new (or vice versa) |
| `COLUMN_MISSING` | A column referenced in common.yaml doesn't exist in the DB |
| `DATA_MISSING` | Rule file not found, table has no data, or unmapped columns found |
| `DEFECT_VIOLATION` | A def rule condition failed |
| `TRANSFORM_ERROR` | Runtime exception — anchor key duplicate, expression parse error, etc. |
