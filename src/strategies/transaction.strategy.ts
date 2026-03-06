import { DatabaseService } from '../database/database.service';
import { NoisyColumnType, SchemaMappings, ValidationError } from '../rules/rule.types';
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
 *
 * Def evaluation (runDefRules, evaluateDefAction, etc.) lives in BaseStrategy
 * so MultipleStrategy can share it.
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
      ...(sm.concat_matches ?? []).map((m) => ({ oldCols: m.old_cols, newCols: [m.new] })),
      ...(sm.formula_matches ?? []).map((m) => ({ oldCols: m.old_cols, newCols: [m.new] })),
    ]);
    if (colErrors.length > 0) {
      errors.push(...colErrors);
      this.logger.warn(
        `[TXN] ${colErrors.length} column(s) missing — continuing with valid mappings only`,
      );
      sm = this.filterMappingsAfterSchemaCheck(sm, colErrors);
    }
    errors.push(...await this.reportUnmappedColumns(source, target, sm, 'TXN'));

    // ---- Noisy column detection ----
    const allOldCols = [
      ...(sm.exact_matches ?? []).map((m) => m.old),
      ...(sm.split_matches ?? []).map((m) => m.old),
      ...(sm.concat_matches ?? []).flatMap((m) => m.old_cols),
      ...(sm.formula_matches ?? []).flatMap((m) => m.old_cols),
    ];
    const noisyMap = await this.detectNoisyColumns(source, allOldCols);
    for (const [col, type] of noisyMap) {
      if (type !== 'NORMAL') {
        this.logger.warn(`[TXN] Column [${col}] is ${type} — name-only match`);
      }
    }

    // ---- Anchor key uniqueness check ----
    // Only source needs to be unique — keyset pagination streams old rows by anchorKeyOld.
    // Target is fetched by key lookup (streamRowsByKeys), not paginated, so duplicates there
    // affect grouping but don't cause rows to be skipped.
    const anchorDupErr = await this.checkAnchorKeyUnique(source, anchorKeyOld);
    if (anchorDupErr) {
      errors.push(anchorDupErr);
      this.logger.warn(`[TXN] ${anchorDupErr.message}`);
    }

    // ---- Anchor-key streaming with carry-over (Issue #2 + chunk-boundary fix) ----
    // Stream OLD rows ordered by anchorKey, group by groupKey in memory.
    // Problem: a transaction group whose rows span a chunk boundary would be split,
    // producing wrong per-group sums. Fix: carry the last group of each chunk forward
    // and merge it with the matching rows from the next chunk before comparing.
    let lastAnchorKey: unknown = null;
    let carryOld = new Map<string, Record<string, unknown>[]>();
    let carryNew = new Map<string, Record<string, unknown>[]>();

    const sourceFilter = commonRule.table_info.source_filter;

    while (true) {
      const oldChunk = await this.db.fetchChunk(source, anchorKeyOld, chunkSize, lastAnchorKey, sourceFilter);
      if (oldChunk.length === 0) break;

      // Seed group maps with rows carried over from the previous chunk.
      // Must happen BEFORE computing groupKeyVals so we can exclude already-fetched groups (Bug 2 fix).
      const oldGroupMap = new Map<string, Record<string, unknown>[]>(carryOld);
      const newGroupMap = new Map<string, Record<string, unknown>[]>(carryNew);
      carryOld = new Map();
      carryNew = new Map();

      // Bug 1 fix: fetch new rows by GROUP KEY (tg.keys.new), not by anchor key.
      //   anchor_key is a keyset pagination cursor only (must be unique+monotonic, e.g. id).
      //   tg.keys is the cross-table join key (e.g. systemreferencenumber → systemreferenceno).
      //   Without this fix, tables where IDs are not preserved through migration return 0 new rows
      //   and every group is incorrectly flagged as ROW_MISSING.
      //
      // Bug 2 fix: exclude group keys already in newGroupMap (seeded from carryNew above).
      //   carryNew holds ALL new rows for the carry group — they were fully fetched in the
      //   previous chunk. Re-fetching that key would push duplicate rows into newGroupMap,
      //   doubling group sums and producing false VALUE_MISMATCH errors.
      //
      // Performance (15M rows): at chunkSize=5000 and group_size≈2-5, each chunk produces
      //   ~1000-2500 distinct group keys — within the 2000-key batch limit of streamRowsByKeys,
      //   so each chunk triggers exactly one DB round-trip on the target side.
      const groupKeyVals = [
        ...new Set(oldChunk.map((r) => this.normalizeKey(r[oldKeyCol], tg.transform_key))),
      ].filter((k) => k !== '' && !newGroupMap.has(k));

      const newRows: Record<string, unknown>[] = [];
      await this.db.streamRowsByKeys(target, newKeyCol, groupKeyVals, (row) => newRows.push(row));

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

      const isLastChunk = oldChunk.length < chunkSize;

      // If more chunks follow, hold back the last group — it may continue in the next chunk
      const carryKey = !isLastChunk ? [...oldGroupMap.keys()].at(-1) : undefined;
      if (carryKey) {
        carryOld.set(carryKey, oldGroupMap.get(carryKey)!);
        if (newGroupMap.has(carryKey)) carryNew.set(carryKey, newGroupMap.get(carryKey)!);
      }

      // Compare all committed groups (everything except the carried one)
      for (const [groupKey, oldGroup] of oldGroupMap) {
        if (groupKey === carryKey) continue;

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
        errors.push(...this.runDefRules(groupKey, oldGroup, newGroup, defRules, affectCodeMap, tolerance));
      }

      // Extra groups in target (only for committed groups)
      for (const [groupKey] of newGroupMap) {
        if (groupKey === carryKey) continue;
        if (!oldGroupMap.has(groupKey)) {
          errors.push({
            errorType: 'ROW_MISSING',
            groupKey,
            message: `Transaction group [${groupKey}] found in target but not in source (extra row)`,
          });
        }
      }

      lastAnchorKey = oldChunk[oldChunk.length - 1][anchorKeyOld];
      if (isLastChunk) break;
    }

    // Flush any group still in carry (last group of the last full-sized chunk)
    for (const [groupKey, oldGroup] of carryOld) {
      const newGroup = carryNew.get(groupKey) ?? [];
      if (newGroup.length === 0) {
        errors.push({
          errorType: 'ROW_MISSING',
          groupKey,
          message: `Transaction group [${groupKey}] found in source but not in target`,
        });
        continue;
      }
      errors.push(...this.validateGroup(groupKey, oldGroup, newGroup, sm, tolerance, noisyMap));
      errors.push(...this.runDefRules(groupKey, oldGroup, newGroup, defRules, affectCodeMap, tolerance));
    }

    // Extra groups in target at chunk boundary
    for (const [groupKey] of carryNew) {
      if (!carryOld.has(groupKey)) {
        errors.push({
          errorType: 'ROW_MISSING',
          groupKey,
          message: `Transaction group [${groupKey}] found in target but not in source (extra row at chunk boundary)`,
        });
      }
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

    // transformed_matches — sum numeric values per group (e.g. amounts with transform_rule: NONE).
    // Non-numeric results (dates, strings) make sumColumn return null → comparison skipped gracefully.
    for (const mapping of sm.transformed_matches ?? []) {
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
          message: `Group sum mismatch [${mapping.old}→${mapping.new}]: ${oldTotal} ≠ ${newTotal} (group: ${groupKey})`,
        });
      }
    }

    for (const mapping of sm.concat_matches ?? []) {
      if (mapping.old_cols.some((c) => this.isNoisyType(noisyMap.get(c)))) continue;
      const sep = mapping.separator ?? '';
      const oldVals = [...new Set(oldGroup.map((r) => mapping.old_cols.map((c) => String(r[c] ?? '').trim()).join(sep)))].sort().join('|');
      const newVals = [...new Set(newGroup.map((r) => String(r[mapping.new] ?? '').trim()))].sort().join('|');
      if (oldVals !== newVals) {
        errors.push({
          errorType: 'VALUE_MISMATCH',
          oldColumn: mapping.old_cols.join('+'),
          newColumn: mapping.new,
          oldValue: oldVals,
          newValue: newVals,
          groupKey,
          message: `Concat mismatch [${mapping.old_cols.join('+')}→${mapping.new}]: "${oldVals}" ≠ "${newVals}" (group: ${groupKey})`,
        });
      }
    }

    for (const mapping of sm.formula_matches ?? []) {
      if (mapping.old_cols.some((c) => this.isNoisyType(noisyMap.get(c)))) continue;
      const oldInputs = mapping.old_cols.map((c) => this.sumColumn(oldGroup, c));
      // If any source column is entirely null, skip (nothing to compare)
      if (oldInputs.some((v) => v === null)) continue;
      const oldComputed = TransformUtils.evaluateFormula(mapping.formula, oldInputs);
      const newTotal = this.sumColumn(newGroup, mapping.new);
      if (newTotal !== null && Math.abs(oldComputed - newTotal) > tolerance) {
        errors.push({
          errorType: 'VALUE_MISMATCH',
          oldColumn: mapping.old_cols.join(`${mapping.formula === 'SUBTRACT' ? '-' : '+'}`),
          newColumn: mapping.new,
          oldValue: oldComputed,
          newValue: newTotal,
          groupKey,
          message: `Formula mismatch [${mapping.formula}(${mapping.old_cols.join(',')})→${mapping.new}]: ${oldComputed} ≠ ${newTotal} (group: ${groupKey})`,
        });
      }
    }

    return errors;
  }
}
