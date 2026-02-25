import { TransformUtils } from '../strategies/transform.utils';

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

export type InferredType = 'numeric' | 'string' | 'date' | 'boolean';

/** Detected date/datetime string format from sample values */
export type DateFormat = 'ISO_TZ' | 'DATETIME_MS' | 'DATETIME' | 'DATE' | 'UNKNOWN';

export type MatchStatus =
  | 'VERIFIED'
  | 'PROBABLE'
  | 'MANUAL_CHECK'
  | 'NO_MATCH'
  | 'SAME_NAME_DIFF_DATA'   // same column name, but data has zero overlap (e.g. accountno with old format)
  | 'REGENERATED_ID'        // column named exactly "id" with system-generated large integer values
  | 'NULL_COLUMN'
  | 'ZERO_COLUMN'
  | 'BOOLEAN_COLUMN';

export type TransformHint =
  | 'DATE_TO_DATETIME'         // date-only → any datetime (time component added)
  | 'DATETIME_FORMAT_CHANGE'   // both datetime but different format (e.g. ISO+TZ vs plain)
  | 'STRIP_LEADING_ZEROS'
  | 'NONE';

export interface ColumnMeta {
  name: string;
  noisyType: 'NORMAL' | 'NULL' | 'ZERO' | 'BOOLEAN';
  inferredType: InferredType;
  dateFormat?: DateFormat;          // populated for date-type columns
  sampleValues: string[];
  uniqueRatio: number;
  uniqueValues?: Set<string>;       // up to 200 sampled unique values — used for Jaccard
  mean?: number;
  min?: number;
  max?: number;
}

export interface ColumnMatch {
  oldCol: ColumnMeta;
  newCol: ColumnMeta | null;
  nameSim: number;
  typeSim: number;
  valueSim: number;
  confidence: number;
  status: MatchStatus;
  transformHint: TransformHint;
}

export interface MatcherResult {
  matches: ColumnMatch[];
  anchorOld: string | null;
  anchorNew: string | null;
  anchorOverlapPct: number | null;   // % of old anchor values found in new — confidence of anchor detection
  unmatchedNew: string[];
}

// ----------------------------------------------------------------
// Date format detection
// ----------------------------------------------------------------

const RE_ISO_TZ        = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/;
const RE_DATETIME_MS   = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\.\d+$/;
const RE_DATETIME      = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/;
const RE_DATE          = /^\d{4}-\d{2}-\d{2}$/;

function detectDateFormat(sampleValues: string[]): DateFormat {
  for (const v of sampleValues) {
    if (!v) continue;
    if (RE_ISO_TZ.test(v))      return 'ISO_TZ';
    if (RE_DATETIME_MS.test(v)) return 'DATETIME_MS';
    if (RE_DATETIME.test(v))    return 'DATETIME';
    if (RE_DATE.test(v))        return 'DATE';
  }
  return 'UNKNOWN';
}

// ----------------------------------------------------------------
// Build ColumnMeta from sample rows
// ----------------------------------------------------------------

const DATE_PATTERN       = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/;
const LEADING_ZEROS_PATTERN = /^0+\d/;
const LARGE_INT_PATTERN  = /^\d{15,}$/;

export function buildColumnMeta(
  colName: string,
  rows: Record<string, unknown>[],
): ColumnMeta {
  const values = rows.map((r) => r[colName]);
  const totalRows = values.length;

  const noisyType: ColumnMeta['noisyType'] =
    TransformUtils.isNullColumn(values)
      ? 'NULL'
      : TransformUtils.isBooleanColumn(values)
        ? 'BOOLEAN'
        : TransformUtils.isZeroColumn(values)
          ? 'ZERO'
          : 'NORMAL';

  const nonNull = values.filter((v) => v !== null && v !== undefined);
  const nonNullStr = nonNull.map((v) => String(v).trim()).filter((s) => s !== '');

  // Inferred type
  let inferredType: InferredType = 'string';
  if (noisyType === 'BOOLEAN') {
    inferredType = 'boolean';
  } else if (nonNullStr.length > 0) {
    const numericCount = nonNullStr.filter((s) => !isNaN(parseFloat(s)) && isFinite(Number(s))).length;
    const dateCount    = nonNullStr.filter((s) => DATE_PATTERN.test(s)).length;
    const ratio = (count: number) => count / nonNullStr.length;

    if (ratio(numericCount) > 0.8)    inferredType = 'numeric';
    else if (ratio(dateCount) > 0.8)  inferredType = 'date';
    else                              inferredType = 'string';
  }

  // Date format (for date-type columns)
  let dateFormat: DateFormat | undefined;
  if (inferredType === 'date') {
    dateFormat = detectDateFormat(nonNullStr.slice(0, 10));
  }

  // Sample values (up to 5 non-null)
  const sampleValues = nonNullStr.slice(0, 5);

  // Unique set
  const uniqueSet = new Set(nonNullStr);
  const uniqueRatio = totalRows > 0 ? uniqueSet.size / totalRows : 0;

  // Numeric stats
  let mean: number | undefined;
  let min: number | undefined;
  let max: number | undefined;
  if (inferredType === 'numeric' && nonNullStr.length > 0) {
    const nums = nonNullStr.map((s) => parseFloat(s));
    min  = Math.min(...nums);
    max  = Math.max(...nums);
    mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  }

  // Unique values for Jaccard — store up to 200 for ALL string columns
  // (previously only stored for low-cardinality; this fixes false-positive matches
  //  for columns like accountno that have the same name but completely different data)
  let uniqueValues: Set<string> | undefined;
  if (inferredType === 'string') {
    uniqueValues = new Set(Array.from(uniqueSet).slice(0, 200));
  }

  return {
    name: colName,
    noisyType,
    inferredType,
    dateFormat,
    sampleValues,
    uniqueRatio,
    uniqueValues,
    mean,
    min,
    max,
  };
}

// ----------------------------------------------------------------
// Similarity functions
// ----------------------------------------------------------------

function typeSim(a: InferredType, b: InferredType): number {
  if (a === b) return 1.0;
  return 0.5;
}

function valueSim(old: ColumnMeta, neu: ColumnMeta): number {
  if (old.noisyType !== 'NORMAL' || neu.noisyType !== 'NORMAL') return 0;

  if (old.inferredType === 'numeric' && neu.inferredType === 'numeric') {
    if (old.mean === undefined || neu.mean === undefined) return 0.5;
    const oldMag = old.mean !== 0 ? Math.floor(Math.log10(Math.abs(old.mean))) : 0;
    const newMag = neu.mean !== 0 ? Math.floor(Math.log10(Math.abs(neu.mean))) : 0;
    return Math.abs(oldMag - newMag) <= 1 ? 0.8 : 0.2;
  }

  if (
    old.inferredType === 'string' &&
    neu.inferredType === 'string' &&
    old.uniqueValues !== undefined &&
    neu.uniqueValues !== undefined
  ) {
    // Jaccard: intersection / union (on sampled 200 unique values)
    let intersect = 0;
    for (const v of old.uniqueValues) {
      if (neu.uniqueValues.has(v)) intersect++;
    }
    const union = old.uniqueValues.size + neu.uniqueValues.size - intersect;
    return union > 0 ? intersect / union : 0;
  }

  // Date columns — don't compare string values directly (formats differ);
  // format differences are reported via transformHint instead
  if (old.inferredType === 'date' && neu.inferredType === 'date') {
    return 0.8;   // assume same data, format change is flagged by detectTransformHint
  }

  return 0.5;
}

// ----------------------------------------------------------------
// Transform hint detection
// ----------------------------------------------------------------

function detectTransformHint(old: ColumnMeta, neu: ColumnMeta): TransformHint {
  if (old.inferredType !== 'date' || neu.inferredType !== 'date') {
    // Non-date: only check leading zeros
    if (
      old.inferredType === 'string' &&
      neu.inferredType === 'numeric' &&
      old.sampleValues.some((v) => LEADING_ZEROS_PATTERN.test(v))
    ) {
      return 'STRIP_LEADING_ZEROS';
    }
    return 'NONE';
  }

  // Both are date-type: compare formats
  const of = old.dateFormat ?? 'UNKNOWN';
  const nf = neu.dateFormat ?? 'UNKNOWN';

  if (of === nf) return 'NONE';

  // Date-only → any datetime = time component being added
  if (of === 'DATE' && nf !== 'DATE' && nf !== 'UNKNOWN') return 'DATE_TO_DATETIME';

  // Any datetime → different datetime format (e.g. ISO+TZ → plain datetime)
  return 'DATETIME_FORMAT_CHANGE';
}

// ----------------------------------------------------------------
// Anchor key detection — cross-table value overlap
// ----------------------------------------------------------------

const ANCHOR_KEYWORDS = ['accountno', 'refno', 'referencenumber', 'referenceno', 'systemreference', 'contractno', 'policyno', 'memberno'];

function isAnchorKeyword(name: string): boolean {
  const lower = name.toLowerCase();
  return ANCHOR_KEYWORDS.some((kw) => lower.includes(kw));
}

function detectAnchorKeys(
  oldRows: Record<string, unknown>[],
  newRows: Record<string, unknown>[],
  oldMeta: ColumnMeta[],
  newMeta: ColumnMeta[],
): { anchorOld: string | null; anchorNew: string | null; anchorOverlapPct: number | null } {
  // Candidate columns: name contains anchor keyword + not too-low cardinality
  const oldCandidates = oldMeta.filter(
    (m) => isAnchorKeyword(m.name) && m.uniqueRatio > 0.01 && m.noisyType === 'NORMAL',
  );
  const newCandidates = newMeta.filter(
    (m) => isAnchorKeyword(m.name) && m.uniqueRatio > 0.01 && m.noisyType === 'NORMAL',
  );

  if (oldCandidates.length === 0 || newCandidates.length === 0) {
    return { anchorOld: null, anchorNew: null, anchorOverlapPct: null };
  }

  let bestOld: string | null = null;
  let bestNew: string | null = null;
  let bestScore = -1;

  for (const oc of oldCandidates) {
    // Build full value set from all sample rows (not just uniqueValues which is capped at 200)
    const oldVals = new Set(
      oldRows.map((r) => String(r[oc.name] ?? '')).filter((v) => v !== '' && v !== 'null' && v !== 'undefined'),
    );
    if (oldVals.size === 0) continue;

    for (const nc of newCandidates) {
      const newVals = new Set(
        newRows.map((r) => String(r[nc.name] ?? '')).filter((v) => v !== '' && v !== 'null' && v !== 'undefined'),
      );
      if (newVals.size === 0) continue;

      // Overlap: % of old values that appear in new
      let overlap = 0;
      for (const v of oldVals) {
        if (newVals.has(v)) overlap++;
      }
      const score = overlap / oldVals.size;

      if (score > bestScore) {
        bestScore = score;
        bestOld = oc.name;
        bestNew = nc.name;
      }
    }
  }

  // Require at least 20% overlap — below that it's likely noise
  if (bestScore < 0.2) {
    return { anchorOld: null, anchorNew: null, anchorOverlapPct: bestScore > 0 ? Math.round(bestScore * 100) : null };
  }

  return {
    anchorOld: bestOld,
    anchorNew: bestNew,
    anchorOverlapPct: Math.round(bestScore * 100),
  };
}

// ----------------------------------------------------------------
// Main matcher
// ----------------------------------------------------------------

export function matchColumns(
  oldRows: Record<string, unknown>[],
  newRows: Record<string, unknown>[],
  oldColumns: string[],
  newColumns: string[],
): MatcherResult {
  const oldMeta = oldColumns.map((c) => buildColumnMeta(c, oldRows));
  const newMeta = newColumns.map((c) => buildColumnMeta(c, newRows));

  const usedNewCols = new Set<string>();
  const matches: ColumnMatch[] = [];

  for (const om of oldMeta) {
    // --- REGENERATED_ID: exact column named "id" with 15+ digit integer values ---
    if (
      om.name.toLowerCase() === 'id' &&
      om.inferredType === 'numeric' &&
      om.sampleValues.some((v) => LARGE_INT_PATTERN.test(v.replace(/\..*/, '')))
    ) {
      matches.push({
        oldCol: om, newCol: null, nameSim: 0, typeSim: 0, valueSim: 0,
        confidence: 0, status: 'REGENERATED_ID', transformHint: 'NONE',
      });
      continue;
    }

    // --- Noisy columns ---
    if (om.noisyType === 'NULL') {
      matches.push({ oldCol: om, newCol: null, nameSim: 0, typeSim: 0, valueSim: 0, confidence: 0, status: 'NULL_COLUMN', transformHint: 'NONE' });
      continue;
    }
    if (om.noisyType === 'ZERO') {
      matches.push({ oldCol: om, newCol: null, nameSim: 0, typeSim: 0, valueSim: 0, confidence: 0, status: 'ZERO_COLUMN', transformHint: 'NONE' });
      continue;
    }
    if (om.noisyType === 'BOOLEAN') {
      matches.push({ oldCol: om, newCol: null, nameSim: 0, typeSim: 0, valueSim: 0, confidence: 0, status: 'BOOLEAN_COLUMN', transformHint: 'NONE' });
      continue;
    }

    // --- Score all new columns ---
    let bestScore    = -1;
    let bestNm: ColumnMeta | null = null;
    let bestNameSim  = 0;
    let bestTypeSim  = 0;
    let bestValueSim = 0;

    for (const nm of newMeta) {
      const ns = TransformUtils.stringSimilarity(om.name, nm.name);
      const ts = typeSim(om.inferredType, nm.inferredType);
      const vs = valueSim(om, nm);
      const conf = ns * 0.6 + ts * 0.2 + vs * 0.2;

      if (conf > bestScore) {
        bestScore    = conf;
        bestNm       = nm;
        bestNameSim  = ns;
        bestTypeSim  = ts;
        bestValueSim = vs;
      }
    }

    const confidence = bestScore;

    // --- Determine status ---
    let status: MatchStatus;

    // SAME_NAME_DIFF_DATA: close name match but zero value overlap for string columns
    // Catches cases like old.accountno ≠ new.accountno (account renumbered in migration)
    if (
      bestNameSim > 0.85 &&
      bestValueSim < 0.1 &&
      om.inferredType === 'string' &&
      bestNm?.inferredType === 'string' &&
      om.uniqueRatio > 0.05 &&
      (bestNm?.uniqueRatio ?? 0) > 0.05
    ) {
      status = 'SAME_NAME_DIFF_DATA';
    } else if (confidence >= 0.9 && bestTypeSim === 1.0) {
      status = 'VERIFIED';
    } else if (confidence >= 0.7) {
      status = 'PROBABLE';
    } else if (confidence >= 0.5) {
      status = 'MANUAL_CHECK';
    } else {
      status = 'NO_MATCH';
    }

    const hint = bestNm ? detectTransformHint(om, bestNm) : 'NONE';

    if (bestNm && status !== 'NO_MATCH' && status !== 'SAME_NAME_DIFF_DATA') {
      usedNewCols.add(bestNm.name);
    }

    matches.push({
      oldCol: om,
      newCol: bestNm,
      nameSim: bestNameSim,
      typeSim: bestTypeSim,
      valueSim: bestValueSim,
      confidence,
      status,
      transformHint: hint,
    });
  }

  const unmatchedNew = newColumns.filter((c) => !usedNewCols.has(c));

  // --- Anchor key detection (cross-table value overlap) ---
  const { anchorOld, anchorNew, anchorOverlapPct } = detectAnchorKeys(
    oldRows, newRows, oldMeta, newMeta,
  );

  return { matches, anchorOld, anchorNew, anchorOverlapPct, unmatchedNew };
}
