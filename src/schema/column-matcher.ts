import { TransformUtils } from '../strategies/transform.utils';

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

export type InferredType = 'numeric' | 'string' | 'date' | 'boolean';

export type MatchStatus =
  | 'VERIFIED'
  | 'PROBABLE'
  | 'MANUAL_CHECK'
  | 'NO_MATCH'
  | 'NULL_COLUMN'
  | 'ZERO_COLUMN'
  | 'BOOLEAN_COLUMN';

export type TransformHint = 'DATE_TO_DATETIME' | 'STRIP_LEADING_ZEROS' | 'NONE';

export interface ColumnMeta {
  name: string;
  noisyType: 'NORMAL' | 'NULL' | 'ZERO' | 'BOOLEAN';
  inferredType: InferredType;
  sampleValues: string[];
  uniqueRatio: number;
  uniqueValues?: Set<string>;  // only when uniqueCount <= 200
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
  unmatchedNew: string[];
}

// ----------------------------------------------------------------
// Date regex
// ----------------------------------------------------------------

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/;
const LEADING_ZEROS_PATTERN = /^0+\d/;

// ----------------------------------------------------------------
// Build ColumnMeta from sample rows
// ----------------------------------------------------------------

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
    const dateCount = nonNullStr.filter((s) => DATE_PATTERN.test(s)).length;
    const ratio = (count: number) => count / nonNullStr.length;

    if (ratio(numericCount) > 0.8) {
      inferredType = 'numeric';
    } else if (ratio(dateCount) > 0.8) {
      inferredType = 'date';
    } else {
      inferredType = 'string';
    }
  }

  // Sample values (up to 5 non-null)
  const sampleValues = nonNullStr.slice(0, 5);

  // Unique ratio
  const uniqueSet = new Set(nonNullStr);
  const uniqueRatio = totalRows > 0 ? uniqueSet.size / totalRows : 0;

  // Numeric stats
  let mean: number | undefined;
  let min: number | undefined;
  let max: number | undefined;
  if (inferredType === 'numeric' && nonNullStr.length > 0) {
    const nums = nonNullStr.map((s) => parseFloat(s));
    min = Math.min(...nums);
    max = Math.max(...nums);
    mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  }

  // String unique values (if cardinality is low enough)
  let uniqueValues: Set<string> | undefined;
  if (inferredType === 'string' && uniqueSet.size <= 200) {
    uniqueValues = uniqueSet;
  }

  return { name: colName, noisyType, inferredType, sampleValues, uniqueRatio, uniqueValues, mean, min, max };
}

// ----------------------------------------------------------------
// Similarity functions
// ----------------------------------------------------------------

function typeSim(a: InferredType, b: InferredType): number {
  if (a === b) return 1.0;
  // Treat one unknown side as 'mixed'
  return 0.5;
}

function valueSim(old: ColumnMeta, neu: ColumnMeta): number {
  if (old.noisyType !== 'NORMAL' || neu.noisyType !== 'NORMAL') return 0;

  if (old.inferredType === 'numeric' && neu.inferredType === 'numeric') {
    // Overlap ratio: check if ranges share the same order-of-magnitude
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
    // Jaccard similarity: intersection / union
    let intersect = 0;
    for (const v of old.uniqueValues) {
      if (neu.uniqueValues.has(v)) intersect++;
    }
    const union = old.uniqueValues.size + neu.uniqueValues.size - intersect;
    return union > 0 ? intersect / union : 0;
  }

  return 0.5;
}

// ----------------------------------------------------------------
// Transform hint detection
// ----------------------------------------------------------------

function detectTransformHint(old: ColumnMeta, neu: ColumnMeta): TransformHint {
  if (old.inferredType === 'date' && neu.inferredType === 'date') return 'NONE';
  if (old.inferredType === 'string' && neu.inferredType === 'date') return 'DATE_TO_DATETIME';
  if (
    old.inferredType === 'string' &&
    neu.inferredType === 'numeric' &&
    old.sampleValues.some((v) => LEADING_ZEROS_PATTERN.test(v))
  ) {
    return 'STRIP_LEADING_ZEROS';
  }
  return 'NONE';
}

// ----------------------------------------------------------------
// Anchor key detection
// ----------------------------------------------------------------

const ANCHOR_KEYWORDS = ['accountno', 'referenceno', 'id', 'no', 'key', 'ref', 'code'];

function isAnchorCandidate(col: ColumnMeta): boolean {
  return col.uniqueRatio > 0.95 && col.inferredType === 'string';
}

function anchorPreference(name: string): number {
  const lower = name.toLowerCase();
  return ANCHOR_KEYWORDS.findIndex((kw) => lower.includes(kw));
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
  // Build meta for all columns
  const oldMeta = oldColumns.map((c) => buildColumnMeta(c, oldRows));
  const newMeta = newColumns.map((c) => buildColumnMeta(c, newRows));

  const usedNewCols = new Set<string>();
  const matches: ColumnMatch[] = [];

  for (const om of oldMeta) {
    // Determine match status for noisy columns immediately
    if (om.noisyType === 'NULL') {
      matches.push({
        oldCol: om, newCol: null, nameSim: 0, typeSim: 0, valueSim: 0,
        confidence: 0, status: 'NULL_COLUMN', transformHint: 'NONE',
      });
      continue;
    }
    if (om.noisyType === 'ZERO') {
      matches.push({
        oldCol: om, newCol: null, nameSim: 0, typeSim: 0, valueSim: 0,
        confidence: 0, status: 'ZERO_COLUMN', transformHint: 'NONE',
      });
      continue;
    }
    if (om.noisyType === 'BOOLEAN') {
      matches.push({
        oldCol: om, newCol: null, nameSim: 0, typeSim: 0, valueSim: 0,
        confidence: 0, status: 'BOOLEAN_COLUMN', transformHint: 'NONE',
      });
      continue;
    }

    // Score all new columns
    let bestScore = -1;
    let bestNm: ColumnMeta | null = null;
    let bestNameSim = 0;
    let bestTypeSim = 0;
    let bestValueSim = 0;

    for (const nm of newMeta) {
      const ns = TransformUtils.stringSimilarity(om.name, nm.name);
      const ts = typeSim(om.inferredType, nm.inferredType);
      const vs = valueSim(om, nm);
      const confidence = ns * 0.6 + ts * 0.2 + vs * 0.2;

      if (confidence > bestScore) {
        bestScore = confidence;
        bestNm = nm;
        bestNameSim = ns;
        bestTypeSim = ts;
        bestValueSim = vs;
      }
    }

    const confidence = bestScore;
    let status: MatchStatus;
    if (confidence >= 0.9 && bestTypeSim === 1.0) {
      status = 'VERIFIED';
    } else if (confidence >= 0.7) {
      status = 'PROBABLE';
    } else if (confidence >= 0.5) {
      status = 'MANUAL_CHECK';
    } else {
      status = 'NO_MATCH';
    }

    const hint = bestNm ? detectTransformHint(om, bestNm) : 'NONE';

    if (bestNm && status !== 'NO_MATCH') {
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

  // Unmatched new columns
  const unmatchedNew = newColumns.filter((c) => !usedNewCols.has(c));

  // Anchor key detection
  const oldAnchorCandidates = oldMeta.filter(isAnchorCandidate);
  const newAnchorCandidates = newMeta.filter(isAnchorCandidate);

  const pickAnchor = (candidates: ColumnMeta[]): string | null => {
    if (candidates.length === 0) return null;
    const sorted = [...candidates].sort((a, b) => {
      const pa = anchorPreference(a.name);
      const pb = anchorPreference(b.name);
      if (pa === -1 && pb === -1) return b.uniqueRatio - a.uniqueRatio;
      if (pa === -1) return 1;
      if (pb === -1) return -1;
      return pa - pb;
    });
    return sorted[0].name;
  };

  return {
    matches,
    anchorOld: pickAnchor(oldAnchorCandidates),
    anchorNew: pickAnchor(newAnchorCandidates),
    unmatchedNew,
  };
}
