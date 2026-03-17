# VIDAR — Data Validation Service

Post-migration data validation engine for BAM NCS system.
Compares legacy data (`ncs-conv-aging`) against migrated data (`ncs-npl-aging`) to confirm correctness of the migration.

---

## Architecture

```
API Request (preset or single rule)
        │
        ▼
ValidationService
        │  loads rules from rules/{module}/{case}/
        │
        ├─► MasterStrategy      — 1:1 row-by-row comparison (MASTER table type)
        ├─► TransactionStrategy — group-by sysref comparison (TRANSACTION type)
        │     └─► validateCompositeKey  — composite (sysref+accountno) group key
        ├─► MultipleStrategy    — N old sources → 1 new target (MULTIPLE type)
        └─► UnionStrategy       — non-overlapping source split (UNION type)
                │
                ▼
        BaseStrategy (shared)
          ├─ runDefRules()       — per-group business rule checks (def/*.yaml)
          ├─ evaluateExpression()— SUM/COUNT/filtered expressions
          └─ validateGroup()     — column-level comparisons
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
| `DB_PASSWORD` | SQL password | `...` |
| `DB_NAME` | Default database (connect context) | `ncs-npl-aging` |
| `DB_ENCRYPT` | TLS encrypt (default `true`) | `false` for local SQL |
| `CHUNK_SIZE` | Rows per fetch chunk (default `5000`) | `10000` |

---

## Running

```bash
# development
npm run start:dev

# production build
npm run build && npm run start:prod
```

Service starts at `http://localhost:3000` (or configured port).

---

## API

### Run a preset (all cases for a module)
```
POST /validation/run-preset
{
  "preset": "invest/lv"
}
```

### Run a single case
```
POST /validation/run
{
  "module": "invest_lv",
  "case": "lvhisthsum"
}
```

### List available presets
```
GET /validation/presets
```

### Health check
```
GET /
```

---

## Rules

All validation logic lives in `rules/`. See **[rules/README.md](rules/README.md)** for the full authoring guide.

```
rules/
  global/              ← rules that apply to all cases
  rights_npl/          ← NPL loan transaction history
  rights_npa/          ← NPA asset transaction history
  eir_npa/             ← EIR investment history
  invest_lv/           ← LV investment tables

presets/
  invest/lv.yaml       ← groups invest_lv cases for one API call
```

---

## Git / Deployment

Branch strategy:
```
develop  ← all active development (commit here)
sit      ← staging — merge from develop, push to trigger deployment
main     ← production (infra team manages)
```

**Never commit directly to `sit`.** Always commit to `develop` first, then merge:
```bash
git checkout sit
git merge develop
git push origin sit
```

CI/CD is handled by the infra team's Jenkins pipeline. Kubernetes deployment is managed by infra — we deliver the image only.

GitLab: `http://172.18.1.92` → `bam-ncs-automation/vidar`

---

## Adding a New Rule

See [rules/README.md → How to Add a New Rule](rules/README.md#how-to-add-a-new-rule).
