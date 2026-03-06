/**
 * compare.worker.ts
 * Worker thread for CPU-bound row comparison.
 * Receives a CompareTask via parentPort.on('message') and posts back CompareResult.
 *
 * Runs in isolation — imports only TransformUtils (no NestJS DI, no DB calls).
 */
import { parentPort } from 'worker_threads';
import { TransformUtils } from './transform.utils';
import type { NoisyColumnType } from '../rules/rule.types';

// ---- Serializable task/result types (mirrors rule.types but no class instances) ----

interface ExactMatchTask {
  old: string;
  new: string;
  transform_rule?: string;
}

interface SplitMatchTask {
  old: string;
  new_cols: string[];
  formula: 'SUM' | 'SUBTRACT' | 'EXACT';
}

interface TransformedMatchTask {
  old: string;
  new: string;
  transform_rule: string;
}

interface ConcatMatchTask {
  old_cols: string[];
  new: string;
  separator?: string;
}

interface FormulaMatchTask {
  old_cols: string[];
  formula: 'SUM' | 'SUBTRACT' | 'EXACT';
  new: string;
}

export interface CompareTask {
  oldChunk: Record<string, unknown>[];
  /**
   * New rows fetched by matching anchor key — NOT a positional array.
   * The worker builds a Map<anchorKeyNew, row> from this for key-based lookup.
   */
  newRows: Record<string, unknown>[];
  /** Anchor key column name in the old table — used to look up each old row's match */
  anchorKeyOld: string;
  /** Anchor key column name in the new table — used as the Map key */
  anchorKeyNew: string;
  exactMatches: ExactMatchTask[];
  splitMatches: SplitMatchTask[];
  transformedMatches: TransformedMatchTask[];
  concatMatches: ConcatMatchTask[];
  formulaMatches: FormulaMatchTask[];
  tolerance: number;
  baseIndex: number;
  /** Column-level noisy classification sampled before the loop */
  noisyColumns: Record<string, NoisyColumnType>;
}

export interface CompareResult {
  errors: Array<{
    errorType: string;
    oldColumn?: string;
    newColumn?: string;
    oldValue?: unknown;
    newValue?: unknown;
    rowIdentifier?: string;
    message: string;
  }>;
}

// ---- Core comparison logic ----

function shouldSkip(col: string, noisyColumns: Record<string, NoisyColumnType>): boolean {
  const t = noisyColumns[col];
  return t === 'NULL' || t === 'ZERO' || t === 'BOOLEAN';
}

function compareChunk(task: CompareTask): CompareResult {
  const {
    oldChunk,
    newRows,
    anchorKeyOld,
    anchorKeyNew,
    exactMatches,
    splitMatches,
    transformedMatches,
    concatMatches,
    formulaMatches,
    tolerance,
    baseIndex,
    noisyColumns,
  } = task;

  const errors: CompareResult['errors'] = [];

  // Build a Map<newAnchorKey, newRow> for O(1) key-based lookup.
  // This is the core fix: we join by anchor key, NOT by array position.
  const newMap = new Map<string, Record<string, unknown>>();
  for (const row of newRows) {
    newMap.set(String(row[anchorKeyNew] ?? '').trim(), row);
  }

  // Track which new-side keys we've matched (to detect extra rows in target)
  const matchedNewKeys = new Set<string>();

  for (let i = 0; i < oldChunk.length; i++) {
    const oldRow = oldChunk[i];
    const oldKey = String(oldRow[anchorKeyOld] ?? '').trim();
    const rowId = oldKey || `row_${baseIndex + i}`;

    const newRow = newMap.get(oldKey);
    if (!newRow) {
      errors.push({
        errorType: 'ROW_MISSING',
        rowIdentifier: rowId,
        message: `Row with key [${oldKey}] found in source but not in target`,
      });
      continue;
    }
    matchedNewKeys.add(oldKey);

    // ---- exact matches ----
    for (const m of exactMatches) {
      if (shouldSkip(m.old, noisyColumns)) continue;

      const oldVal = oldRow[m.old];
      const newVal = newRow[m.new];

      const transformedOld = m.transform_rule
        ? TransformUtils.apply(oldVal, m.transform_rule as any)
        : String(oldVal ?? '').trim();
      const transformedNew = String(newVal ?? '').trim();

      if (!TransformUtils.isEqual(transformedOld, transformedNew, tolerance)) {
        errors.push({
          errorType: 'VALUE_MISMATCH',
          oldColumn: m.old,
          newColumn: m.new,
          oldValue: oldVal,
          newValue: newVal,
          rowIdentifier: rowId,
          message: `Mismatch on [${m.old}→${m.new}]: "${oldVal}" ≠ "${newVal}" (${rowId})`,
        });
      }
    }

    // ---- split matches ----
    for (const m of splitMatches) {
      if (shouldSkip(m.old, noisyColumns)) continue;

      const oldVal = parseFloat(String(oldRow[m.old] ?? 0));
      const newVals = m.new_cols.map((c) => newRow[c]);
      const computed = TransformUtils.evaluateFormula(m.formula, newVals);

      if (Math.abs(oldVal - computed) > tolerance) {
        errors.push({
          errorType: 'VALUE_MISMATCH',
          oldColumn: m.old,
          newColumn: m.new_cols.join('+'),
          oldValue: oldVal,
          newValue: computed,
          rowIdentifier: rowId,
          message: `Split formula mismatch: ${m.old}=${oldVal}, ${m.formula}(${m.new_cols.join(',')})=${computed} (${rowId})`,
        });
      }
    }

    // ---- transformed matches ----
    for (const m of transformedMatches) {
      if (shouldSkip(m.old, noisyColumns)) continue;

      const oldVal = oldRow[m.old];
      const newVal = newRow[m.new];
      const transformedOld = TransformUtils.apply(oldVal, m.transform_rule as any);
      const transformedNew = TransformUtils.apply(newVal, 'NONE');

      if (!TransformUtils.isEqual(transformedOld, transformedNew, tolerance)) {
        errors.push({
          errorType: 'VALUE_MISMATCH',
          oldColumn: m.old,
          newColumn: m.new,
          oldValue: oldVal,
          newValue: newVal,
          rowIdentifier: rowId,
          message: `Transform mismatch on [${m.old}→${m.new}]: "${transformedOld}" ≠ "${transformedNew}" (${rowId})`,
        });
      }
    }

    // ---- concat matches ----
    for (const m of concatMatches) {
      // Check if any source column is noisy
      if (m.old_cols.some((c) => shouldSkip(c, noisyColumns))) continue;

      const sep = m.separator ?? '';
      const concatenated = m.old_cols
        .map((c) => String(oldRow[c] ?? '').trim())
        .join(sep);
      const newVal = String(newRow[m.new] ?? '').trim();

      if (!TransformUtils.isEqual(concatenated, newVal, tolerance)) {
        errors.push({
          errorType: 'VALUE_MISMATCH',
          oldColumn: m.old_cols.join('+'),
          newColumn: m.new,
          oldValue: concatenated,
          newValue: newVal,
          rowIdentifier: rowId,
          message: `Concat mismatch on [${m.old_cols.join('+')}→${m.new}]: "${concatenated}" ≠ "${newVal}" (${rowId})`,
        });
      }
    }

    // ---- formula matches ----
    for (const m of formulaMatches) {
      if (m.old_cols.some((c) => shouldSkip(c, noisyColumns))) continue;

      const oldInputs = m.old_cols.map((c) => oldRow[c]);
      // Skip if any source column is null for this row
      if (oldInputs.some((v) => v === null || v === undefined)) continue;

      const computed = TransformUtils.evaluateFormula(m.formula, oldInputs);
      const newVal = parseFloat(String(newRow[m.new] ?? 0));

      if (Math.abs(computed - newVal) > tolerance) {
        errors.push({
          errorType: 'VALUE_MISMATCH',
          oldColumn: m.old_cols.join(m.formula === 'SUBTRACT' ? '-' : '+'),
          newColumn: m.new,
          oldValue: computed,
          newValue: newVal,
          rowIdentifier: rowId,
          message: `Formula mismatch [${m.formula}(${m.old_cols.join(',')})→${m.new}]: ${computed} ≠ ${newVal} (${rowId})`,
        });
      }
    }
  }

  // Detect extra rows that exist in the target but have no source counterpart
  for (const [newKey] of newMap) {
    if (!matchedNewKeys.has(newKey)) {
      errors.push({
        errorType: 'ROW_MISSING',
        rowIdentifier: newKey,
        message: `Row with key [${newKey}] found in target but not in source (extra row)`,
      });
    }
  }

  return { errors };
}

// ---- Worker entry point ----
if (parentPort) {
  parentPort.on('message', (task: CompareTask) => {
    try {
      const result = compareChunk(task);
      parentPort!.postMessage(result);
    } catch (err: any) {
      parentPort!.postMessage({
        errors: [
          {
            errorType: 'TRANSFORM_ERROR',
            message: `Worker error: ${err?.message ?? String(err)}`,
          },
        ],
      });
    }
  });
}
