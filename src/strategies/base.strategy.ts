import { Logger } from '@nestjs/common';
import { DatabaseService, tableRef } from '../database/database.service';
import { CommonRule, DefRule, NoisyColumnType, SchemaMappings, ValidationError } from '../rules/rule.types';
import { TransformUtils } from './transform.utils';

export interface ValidationContext {
  commonRule: CommonRule;
  defRules: DefRule[];
  affectCodeMap: Map<string, string>;
}

export abstract class BaseStrategy {
  protected readonly logger: Logger;
  protected readonly db: DatabaseService;

  protected readonly FALLBACK_SIMILARITY_THRESHOLD = 0.9;

  // Common name variants for the affect code column (case-insensitive check)
  protected static readonly AFFECT_CODE_VARIANTS = [
    'affectcode', 'affect_code', 'afcode', 'affcode',
    'affect_cd',  'affectcd',   'af_code', 'aff_code',
  ];

  constructor(db: DatabaseService) {
    this.db = db;
    this.logger = new Logger(this.constructor.name);
  }

  abstract validate(ctx: ValidationContext): Promise<{ errors: ValidationError[]; rowsChecked: number }>;

  // ----------------------------------------------------------------
  // Schema helpers
  // ----------------------------------------------------------------

  protected async checkMissingColumns(
    source: string,
    target: string,
    expectedMappings: { oldCols: string[]; newCols: string[] }[],
  ): Promise<ValidationError[]> {
    const errors: ValidationError[] = [];
    const sourceCols = new Set(await this.getColumnNames(source));
    const targetCols = new Set(await this.getColumnNames(target));

    for (const mapping of expectedMappings) {
      for (const col of mapping.oldCols) {
        if (!sourceCols.has(col)) {
          errors.push({
            errorType: 'COLUMN_MISSING',
            oldColumn: col,
            message: `Column [${col}] not found in source table [${source}]`,
          });
        }
      }
      for (const col of mapping.newCols) {
        if (!targetCols.has(col)) {
          errors.push({
            errorType: 'COLUMN_MISSING',
            newColumn: col,
            message: `Column [${col}] not found in target table [${target}]`,
          });
        }
      }
    }

    return errors;
  }

  /**
   * Resilient schema handling (Issue #1).
   *
   * Instead of aborting when columns are missing, filter the schema_mappings
   * to remove any mapping that references a missing column and return the
   * reduced set. The caller logs the column errors and continues validating
   * with whatever columns DO exist.
   *
   * Only aborts (returns null) if BOTH source and target have zero valid
   * mappings left — meaning there is nothing to compare at all.
   */
  protected filterMappingsAfterSchemaCheck(
    sm: SchemaMappings,
    colErrors: ValidationError[],
  ): SchemaMappings {
    if (colErrors.length === 0) return sm;

    const missingOld = new Set(colErrors.filter((e) => e.oldColumn).map((e) => e.oldColumn!));
    const missingNew = new Set(colErrors.filter((e) => e.newColumn).map((e) => e.newColumn!));

    return {
      exact_matches: (sm.exact_matches ?? []).filter(
        (m) => !missingOld.has(m.old) && !missingNew.has(m.new),
      ),
      split_matches: (sm.split_matches ?? []).filter(
        (m) => !missingOld.has(m.old) && !m.new_cols.some((c) => missingNew.has(c)),
      ),
      transformed_matches: (sm.transformed_matches ?? []).filter(
        (m) => !missingOld.has(m.old) && !missingNew.has(m.new),
      ),
      concat_matches: (sm.concat_matches ?? []).filter(
        (m) => !m.old_cols.some((c) => missingOld.has(c)) && !missingNew.has(m.new),
      ),
      formula_matches: (sm.formula_matches ?? []).filter(
        (m) => !m.old_cols.some((c) => missingOld.has(c)) && !missingNew.has(m.new),
      ),
      filtered_sum_matches: (sm.filtered_sum_matches ?? []).filter(
        (m) => !missingOld.has(m.old) && !missingNew.has(m.new),
      ),
      // L3: filter pivot_matches the same way as other mapping types.
      pivot_matches: (sm.pivot_matches ?? []).filter(
        (m) => !missingOld.has(m.value_col) && !missingNew.has(m.new_col),
      ),
    };
  }

  protected async getColumnNames(tableName: string): Promise<string[]> {
    // C10: parse [db].[schema].[table] — capture schema to filter INFORMATION_SCHEMA correctly.
    // Without TABLE_SCHEMA filter, DBs with the same table in multiple schemas return duplicate
    // columns → false COLUMN_MISSING errors or incorrect schema checks.
    const crossDb = tableName.match(/\[([^\]]+)\]\.(?:\[?([^\[\].]+)\]?\.)?\[([^\]]+)\]/);
    if (crossDb) {
      const [, db, schema, tbl] = crossDb;
      const schemaFilter = schema ? `AND TABLE_SCHEMA = '${schema}'` : `AND TABLE_SCHEMA = 'dbo'`;
      const rows = await this.db.query<{ COLUMN_NAME: string }>(
        `SELECT COLUMN_NAME FROM [${db}].INFORMATION_SCHEMA.COLUMNS ` +
        `WHERE TABLE_NAME = '${tbl}' ${schemaFilter} ORDER BY ORDINAL_POSITION`,
      );
      return rows.map((r) => r.COLUMN_NAME);
    }
    // Simple table name (no cross-db ref) — default to dbo schema
    const rows = await this.db.query<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS ` +
      `WHERE TABLE_NAME = '${tableName}' AND TABLE_SCHEMA = 'dbo' ORDER BY ORDINAL_POSITION`,
    );
    return rows.map((r) => r.COLUMN_NAME);
  }

  // ----------------------------------------------------------------
  // Noisy column detection
  // ----------------------------------------------------------------

  protected async detectNoisyColumns(
    table: string,
    columns: string[],
  ): Promise<Map<string, NoisyColumnType>> {
    const result = new Map<string, NoisyColumnType>();
    if (columns.length === 0) return result;

    let sample: Record<string, unknown>[];
    try {
      sample = await this.db.sampleRows(table, 1000);
    } catch (e: unknown) {
      this.logger.warn(
        `[noisy-col] sampleRows failed for [${table}] — all columns treated as NORMAL. Cause: ${(e as Error)?.message ?? String(e)}`,
      );
      columns.forEach((c) => result.set(c, 'NORMAL'));
      return result;
    }

    for (const col of columns) {
      const values = sample.map((r) => r[col]);

      if (TransformUtils.isNullColumn(values)) {
        result.set(col, 'NULL');
      } else if (TransformUtils.isBooleanColumn(values)) {
        result.set(col, 'BOOLEAN');
      } else if (TransformUtils.isZeroColumn(values)) {
        result.set(col, 'ZERO');
      } else {
        result.set(col, 'NORMAL');
      }
    }

    return result;
  }

  protected isNoisyType(type: NoisyColumnType | undefined): boolean {
    return type === 'NULL' || type === 'ZERO' || type === 'BOOLEAN';
  }

  // ----------------------------------------------------------------
  // Fallback auto-match
  // ----------------------------------------------------------------

  protected async findFallbackMappings(
    sourceTable: string,
    targetTable: string,
    mappedOldCols: Set<string>,
    mappedNewCols: Set<string>,
  ): Promise<Array<{ old: string; new: string; similarity: number }>> {
    const allSourceCols = await this.getColumnNames(sourceTable);
    const allTargetCols = await this.getColumnNames(targetTable);

    const unmappedOld = allSourceCols.filter((c) => !mappedOldCols.has(c));
    const unmappedNew = allTargetCols.filter((c) => !mappedNewCols.has(c));

    if (unmappedOld.length === 0 || unmappedNew.length === 0) return [];

    const matches: Array<{ old: string; new: string; similarity: number }> = [];

    for (const oldCol of unmappedOld) {
      let bestSim = 0;
      let bestNew = '';
      for (const newCol of unmappedNew) {
        const sim = TransformUtils.stringSimilarity(oldCol, newCol);
        if (sim > bestSim) { bestSim = sim; bestNew = newCol; }
      }
      if (bestSim >= this.FALLBACK_SIMILARITY_THRESHOLD && bestNew) {
        matches.push({ old: oldCol, new: bestNew, similarity: bestSim });
      }
    }

    return matches;
  }

  /**
   * Reports DB columns that exist in either table but are not covered by any mapping.
   * Pushes one DATA_MISSING error per table that has unmapped columns.
   * Does NOT attempt auto-matching — reporting only.
   */
  protected async reportUnmappedColumns(
    source: string,
    target: string,
    sm: SchemaMappings,
    tag: string,
  ): Promise<ValidationError[]> {
    const errors: ValidationError[] = [];

    const mappedOld = new Set<string>([
      ...(sm.exact_matches ?? []).map((m) => m.old),
      ...(sm.split_matches ?? []).map((m) => m.old),
      ...(sm.transformed_matches ?? []).map((m) => m.old),
      ...(sm.concat_matches ?? []).flatMap((m) => m.old_cols),
      ...(sm.formula_matches ?? []).flatMap((m) => m.old_cols),
      ...(sm.filtered_sum_matches ?? []).map((m) => m.old),
      ...(sm.pivot_matches ?? []).map((m) => m.value_col),
    ]);

    const mappedNew = new Set<string>([
      ...(sm.exact_matches ?? []).map((m) => m.new),
      ...(sm.split_matches ?? []).flatMap((m) => m.new_cols),
      ...(sm.transformed_matches ?? []).map((m) => m.new),
      ...(sm.concat_matches ?? []).map((m) => m.new),
      ...(sm.formula_matches ?? []).map((m) => m.new),
      ...(sm.filtered_sum_matches ?? []).map((m) => m.new),
      ...(sm.pivot_matches ?? []).map((m) => m.new_col),
    ]);

    const [allOld, allNew] = await Promise.all([
      this.getColumnNames(source),
      this.getColumnNames(target),
    ]);

    const unmappedOld = allOld.filter((c) => !mappedOld.has(c));
    const unmappedNew = allNew.filter((c) => !mappedNew.has(c));

    if (unmappedOld.length > 0) {
      this.logger.warn(
        `[${tag}] ${unmappedOld.length} source column(s) in [${source}] not covered by any mapping: ${unmappedOld.join(', ')}`,
      );
      errors.push({
        errorType: 'DATA_MISSING',
        message: `[${tag}] Source [${source}] has ${unmappedOld.length} unmapped column(s): ${unmappedOld.join(', ')}`,
      });
    }

    if (unmappedNew.length > 0) {
      this.logger.warn(
        `[${tag}] ${unmappedNew.length} target column(s) in [${target}] not covered by any mapping: ${unmappedNew.join(', ')}`,
      );
      errors.push({
        errorType: 'DATA_MISSING',
        message: `[${tag}] Target [${target}] has ${unmappedNew.length} unmapped column(s): ${unmappedNew.join(', ')}`,
      });
    }

    return errors;
  }

  // ----------------------------------------------------------------
  // Anchor key uniqueness
  // ----------------------------------------------------------------

  /**
   * Checks that anchorKey has no duplicate values in the given table.
   * Duplicate anchor keys break keyset pagination — rows are silently skipped.
   * Uses TOP 1 … HAVING COUNT(*) > 1 so it short-circuits on the first duplicate found.
   * Returns a TRANSFORM_ERROR if duplicates exist, null if clean, null if the check fails.
   */
  protected async checkAnchorKeyUnique(
    table: string,
    anchorKey: string,
  ): Promise<ValidationError | null> {
    try {
      const rows = await this.db.query<{ dupe_key: unknown }>(
        `SELECT TOP 1 [${anchorKey}] as dupe_key
         FROM ${tableRef(table)}
         GROUP BY [${anchorKey}]
         HAVING COUNT(*) > 1`,
      );
      if (rows.length > 0) {
        return {
          errorType: 'TRANSFORM_ERROR',
          message:
            `Anchor key [${anchorKey}] has duplicate values in [${table}] ` +
            `(first duplicate: "${rows[0].dupe_key}") — keyset streaming may skip rows, results unreliable`,
        };
      }
      return null;
    } catch {
      // Silently skip if the check itself fails (e.g. cross-db permission issues)
      return null;
    }
  }

  // ----------------------------------------------------------------
  // Def rule evaluation (shared by TransactionStrategy and group-mode MultipleStrategy)
  // ----------------------------------------------------------------

  protected runDefRules(
    groupKey: string,
    oldGroup: Record<string, unknown>[],
    newGroup: Record<string, unknown>[],
    defRules: DefRule[],
    affectCodeMap: Map<string, string>,
    tolerance: number,
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const def of defRules) {
      if (def.trigger_condition?.must_have_all || def.trigger_condition?.must_have_any) {
        const oldAffectCodes = this.extractAffectCodes(oldGroup, affectCodeMap);

        if (def.trigger_condition.must_have_all) {
          const hasAll = def.trigger_condition.must_have_all.every((code) =>
            oldAffectCodes.has(code),
          );
          if (!hasAll) continue;
        }

        if (def.trigger_condition.must_have_any) {
          const hasAny = def.trigger_condition.must_have_any.some((code) =>
            oldAffectCodes.has(code),
          );
          if (!hasAny) continue;
        }
      }

      for (const action of def.actions) {
        // Per-action trigger_condition — e.g. step 7 only fires when group has PP rows
        if (action.trigger_condition?.must_have_all || action.trigger_condition?.must_have_any) {
          const oldAffectCodes = this.extractAffectCodes(oldGroup, affectCodeMap);
          if (action.trigger_condition.must_have_all) {
            if (!action.trigger_condition.must_have_all.every((code) => oldAffectCodes.has(code))) continue;
          }
          if (action.trigger_condition.must_have_any) {
            if (!action.trigger_condition.must_have_any.some((code) => oldAffectCodes.has(code))) continue;
          }
        }
        errors.push(...this.evaluateDefAction(def.def_id, groupKey, oldGroup, newGroup, action, tolerance));
      }
    }

    return errors;
  }

  protected evaluateDefAction(
    defId: string,
    groupKey: string,
    oldGroup: Record<string, unknown>[],
    newGroup: Record<string, unknown>[],
    action: any,
    tolerance: number,
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    if (action.check_type === 'ROW_LEVEL_COHESION') {
      const resolvedVars: Record<string, number> = {};

      // Evaluate all variable expressions — catch per-variable so other DEF rules still run.
      try {
        for (const [varName, expr] of Object.entries(action.variables ?? {})) {
          resolvedVars[varName] = this.evaluateExpression(String(expr), oldGroup, newGroup);
        }
      } catch (e: any) {
        errors.push({
          errorType: 'TRANSFORM_ERROR',
          defId,
          groupKey,
          message: `DEF rule expression error (${defId}): ${e.message}`,
        });
        return errors;
      }

      let conditionMet: boolean;
      try {
        conditionMet = this.evaluateCondition(action.condition, resolvedVars, tolerance);
      } catch (e: any) {
        errors.push({
          errorType: 'TRANSFORM_ERROR',
          defId,
          groupKey,
          message: `DEF condition evaluation error (${defId}): ${e.message}`,
        });
        return errors;
      }

      if (!conditionMet) {
        // Interpolate {var_name} placeholders in error_message with resolved values
        const interpolated = String(action.error_message ?? '').replace(
          /\{(val_\w+)\}/g,
          (_, name) => (name in resolvedVars ? String(resolvedVars[name]) : `{${name}}`),
        );
        errors.push({
          errorType: 'DEFECT_VIOLATION',
          defId,
          groupKey,
          message: interpolated,
        });
      }
    }

    if (action.check_type === 'FIELD_VALUE_CHECK') {
      // Variables:
      //   new_col: column in new rows to validate
      //   old_col: column in old rows (optional, for skip-count logic)
      //   skip_if_old_equals: literal value — if old row's old_col equals this, it "permits"
      //                       one matching bad value in new (e.g. old CONV rows → new CONV allowed)
      //   fail_if_new_matches: regex pattern — any new row whose new_col matches this fails
      const newCol: string = action.variables?.new_col ?? '';
      const oldCol: string = action.variables?.old_col ?? '';
      const skipIfOldEquals: string = action.variables?.skip_if_old_equals ?? '';
      const failPattern: string = action.variables?.fail_if_new_matches ?? '';

      if (!newCol || !failPattern) {
        errors.push({
          errorType: 'TRANSFORM_ERROR',
          defId,
          groupKey,
          message: `DEF ${defId}: FIELD_VALUE_CHECK requires variables.new_col and variables.fail_if_new_matches`,
        });
        return errors;
      }

      let regex: RegExp;
      try {
        regex = new RegExp(failPattern, 'i');
      } catch {
        errors.push({
          errorType: 'TRANSFORM_ERROR',
          defId,
          groupKey,
          message: `DEF ${defId}: FIELD_VALUE_CHECK — invalid regex pattern: "${failPattern}"`,
        });
        return errors;
      }

      // Count how many old rows have the skip value — each permits one bad new row
      const skipCount = (skipIfOldEquals && oldCol)
        ? oldGroup.filter((r) =>
            String(r[oldCol] ?? '').trim().toUpperCase() === skipIfOldEquals.toUpperCase(),
          ).length
        : 0;

      // Collect bad new rows (those whose new_col matches the fail pattern)
      const badNewRows = newGroup.filter((r) => regex.test(String(r[newCol] ?? '').trim()));
      const badCount = badNewRows.length;

      const excessBad = badCount - skipCount;
      if (excessBad > 0) {
        // Distinct bad new values — what actually ended up in new (useful for report)
        const badNewVals = [...new Set(badNewRows.map((r) => String(r[newCol] ?? '').trim()))];

        // Distinct old values that SHOULD have been converted
        // (old values that are NOT the skip value — these are the original codes to fix)
        const unconvertedOldVals = (oldCol && oldGroup.length > 0)
          ? [
              ...new Set(
                oldGroup
                  .filter((r) =>
                    skipIfOldEquals
                      ? String(r[oldCol] ?? '').trim().toUpperCase() !== skipIfOldEquals.toUpperCase()
                      : true,
                  )
                  .map((r) => String(r[oldCol] ?? '').trim())
                  .filter((v) => v !== ''),
              ),
            ]
          : [];

        const detail = unconvertedOldVals.length > 0
          ? `old ${oldCol}: [${unconvertedOldVals.join(', ')}] → new ${newCol}: [${badNewVals.join(', ')}]`
          : `new ${newCol}: [${badNewVals.join(', ')}]`;

        errors.push({
          errorType: 'DEFECT_VIOLATION',
          defId,
          groupKey,
          message: `${action.error_message} — ${detail}`,
        });
      }
    }

    return errors;
  }

  /**
   * Evaluates a DEF variable expression against old and/or new rows.
   *
   * Supported formats:
   *   SUM(old.col)                       — sum of col across all old rows
   *   SUM(new.col)                       — sum of col across all new rows
   *   SUM(old.col[f1=v1][f2=v2]...)      — conditional sum (one or more bracket filters AND-ed)
   *   SUM(old.col) WHERE filterCol == 'val'  — same as bracket filter (legacy syntax)
   *   COUNT(old)                         — number of old rows in this group
   *   COUNT(new)                         — number of new rows in this group
   */
  protected evaluateExpression(
    expr: string,
    oldRows: Record<string, unknown>[],
    newRows: Record<string, unknown>[],
  ): number {
    const t = expr.trim();

    // SUM(old.col) WHERE filterCol == 'val'  — legacy WHERE filter syntax
    const whereMatch = t.match(/^SUM\(old\.(\w+)\)\s+WHERE\s+(\w+)\s*==\s*'([^']+)'$/i);
    if (whereMatch) {
      const [, col, filterCol, filterVal] = whereMatch;
      return oldRows
        .filter((r) => String(r[filterCol] ?? '').toUpperCase() === filterVal.toUpperCase())
        .reduce((sum, r) => sum + (parseFloat(String(r[col] ?? 0)) || 0), 0);
    }

    // SUM(old.col[f1=v1][f2=v2]...)  — one or more bracket filters (shorter YAML syntax)
    const bracketMatch = t.match(/^SUM\(old\.(\w+)((?:\[[^\]]+\])+)\)$/i);
    if (bracketMatch) {
      const [, col, bracketStr] = bracketMatch;
      const conditions = [...bracketStr.matchAll(/\[(\w+)=([^\]]+)\]/g)].map(
        (m) => [m[1], m[2].trim()] as [string, string],
      );
      return oldRows
        .filter((r) =>
          conditions.every(
            ([filterCol, filterVal]) =>
              String(r[filterCol] ?? '').toUpperCase() === filterVal.toUpperCase(),
          ),
        )
        .reduce((sum, r) => sum + (parseFloat(String(r[col] ?? 0)) || 0), 0);
    }

    // SUM(old.col)  — plain sum across all old rows
    const oldSumMatch = t.match(/^SUM\(old\.(\w+)\)$/i);
    if (oldSumMatch) {
      return oldRows.reduce((sum, r) => sum + (parseFloat(String(r[oldSumMatch[1]] ?? 0)) || 0), 0);
    }

    // SUM(new.col)  — plain sum across all new rows
    const newSumMatch = t.match(/^SUM\(new\.(\w+)\)$/i);
    if (newSumMatch) {
      return newRows.reduce((sum, r) => sum + (parseFloat(String(r[newSumMatch[1]] ?? 0)) || 0), 0);
    }

    // COUNT(old) / COUNT(new)
    if (/^COUNT\(old\)$/i.test(t)) return oldRows.length;
    if (/^COUNT\(new\)$/i.test(t)) return newRows.length;

    throw new Error(
      `DEF rule expression not parseable: "${expr}" — ` +
      `supported: SUM(old.col), SUM(new.col), SUM(old.col[f1=v1][f2=v2]...), COUNT(old), COUNT(new)`,
    );
  }

  /**
   * Evaluates a DEF condition string after variable substitution.
   *
   * All variables in `vars` are substituted by value, then the expression is
   * evaluated as JavaScript arithmetic. The `==` operator is treated as a
   * tolerance-aware equality check: Math.abs(left - right) <= tolerance.
   *
   * Examples:
   *   "val_a == val_b"            → Math.abs(a - b) <= tolerance
   *   "val_a + val_b == 0"        → Math.abs((a + b) - 0) <= tolerance
   *   "val_credit == 0"           → Math.abs(credit - 0) <= tolerance
   */
  protected evaluateCondition(
    condition: string,
    vars: Record<string, number>,
    tolerance: number,
  ): boolean {
    // Substitute all variable names with their numeric values.
    // Word-boundary matching ensures val_credit won't partially replace val_credit_interest.
    let expr = condition;
    for (const [name, value] of Object.entries(vars)) {
      expr = expr.replace(new RegExp(`\\b${name}\\b`, 'g'), String(value));
    }

    // Find a standalone == (not part of !=, <=, >=) and rewrite as tolerance-aware comparison.
    const eqIdx = expr.search(/(?<![!<>=])==(?!=)/);
    if (eqIdx >= 0) {
      const left = expr.slice(0, eqIdx).trim();
      const right = expr.slice(eqIdx + 2).trim();
      try {
        // eslint-disable-next-line no-new-func
        const lv = new Function(`return (${left});`)() as number;
        // eslint-disable-next-line no-new-func
        const rv = new Function(`return (${right});`)() as number;
        return Math.abs(lv - rv) <= tolerance;
      } catch (e: any) {
        throw new Error(
          `DEF condition evaluation failed: "${condition}" (left="${left}", right="${right}"): ${e.message}`,
        );
      }
    }

    // No == — evaluate as a boolean expression (e.g. "val_a > 0")
    try {
      // eslint-disable-next-line no-new-func
      return !!new Function(`return (${expr});`)();
    } catch (e: any) {
      throw new Error(`DEF condition evaluation failed: "${condition}": ${e.message}`);
    }
  }

  /**
   * Normalizes a fingerprint column value so old and new produce the same string.
   * - Date object (mssql datetime2) → toISOString().slice(0,10)
   * - ISO nvarchar "2024-01-15T..." → extract date before T
   * - Numeric string / number → parseFloat (strips trailing zeros)
   * - Other → trim to string
   */
  protected normalizeFingerprint(v: unknown): string {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const s = String(v ?? '').trim();
    const dateMatch = s.match(/^(\d{4}-\d{2}-\d{2})T/);
    if (dateMatch) return dateMatch[1];
    const n = parseFloat(s);
    if (!isNaN(n) && s !== '') return String(n);
    return s;
  }

  /**
   * Row-level fingerprint diff — call after validateGroup finds errors.
   * Diffs old vs new as multisets by joining fpCols values with '|'.
   * Reports ROW_MISSING with [FP] prefix for unmatched rows.
   */
  protected fingerprintDiff(
    groupKey: string,
    oldGroup: Record<string, unknown>[],
    newGroup: Record<string, unknown>[],
    fpCols: Array<{ old: string; new: string }>,
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    const buildMultiset = (
      rows: Record<string, unknown>[],
      colKey: (c: { old: string; new: string }) => string,
    ): Map<string, number> => {
      const map = new Map<string, number>();
      for (const row of rows) {
        const fp = fpCols.map((c) => this.normalizeFingerprint(row[colKey(c)])).join('|');
        map.set(fp, (map.get(fp) ?? 0) + 1);
      }
      return map;
    };

    const oldMs = buildMultiset(oldGroup, (c) => c.old);
    const newMs = buildMultiset(newGroup, (c) => c.new);

    for (const [fp, cnt] of oldMs) {
      const missing = cnt - (newMs.get(fp) ?? 0);
      if (missing > 0) {
        errors.push({
          errorType: 'ROW_MISSING',
          groupKey,
          message: `[FP] ${missing}x in source not in target — group: ${groupKey} | ${fp}`,
        });
      }
    }
    for (const [fp, cnt] of newMs) {
      const extra = cnt - (oldMs.get(fp) ?? 0);
      if (extra > 0) {
        errors.push({
          errorType: 'ROW_MISSING',
          groupKey,
          message: `[FP] ${extra}x extra in target not in source — group: ${groupKey} | ${fp}`,
        });
      }
    }
    return errors;
  }

  protected sumColumn(rows: Record<string, unknown>[], col: string): number | null {
    const vals = rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined);
    if (vals.length === 0) return null;
    const nums = vals.map((v) => parseFloat(String(v)));
    if (nums.some(isNaN)) return null;
    return nums.reduce((a, b) => a + b, 0);
  }

  protected extractAffectCodes(
    rows: Record<string, unknown>[],
    affectCodeMap: Map<string, string>,
  ): Set<string> {
    const codeSet = new Set<string>();
    if (rows.length === 0) return codeSet;

    // Locate the affect code column once — handles any casing and all known name variants.
    const rowKeys = Object.keys(rows[0]);
    const colName = rowKeys.find((k) =>
      BaseStrategy.AFFECT_CODE_VARIANTS.includes(k.toLowerCase()),
    );

    if (!colName) {
      this.logger.warn(
        `No affect code column found (checked: ${BaseStrategy.AFFECT_CODE_VARIANTS.join(', ')}) — ` +
        `trigger_condition checks will be skipped`,
      );
      return codeSet;
    }

    for (const row of rows) {
      const val = row[colName];
      if (val == null) continue;
      const str = String(val).toUpperCase();
      if (affectCodeMap.has(str)) codeSet.add(str);
    }
    return codeSet;
  }
}
