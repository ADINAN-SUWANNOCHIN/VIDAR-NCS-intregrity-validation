import { DatabaseService, tableRef } from '../database/database.service';
import { NoisyColumnType, ValidationError } from '../rules/rule.types';
import { BaseStrategy, ValidationContext } from './base.strategy';
import { WorkerPoolService } from './worker-pool.service';
import type { CompareTask } from './compare.worker';

export class MasterStrategy extends BaseStrategy {
  constructor(
    db: DatabaseService,
    private readonly workerPool: WorkerPoolService,
  ) {
    super(db);
  }

  async validate(ctx: ValidationContext): Promise<{ errors: ValidationError[]; rowsChecked: number }> {
    const errors: ValidationError[] = [];
    const { commonRule } = ctx;
    const { source, target } = commonRule.table_info;
    let sm = commonRule.schema_mappings;
    const tolerance = commonRule.defaults?.tolerance ?? 0;
    const anchorKeyOld = commonRule.anchor_key.old;
    const anchorKeyNew = commonRule.anchor_key.new;
    const chunkSize = parseInt(process.env.CHUNK_SIZE ?? '5000');

    this.logger.log(`[MASTER] Validating ${source} → ${target}`);

    // ---- 1. Schema check — resilient (Issue #1) ----
    const expectedMappings = [
      ...(sm.exact_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: [m.new] })),
      ...(sm.split_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: m.new_cols })),
      ...(sm.transformed_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: [m.new] })),
      ...(sm.concat_matches ?? []).map((m) => ({ oldCols: m.old_cols, newCols: [m.new] })),
    ];
    const colErrors = await this.checkMissingColumns(source, target, expectedMappings);
    if (colErrors.length > 0) {
      errors.push(...colErrors);
      this.logger.warn(
        `[MASTER] ${colErrors.length} column(s) missing — continuing with valid mappings only`,
      );
      sm = this.filterMappingsAfterSchemaCheck(sm, colErrors);
    }

    // If nothing to compare, stop here
    const hasMappings =
      (sm.exact_matches?.length ?? 0) +
      (sm.split_matches?.length ?? 0) +
      (sm.transformed_matches?.length ?? 0) +
      (sm.concat_matches?.length ?? 0) > 0;
    if (!hasMappings) {
      this.logger.warn(`[MASTER] No valid mappings remain after schema check — skipping data comparison`);
      return { errors, rowsChecked: 0 };
    }

    // ---- 2. Anchor key uniqueness check ----
    // Duplicate anchor keys break keyset pagination (rows get silently skipped).
    // Check both sides: source drives the stream, target is used as a Map key in the worker.
    for (const [tbl, key] of [[source, anchorKeyOld], [target, anchorKeyNew]] as [string, string][]) {
      const anchorErr = await this.checkAnchorKeyUnique(tbl, key);
      if (anchorErr) {
        errors.push(anchorErr);
        this.logger.warn(`[MASTER] ${anchorErr.message}`);
      }
    }

    // ---- 3. Row count check ----
    const [oldCount, newCount] = await Promise.all([
      this.db.query<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${tableRef(source)}`),
      this.db.query<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${tableRef(target)}`),
    ]);
    if (oldCount[0].cnt !== newCount[0].cnt) {
      errors.push({
        errorType: 'ROW_MISSING',
        message: `Row count mismatch: source=${oldCount[0].cnt}, target=${newCount[0].cnt}`,
      });
    }

    // ---- 3. Noisy column detection ----
    const allOldCols = [
      ...(sm.exact_matches ?? []).map((m) => m.old),
      ...(sm.split_matches ?? []).map((m) => m.old),
      ...(sm.transformed_matches ?? []).map((m) => m.old),
      ...(sm.concat_matches ?? []).flatMap((m) => m.old_cols),
    ];
    const noisyMap = await this.detectNoisyColumns(source, allOldCols);
    const noisyColumns: Record<string, NoisyColumnType> = Object.fromEntries(noisyMap);
    for (const [col, type] of noisyMap) {
      if (type !== 'NORMAL') {
        this.logger.warn(`[MASTER] Column [${col}] is ${type} — name-only match`);
      }
    }

    // ---- 4. Fallback auto-match for unmapped columns ----
    const mappedOld = new Set(allOldCols);
    const mappedNew = new Set([
      ...(sm.exact_matches ?? []).map((m) => m.new),
      ...(sm.split_matches ?? []).flatMap((m) => m.new_cols),
      ...(sm.transformed_matches ?? []).map((m) => m.new),
      ...(sm.concat_matches ?? []).map((m) => m.new),
    ]);
    const fallbacks = await this.findFallbackMappings(source, target, mappedOld, mappedNew);
    if (fallbacks.length > 0) {
      this.logger.warn(
        `[MASTER] Fallback auto-matched ${fallbacks.length} column(s): ` +
          fallbacks.map((f) => `${f.old}→${f.new}(${(f.similarity * 100).toFixed(0)}%)`).join(', '),
      );
    }

    // ---- 5. Key-based chunk comparison via worker threads ----
    let lastOldKey: unknown = null;
    let globalIndex = 0;

    const taskBase: Omit<CompareTask, 'oldChunk' | 'newRows' | 'baseIndex'> = {
      anchorKeyOld,
      anchorKeyNew,
      exactMatches: [
        ...(sm.exact_matches ?? []).map((m) => ({ old: m.old, new: m.new, transform_rule: m.transform_rule })),
        ...fallbacks.map((f) => ({ old: f.old, new: f.new, transform_rule: undefined })),
      ],
      splitMatches: sm.split_matches ?? [],
      transformedMatches: sm.transformed_matches ?? [],
      concatMatches: sm.concat_matches ?? [],
      tolerance,
      noisyColumns,
    };

    while (true) {
      const oldChunk = await this.db.fetchChunk(source, anchorKeyOld, chunkSize, lastOldKey);
      if (oldChunk.length === 0) break;

      const oldKeyValues = oldChunk.map((r) => String(r[anchorKeyOld] ?? '').trim());
      const newRows: Record<string, unknown>[] = [];
      await this.db.streamRowsByKeys(target, anchorKeyNew, oldKeyValues, (row) => newRows.push(row));

      const result = await this.workerPool.run({
        ...taskBase,
        oldChunk,
        newRows,
        baseIndex: globalIndex,
      });
      errors.push(...(result.errors as ValidationError[]));

      lastOldKey = oldChunk[oldChunk.length - 1][anchorKeyOld];
      globalIndex += oldChunk.length;
      if (oldChunk.length < chunkSize) break;
    }

    this.logger.log(`[MASTER] Done: ${errors.length} error(s), ${globalIndex} rows checked`);
    return { errors, rowsChecked: globalIndex };
  }
}
