# VIDAR — Rules Authoring Guide

This folder contains all validation rules. Each rule compares a legacy source table against a migrated target table and reports mismatches.

---

## Folder Structure

```
rules/
  global/
    affect_codes.json         # known affectcode list (used by trigger_condition)
    defs/
      def001.yaml             # global tellerid format check
  {module}_{product}/         # e.g. rights_npl, invest_lv
    {case_name}/
      common.yaml             # required: table config + column mappings
      def/
        def001.yaml           # optional: business rule checks
        def002.yaml           # optional: additional checks

presets/
  {product}/
    {module}.yaml             # groups cases to run via one API call
```

---

## Table Types

Set in `table_info.table_type`:

| Type | Description |
|---|---|
| `MASTER` | 1:1 row comparison keyed by unique anchor column |
| `TRANSACTION` | N old rows share a group key (sysref). Compare group-level aggregates. |
| `MULTIPLE` | N old source tables → 1 new target. Each source pair validated independently. |
| `UNION` | N old tables → 1 new target, non-overlapping groups. |
| `SPLIT` | 1 old table → N new tables. |
| `HEADER` | Long format → wide format (pivot). |
| `ASSOCIATE` | 1:1 key comparison (same as MASTER). |

---

## common.yaml — Full Field Reference

```yaml
# ─────────────────────────────────────────────
# TABLE INFO
# ─────────────────────────────────────────────
table_info:
  source: "[ncs-conv-aging].dbo.[conv$table]"   # old table (comma-separated for MULTIPLE)
  target: "[ncs-npl-aging].dbo.[new$table]"      # new table
  table_type: TRANSACTION                         # see Table Types
  source_filter: "col LIKE 'P%'"                 # optional SQL WHERE on old table

# ─────────────────────────────────────────────
# ANCHOR KEY
# ─────────────────────────────────────────────
# Must be a unique, monotonically increasing column (auto-increment id).
# Used for keyset pagination to stream old rows in chunks.
anchor_key:
  old: id
  new: id    # required field — not used for fetching in group/composite-key mode

# ─────────────────────────────────────────────
# TRANSACTION GROUPING  (TRANSACTION / MULTIPLE only)
# ─────────────────────────────────────────────
transaction_grouping:
  keys:
    old: systemreferencenumber    # group key column in old table
    new: systemreferenceno        # group key column in new table
  target_fetch_key: journalseqno  # optional: use a different (indexed) column for new-table lookup
  transform_key: STRIP_LEADING_ZEROS  # optional: normalize key before comparison

  # composite_key: use when one sysref covers multiple accounts
  # Triggers validateCompositeKey mode + temp table caching
  composite_key:
    old_col: accountno            # account ID column in old table
    new_col: lvaccountno          # account ID column in new table
    account_mapping:              # translation table (old accountno → new accountno)
      table: "[ncs-conv-aging].dbo.[conv$vinpllvcithistory]"
      lookup_col: invaccountno
      result_col: newinvaccountno

# ─────────────────────────────────────────────
# DEFAULTS
# ─────────────────────────────────────────────
defaults:
  tolerance: 0.01    # max allowed difference for numeric comparisons (handles rounding)

# ─────────────────────────────────────────────
# SCHEMA MAPPINGS
# ─────────────────────────────────────────────
schema_mappings:

  # EXACT — direct value comparison (column rename allowed)
  exact_matches:
    - old: col_name
      new: col_name
      src_table: "..."    # MULTIPLE only: registers this source in the engine pair map
      tgt_table: "..."    # MULTIPLE only: paired with src_table

  # TRANSFORMED — apply a transform rule before comparison
  transformed_matches:
    - old: col_name
      new: col_name
      transform_rule: DATE_TO_DATETIME    # see Transform Rules
      src_table: "..."                    # MULTIPLE only

  # CONCAT — join multiple old cols into one new col
  concat_matches:
    - old_cols: [col1, col2]
      new: col_name
      separator: ""

  # SPLIT — one old col → formula across multiple new cols
  split_matches:
    - old: col_name
      new_cols: [new1, new2]
      formula: SUM    # SUM | SUBTRACT | EXACT

  # FORMULA — arithmetic on old cols → one new col
  formula_matches:
    - old_cols: [col1, col2]
      new: col_name
      formula: SUM    # SUM | SUBTRACT

  # FILTERED SUM — SUM(old.col WHERE filter) must equal new.col
  # Used for lv* pivot columns where affectcode + debitcredit determine the target column.
  filtered_sum_matches:
    - old: transactionamount
      old_filter:
        affectcode_in: [PP, I1]           # whitelist of affectcodes
        debitcredit: C                    # exact match on debitcredit
        loantranshostcode_not_in:         # exclusion list (rows with these lthc are skipped)
          - "80000"
          - "82100"
        loantranshostcode_in:             # whitelist (only rows with these lthc are included)
          - "24100"
          - "26100"
      new: lvcreditinterestamount
```

### Transform Rules

| Rule | What it does |
|---|---|
| `NONE` | String trim only. Use for nvarchar → decimal amount columns. |
| `DATE_TO_DATETIME` | ISO string or date string → `YYYY-MM-DD` (normalizes both sides). |
| `STRIP_LEADING_ZEROS` | `'00123'` → `'123'`. Also fixes leading-dot: `'.0525'` → `0.0525`. |
| `STRIP_SPECIAL_CHARS` | Removes non-alphanumeric characters. |
| `SPLIT_FIRST` | Removes last 4 characters. |
| `SPLIT_SECOND` | Returns last 4 characters only. |

### MULTIPLE: Source Registration (Critical)

Every source table in a MULTIPLE rule **must** have at least one mapping with `src_table` + `tgt_table`. Without this, the engine's `pairMap` has no entry and the entire source is silently skipped.

Minimum registration:
```yaml
- old: newaccountno
  new: accountno
  src_table: "[ncs-conv-aging].dbo.[conv$secondarytable]"
  tgt_table: "[ncs-npl-aging].dbo.[ln$targettable]"
```

---

## def YAML — Full Field Reference

Def files add per-group business rule checks on top of common.yaml column comparisons.

```yaml
def_id: def001
target_scope: transaction_group

# File-level trigger: skip entire def if old group doesn't contain these affectcodes
trigger_condition:
  must_have_any: [PP, I1, QQ]    # at least one must be present
  must_have_all: [PP, I1]        # all must be present

actions:
  - step: "1"
    check_type: ROW_LEVEL_COHESION     # or FIELD_VALUE_CHECK

    # Step-level trigger (overrides file-level for this step only)
    trigger_condition:
      must_have_any: [PP]

    variables:
      val_a: "SUM(old.interestpaid)"
      val_b: "SUM(new.creditinterestamount)"

    condition: "val_a == val_b"        # == uses tolerance-aware comparison

    error_message: >
      Description of what failed.
      old.interestpaid={val_a}, new.creditinterestamount={val_b}.
```

### check_type Options

| Type | Purpose |
|---|---|
| `ROW_LEVEL_COHESION` | Compare aggregated values between old and new per group |
| `FIELD_VALUE_CHECK` | Validate a column value matches a regex pattern |

### Variable Expressions

| Expression | Meaning |
|---|---|
| `SUM(old.col)` | Sum of `col` across all old rows in this group |
| `SUM(new.col)` | Sum of `col` across all new rows in this group |
| `SUM(old.col[filterCol=val])` | Conditional sum: only rows where `filterCol == val` |
| `SUM(old.col[f1=v1][f2=v2])` | Multi-condition: rows where `f1==v1 AND f2==v2` (AND-chained) |
| `COUNT(old)` | Row count in old for this group |
| `COUNT(new)` | Row count in new for this group |

### Condition Syntax

- `val_a == val_b` — tolerance-aware equality: `|a - b| <= tolerance`
- `val_a + val_b == 0` — arithmetic then compare
- `val_a > 0` — boolean expression (no tolerance)

---

## All Current Cases

### rights_npl — Loan Transaction History (NPL)

| Case | Strategy | Old Source(s) | New Target | Notes |
|---|---|---|---|---|
| `lnhistloantransactionhistory` | TRANSACTION | conv$vinplhistory | ln$lnhistloantransactionhistory | Excludes BF/CAL_INT/B_DIFF |
| `lnhisthloantransactionhistoryh` | MULTIPLE 2:1 | conv$vinplsbthistory + conv$vinplhistory | ln$lnhisthloantransactionhistoryh | Normal sysrefs only |
| `lnhisthloantransactionhistoryh_adj` | MULTIPLE 2:1 | conv$vinplsbthistory + conv$vinplhistory | ln$lnhisthloantransactionhistoryh | ADJ-* sysrefs only |

### rights_npa — Asset Transaction History (NPA)

| Case | Strategy | Old Source(s) | New Target | Notes |
|---|---|---|---|---|
| `lahistloantransactionhistory` | MULTIPLE 3:1 | conv$vinpahistory + rental + respasserhist | la$lahistloantransactionhistory | |
| `lahisthloantransactionhistoryh` | MULTIPLE 5:1 | conv$vinpahistory + CIT + nsbt + rental + respasserhist | la$lahisthloantransactionhistoryh | H-table pivot |
| `lahistloantransactionhistory_crosscheck` | TRANSACTION | la$lahisthloantransactionhistoryh (as source) | la$lahistloantransactionhistory | Cross-check only |

### eir_npa — EIR Investment History (NPA)

| Case | Strategy | Old Source(s) | New Target | Notes |
|---|---|---|---|---|
| `lshistinvtransactionhistory` | TRANSACTION | conv$vinpainvesthist | ls$lshistinvtransactionhistory | |
| `lshisthinvtransactionhistoryh` | TRANSACTION | conv$vinpainvesthist | ls$lshisthinvtransactionhistoryh | H-table with filtered_sum_matches |

### invest_lv — LV Investment Tables

| Case | Strategy | Old Source(s) | New Target | Notes |
|---|---|---|---|---|
| `lvhisthinvtransactionhistoryh` | TRANSACTION | conv$vinpllvcithistory (TX only) | lv$lvhisthinvtransactionhistoryh | |
| `lvhisthsum` | TRANSACTION | conv$vinpllvhistory (P%/ADC% only) | lv$lvhisthsum | filtered_sum_matches for lv* cols |
| `lvhisthsum_cerq` | TRANSACTION (CK) | conv$vinpllvhistory (CE/RQ/TD/IN/…) | lv$lvhisthsum | Composite key + temp cache |
| `lvhisth_fbo` | TRANSACTION | conv$vinpllvcithistory (TF only) | lv$lvhisth_fbo | |
| `lvhisth_truesale` | TRANSACTION | conv$vinpllvcithistory (TS only) | lv$lvhisth_truesale | |
| `lvhisth_fbo_truesale` | TRANSACTION | conv$vinpllvcithistory (TF+TS) | lv$lvhisth_fbo_truesale | |
| `lvhistinvtransactionhistory` | TRANSACTION | conv$vinpllvhistory (all) | lv$lvhistinvtransactionhistory | Detail history |

---

## All Def Rules

### GLOBAL — `global/defs/def001.yaml`

Applies to all cases unless overridden by a table-specific def001.

| Step | Checks | Pass condition |
|---|---|---|
| 1 | Teller ID converted from numeric code to AD username | New tellerid is an AD username (`surasak.s`). Fails if still numeric, starts with `*`, or is `CONV`/`PLAN`. Skips old rows where tellerid = `CONV`. |

---

### rights_npl / lnhisthloantransactionhistoryh

Source: conv$vinplsbthistory + conv$vinplhistory → ln$lnhisthloantransactionhistoryh (normal sysrefs)

| Step | Source | Checks | Pass condition |
|---|---|---|---|
| 1 | sbthistory | interestpaid → creditinterestamount | `SUM(old.interestpaid) == SUM(new.creditinterestamount)` |
| 2 | sbthistory | interestpaid → debitinterestamount | `SUM(old.interestpaid) == SUM(new.debitinterestamount)` |
| 3 | sbthistory | interest33 ≈ totaltax (±0.01) | `SUM(old.interest33) == SUM(new.totaltax)` |
| 4 | sbthistory | interestb4t carried over | `SUM(old.interestb4t) == SUM(new.interestb4t)` |
| 5 | new only | H ledger self-balanced | `SUM(new.creditinterestamount) == SUM(new.debitinterestamount)` |
| 6 | sbthistory | SBT tax self-check | `SUM(old.sbttotalamount) == SUM(old.sbtrevenue) + SUM(old.sbtrevenueamount)` |
| 7 | plhistory | PP/C → creditprincipleamount | `SUM(old.transactionamount[affectcode=PP][debitcredit=C]) == SUM(new.creditprincipleamount)` |
| 8 | plhistory | QQ/C → transactionamount | `SUM(old.transactionamount[affectcode=QQ][debitcredit=C]) == SUM(new.transactionamount)` |

---

### rights_npl / lnhisthloantransactionhistoryh_adj

Source: conv$vinplsbthistory (ADJ-* only) → ln$lnhisthloantransactionhistoryh

ADJ = late-entry correction. Negative interestpaid → 1 debit row with sign flipped.

| Step | Checks | Pass condition |
|---|---|---|
| 1 | Sign flip: negative interestpaid → positive debitinterestamount | `SUM(old.interestpaid) + SUM(new.debitinterestamount) == 0` |
| 2 | No credit row created (ADJ is debit-only) | `SUM(new.creditinterestamount) == 0` |
| 3 | interest33 ≈ totaltax | `SUM(old.interest33) == SUM(new.totaltax)` |
| 4 | interestb4t carried over | `SUM(old.interestb4t) == SUM(new.interestb4t)` |

---

### rights_npa / lahisthloantransactionhistoryh

Source: conv$vinpahistory (via MULTIPLE) → la$lahisthloantransactionhistoryh

Row restructuring: N rows with different affectcodes → 2 H rows (1 credit + 1 debit).

| Step | Trigger | Checks | Pass condition |
|---|---|---|---|
| 1 | has PP | PP/C → creditprincipleamount | `SUM(old.transactionamount[affectcode=PP][debitcredit=C]) == SUM(new.creditprincipleamount)` |
| 2 | has I1 | I1/C → creditinterestamount | `SUM(old.transactionamount[affectcode=I1][debitcredit=C]) == SUM(new.creditinterestamount)` |
| 3 | has I1 | I1/D → debitinterestamount | `SUM(old.transactionamount[affectcode=I1][debitcredit=D]) == SUM(new.debitinterestamount)` |
| 4 | has QQ | QQ/C → transactionamount | `SUM(old.transactionamount[affectcode=QQ][debitcredit=C]) == SUM(new.transactionamount)` |
| 5 | has I1 | H ledger self-balanced | `SUM(new.creditinterestamount) == SUM(new.debitinterestamount)` |

---

## H-Table Row Restructuring Pattern

Tables ending in `h` are "header" tables — they aggregate multiple affectcode rows into one or two pivot rows with named columns.

### Pattern (applies to la, ls, ln H-tables)

```
OLD (N rows, one per affectcode):          NEW (1–2 rows, pivoted columns):

affectcode=PP, dc=C, amount=1000   →   creditprincipleamount = 1000
affectcode=I1, dc=C, amount=500    →   creditinterestamount  = 500   (credit row)
affectcode=I1, dc=D, amount=500    →   debitinterestamount   = 500   (debit row)
affectcode=QQ, dc=C, amount=1500   →   transactionamount     = 1500
```

### Affectcode → Column Mapping (lv$lvhisthsum)

| Affectcode | dc | lthc filter | New column |
|---|---|---|---|
| PP | C | exclude 80000/82100/90000/92090/99000/21300–29400/24100–26200 | lvcreditprincipleamount |
| PP | D | same | lvdebitprincipleamount |
| I1/I2/I3/IN/IT/GG | C | same | lvcreditinterestamount |
| I1/I2/I3/IN/IT/GG | D | same | lvdebitinterestamount |
| GC | C | same | lvcreditgaincash |
| GC | D | same | lvdebitgaincash |
| GS | C | same | lvcreditgainsettlement |
| GS | D | same | lvdebitgainsettlement |
| OF/CF | C | same | lvcreditotherchargeamount |
| OF/CF | D | same | lvdebitotherchargeamount |
| I2/I3 | C | include 24100/26100/26200 | lvcredityieldamount |
| I2/I3 | D | include 25100 | lvdebityieldamount |
| I3 | D | include 25200 | lvdebitirramount |
| I3 | C | include 24200 | lvcreditirramount |
| QQ | any | all excluded | not mapped (recalculated) |

`lvformat*` columns are derived: `lvformatX = lvdebitX - lvcreditX`. Validated implicitly.

---

## Composite Key Mode (lvhisthsum_cerq)

When `transaction_grouping.composite_key` is set, the engine uses `validateCompositeKey`:

```
Group key: (systemreferenceno, accountno) OLD
        ↓  cithistory: invaccountno → newinvaccountno
Group key: (systemreferenceno, lvaccountno) NEW
```

### Performance: Target Cache (Temp Table)

To avoid 16,000+ full table scans on the unindexed `lv$lvhisthsum`:
1. At validation start, `lv$lvhisthsum` is copied to `##dv_ck_{pid}_{ts}` in SQL tempdb
2. A clustered index `(systemreferenceno, lvaccountno)` is created on the temp table
3. All validation lookups use the temp table instead of the real table
4. Temp table is dropped after validation (in a `finally` block)

**Requirements:** Only `SELECT` permission on source — temp tables are always writable in tempdb.
**Memory:** Data stays in SQL Server tempdb (~1.5 GB for lv$lvhisthsum), not Node.js heap.

---

## Known Patterns and Edge Cases

### Cross-DB Collation Conflict

When joining old and new tables across databases, add `COLLATE Thai_CI_AS` on both sides:
```sql
ON o.systemreferencenumber COLLATE Thai_CI_AS = n.systemreferenceno COLLATE Thai_CI_AS
```

### Group Key Mismatch in MULTIPLE

If a secondary source uses a different column name for the group key, its rows group under `''` (empty string) → one `ROW_MISSING` for the empty group. Acceptable behavior — register the source anyway for column-level checks.

### source_filter for Routing

Split one physical table into multiple logical rules:
```yaml
source_filter: "invaccounttype = 'TF'"             # invest_lv routing by account type
source_filter: "systemreferenceno LIKE 'ADJ-%'"    # ADJ-only rule
source_filter: "systemreferenceno NOT IN ('BF', 'CAL_INT', 'B_DIFF')"  # exclude batch codes
```

### BF / CAL_INT / B_DIFF

System-wide batch codes used as sysref values. All accounts share one sysref key — per-group comparison is meaningless. Currently excluded via `source_filter` with a comment. BF% sysrefs (with real sysref format like `BF6302-000001`) are validated in `lvhisthsum_cerq`.

### target_fetch_key

When `keys.new` (e.g. `systemreferenceno`) has no index on the new table, use `target_fetch_key` to specify an indexed column with the same value:
```yaml
target_fetch_key: journalseqno    # indexed; verified equal to systemreferenceno on all rows
```

### Placeholder Comments

Excluded columns are documented with `# PLACEHOLDER:` comments in `schema_mappings`:
```yaml
# PLACEHOLDER: transactionamount — EXCLUDED: no clean 1:1 SUM to new (Q3)
# PLACEHOLDER: ratio — EXCLUDED: both sides = 0, AI report error
```

---

## How to Add a New Rule

1. **Identify the pattern**: MASTER (1:1), TRANSACTION (group by sysref), MULTIPLE (N sources), or UNION.

2. **Create the folder**:
   ```
   rules/{module}_{product}/{case_name}/
   ```

3. **Investigate before writing** — always verify against live DB:
   ```sql
   -- Check columns exist
   SELECT COLUMN_NAME FROM [db].INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_NAME = 'tablename' ORDER BY ORDINAL_POSITION

   -- Verify a mapping with actual data
   SELECT TOP 5 o.col, n.col
   FROM old_table o
   JOIN new_table n ON o.sysref = n.sysref
   WHERE o.sysref = 'SAMPLE-SYSREF'
   ```

4. **Write `common.yaml`**: use the field reference above. Always set `anchor_key.old` to `id`.

5. **Write def files** (optional): `def/def001.yaml`, `def002.yaml`, etc.

6. **Register in preset**: add to `presets/{product}/{module}.yaml`:
   ```yaml
   cases:
     - name: your_case_name
       rule_path: module_product/your_case_name
       tables:
         - "[ncs-conv-aging].dbo.[conv$sourcetable]"
   ```

7. **Test**: call the API with your single case and check the report.
