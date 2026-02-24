import { DatabaseService } from '../database/database.service';
import { DefRule, NoisyColumnType, SchemaMappings, ValidationError } from '../rules/rule.types';
import { BaseStrategy, ValidationContext } from './base.strategy';
import { TransformUtils } from './transform.utils';

/**
 * Transaction Strategy — groups rows by groupKey (e.g. systemreferencenumber)
 * and compares group-level aggregates.
 *
 * Fix (Issue #2): No longer uses SELECT DISTINCT on the group key column.
 * Instead, streams by anchorKey (which has reliable ordering) and groups
 * rows in memory. This eliminates the need for any index on the group key.
 *
 * Fix (Issue #1): Schema errors on individual columns do NOT abort the job.
 * Missing columns are reported and those mappings are skipped; the rest continue.
 */
export class TransactionStrategy extends BaseStrategy {
  constructor(db: DatabaseService) {
    super(db);
  }

  async validate(ctx: ValidationContext): Promise<{ errors: ValidationError[]; rowsChecked: number }> {
    const errors: ValidationError[] = [];
    let rowsChecked = 0;
    const { commonRule, defRules, affectCodeMap } = ctx;
    const { source, target } = commonRule.table_info;
    const tg = commonRule.transaction_grouping;
    let sm = commonRule.schema_mappings;
    const tolerance = commonRule.defaults?.tolerance ?? 0;
    const anchorKeyOld = commonRule.anchor_key.old;
    const anchorKeyNew = commonRule.anchor_key.new;
    const chunkSize = parseInt(process.env.CHUNK_SIZE ?? '5000');

    if (!tg) {
      errors.push({
        errorType: 'TRANSFORM_ERROR',
        message: `Table ${source} is TRANSACTION type but has no transaction_grouping in common.yaml`,
      });
      return { errors, rowsChecked: 0 };
    }

    const oldKeyCol = tg.keys.old;
    const newKeyCol = tg.keys.new;

    this.logger.log(`[TXN] Validating ${source} → ${target} grouped by [${oldKeyCol}]`);

    // ---- Schema check — resilient (Issue #1) ----
    const colErrors = await this.checkMissingColumns(source, target, [
      ...(sm.exact_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: [m.new] })),
      ...(sm.split_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: m.new_cols })),
      ...(sm.transformed_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: [m.new] })),
    ]);
    if (colErrors.length > 0) {
      errors.push(...colErrors);
      this.logger.warn(
        `[TXN] ${colErrors.length} column(s) missing — continuing with valid mappings only`,
      );
      sm = this.filterMappingsAfterSchemaCheck(sm, colErrors);
    }

    // ---- Noisy column detection ----
    const allOldCols = [
      ...(sm.exact_matches ?? []).map((m) => m.old),
      ...(sm.split_matches ?? []).map((m) => m.old),
    ];
    const noisyMap = await this.detectNoisyColumns(source, allOldCols);
    for (const [col, type] of noisyMap) {
      if (type !== 'NORMAL') {
        this.logger.warn(`[TXN] Column [${col}] is ${type} — name-only match`);
      }
    }

    // ---- Anchor-key streaming (Issue #2) ----
    // Stream OLD rows ordered by anchorKey → fetch matching NEW rows by anchorKey
    // → group both sides by groupKey in memory. No index on groupKey required.
    let lastAnchorKey: unknown = null;

    while (true) {
      const oldChunk = await this.db.fetchChunk(source, anchorKeyOld, chunkSize, lastAnchorKey);
      if (oldChunk.length === 0) break;

      // Unique anchor key values in this chunk
      const anchorVals = [...new Set(oldChunk.map((r) => String(r[anchorKeyOld] ?? '').trim()))];

      // Fetch matching new rows by anchor key
      const newRows: Record<string, unknown>[] = [];
      await this.db.streamRowsByKeys(target, anchorKeyNew, anchorVals, (row) => newRows.push(row));

      // Group both sides by groupKey in memory
      const oldGroupMap = new Map<string, Record<string, unknown>[]>();
      const newGroupMap = new Map<string, Record<string, unknown>[]>();

      for (const row of oldChunk) {
        const key = this.normalizeKey(row[oldKeyCol], tg.transform_key);
        if (!oldGroupMap.has(key)) oldGroupMap.set(key, []);
        oldGroupMap.get(key)!.push(row);
        rowsChecked++;
      }
      for (const row of newRows) {
        const key = this.normalizeKey(row[newKeyCol], tg.transform_key);
        if (!newGroupMap.has(key)) newGroupMap.set(key, []);
        newGroupMap.get(key)!.push(row);
      }

      // Compare each group
      for (const [groupKey, oldGroup] of oldGroupMap) {
        const newGroup = newGroupMap.get(groupKey) ?? [];

        if (newGroup.length === 0) {
          errors.push({
            errorType: 'ROW_MISSING',
            groupKey,
            message: `Transaction group [${groupKey}] found in source but not in target`,
          });
          continue;
        }

        errors.push(...this.validateGroup(groupKey, oldGroup, newGroup, sm, tolerance, noisyMap));
        errors.push(...this.runDefRules(groupKey, oldGroup, newGroup, defRules, affectCodeMap));
      }

      // Extra groups in target with no source counterpart
      for (const [groupKey] of newGroupMap) {
        if (!oldGroupMap.has(groupKey)) {
          errors.push({
            errorType: 'ROW_MISSING',
            groupKey,
            message: `Transaction group [${groupKey}] found in target but not in source (extra row)`,
          });
        }
      }

      oldGroupMap.clear();
      newGroupMap.clear();

      lastAnchorKey = oldChunk[oldChunk.length - 1][anchorKeyOld];
      if (oldChunk.length < chunkSize) break;
    }

    this.logger.log(`[TXN] Done: ${errors.length} error(s), ${rowsChecked} rows checked`);
    return { errors, rowsChecked };
  }

  // ----------------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------------

  private normalizeKey(value: unknown, transformRule?: string): string {
    if (!transformRule || transformRule === 'NONE') return String(value ?? '').trim();
    return TransformUtils.apply(value, transformRule as any) ?? '';
  }

  private validateGroup(
    groupKey: string,
    oldGroup: Record<string, unknown>[],
    newGroup: Record<string, unknown>[],
    sm: SchemaMappings,
    tolerance: number,
    noisyMap: Map<string, NoisyColumnType>,
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const mapping of sm.exact_matches ?? []) {
      if (this.isNoisyType(noisyMap.get(mapping.old))) continue;
      const oldTotal = this.sumColumn(oldGroup, mapping.old);
      const newTotal = this.sumColumn(newGroup, mapping.new);
      if (oldTotal !== null && newTotal !== null && Math.abs(oldTotal - newTotal) > tolerance) {
        errors.push({
          errorType: 'VALUE_MISMATCH',
          oldColumn: mapping.old,
          newColumn: mapping.new,
          oldValue: oldTotal,
          newValue: newTotal,
          groupKey,
          message: `Group sum mismatch [${mapping.old}]: ${oldTotal} ≠ ${newTotal} (group: ${groupKey})`,
        });
      }
    }

    for (const mapping of sm.split_matches ?? []) {
      if (this.isNoisyType(noisyMap.get(mapping.old))) continue;
      const oldTotal = this.sumColumn(oldGroup, mapping.old);
      const newTotals = mapping.new_cols.map((c) => this.sumColumn(newGroup, c));
      if (oldTotal !== null) {
        const computed = TransformUtils.evaluateFormula(mapping.formula, newTotals);
        if (Math.abs(oldTotal - computed) > tolerance) {
          errors.push({
            errorType: 'VALUE_MISMATCH',
            oldColumn: mapping.old,
            newColumn: mapping.new_cols.join('+'),
            oldValue: oldTotal,
            newValue: computed,
            groupKey,
            message: `Split formula group mismatch: ${mapping.old}=${oldTotal}, result=${computed} (group: ${groupKey})`,
          });
        }
      }
    }

    return errors;
  }

  private runDefRules(
    groupKey: string,
    oldGroup: Record<string, unknown>[],
    newGroup: Record<string, unknown>[],
    defRules: DefRule[],
    affectCodeMap: Map<string, string>,
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const def of defRules) {
      if (def.trigger_condition?.must_have_all) {
        const oldAffectCodes = this.extractAffectCodes(oldGroup, affectCodeMap);
        const hasAll = def.trigger_condition.must_have_all.every((code) =>
          oldAffectCodes.has(code),
        );
        if (!hasAll) continue;
      }

      for (const action of def.actions) {
        errors.push(...this.evaluateDefAction(def.def_id, groupKey, oldGroup, newGroup, action));
      }
    }

    return errors;
  }

  private evaluateDefAction(
    defId: string,
    groupKey: string,
    oldGroup: Record<string, unknown>[],
    newGroup: Record<string, unknown>[],
    action: any,
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    if (action.check_type === 'ROW_LEVEL_COHESION') {
      const resolvedVars: Record<string, number> = {};
      for (const [varName, expr] of Object.entries(action.variables ?? {})) {
        resolvedVars[varName] = this.evaluateExpression(String(expr), oldGroup);
      }

      const conditionMet = this.evaluateCondition(action.condition, newGroup, resolvedVars);
      if (!conditionMet) {
        errors.push({
          errorType: 'DEFECT_VIOLATION',
          defId,
          groupKey,
          message: action.error_message,
        });
      }
    }

    return errors;
  }

  private evaluateExpression(expr: string, rows: Record<string, unknown>[]): number {
    const sumMatch = expr.match(/SUM\((?:old\.)?(\w+)\)\s+WHERE\s+(\w+)\s*==\s*'([^']+)'/i);
    if (sumMatch) {
      const [, col, filterCol, filterVal] = sumMatch;
      return rows
        .filter((r) => String(r[filterCol] ?? '').toUpperCase() === filterVal.toUpperCase())
        .reduce((sum, r) => sum + (parseFloat(String(r[col] ?? 0)) || 0), 0);
    }
    return 0;
  }

  private evaluateCondition(
    condition: string,
    newGroup: Record<string, unknown>[],
    vars: Record<string, number>,
  ): boolean {
    const checks: Array<{ col: string; varName: string }> = [];
    const pattern = /target\.(\w+)\s*==\s*(val_\w+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(condition)) !== null) {
      checks.push({ col: match[1], varName: match[2] });
    }
    if (checks.length === 0) return true;
    return newGroup.some((row) =>
      checks.every((chk) => {
        const expected = vars[chk.varName] ?? 0;
        const actual = parseFloat(String(row[chk.col] ?? 0)) || 0;
        return Math.abs(actual - expected) <= 0.01;
      }),
    );
  }

  private sumColumn(rows: Record<string, unknown>[], col: string): number | null {
    const vals = rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined);
    if (vals.length === 0) return null;
    const nums = vals.map((v) => parseFloat(String(v)));
    if (nums.some(isNaN)) return null;
    return nums.reduce((a, b) => a + b, 0);
  }

  private extractAffectCodes(
    rows: Record<string, unknown>[],
    affectCodeMap: Map<string, string>,
  ): Set<string> {
    const codeSet = new Set<string>();
    for (const row of rows) {
      for (const val of Object.values(row)) {
        const str = String(val ?? '').toUpperCase();
        if (affectCodeMap.has(str)) codeSet.add(str);
      }
    }
    return codeSet;
  }
}
