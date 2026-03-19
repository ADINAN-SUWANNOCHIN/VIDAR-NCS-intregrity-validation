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
7. [Strategies — Detailed](#7-strategies--detailed)
8. [Mapping Types](#8-mapping-types)
9. [Def Rules — Business Logic](#9-def-rules--business-logic)
10. [Report Output](#10-report-output)
11. [Job Management](#11-job-management)
12. [Database Layer](#12-database-layer)
13. [Adding a New Rule](#13-adding-a-new-rule)

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
│   │   ├── validation.controller.ts  # HTTP endpoints — POST /validation/run, GET /validation/status, etc.
│   │   ├── validation.service.ts     # Core job runner — loads rules, picks strategy, runs comparison
│   │   └── preset.service.ts         # Reads preset YAMLs → resolves table+rule_path pairs
│   │
│   ├── job/
│   │   ├── job.service.ts            # Job state machine — create/start/complete/fail + persist to disk
│   │   └── job.types.ts             # TypeScript types: JobRecord, JobStatus, TableSummary
│   │
│   ├── rules/
│   │   ├── rule-loader.service.ts    # Reads common.yaml and def/*.yaml from disk, caches them
│   │   └── rule.types.ts            # TypeScript types for all rule structures (CommonRule, DefRule, etc.)
│   │
│   ├── strategies/
│   │   ├── strategy.factory.ts       # Maps table_type → Strategy class
│   │   ├── base.strategy.ts          # Shared utilities: schema check, noisy column detection, fingerprint
│   │   ├── transaction.strategy.ts   # TRANSACTION type: group-based comparison (main strategy)
│   │   ├── master.strategy.ts        # MASTER type: row-by-row via worker threads
│   │   ├── other.strategies.ts       # SPLIT, HEADER, UNION, MULTIPLE strategies
│   │   ├── compare.worker.ts         # Worker thread code for MASTER row comparison
│   │   ├── worker-pool.service.ts    # Thread pool manager for MASTER strategy
│   │   └── transform.utils.ts        # Value transformation functions (strip zeros, date convert, etc.)
│   │
│   ├── reports/
│   │   └── report.service.ts         # Writes Validation_Report.xlsx (4 sheets)
│   │
│   ├── database/
│   │   └── database.service.ts       # All SQL Server queries: fetchChunk, streamRowsByKeys, etc.
│   │
│   ├── dto/
│   │   └── validation-request.dto.ts # Shape of POST /validation/run request body
│   │
│   └── schema/                       # Schema discovery tools (separate feature — not part of validation flow)
│       ├── schema.controller.ts
│       ├── schema.service.ts
│       ├── column-matcher.ts
│       ├── yaml-generator.ts
│       └── excel-report.ts
│
├── rules/                            # Rule files — one folder per validation case
│   ├── global/
│   │   ├── affect_codes.json         # Master list of all valid affect codes
│   │   └── defs/                     # Global def rules (apply to all tables unless overridden)
│   ├── rights_npa/
│   │   ├── lahistloantransactionhistory/
│   │   │   ├── common.yaml           # Column mappings and comparison config for this case
│   │   │   └── def/                  # Table-specific def rules (optional)
│   │   │       └── def001.yaml
│   │   └── lahisthloantransactionhistoryh/
│   │       └── common.yaml
│   ├── rights_npl/
│   ├── eir_npa/
│   └── invest_lv/
│
├── presets/                          # Preset configs — groups tables into runnable cases
│   ├── npa/
│   │   ├── rights.yaml               # NPA rights module: lists cases + source tables
│   │   └── eir.yaml
│   ├── npl/
│   │   └── rights.yaml
│   └── invest/
│       └── lv.yaml
│
├── kubernetes/
│   └── sit/
│       ├── deploy-sit.yaml           # K8s Deployment (image, resources, env)
│       ├── service-sit.yaml          # K8s Service
│       └── ingress-sit.yaml          # K8s Ingress
│
├── Dockerfile                        # Multi-stage build: compile TS → lean production image
├── ENGINE.md                         # This file
└── README.md                         # Quick start guide
```

---

## 2. How It Works — Big Picture

```
HTTP Request
     │
     ▼
ValidationController          src/validation/validation.controller.ts
  POST /validation/run
  POST /validation/run/preset/:module/:category
     │
     ▼
PresetService (optional)      src/validation/preset.service.ts
  reads presets/*.yaml
  resolves → list of { table_name, rule_path }
     │
     ▼
ValidationService             src/validation/validation.service.ts
  creates Job (returns jobId immediately)
  runs comparison in background:
     │
     ├─► RuleLoaderService    src/rules/rule-loader.service.ts
     │     reads rules/{rule_path}/common.yaml
     │     reads rules/{rule_path}/def/*.yaml
     │
     ├─► StrategyFactory      src/strategies/strategy.factory.ts
     │     picks strategy from table_type in common.yaml
     │
     ├─► Strategy.validate()  src/strategies/*.strategy.ts
     │     queries SQL Server (old + new tables)
     │     compares data, returns errors[]
     │
     ├─► AggregateSumCheck    (inside validation.service.ts)
     │     independently checks SUM(amount) per affectcode
     │
     └─► ReportService        src/reports/report.service.ts
           writes reports/{jobId}/Validation_Report.xlsx

GET /validation/status/:jobId  → poll progress
GET /validation/download/:jobId → download Excel report
```

**Key design decision: fire-and-forget jobs.**
The POST endpoint returns a `jobId` immediately (HTTP 202). Validation runs in the background. You poll `GET /status/:jobId` to check progress. This avoids HTTP timeout issues for large tables that take minutes to validate.

---

## 3. API Endpoints

All endpoints are defined in `src/validation/validation.controller.ts`.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/validation/run` | Manual run — supply tables + rule_paths directly in body |
| `POST` | `/validation/run/all` | Run every preset in one shot |
| `POST` | `/validation/run/preset/:module` | Run all categories for one module (e.g. `npa`) |
| `POST` | `/validation/run/preset/:module/:category` | Run one category, optionally filtered by case_name |
| `GET`  | `/validation/jobs` | List all jobs (most recent first) |
| `GET`  | `/validation/status/:jobId` | Get job status + inline summary when DONE |
| `GET`  | `/validation/download/:jobId` | Download `Validation_Report.xlsx` (no extra params needed) |
| `GET`  | `/validation/presets` | List all available presets, cases, and source tables |

**Swagger UI** is available at `/api` (auto-generated from decorators in `src/main.ts`).

### Example: run a specific case

```
POST /validation/run/preset/npa/rights
{
  "case_name": "lahistloantransactionhistory"
}
```

### Example: manual run

```
POST /validation/run
{
  "job_name": "My_Test",
  "tables": [
    {
      "table_name": "conv$vinpahistory",
      "rule_path": "rights_npa/lahistloantransactionhistory"
    }
  ]
}
```

---

## 4. Preset System

**Files:** `presets/{module}/{category}.yaml`
**Code:** `src/validation/preset.service.ts`

Presets are a convenience layer. Instead of remembering which source table maps to which rule_path, you use `POST /validation/run/preset/npa/rights` and the engine figures out the rest.

### Preset YAML structure

```yaml
# presets/npa/rights.yaml
name: Rights NPA
module: npa

cases:
  - name: lahistloantransactionhistory        # used as case_name filter in API
    rule_path: rights_npa/lahistloantransactionhistory   # points to rules/ folder
    tables:
      - "conv$vinpahistory"                   # source table(s) to validate

  - name: lahisthloantransactionhistoryh
    rule_path: rights_npa/lahisthloantransactionhistoryh
    tables:
      - "conv$vinpahistory"
```

### Module/Category naming

| Module | Category | Preset file |
|--------|----------|-------------|
| `npa`  | `rights` | `presets/npa/rights.yaml` |
| `npa`  | `eir`    | `presets/npa/eir.yaml` |
| `npl`  | `rights` | `presets/npl/rights.yaml` |
| `invest` | `lv`   | `presets/invest/lv.yaml` |

Use `GET /validation/presets` to see all loaded presets and their valid `case_name` values.

---

## 5. Rule Files

**Location:** `rules/{module_category}/{case_name}/`
**Loader:** `src/rules/rule-loader.service.ts`
**Types:** `src/rules/rule.types.ts`

Each validation case has its own folder containing:

```
rules/rights_npa/lahistloantransactionhistory/
├── common.yaml          # Required — column mappings + comparison config
└── def/                 # Optional — business rule checks
    └── def001.yaml
```

### common.yaml structure

```yaml
table_info:
  source: "conv$vinpahistory"        # Legacy DB table (old)
  target: "la$lahistloantransactionhistory"  # New Core DB table (new)
  table_type: MULTIPLE               # Controls which strategy is used
  source_filter: "successlv2 = 1"   # Optional SQL WHERE on source (filters rows before comparison)

anchor_key:
  old: id                            # Column used for keyset pagination on old table
  new: id                            # Column used for keyset pagination on new table

transaction_grouping:                # Required for TRANSACTION/MULTIPLE/HEADER strategies
  keys:
    old: systemreferencenumber       # Group rows by this column on old table
    new: systemreferenceno           # Corresponding column on new table

schema_mappings:
  exact_matches:
    - old: newaccountno
      new: accountno
  transformed_matches:
    - old: transactiondate
      new: transactiondate
      transform_rule: DATE_TO_DATETIME
  filtered_sum_matches:
    - old: transactionamount
      old_filter:
        affectcode_in: ["PP"]
        debitcredit: "C"
      new: lvcreditprincipleamount

defaults:
  tolerance: 0.01                    # Numeric comparison tolerance
```

### Where rule files come from

The `RULES_DIR` environment variable controls the root directory (default: `./rules`).
Path resolution: `{RULES_DIR}/{rule_path}/common.yaml`

For example, `rule_path: "rights_npa/lahistloantransactionhistory"` → reads from `rules/rights_npa/lahistloantransactionhistory/common.yaml`.

### Global affect codes

`rules/global/affect_codes.json` — master list of affect codes used by the aggregate SUM check.
Loaded once at job start. Example entry: `{ "code": "PP", "description": "Principal Payment" }`.

---

## 6. Strategy Selection

**File:** `src/strategies/strategy.factory.ts`

The `table_type` field in `common.yaml` determines which strategy runs. Each strategy handles a different relationship between old and new tables.

| `table_type` | Strategy class | Use case |
|-------------|----------------|----------|
| `TRANSACTION` | `TransactionStrategy` | Default. 1-to-1 or N-to-1 old→new. Group by sysref, compare sums |
| `MASTER` | `MasterStrategy` | Row-by-row key comparison via worker threads. No grouping |
| `MULTIPLE` | `MultipleStrategy` | Multiple old sources merge into one new table |
| `UNION` | `UnionStrategy` | Old table splits into multiple non-overlapping new tables |
| `SPLIT` | `SplitStrategy` | One old column splits into multiple new columns |
| `HEADER` | `HeaderStrategy` | Long→Wide pivot: old has many rows per account, new has one row with pivoted columns |
| `ASSOCIATE` | _(uses MasterStrategy)_ | Same as MASTER (key-only comparison) |

---

## 7. Strategies — Detailed

### TransactionStrategy
**File:** `src/strategies/transaction.strategy.ts`

The most common strategy. Used when multiple old rows per sysref (group key) map to multiple new rows per sysref, and you validate by comparing aggregates (SUM, distinct values) per group.

**How it works:**
1. Streams old table in chunks ordered by anchor key (id)
2. For each chunk, groups rows by `transaction_grouping.keys.old`
3. Fetches corresponding new rows by sysref
4. Compares each old group vs new group:
   - `exact_matches` → distinct value sets must match
   - `filtered_sum_matches` → SUM(old filtered rows) must equal new column value
   - `formula_matches` → arithmetic expression on old columns vs new column
5. Any group with a mismatch → `failCount += oldGroup.length`; clean group → `passCount += oldGroup.length`

**Modes (set in common.yaml under `transaction_grouping`):**

| Mode | Flag | When to use |
|------|------|-------------|
| Default (anchor-key streaming) | _(none)_ | Group rows are contiguous in id order |
| Sysref-sort | `use_sysref_sort: true` | Group rows are scattered in id order — sort by sysref instead |
| Group-pagination | `use_group_pagination: true` | Similar to sysref-sort but uses DISTINCT key fetch. Use only if sysref column has an index |
| Composite key | `composite_key: {...}` | One sysref covers many accounts — need (sysref + accountno) as combined key |

**Scattered groups problem:**
If rows for the same sysref are spread across the whole table (not contiguous by id), the default chunk boundary can split a group. Use `use_sysref_sort: true` to fix this — it sorts old rows by sysref before chunking so all rows for the same sysref are always together.

**Row fingerprint (post-mismatch detail):**
Set `row_fingerprint` in `transaction_grouping` to get row-level diff on any group that fails. Without it, you only know "group X has a sum mismatch". With it, you know which exact transaction row is missing.

```yaml
transaction_grouping:
  keys: { old: systemreferencenumber, new: systemreferenceno }
  row_fingerprint:
    - { old: transactiondate, new: transactiondate }
    - { old: transactionamount, new: transactionamount }
```

---

### MasterStrategy
**File:** `src/strategies/master.strategy.ts`

Used for MASTER tables — large reference tables where each old row should have exactly one matching new row by key.

**How it works:**
1. Schema check — verifies all mapped columns exist in both tables
2. Anchor key uniqueness check — duplicate keys break pagination
3. Row count check — source vs target counts must match
4. Noisy column detection — identifies NULL/ZERO/BOOLEAN columns (treated differently)
5. Streams old table in chunks, fetches matching new rows by key batch, runs comparison in **worker threads** (parallel CPU work via `src/strategies/worker-pool.service.ts`)
6. Reverse scan — paginates new table to find rows that exist in new but not in old (extra rows)

**Worker threads:**
Row comparison logic lives in `src/strategies/compare.worker.ts`. The `WorkerPoolService` (`src/strategies/worker-pool.service.ts`) manages a pool of Node.js worker threads so multiple chunks can be compared in parallel.

---

### MultipleStrategy
**File:** `src/strategies/other.strategies.ts` — class `MultipleStrategy`

Used when N old source tables merge into 1 new target table. Example: 3 old tables (`conv$vinpahistory`, `conv$vinpalrentalhistory`, `conv$vinpalrtrespasserhist`) all feed rows into one new table (`la$lahistloantransactionhistory`).

**Key requirement:** Group keys (sysref) must be mutually exclusive across sources — each sysref appears in exactly one old table.

**How it works:**
1. Loads all source tables defined in `table_info.source` (comma-separated)
2. For each source, streams and groups by sysref
3. Fetches matching new rows by sysref
4. Compares each old group vs new group using the same logic as TransactionStrategy

---

### HeaderStrategy
**File:** `src/strategies/other.strategies.ts` — class `HeaderStrategy`

Used for **Long→Wide pivot** tables. Old table has multiple rows per account (one per `pivot_key` value). New table has one row per account with each `pivot_key` value as its own column.

```
OLD TABLE (long format):          NEW TABLE (wide format):
account | header_type | value     account | type_A | type_B | type_C
A001    | A           | 100   →   A001    | 100    | 200    | 300
A001    | B           | 200
A001    | C           | 300
```

Config in `common.yaml`:
```yaml
pivot_config:
  identity_key: { old: accountno, new: accountno }
  pivot_key: header_type

schema_mappings:
  pivot_matches:
    - pivot_key_value: "A"
      value_col: value
      new_col: type_A
```

---

### UnionStrategy
**File:** `src/strategies/other.strategies.ts` — class `UnionStrategy`

Used when one old table splits into multiple non-overlapping new tables. Validates each segment of the old table against its corresponding new target.

---

### SplitStrategy
**File:** `src/strategies/other.strategies.ts` — class `SplitStrategy`

Used when one old column splits into multiple new columns (typically name splits, etc.).

---

## 8. Mapping Types

**Types defined in:** `src/rules/rule.types.ts`
**Used in:** `schema_mappings` section of `common.yaml`

### exact_matches
Old column value should equal new column value (as distinct value sets within a group).

```yaml
exact_matches:
  - old: accountno
    new: accountno
  - old: transactiondate
    new: transactiondate
    transform_rule: DATE_TO_DATETIME   # optional — transform before comparing
```

> **Note:** Comparison is by distinct value set, not SUM. If old has 1 row with `accountno=A001` and new has 3 rows all with `accountno=A001`, this passes correctly (`{A001} == {A001}`).

### transformed_matches
Same as exact_match but a transform is always applied.

```yaml
transformed_matches:
  - old: receiptno
    new: receiptno
    transform_rule: STRIP_LEADING_ZEROS
```

Available `transform_rule` values (defined in `src/strategies/transform.utils.ts`):

| Rule | What it does |
|------|-------------|
| `NONE` | No transform |
| `STRIP_LEADING_ZEROS` | Remove leading zeros from string |
| `STRIP_SPECIAL_CHARS` | Remove non-alphanumeric characters |
| `DATE_TO_DATETIME` | Compare only the date part (strip time) |
| `CONCAT` | Concatenate multiple values |
| `SPLIT_FIRST` | Take first part of a delimited string |
| `SPLIT_SECOND` | Take second part of a delimited string |

### filtered_sum_matches
Sum old column values filtered by conditions, compare to new column.

```yaml
filtered_sum_matches:
  - old: transactionamount
    old_filter:
      affectcode_in: ["PP", "SP"]    # only rows where affectcode IN (PP, SP)
      debitcredit: "C"               # only credit rows
      loantranshostcode_not_in: ["24100", "26100"]  # exclude consolidate transactions
    new: lvcreditprincipleamount
```

Used for `invest_lv` tables where new columns are derived aggregates.

### formula_matches
Arithmetic formula across multiple old columns → one new column.

```yaml
formula_matches:
  - old_cols: [creditprincipleamount, debitprincipleamount]
    formula: SUBTRACT      # old_cols[0] - old_cols[1] - ...
    new: billprinciple
```

`formula` values: `SUM`, `SUBTRACT`, `EXACT`

### concat_matches
Concatenate multiple old columns → one new column.

```yaml
concat_matches:
  - old_cols: [first_name, last_name]
    new: full_name
    separator: " "
```

### split_matches
One old column → multiple new columns with a formula.

```yaml
split_matches:
  - old: totalamount
    new_cols: [debitamount, creditamount]
    formula: SUM    # validates SUM(new_cols) == old
```

### pivot_matches
HEADER strategy only — maps pivot key values to new column names.

```yaml
pivot_matches:
  - pivot_key_value: "INT"
    value_col: amount
    new_col: interestamount
```

---

## 9. Def Rules — Business Logic

**Files:** `rules/{rule_path}/def/*.yaml` and `rules/global/defs/*.yaml`
**Loader:** `src/rules/rule-loader.service.ts` — `loadDefRules()`
**Evaluator:** `src/strategies/base.strategy.ts` — `runDefRules()`

Def rules encode business logic that can't be expressed as column mappings. They check conditions on data within a transaction group.

Table-specific defs take priority over global defs. If both have `def001`, the table-specific version is used.

### def.yaml structure

```yaml
def_id: def001
target_scope: transaction_group      # applies to all rows in the group together

trigger_condition:
  must_have_any: ["PP", "A1"]        # only run this def if group contains these affect codes

actions:
  - step: "1"
    check_type: SUM_MATCH
    variables:
      debit_sum: "SUM(debitamount WHERE affectcode=PP)"
      credit_sum: "SUM(creditamount WHERE affectcode=PP)"
    condition: "debit_sum == credit_sum"
    error_message: "PP debit/credit sum mismatch in group {group_key}"
```

To run only specific defs, pass `def_list` in the request body:
```json
{ "def_list": ["def001", "def002"] }
```

Omit `def_list` to run all defs for that table.

---

## 10. Report Output

**File:** `src/reports/report.service.ts`
**Output:** `reports/{jobId}/Validation_Report.xlsx`

A single Excel file with 4 sheets is written after every job completes.

### Sheet 1 — Summary

One row per validated table. Columns:

| Column | Description |
|--------|-------------|
| Rule | The `table_name` (label for this case) |
| Source Table | Actual DB source table from `common.yaml` |
| Target Table | Actual DB target table from `common.yaml` |
| Rows Checked | Total source rows processed by the engine |
| Pass (rows) | Source rows in groups where ALL checks passed |
| Fail (rows) | Source rows in groups where at least one check failed |
| Skipped | `Rows Checked - Pass - Fail`. Should always be 0. >0 means an engine bug |
| Total Errors | Total number of error records generated |
| Missing | Count of ROW_MISSING + COLUMN_MISSING + DATA_MISSING errors |
| Time (sec) | How long this table took |
| Status | **PASS** (green) or **FAIL** (red). FAIL if `fail > 0 OR missing > 0 OR skipped > 0` |
| Remarks | Messages from COLUMN_MISSING / DATA_MISSING / TRANSFORM_ERROR errors |

### Sheet 2 — Value_Mismatch

All `VALUE_MISMATCH` errors. Shows old column, new column, old value, new value, group key.

### Sheet 3 — Row_Missing

All `ROW_MISSING` errors. Shows group key and message (e.g. "row with key X found in target but not in source").

### Sheet 4 — Def_Violation

All `DEFECT_VIOLATION` errors from def rule checks.

### Download

```
GET /validation/download/:jobId
```

No query parameters needed. Automatically serves `Validation_Report.xlsx`.

---

## 11. Job Management

**Files:** `src/job/job.service.ts`, `src/job/job.types.ts`

Jobs survive server restarts — they are persisted to `jobs.json` on disk after every state change.

### Job states

```
PENDING → RUNNING → DONE
                  → FAILED
```

### Job record (GET /validation/status/:jobId response)

```json
{
  "jobId": "abc123",
  "label": "NPA_RIGHTS",
  "status": "DONE",
  "createdAt": "2026-03-19T10:00:00Z",
  "startedAt": "2026-03-19T10:00:01Z",
  "finishedAt": "2026-03-19T10:05:23Z",
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

## 12. Database Layer

**File:** `src/database/database.service.ts`

Handles all SQL Server connections and queries. Both databases (Legacy and New Core) are accessed through this single service.

### Key methods

| Method | What it does |
|--------|-------------|
| `fetchChunk(table, keyCol, size, lastKey)` | Keyset-paginate old table — returns next N rows after `lastKey` |
| `fetchChunkKeys(table, keyCol, size, lastKey)` | Same but SELECT key column only — used by MASTER reverse scan |
| `streamRowsByKeys(table, keyCol, keys, callback)` | Fetch new rows by a list of sysref keys using OPENJSON batching |
| `query(sql, params)` | General parameterized query |
| `querySumByGroup(table, amountCol, groupCol)` | SELECT groupCol, SUM(amountCol) GROUP BY groupCol |

### Connection config

Set via environment variables (see `secret.template.yaml`):
- `DB_OLD_SERVER`, `DB_OLD_DATABASE`, `DB_OLD_USER`, `DB_OLD_PASSWORD` — Legacy DB
- `DB_NEW_SERVER`, `DB_NEW_DATABASE`, `DB_NEW_USER`, `DB_NEW_PASSWORD` — New Core DB

### Chunk size

Controlled by `CHUNK_SIZE` environment variable (default: `5000`). How many rows are fetched per DB round-trip.

---

## 13. Adding a New Rule

To validate a new pair of tables, you need to:

### Step 1 — Create the rule folder

```
rules/{module}_{category}/{case_name}/
└── common.yaml
```

Example: `rules/rights_npa/lahistnewcase/common.yaml`

### Step 2 — Write common.yaml

Minimum required fields:

```yaml
table_info:
  source: "conv$sourceTable"
  target: "la$targetTable"
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
    - old: accountno
      new: accountno
```

Refer to [Section 8](#8-mapping-types) for all mapping types and [Section 6](#6-strategy-selection) to pick the right `table_type`.

### Step 3 — Add to a preset (optional but recommended)

Add a new case entry to the appropriate `presets/{module}/{category}.yaml`:

```yaml
cases:
  - name: lahistnewcase
    rule_path: rights_npa/lahistnewcase
    tables:
      - "conv$sourceTable"
```

### Step 4 — Test

```
POST /validation/run/preset/npa/rights
{ "case_name": "lahistnewcase" }
```

Or manually:

```
POST /validation/run
{
  "job_name": "Test_NewCase",
  "tables": [
    {
      "table_name": "conv$sourceTable",
      "rule_path": "rights_npa/lahistnewcase"
    }
  ]
}
```

Poll `GET /validation/status/:jobId` until status is `DONE`, then download `GET /validation/download/:jobId`.

---

## Error Types Reference

| Error Type | Meaning |
|------------|---------|
| `VALUE_MISMATCH` | A mapped column or aggregate has a different value between old and new |
| `ROW_MISSING` | A row/group exists in old but not in new (or vice versa) |
| `COLUMN_MISSING` | A column referenced in common.yaml doesn't exist in the DB table |
| `DATA_MISSING` | Rule file not found, or table has no data |
| `DEFECT_VIOLATION` | A def rule condition failed |
| `TRANSFORM_ERROR` | Runtime exception during validation (strategy or rule error) |
