# VIDAR — Data Validation Service

Post-migration data validation engine for BAM NCS system.
Compares legacy source data (`ncs-conv-aging`) against migrated target data (`ncs-npl-aging`) to confirm correctness of the ETL migration.

**Live (SIT):** `http://vidar-ncs-sit.arctic.bamdns.local`
**Swagger UI:** `http://vidar-ncs-sit.arctic.bamdns.local/api`
**GitLab:** `http://172.18.1.92` → `bam-ncs-automation/vidar`

---

## Architecture

```
API Request
     │
     ▼
ValidationController
     │  (preset or manual)
     ▼
ValidationService.startJob()
     │  fires background job, returns jobId immediately
     │
     ├─ loads rules from rules/{rule_path}/common.yaml + def/*.yaml
     │
     ▼
StrategyFactory → picks strategy by table_type in common.yaml
     │
     ├─ MasterStrategy      MASTER type — 1:1 row-by-row comparison
     │                       streams old rows by id, matches to new by id
     │
     ├─ TransactionStrategy  TRANSACTION type — group by systemreferenceno
     │    └─ validateSysrefSort     use_sysref_sort: true
     │         Creates ##dv_src temp table with clustered index on (sysref, id)
     │         Eliminates full-sort per chunk on scattered 15M-row tables
     │    └─ validateCompositeKey   composite sysref+accountno key
     │         Creates ##dv_ck temp table for fast index seeks
     │
     ├─ MultipleStrategy     MULTIPLE type — N old sources → 1 new target
     │    Merges multiple source tables; supports use_sysref_sort
     │
     └─ UnionStrategy        UNION type — non-overlapping source split
          Each old source maps to a disjoint subset of the new target
               │
               ▼
          BaseStrategy (shared by all)
            ├─ validateGroup()      column-level comparisons per group
            ├─ runDefRules()        business rule checks from def/*.yaml
            ├─ evaluateExpression() SUM/COUNT/filtered expressions
            └─ concat_matches       string set comparison per group
               │
               ▼
          runAggregateSumCheck()   independent SUM(amount) by affectcode
          ReportService            writes CSV + JSON reports
          JobService               tracks PENDING → RUNNING → DONE/FAILED
```

---

## Setup

```bash
npm install
```

### Environment Variables

| Variable | Description | Example |
|---|---|---|
| `DB_HOST` | SQL Server hostname/IP | `172.18.1.153` |
| `DB_PORT` | SQL Server port | `1433` |
| `DB_USER` | SQL login | `sa` |
| `DB_PASSWORD` | SQL password | |
| `DB_NAME` | Default database (connection context) | `ncs-npl-aging` |
| `DB_ENCRYPT` | TLS encrypt flag | `false` for local SQL Server |
| `CHUNK_SIZE` | Rows per fetch chunk (default `5000`) | `10000` |
| `PRESETS_DIR` | Path to presets directory (default `./presets`) | `./presets` |

---

## Running

```bash
# development (hot reload)
npm run start:dev

# production build
npm run build && npm run start:prod
```

Service starts at `http://localhost:3000` (or `$PORT`).
Swagger UI at `http://localhost:3000/api`.

---

## How to Run Validations

### Step 1 — Open Swagger UI

Go to `http://vidar-ncs-sit.arctic.bamdns.local/api`

---

### Step 2 — Pick scope and fire a run

**Run everything (all modules, all tables)**
```
POST /validation/run/all
```
```json
{
  "job_name": "FULL_RUN"
}
```

**Run all tables in one module**
```
POST /validation/run/preset/{module}
```
Valid modules: `npa`, `npl`, `invest`

```
POST /validation/run/preset/npa
```
```json
{
  "job_name": "NPA_RUN"
}
```

**Run one category inside a module**
```
POST /validation/run/preset/{module}/{category}
```
```
POST /validation/run/preset/npa/rights
```
```json
{
  "job_name": "NPA_RIGHTS",
  "case_name": "lahistloantransactionhistory",
  "sources": ["conv$vinpahistory"],
  "def_list": ["def001"]
}
```
All body fields are optional. Omit `case_name` / `sources` / `def_list` to run the full category.

**Manual run (specify tables directly)**
```
POST /validation/run
```
```json
{
  "job_name": "Manual_Test",
  "tables": [
    {
      "table_name": "conv$vinpahistory",
      "rule_path": "rights_npa/lahistloantransactionhistory",
      "def_list": ["def001"]
    }
  ]
}
```

---

### Step 3 — Get a Job ID

Every run endpoint returns immediately with:
```json
{
  "jobId": "abc123",
  "queued": 5,
  "tables": ["conv$vinpahistory", "..."],
  "message": "Queued 5 table(s). Use GET /validation/status/abc123 to track progress."
}
```
Copy the `jobId`.

---

### Step 4 — Poll for progress

```
GET /validation/status/{jobId}
```
```json
{
  "jobId": "abc123",
  "label": "NPA_RUN",
  "status": "RUNNING",
  "totalTables": 5,
  "doneTables": 2,
  "createdAt": "...",
  "startedAt": "..."
}
```
Status lifecycle: `PENDING` → `RUNNING` → `DONE` or `FAILED`

Keep polling until `"status": "DONE"`.

---

### Step 5 — Get report paths

```
GET /validation/report/{jobId}
```
```json
{
  "reportPaths": [
    "reports/abc123/lahistloantransactionhistory.csv",
    "reports/abc123/summary.json"
  ],
  "message": "Reports ready"
}
```

---

### Step 6 — Discover what's available

```
GET /validation/presets
```
Lists every module → category → case → source tables. Use this to find valid values for `case_name` and `sources` filters.

---

### Quick Reference

| Goal | Endpoint |
|---|---|
| Run everything | `POST /validation/run/all` |
| Run all NPA | `POST /validation/run/preset/npa` |
| Run all NPL | `POST /validation/run/preset/npl` |
| Run all invest (LV) | `POST /validation/run/preset/invest` |
| Run NPA rights only | `POST /validation/run/preset/npa/rights` |
| Run NPA eir only | `POST /validation/run/preset/npa/eir` |
| Run NPL rights only | `POST /validation/run/preset/npl/rights` |
| Manual run | `POST /validation/run` |
| Check job status | `GET /validation/status/{jobId}` |
| Get report paths | `GET /validation/report/{jobId}` |
| See all available presets | `GET /validation/presets` |

> **Note:** cit, sbt, tax categories exist as placeholders — rules not yet written. Running them returns 404.

---

## Error Types in Reports

| Error Type | Meaning |
|---|---|
| `VALUE_MISMATCH` | Column value in old ≠ new (after transformation) |
| `ROW_MISSING` | A sysref group exists in old but is absent in new |
| `COLUMN_MISSING` | Mapped column not found in result set |
| `DATA_MISSING` | No rule directory or common.yaml found for this table |
| `DEFECT_VIOLATION` | A def rule condition was triggered |
| `TRANSFORM_ERROR` | Runtime exception during strategy execution |

Reports also include `[AGGREGATE]` VALUE_MISMATCH entries from the independent SUM-by-affectcode cross-check.

---

## Project Structure

```
src/
  validation/
    validation.controller.ts   API routes
    validation.service.ts      job runner, aggregate SUM check
    preset.service.ts          preset YAML loader + table resolver
  strategies/
    base.strategy.ts           shared column comparison logic
    master.strategy.ts         MASTER table type
    transaction.strategy.ts    TRANSACTION type (sysref-sort + composite key)
    other.strategies.ts        MULTIPLE + UNION types
    strategy.factory.ts        picks strategy by table_type
    transform.utils.ts         DATE_TO_DATETIME, STRIP_LEADING_ZEROS, etc.
    worker-pool.service.ts     worker thread pool
    compare.worker.ts          worker thread entry point
  database/
    database.service.ts        mssql pool, fetchChunk, createSourceCache,
                               createTargetCache, querySumByGroup, etc.
  rules/
    rule-loader.service.ts     loads common.yaml + def/*.yaml
    rule.types.ts              TypeScript interfaces for rule schema
  job/
    job.service.ts             in-memory job registry
    job.types.ts               JobRecord, JobStatus
  reports/
    report.service.ts          CSV + JSON report writer
  dto/
    validation-request.dto.ts  request body shape

rules/                         validation rule YAML files
  global/                      affect codes, shared lookups
  rights_npa/                  NPA loan transaction history rules
  rights_npl/                  NPL loan transaction history rules
  eir_npa/                     NPA EIR investment history rules
  invest_lv/                   LV investment table rules
  README.md                    full rule authoring guide

presets/                       preset YAML files (groups cases for API)
  npa/
    rights.yaml
    eir.yaml
    cit.yaml  (placeholder)
    sbt.yaml  (placeholder)
    tax.yaml  (placeholder)
  npl/
    rights.yaml
    eir.yaml  (placeholder)
    cit.yaml  (placeholder)
    sbt.yaml  (placeholder)
    tax.yaml  (placeholder)
  invest/
    lv.yaml
```

---

## Rules

All validation logic lives in `rules/`. See **[rules/README.md](rules/README.md)** for the full authoring guide covering:
- `common.yaml` schema (table_info, anchor_key, transaction_grouping, schema_mappings)
- All mapping types: exact_matches, transformed_matches, concat_matches, filtered_sum_matches, formula_matches
- `def/*.yaml` business rule expressions
- How to add a new rule end-to-end

---

## Git / Deployment Workflow

```
develop  ← all active development — commit here only
sit      ← staging — merge from develop, then push
main     ← production — managed by infra team
```

**Correct order — always:**
```bash
git checkout develop
# ... make changes, commit ...

git checkout sit
git merge develop
git push origin sit
```

Never commit directly to `sit`. Never push directly to `main`.

CI/CD is the infra team's Jenkins pipeline. Kubernetes deployment is managed by infra — we deliver the image only.
