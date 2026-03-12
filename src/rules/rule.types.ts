// ============================================================
// Types ที่ match กับ format ของ common.yaml และ def.yaml
// ============================================================

export type TableType = 'MASTER' | 'SPLIT' | 'TRANSACTION' | 'MULTIPLE' | 'UNION' | 'ASSOCIATE' | 'HEADER';

export type TransformRule =
  | 'NONE'
  | 'STRIP_LEADING_ZEROS'
  | 'STRIP_SPECIAL_CHARS'
  | 'DATE_TO_DATETIME'
  | 'CONCAT'
  | 'SPLIT_FIRST'
  | 'SPLIT_SECOND';

export type FormulaType = 'SUM' | 'SUBTRACT' | 'EXACT';

export type NoisyColumnType = 'NORMAL' | 'NULL' | 'ZERO' | 'BOOLEAN';

// ---- Schema Mapping Types ----

export interface ExactMatch {
  old: string;
  new: string;
  transform_rule?: TransformRule;
  // MULTIPLE (N:N) only: which source/target table this mapping belongs to
  src_table?: string;
  tgt_table?: string;
}

export interface SplitMatch {
  old: string;
  new_cols: string[];
  formula: FormulaType;
}

export interface TransformedMatch {
  old: string;
  new: string;
  transform_rule: TransformRule;
  // MULTIPLE (N:N) only
  src_table?: string;
  tgt_table?: string;
}

/** Concatenate multiple source columns into one target column */
export interface ConcatMatch {
  old_cols: string[];   // e.g. ['first_name', 'last_name']
  new: string;          // e.g. 'full_name'
  separator?: string;   // e.g. ' ' (default: '')
  // MULTIPLE (N:N) only
  src_table?: string;
  tgt_table?: string;
}

/**
 * Apply an arithmetic formula across multiple source columns and compare result to one target column.
 * e.g. creditprincipleamount - debitprincipleamount → billprinciple
 * Uses FormulaType: SUBTRACT = old_cols[0] - old_cols[1] - ..., SUM = sum of all old_cols
 */
export interface FormulaMatch {
  old_cols: string[];    // e.g. ['creditprincipleamount', 'debitprincipleamount']
  formula: FormulaType;  // SUBTRACT | SUM | EXACT
  new: string;           // e.g. 'billprinciple'
}

/**
 * HEADER (Pivot): one row per (identity_key × pivot_key_value) in old table
 * maps to one row per identity_key in new table with each pivot_key_value as a column.
 */
export interface PivotMatch {
  pivot_key_value: string;  // filter: WHERE pivot_key = this value
  value_col: string;        // old table column to read value from
  new_col: string;          // new table column name
}

/**
 * Sum a source column filtered by (affectcode_in, debitcredit, loantranshostcode_not_in)
 * and compare to one target column.
 *
 * Used for lv$lvhisthsum lvcredit_/lvdebit_ columns where the new column is derived
 * by summing old.transactionamount for rows matching a specific (affectcode, debitcredit)
 * combination while excluding consolidate=N loantranshostcodes.
 *
 * Example:
 *   SUM(old.transactionamount WHERE affectcode IN [PP] AND debitcredit=C AND tc NOT IN [...])
 *   = new.lvcreditprincipleamount
 */
export interface FilteredSumMatch {
  old: string;                            // source column to sum (e.g. transactionamount)
  old_filter: {
    affectcode_in?: string[];             // e.g. ['PP'] or ['I1','I2','I3','IN','IT','GG']
    debitcredit?: string;                 // 'C' or 'D'
    loantranshostcode_not_in?: string[];  // consolidate=N exclusion list
  };
  new: string;                            // target column (e.g. lvcreditprincipleamount)
}

export interface SchemaMappings {
  exact_matches?: ExactMatch[];
  split_matches?: SplitMatch[];
  transformed_matches?: TransformedMatch[];
  concat_matches?: ConcatMatch[];
  formula_matches?: FormulaMatch[];          // multi-col arithmetic → one target col
  filtered_sum_matches?: FilteredSumMatch[]; // filtered group-sum → one target col (lv* columns)
  pivot_matches?: PivotMatch[];              // HEADER type only
}

export interface TransactionGrouping {
  keys: { old: string; new: string };
  transform_key?: TransformRule;
  // Per-source group key overrides for MULTIPLE strategy.
  // Key = full source table reference, value = column name in that source.
  // Falls back to keys.old if a source is not listed here.
  // Use when different sources call the shared group key by different column names.
  source_key_aliases?: Record<string, string>;
  // Override which column is used in the WHERE IN query when fetching new rows.
  // Defaults to keys.new when not set.
  // Use when an indexed column (e.g. journalseqno) stores the same value as keys.new
  // but has an index while keys.new does not — avoids full table scan on target fetch.
  target_fetch_key?: string;
}

/**
 * Pivot configuration for HEADER (Long → Wide) tables.
 * pivot_key: column in old table whose distinct VALUES become column names in new table.
 */
export interface PivotConfig {
  identity_key: { old: string; new: string };
  pivot_key: string;    // e.g. 'header_type'
}

// ---- Common Rule (จาก common.yaml) ----
export interface CommonRule {
  table_info: {
    source: string;     // table reference — comma-separated for UNION/MULTIPLE
    target: string;     // target table reference — comma-separated for MULTIPLE
    table_type: TableType;
    source_filter?: string;  // optional SQL WHERE condition on old table (e.g. "invaccounttype = 'TF'")
  };
  anchor_key: {
    old: string;        // cursor column name in old table — used for keyset streaming
    new: string;        // cursor column name in new table
  };
  transaction_grouping?: TransactionGrouping;
  pivot_config?: PivotConfig;       // HEADER type only
  schema_mappings: SchemaMappings;
  defaults?: {
    tolerance?: number;
  };
}

// ---- Def Rule (จาก def.yaml) ----
export interface DefAction {
  step: string;
  check_type: string;
  variables?: Record<string, string>;
  condition: string;
  error_message: string;
}

export interface DefRule {
  def_id: string;
  target_scope: 'transaction_group' | 'row' | 'table';
  trigger_condition?: {
    must_have_all?: string[];
    must_have_any?: string[];
  };
  actions: DefAction[];
}

// ---- Affect Code (จาก global JSON) ----
export interface AffectCode {
  code: string;
  description: string;
  category?: string;
}

export interface GlobalAffectCodes {
  codes: AffectCode[];
}

// ---- Validation Error Types ----
export type ErrorType =
  | 'VALUE_MISMATCH'
  | 'ROW_MISSING'
  | 'COLUMN_MISSING'
  | 'DATA_MISSING'
  | 'DEFECT_VIOLATION'
  | 'TRANSFORM_ERROR';

export interface ValidationError {
  errorType: ErrorType;
  defId?: string;
  oldColumn?: string;
  newColumn?: string;
  oldValue?: unknown;
  newValue?: unknown;
  groupKey?: string;
  rowIdentifier?: string;
  message: string;
}
