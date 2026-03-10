# VIDAR — Rules Guide

This folder contains all validation rules for the post-migration data validation engine.
Each rule compares data between the **legacy (old)** database and the **new core** database.

---

## Folder Structure

```
rules/
  global/
    defs/def001.yaml          # Global def: tellerid format check (applies to all cases)
  {module}_{product}/         # e.g. rights_npl, eir_npa, invest_lv
    {case_name}/
      common.yaml             # Column mappings, table config, group key
      def/
        def001.yaml           # Business rule checks (optional)
        def002.yaml           # Additional checks (optional)

presets/
  {product}/
    {module}.yaml             # Preset: groups cases to run together via API
```

> **No subfolder inside case_name.** The engine looks for `common.yaml` directly inside the case folder.

---

## Current Cases

### rights_npl (Rights — NPL)
| Case | Strategy | Old Source(s) | New Target |
|---|---|---|---|
| `lnhistloantransactionhistory` | TRANSACTION | conv$vinplhistory | ln$lnhistloantransactionhistory |
| `lnhisthloantransactionhistoryh` | MULTIPLE 2:1 | conv$vinplsbthistory + conv$vinplhistory | ln$lnhisthloantransactionhistoryh |
| `lnhisthloantransactionhistoryh_adj` | MULTIPLE 2:1 | conv$vinplsbthistory (ADJ only) | ln$lnhisthloantransactionhistoryh |

> `lnhisthloantransactionhistoryh` and `_adj` are split by `source_filter` — see [Case Deep-Dive: H Table + ADJ Split](#case-deep-dive-lnhisthloantransactionhistoryh--adj) below.

### rights_npa (Rights — NPA)
| Case | Strategy | Old Source(s) | New Target |
|---|---|---|---|
| `lahistloantransactionhistory` | MULTIPLE 3:1 | conv$vinpahistory + rental + respasserhist | la$lahistloantransactionhistory |
| `lahisthloantransactionhistoryh` | MULTIPLE 5:1 | conv$vinpahistory + CIT + nsbt + rental + respasserhist | la$lahisthloantransactionhistoryh |
| `lahistloantransactionhistory_crosscheck` | TRANSACTION | la$lahisthloantransactionhistoryh (cross-check) | la$lahistloantransactionhistory |

### eir_npa (EIR — NPA)
| Case | Strategy | Old Source(s) | New Target |
|---|---|---|---|
| `lshistinvtransactionhistory` | TRANSACTION | conv$vinpainvesthist | ls$lshistinvtransactionhistory |
| `lshisthinvtransactionhistoryh` | TRANSACTION | conv$vinpainvesthist | ls$lshisthinvtransactionhistoryh |

### invest_lv (Investment — LV)
| Case | Strategy | Old Source(s) | New Target |
|---|---|---|---|
| `lvhisthinvtransactionhistoryh` | TRANSACTION | conv$vinpllvcithistory (TX rows) | lv$lvhisthinvtransactionhistoryh |
| `lvhisthsum` | TRANSACTION | conv$vinpllvhistory (P-prefix) | lv$lvhisthsum |
| `lvhisth_fbo` | TRANSACTION | conv$vinpllvcithistory (TF rows) | lv$lvhisth_fbo |
| `lvhisth_truesale` | TRANSACTION | conv$vinpllvcithistory (TS rows) | lv$lvhisth_truesale |
| `lvhisth_fbo_truesale` | TRANSACTION | conv$vinpllvcithistory (TF+TS rows) | lv$lvhisth_fbo_truesale |

---

## Def Rules — What Each Check Tests

Quick reference: if you see a def error in the report, find the case and step below to understand what failed.

---

### GLOBAL — `global/defs/def001.yaml`
Applies to any case that includes `def001` in its run. Can be overridden by a table-specific `def001.yaml`.

| Step | Checks | Pass condition |
|---|---|---|
| 1 | Teller ID was converted from numeric code to AD username | New tellerid is an AD username (e.g. `surasak.s`). Fails if new tellerid is still a number, starts with `*`, or is `CONV`/`PLAN`. Skips rows where old tellerid = `CONV` (conversion records). |

---

### rights_npl / lnhisthloantransactionhistoryh — Normal Transactions
Source: `conv$vinplsbthistory` → Target: `ln$lnhisthloantransactionhistoryh` (excluding ADJ-* sysrefs)

| Step | Checks | Pass condition |
|---|---|---|
| 1 | `interestpaid` was correctly copied to the **credit** side of H | `SUM(old.interestpaid) == SUM(new.creditinterestamount)` |
| 2 | `interestpaid` was correctly copied to the **debit** side of H | `SUM(old.interestpaid) == SUM(new.debitinterestamount)` |
| 3 | Withholding tax (`interest33`) matches `totaltax` in H | `SUM(old.interest33) == SUM(new.totaltax)` within ±0.01 |
| 4 | Running interest balance (`interestb4t`) carried over correctly | `SUM(old.interestb4t) == SUM(new.interestb4t)` |
| 5 | H ledger is self-balanced (credit total = debit total) | `SUM(new.creditinterestamount) == SUM(new.debitinterestamount)` |
| 6 | SBT tax source data is internally consistent (old side only) | `SUM(old.sbttotalamount) == SUM(old.sbtrevenue)` |

---

### rights_npl / lnhisthloantransactionhistoryh_adj — Adjustment Transactions
Source: `conv$vinplsbthistory` (ADJ-* only) → Target: `ln$lnhisthloantransactionhistoryh`

ADJ transactions are late-entry corrections. They have a **negative** `interestpaid` and produce only **1 debit row** in H (no credit row) with the sign flipped to positive.

| Step | Checks | Pass condition |
|---|---|---|
| 1 | Sign was correctly flipped: negative interestpaid → positive debitinterestamount | `SUM(old.interestpaid) + SUM(new.debitinterestamount) == 0` (they cancel) |
| 2 | No credit row was created (ADJ is debit-only) | `SUM(new.creditinterestamount) == 0` |
| 3 | Withholding tax (`interest33`) matches `totaltax` in H | `SUM(old.interest33) == SUM(new.totaltax)` within ±0.01 |
| 4 | Running interest balance (`interestb4t`) carried over correctly | `SUM(old.interestb4t) == SUM(new.interestb4t)` |

---

## common.yaml — Field Reference

```yaml
table_info:
  source: "[db].dbo.[table]"          # old table(s), comma-separated for MULTIPLE/UNION
  target: "[db].dbo.[table]"          # new table
  table_type: TRANSACTION             # see Table Types below
  source_filter: "col = 'value'"      # optional SQL WHERE appended to old table fetch

anchor_key:
  old: id                             # unique auto-increment column — used for keyset pagination
  new: id                             # required placeholder (not used in group-mode)

transaction_grouping:                 # TRANSACTION / MULTIPLE / UNION only
  keys:
    old: systemreferencenumber        # group key column in old table
    new: systemreferenceno            # group key column in new table

defaults:
  tolerance: 0.01                     # allowed rounding difference for numeric comparisons

schema_mappings:
  exact_matches:                      # direct value comparison (rename allowed)
    - old: col_name
      new: col_name
      src_table: "..."                # required for MULTIPLE: registers source in engine pairMap
      tgt_table: "..."

  transformed_matches:                # value needs transformation before comparison
    - old: col_name
      new: col_name
      transform_rule: NONE            # see Transform Rules below
      src_table: "..."                # required if source-specific

  concat_matches:                     # multiple old cols → one new col
    - old_cols: [col1, col2]
      new: col_name
      separator: ""

  split_matches:                      # one old col → aggregated into new col
    - old_cols: [col_name]
      formula: SUM                    # SUM | SUBTRACT | EXACT
      new: col_name
      src_table: "..."
      tgt_table: "..."

  formula_matches:                    # arithmetic on old cols → new col
    - expression: "old.col1 + old.col2"
      new: col_name
```

### Table Types
| Type | Use when |
|---|---|
| MASTER | 1:1 row comparison, unique key per row |
| TRANSACTION | N old rows share a group key, compare group aggregates |
| MULTIPLE | N old tables → 1 new table, group-mode |
| UNION | N old tables → 1 new table, non-overlapping groups |
| SPLIT | 1 old table → N new tables |
| HEADER | Long format → wide format (pivot) |
| ASSOCIATE | Same as MASTER (1:1 key comparison) |

### Transform Rules
| Rule | What it does |
|---|---|
| `NONE` | String trim only — use for nvarchar → decimal amount columns |
| `DATE_TO_DATETIME` | ISO string / date string → YYYY-MM-DD (normalizes both sides) |
| `STRIP_LEADING_ZEROS` | `'00123'` → `'123'`, also handles leading-dot: `'.0525'` → `0.0525` |
| `STRIP_SPECIAL_CHARS` | Removes non-alphanumeric characters |
| `SPLIT_FIRST` | Removes last 4 characters |
| `SPLIT_SECOND` | Returns last 4 characters only |

### MULTIPLE: Source Registration (Critical)
Every source table in a MULTIPLE rule **must** have at least one mapping with `src_table` + `tgt_table`.
Without it, the engine's `pairMap` has no entry and the entire source is silently skipped.

Minimum registration (one entry per extra source):
```yaml
- old: newaccountno
  new: accountno
  src_table: "[ncs-conv-aging].dbo.[conv$secondarytable]"
  tgt_table: "[ncs-npl-aging].dbo.[ln$targettable]"
```

---

## def YAML — Field Reference

Def files add business rule checks on top of what common.yaml validates.
They run per transaction group (when `target_scope: transaction_group`).

```yaml
def_id: def001
target_scope: transaction_group

actions:
  - step: "1"
    check_type: ROW_LEVEL_COHESION      # or FIELD_VALUE_CHECK
    variables:
      var_name: "SUM(old.column)"       # or SUM(new.column), COUNT(old), etc.
    condition: "var_a == var_b"         # arithmetic condition on variables
    error_message: >
      Human-readable message. Use {var_name} to include variable values.
```

### check_type Options
| Type | Purpose |
|---|---|
| `ROW_LEVEL_COHESION` | Compare aggregated values between old and new per group |
| `FIELD_VALUE_CHECK` | Validate a column value matches a pattern or lookup |

### Variable Expressions
| Expression | Meaning |
|---|---|
| `SUM(old.col)` | Sum of column across all old rows in this group |
| `SUM(new.col)` | Sum of column across all new rows in this group |
| `COUNT(old)` | Row count in old for this group |
| `COUNT(new)` | Row count in new for this group |

---

## How to Add a New Rule

1. **Create the folder**: `rules/{module}_{product}/{case_name}/`
2. **Write `common.yaml`**: use the field reference above. Always set `anchor_key.old` to an auto-increment `id`.
3. **Verify column mappings** against live DB before writing:
   - Step A: Run `SELECT old.col, new.col FROM old JOIN new ON sysref = sysref WHERE sysref = 'X'` to see actual values side-by-side
   - Step B: Run `SELECT COUNT(*) WHERE col IS NOT NULL AND col != ''` on both sides — never trust a report saying a column is empty without checking live DB
4. **Write def files** (optional): add to `def/def001.yaml`, `def002.yaml`, etc.
5. **Register in preset**: add a case entry to `presets/{product}/{module}.yaml`

---

## Known Patterns and Edge Cases

### Cross-DB collation conflict
When joining old and new tables across databases, add `COLLATE Thai_CI_AS` on both sides:
```sql
ON o.systemreferencenumber COLLATE Thai_CI_AS = n.systemreferenceno COLLATE Thai_CI_AS
```

### Group key mismatch in MULTIPLE
If a secondary source uses a different column name for the group key, its rows will be grouped under `''` (empty string) and produce one `ROW_MISSING` for the empty group. This is documented acceptable behavior — register the source anyway for column-level checks via src_table.

### source_filter for routing
Use `source_filter` in `table_info` to split one physical table into multiple logical rules:
```yaml
source_filter: "invaccounttype = 'TF'"   # invest_lv routing by type
source_filter: "systemreferenceno LIKE 'ADJ-%'"   # ADJ-only rule
```

### Placeholder comments
Columns that are excluded from validation are documented as `# PLACEHOLDER:` comments inside `schema_mappings`. Each placeholder states the reason (EMPTY_COLUMN, TYPE_MISMATCH, MISSING, etc.).

---

## Case Deep-Dive: lnhisthloantransactionhistoryh + ADJ

### Why Two Directories

This case is split because ADJ (adjustment) transactions follow completely different migration rules.

**Business context:** ADJ transactions are created when a payment is recorded in the system *after* the actual payment date (e.g. customer paid 12/03, entered 12/04). The system calculates interest up to 12/04, then the ADJ transaction corrects it back to 12/03. Each ADJ has its own unique `systemreferenceno` starting with `ADJ-`.

| Directory | Scope | source_filter |
|---|---|---|
| `lnhisthloantransactionhistoryh/` | Normal transactions | `systemreferenceno NOT LIKE 'ADJ-%'` |
| `lnhisthloantransactionhistoryh_adj/` | Adjustment transactions | `systemreferenceno LIKE 'ADJ-%'` |

### H Table — Double-Entry Ledger Structure

For each **normal** sysref, migration produces **2 rows** in H:

| H Row | creditinterestamount | debitinterestamount |
|---|---|---|
| Row 1 (credit) | = interestpaid | 0 |
| Row 2 (debit) | 0 | = interestpaid |

For each **ADJ** sysref, migration produces **1 row** in H:

| H Row | creditinterestamount | debitinterestamount |
|---|---|---|
| Row 1 (debit only) | 0 | = ABS(interestpaid) — sign flipped |

### Special Interest Columns (3 non-trivial mappings)

| Old Column | New Column | Rule |
|---|---|---|
| `interestpaid` | `creditinterestamount` + `debitinterestamount` | Both H rows carry the same value (double-entry). Validated by def. |
| `interest33` | `totaltax` | `interest33 = interestpaid × 3.3% WHT`. Same target as `sbttotalamount` — cannot be a separate transformed_match. Validated by def. |
| `interestb4t` | `interestb4t` | Direct 1:1 match. Verified against live DB. |

### def/def001.yaml — Normal Sysrefs (6 steps)

| Step | What it checks | Condition |
|---|---|---|
| 1 | interestpaid → creditinterestamount | `SUM(old.interestpaid) == SUM(new.creditinterestamount)` |
| 2 | interestpaid → debitinterestamount | `SUM(old.interestpaid) == SUM(new.debitinterestamount)` |
| 3 | interest33 ≈ totaltax (± 0.01) | `SUM(old.interest33) == SUM(new.totaltax)` |
| 4 | interestb4t direct match | `SUM(old.interestb4t) == SUM(new.interestb4t)` |
| 5 | Double-entry self-balance | `SUM(new.creditinterestamount) == SUM(new.debitinterestamount)` |
| 6 | SBT tax self-check (old only) | `SUM(old.sbttotalamount) == SUM(old.sbtrevenue)` |

### def/def001.yaml — ADJ Sysrefs (4 steps)

| Step | What it checks | Condition |
|---|---|---|
| 1 | Sign-flip: debit = ABS(interestpaid) | `SUM(old.interestpaid) + SUM(new.debitinterestamount) == 0` |
| 2 | No credit row present | `SUM(new.creditinterestamount) == 0` |
| 3 | interest33 ≈ totaltax | `SUM(old.interest33) == SUM(new.totaltax)` |
| 4 | interestb4t direct match | `SUM(old.interestb4t) == SUM(new.interestb4t)` |
