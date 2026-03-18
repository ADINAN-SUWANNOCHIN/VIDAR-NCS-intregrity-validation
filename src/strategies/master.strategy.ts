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

  async validate(ctx: ValidationContext): Promise<{ errors: ValidationError[]; rowsChecked: number; passCount: number; failCount: number }> {
    const errors: ValidationError[] = [];
    const { commonRule } = ctx;
    const { source, target } = commonRule.table_info;
    let sm = commonRule.schema_mappings;
    const tolerance = commonRule.defaults?.tolerance ?? 0;
    const anchorKeyOld = commonRule.anchor_key.old;
    const anchorKeyNew = commonRule.anchor_key.new;
    const chunkSize = parseInt(process.env.CHUNK_SIZE ?? '5000');

    this.logger.log(`[MASTER] Validating ${source} → ${target}`);

    // DEF rules are not supported in MasterStrategy — the worker thread processes row comparisons
    // and does not return old+new row pairs needed by runDefRules. If def rules are needed for a
    // MASTER table, convert it to TRANSACTION type or implement a second-pass DEF evaluation.
    if (ctx.defRules.length > 0) {
      this.logger.warn(`[MASTER] ${ctx.defRules.length} DEF rule(s) defined but MASTER strategy does not support DEF evaluation — skipped`);
      errors.push({
        errorType: 'TRANSFORM_ERROR',
        message: `[MASTER] DEF rules are not evaluated for MASTER strategy tables. Convert to TRANSACTION type if DEF rules are required.`,
      });
    }

    // ---- 1. Schema check — resilient (Issue #1) ----
    const expectedMappings = [
      ...(sm.exact_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: [m.new] })),
      ...(sm.split_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: m.new_cols })),
      ...(sm.transformed_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: [m.new] })),
      ...(sm.concat_matches ?? []).map((m) => ({ oldCols: m.old_cols, newCols: [m.new] })),
      ...(sm.formula_matches ?? []).map((m) => ({ oldCols: m.old_cols, newCols: [m.new] })),
    ];
    const colErrors = await this.checkMissingColumns(source, target, expectedMappings);
    if (colErrors.length > 0) {
      errors.push(...colErrors);
      this.logger.warn(
        `[MASTER] ${colErrors.length} column(s) missing — continuing with valid mappings only`,
      );
      sm = this.filterMappingsAfterSchemaCheck(sm, colErrors);
    }
    errors.push(...await this.reportUnmappedColumns(source, target, sm, 'MASTER'));

    // If nothing to compare, stop here
    const hasMappings =
      (sm.exact_matches?.length ?? 0) +
      (sm.split_matches?.length ?? 0) +
      (sm.transformed_matches?.length ?? 0) +
      (sm.concat_matches?.length ?? 0) > 0;
    if (!hasMappings) {
      this.logger.warn(`[MASTER] No valid mappings remain after schema check — skipping data comparison`);
      return { errors, rowsChecked: 0, passCount: 0, failCount: 0 };
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

    // ---- 4. Noisy column detection ----
    const allOldCols = [
      ...(sm.exact_matches ?? []).map((m) => m.old),
      ...(sm.split_matches ?? []).map((m) => m.old),
      ...(sm.transformed_matches ?? []).map((m) => m.old),
      ...(sm.concat_matches ?? []).flatMap((m) => m.old_cols),
      ...(sm.formula_matches ?? []).flatMap((m) => m.old_cols),
    ];
    const noisyMap = await this.detectNoisyColumns(source, allOldCols);
    const noisyColumns: Record<string, NoisyColumnType> = Object.fromEntries(noisyMap);
    for (const [col, type] of noisyMap) {
      if (type !== 'NORMAL') {
        this.logger.warn(`[MASTER] Column [${col}] is ${type} — name-only match`);
      }
    }

    // ---- 5. Fallback auto-match for unmapped columns ----
    const mappedOld = new Set(allOldCols);
    const mappedNew = new Set([
      ...(sm.exact_matches ?? []).map((m) => m.new),
      ...(sm.split_matches ?? []).flatMap((m) => m.new_cols),
      ...(sm.transformed_matches ?? []).map((m) => m.new),
      ...(sm.concat_matches ?? []).map((m) => m.new),
      ...(sm.formula_matches ?? []).map((m) => m.new),
    ]);
    const fallbacks = await this.findFallbackMappings(source, target, mappedOld, mappedNew);
    if (fallbacks.length > 0) {
      this.logger.warn(
        `[MASTER] Fallback auto-matched ${fallbacks.length} column(s): ` +
          fallbacks.map((f) => `${f.old}→${f.new}(${(f.similarity * 100).toFixed(0)}%)`).join(', '),
      );
    }

    // ---- 6. Key-based chunk comparison via worker threads ----
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
      formulaMatches: sm.formula_matches ?? [],
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

    // ---- 7. Reverse scan: detect extra rows in target with no source counterpart ----
    // The forward scan (step 6) fetches new rows only for keys seen in the current old chunk.
    // Extra new rows whose anchor key is entirely absent from old are never fetched → never reported.
    //
    // Fix: paginate the new table by anchor key (key-column only — SELECT key, not SELECT *),
    // then batch-check each page of new keys against old table using parameterized IN queries.
    // Only keys absent from old are reported as extra rows.
    //
    // Performance at 15M rows:
    //   fetchChunkKeys uses SELECT [keyCol] only → ~100x less bandwidth than SELECT * per chunk.
    //   Existence checks batch at 2000 keys (SQL Server param limit) with SELECT key only.
    //   With an indexed anchor key (required for keyset pagination to work at all), each batch
    //   is an index seek — fast even on 15M rows. Total extra DB round-trips: ~3000 per 15M rows.
    //   Errors capped at EXTRA_ROW_CAP to prevent flooding the report on catastrophic mismatches.
    const EXTRA_ROW_CAP = 1000;
    const KEY_BATCH = 2000;
    let extraFound = 0;
    let lastNewKey: unknown = null;
    let hitCap = false;

    while (!hitCap) {
      const newKeyRows = await this.db.fetchChunkKeys(target, anchorKeyNew, chunkSize, lastNewKey);
      if (newKeyRows.length === 0) break;

      // Raw typed values preserved so the existence check uses correct SQL parameter types
      // (numeric anchor keys stay as numbers → avoids NVarChar string-comparison ordering).
      const newKeyVals = newKeyRows.map((r) => r[anchorKeyNew]);

      // Batch-check which new keys actually exist in old (SELECT key only, not SELECT *)
      const existingOldKeys = new Set<string>();
      for (let i = 0; i < newKeyVals.length; i += KEY_BATCH) {
        const batch = newKeyVals.slice(i, i + KEY_BATCH);
        const inputs = Object.fromEntries(batch.map((k, j) => [`k${j}`, k]));
        const placeholders = batch.map((_, j) => `@k${j}`).join(',');
        const rows = await this.db.query<Record<string, unknown>>(
          `SELECT [${anchorKeyOld}] as k FROM ${tableRef(source)} WITH (NOLOCK) WHERE [${anchorKeyOld}] IN (${placeholders})`,
          inputs,
        );
        rows.forEach((r) => existingOldKeys.add(String(r['k'] ?? '').trim()));
      }

      for (const keyRow of newKeyRows) {
        const key = String(keyRow[anchorKeyNew] ?? '').trim();
        if (key !== '' && !existingOldKeys.has(key)) {
          extraFound++;
          if (extraFound <= EXTRA_ROW_CAP) {
            errors.push({
              errorType: 'ROW_MISSING',
              rowIdentifier: key,
              message: `Row with key [${key}] found in target but not in source (extra row)`,
            });
          } else {
            hitCap = true;
            break;
          }
        }
      }

      lastNewKey = newKeyRows[newKeyRows.length - 1][anchorKeyNew];
      if (newKeyRows.length < chunkSize) break;
    }

    if (extraFound > EXTRA_ROW_CAP) {
      errors.push({
        errorType: 'ROW_MISSING',
        message:
          `[MASTER] Reverse scan capped at ${EXTRA_ROW_CAP} extra-row errors — ` +
          `${extraFound - EXTRA_ROW_CAP}+ more extra rows likely exist in target. ` +
          `Total count diff: target has ${newCount[0].cnt - oldCount[0].cnt} more row(s) than source.`,
      });
    } else if (extraFound > 0) {
      this.logger.warn(`[MASTER] Reverse scan found ${extraFound} extra row(s) in target`);
    } else {
      this.logger.log(`[MASTER] Reverse scan complete — no extra rows in target`);
    }

    // passCount/failCount: post-hoc from distinct failing row identifiers (MASTER has no groups).
    const failingKeys = new Set(
      errors.filter((e) => e.rowIdentifier).map((e) => e.rowIdentifier!),
    );
    const failCount = failingKeys.size;
    const passCount = Math.max(0, globalIndex - failCount);
    this.logger.log(`[MASTER] Done: ${errors.length} error(s), ${globalIndex} rows checked, pass=${passCount} fail=${failCount} skipped=${globalIndex - passCount - failCount}`);
    return { errors, rowsChecked: globalIndex, passCount, failCount };
  }
}
