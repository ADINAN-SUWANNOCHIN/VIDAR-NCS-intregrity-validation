import { TransformRule } from '../rules/rule.types';

export class TransformUtils {
  /**
   * Apply transform rule ให้กับค่าก่อนเทียบ
   */
  static apply(value: unknown, rule: TransformRule): string | null {
    if (value === null || value === undefined) return null;
    const str = String(value).trim();
    if (str === '') return null; // empty string treated as "no value" — same as null

    switch (rule) {
      case 'STRIP_LEADING_ZEROS':
        return str.replace(/^0+/, '') || '0';

      case 'STRIP_SPECIAL_CHARS':
        return str.replace(/[^a-zA-Z0-9]/g, '');

      case 'DATE_TO_DATETIME':
        // Normalize to YYYY-MM-DD for comparison
        // Handles: "2008-11-30", "2021-02-05T00:00:00.000+07:00", "2021-02-05T00:00:00.000Z"
        return str.split('T')[0].split(' ')[0].substring(0, 10);

      case 'SPLIT_FIRST':
        // Composite key split: "123450002" → "12345" (last 4 chars are the suffix)
        // Adjust suffix length via common.yaml if needed — currently hardcoded to 4
        return str.substring(0, str.length - 4);

      case 'SPLIT_SECOND':
        return str.substring(str.length - 4);

      case 'CONCAT':
        // Single-value CONCAT is an identity — actual multi-column concatenation
        // is handled at strategy level via ConcatMatch (see schema_mappings.concat_matches)
        return str;

      case 'NONE':
      default:
        return str;
    }
  }

  /**
   * เทียบค่าสองค่า โดยรองรับ tolerance สำหรับ floating point
   */
  static isEqual(oldVal: unknown, newVal: unknown, tolerance = 0): boolean {
    // Normalise: empty string == null (migration fills null where old had "")
    const norm = (v: unknown) => (v === '' || v === null || v === undefined) ? null : v;
    const a = norm(oldVal);
    const b = norm(newVal);
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    // reassign for comparison below
    oldVal = a; newVal = b;

    const oldNum = parseFloat(String(oldVal));
    const newNum = parseFloat(String(newVal));

    if (!isNaN(oldNum) && !isNaN(newNum)) {
      return Math.abs(oldNum - newNum) <= tolerance;
    }

    return String(oldVal).trim().toLowerCase() === String(newVal).trim().toLowerCase();
  }

  /**
   * ตรวจสอบว่า column เป็น "null column" (ทุก row เป็น null)
   * ถ้าใช่ ให้ match แค่ชื่อ column
   */
  static isNullColumn(values: unknown[]): boolean {
    return values.length > 0 && values.every((v) => v === null || v === undefined);
  }

  /**
   * ตรวจสอบว่า column เป็น "zero column" (ทุก row เป็น 0 หรือ null)
   */
  static isZeroColumn(values: unknown[]): boolean {
    return (
      values.length > 0 &&
      values.every((v) => v === 0 || v === '0' || v === null || v === undefined)
    );
  }

  /**
   * ตรวจสอบว่า column เป็น "boolean column" (มีแค่ 0/1 — ไม่นับ null)
   */
  static isBooleanColumn(values: unknown[]): boolean {
    const nonNull = values.filter((v) => v !== null && v !== undefined);
    if (nonNull.length === 0) return false;
    return nonNull.every((v) => v === 0 || v === 1 || v === '0' || v === '1');
  }

  /**
   * ประเมิน formula สำหรับ split column
   * เช่น SUM([debitinterest, creditinterest]) ต้องเท่ากับ interest เดิม
   */
  static evaluateFormula(
    formula: 'SUM' | 'SUBTRACT' | 'EXACT',
    values: unknown[],
  ): number {
    const nums = values.map((v) => parseFloat(String(v ?? 0)) || 0);
    switch (formula) {
      case 'SUM':
        return nums.reduce((a, b) => a + b, 0);
      case 'SUBTRACT':
        return nums.reduce((a, b, i) => (i === 0 ? a : a - b), nums[0] ?? 0);
      case 'EXACT':
        return nums[0] ?? 0;
    }
  }

  /**
   * Compute name similarity (0–1) using normalized Levenshtein distance.
   * Used for fallback column matching when a column is not in common.yaml.
   */
  static stringSimilarity(a: string, b: string): number {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    if (la === lb) return 1;
    const maxLen = Math.max(la.length, lb.length);
    if (maxLen === 0) return 1;
    return 1 - TransformUtils.levenshtein(la, lb) / maxLen;
  }

  private static levenshtein(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    // Use two rolling rows to keep memory O(n)
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    let curr = new Array<number>(n + 1);
    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        curr[j] =
          a[i - 1] === b[j - 1]
            ? prev[j - 1]
            : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
      }
      [prev, curr] = [curr, prev];
    }
    return prev[n];
  }
}
