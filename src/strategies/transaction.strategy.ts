import { DatabaseService, tableRef } from '../database/database.service';
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

    // Composite key mode — different streaming strategy, separate path
    if (tg.composite_key) {
      return this.validateCompositeKey(ctx);
    }

    // Group-key pagination mode — for tables where group rows are scattered in ID order.
    // Anchor-key streaming + carry-over breaks when id_range >> row_count per group.
    if (tg.use_group_pagination) {
      return this.validateGroupPagination(ctx);
    }

    // Sysref-sort mode — page old table sorted by sysref, carry-over at boundary.
    // Same scatter safety as use_group_pagination but ~10× fewer DB round-trips.
    if (tg.use_sysref_sort) {
      return this.validateSysrefSort(ctx);
    }

    const oldKeyCol = tg.keys.old;
    const newKeyCol = tg.keys.new;
    // target_fetch_key: use an indexed column (e.g. journalseqno) for the WHERE IN query
    // instead of keys.new when keys.new has no index. Verified equal to keys.new on all tables.
    const targetFetchKey = tg.target_fetch_key ?? newKeyCol;

    this.logger.log(`[TXN] Validating ${source} → ${target} grouped by [${oldKeyCol}]`);

    // ---- Schema check — resilient (Issue #1) ----
    const colErrors = await this.checkMissingColumns(source, target, [
      ...(sm.exact_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: [m.new] })),
      ...(sm.split_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: m.new_cols })),
      ...(sm.transformed_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: [m.new] })),
      ...(sm.concat_matches ?? []).map((m) => ({ oldCols: m.old_cols, newCols: [m.new] })),
      ...(sm.formula_matches ?? []).map((m) => ({ oldCols: m.old_cols, newCols: [m.new] })),
      ...(sm.filtered_sum_matches ?? []).map((m) => ({
        oldCols: [
          m.old,
          ...(m.old_filter.affectcode_in?.length ? ['affectcode'] : []),
          ...(m.old_filter.debitcredit ? ['debitcredit'] : []),
          ...((m.old_filter.loantranshostcode_not_in?.length || m.old_filter.loantranshostcode_in?.length) ? ['loantranshostcode'] : []),
        ],
        newCols: [m.new],
      })),
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
      ...(sm.filtered_sum_matches ?? []).map((m) => m.old),
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
      await this.db.streamRowsByKeys(target, targetFetchKey, groupKeyVals, (row) => newRows.push(row));

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

        const groupErrors = this.validateGroup(groupKey, oldGroup, newGroup, sm, tolerance, noisyMap);
        errors.push(...groupErrors);
        if (groupErrors.length > 0 && tg?.row_fingerprint?.length) {
          errors.push(...this.fingerprintDiff(groupKey, oldGroup, newGroup, tg.row_fingerprint));
        }
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
      const groupErrors = this.validateGroup(groupKey, oldGroup, newGroup, sm, tolerance, noisyMap);
      errors.push(...groupErrors);
      if (groupErrors.length > 0 && tg?.row_fingerprint?.length) {
        errors.push(...this.fingerprintDiff(groupKey, oldGroup, newGroup, tg.row_fingerprint));
      }
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

  // ----------------------------------------------------------------
  // Composite key validation (CE/RQ batch sysrefs)
  // ----------------------------------------------------------------

  /**
   * Validate when tg.composite_key is set.
   *
   * Each old row is identified by (keys.old, composite_key.old_col) — e.g. (sysref, accountno).
   * Each new row is identified by (keys.new, composite_key.new_col) — e.g. (sysref, lvaccountno).
   * The old_col → new_col translation uses an optional account_mapping lookup table (cithistory).
   *
   * Strategy:
   *   1. Paginate distinct sysrefs from old table (with source_filter).
   *   2. For each batch of SYSREF_BATCH sysrefs:
   *      a. Fetch all old rows for those sysrefs.
   *      b. Group old rows by composite key (sysref::accountno).
   *      c. Batch-lookup cithistory: accountno → newinvaccountno.
   *      d. Fetch all new rows for those sysrefs.
   *      e. Group new rows by composite key (sysref::lvaccountno).
   *      f. Compare each composite group.
   */
  private async validateCompositeKey(
    ctx: ValidationContext,
  ): Promise<{ errors: ValidationError[]; rowsChecked: number }> {
    const errors: ValidationError[] = [];
    let rowsChecked = 0;
    const { commonRule, defRules, affectCodeMap } = ctx;
    const { source, target } = commonRule.table_info;
    const tg = commonRule.transaction_grouping!;
    let sm = commonRule.schema_mappings;
    const tolerance = commonRule.defaults?.tolerance ?? 0;
    const oldKeyCol = tg.keys.old;
    const newKeyCol = tg.keys.new;
    const targetFetchKey = tg.target_fetch_key ?? newKeyCol;
    const ck = tg.composite_key!;
    const sourceFilter = commonRule.table_info.source_filter;
    const SYSREF_BATCH = 50;

    this.logger.log(
      `[TXN-CK] Validating ${source} → ${target} grouped by [${oldKeyCol}::${ck.old_col}]`,
    );

    // Schema check (same as simple-key path)
    const colErrors = await this.checkMissingColumns(source, target, [
      ...(sm.exact_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: [m.new] })),
      ...(sm.split_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: m.new_cols })),
      ...(sm.transformed_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: [m.new] })),
      ...(sm.concat_matches ?? []).map((m) => ({ oldCols: m.old_cols, newCols: [m.new] })),
      ...(sm.formula_matches ?? []).map((m) => ({ oldCols: m.old_cols, newCols: [m.new] })),
      ...(sm.filtered_sum_matches ?? []).map((m) => ({
        oldCols: [
          m.old,
          ...(m.old_filter.affectcode_in?.length ? ['affectcode'] : []),
          ...(m.old_filter.debitcredit ? ['debitcredit'] : []),
          ...((m.old_filter.loantranshostcode_not_in?.length || m.old_filter.loantranshostcode_in?.length) ? ['loantranshostcode'] : []),
        ],
        newCols: [m.new],
      })),
    ]);
    if (colErrors.length > 0) {
      errors.push(...colErrors);
      this.logger.warn(`[TXN-CK] ${colErrors.length} column(s) missing — continuing with valid mappings`);
      sm = this.filterMappingsAfterSchemaCheck(sm, colErrors);
    }
    errors.push(...await this.reportUnmappedColumns(source, target, sm, 'TXN-CK'));

    // Noisy column detection on source
    const allOldCols = [
      ...(sm.exact_matches ?? []).map((m) => m.old),
      ...(sm.split_matches ?? []).map((m) => m.old),
      ...(sm.concat_matches ?? []).flatMap((m) => m.old_cols),
      ...(sm.formula_matches ?? []).flatMap((m) => m.old_cols),
      ...(sm.filtered_sum_matches ?? []).map((m) => m.old),
    ];
    const noisyMap = await this.detectNoisyColumns(source, allOldCols);

    // ── Target cache ──────────────────────────────────────────────────────────────
    // Copy target table into a global temp table with a clustered index.
    // This replaces repeated full-table IN-clause scans (16K+ for RQ sysrefs)
    // with a single upfront scan + indexed seeks for all subsequent lookups.
    // Requires only SELECT on target — temp tables are created in tempdb (always writable).
    const tempName = `##dv_ck_${process.pid}_${Date.now()}`;
    await this.db.createTargetCache(target, tempName, targetFetchKey, ck.new_col);

    // Paginate through distinct sysrefs using source_filter
    let lastSysref: string | null = null;
    try {
      while (true) {
        const sysrefs = await this.db.getDistinctKeys(
          source, oldKeyCol, SYSREF_BATCH, lastSysref, sourceFilter,
        );
        if (sysrefs.length === 0) break;

        // a. Fetch all old rows for this sysref batch
        const oldRows: Record<string, unknown>[] = [];
        await this.db.streamRowsByKeys(source, oldKeyCol, sysrefs, (row) => oldRows.push(row));

        // b. Group old rows by composite key (sysref::accountno)
        const oldGroupMap = new Map<string, Record<string, unknown>[]>();
        for (const row of oldRows) {
          const sysref = String(row[oldKeyCol] ?? '').trim();
          const acct = String(row[ck.old_col] ?? '').trim();
          if (!acct) continue;
          const key = `${sysref}::${acct}`;
          if (!oldGroupMap.has(key)) oldGroupMap.set(key, []);
          oldGroupMap.get(key)!.push(row);
          rowsChecked++;
        }

        // c. Batch-lookup translation table (cithistory: invaccountno → newinvaccountno)
        const allAccts = [...new Set(
          oldRows.map((r) => String(r[ck.old_col] ?? '').trim()).filter(Boolean),
        )];
        const acctMap: Map<string, string> = ck.account_mapping
          ? await this.db.batchLookup(
              ck.account_mapping.table,
              ck.account_mapping.lookup_col,
              ck.account_mapping.result_col,
              allAccts,
            )
          : new Map(allAccts.map((a) => [a, a]));

        // d. Fetch all new rows from the TEMP CACHE (indexed — fast seek instead of full scan)
        const newRows: Record<string, unknown>[] = [];
        await this.db.streamRowsByKeys(tempName, targetFetchKey, sysrefs, (row) => newRows.push(row));

        // e. Group new rows by composite key (sysref::lvaccountno)
        const newGroupMap = new Map<string, Record<string, unknown>[]>();
        for (const row of newRows) {
          const sysref = String(row[newKeyCol] ?? '').trim();
          const lvAcct = String(row[ck.new_col] ?? '').trim();
          if (!lvAcct) continue;
          const key = `${sysref}::${lvAcct}`;
          if (!newGroupMap.has(key)) newGroupMap.set(key, []);
          newGroupMap.get(key)!.push(row);
        }

        // f. Compare each composite group old→new
        const mappedNewKeys = new Set<string>();
        for (const [ckOld, oldGroup] of oldGroupMap) {
          const [sysref, acct] = ckOld.split('::');
          const newAcct = acctMap.get(acct);
          if (!newAcct) {
            errors.push({
              errorType: 'ROW_MISSING',
              groupKey: ckOld,
              message: `No account mapping found for old [${ck.old_col}=${acct}] (sysref: ${sysref}) — cannot locate new row`,
            });
            continue;
          }
          const ckNew = `${sysref}::${newAcct}`;
          mappedNewKeys.add(ckNew);

          const newGroup = newGroupMap.get(ckNew) ?? [];
          if (newGroup.length === 0) {
            errors.push({
              errorType: 'ROW_MISSING',
              groupKey: ckNew,
              message: `Composite group [${ckNew}] found in source (old ${ck.old_col}=${acct}) but not in target`,
            });
            continue;
          }
          errors.push(...this.validateGroup(ckNew, oldGroup, newGroup, sm, tolerance, noisyMap));
          errors.push(...this.runDefRules(ckNew, oldGroup, newGroup, defRules, affectCodeMap, tolerance));
        }

        // Report extra new rows with no corresponding old source
        for (const [ckNew] of newGroupMap) {
          if (!mappedNewKeys.has(ckNew)) {
            errors.push({
              errorType: 'ROW_MISSING',
              groupKey: ckNew,
              message: `Composite group [${ckNew}] found in target but not in source (extra row)`,
            });
          }
        }

        lastSysref = sysrefs[sysrefs.length - 1];
        if (sysrefs.length < SYSREF_BATCH) break;
      }
    } finally {
      await this.db.dropTargetCache(tempName);
    }

    this.logger.log(`[TXN-CK] Done: ${errors.length} error(s), ${rowsChecked} rows checked`);
    return { errors, rowsChecked };
  }

  // ----------------------------------------------------------------
  // Group-key pagination (use_group_pagination: true)
  // ----------------------------------------------------------------

  /**
   * Alternative to anchor-key streaming for tables where group rows are SCATTERED.
   *
   * Instead of streaming rows ordered by id and relying on carry-over to handle split groups,
   * this method paginates through DISTINCT group key values and fetches all rows per group
   * in one go — groups are always complete before comparison.
   *
   * Reuses the same DB primitives as composite-key mode (getDistinctKeys + streamRowsByKeys)
   * but without account translation and without temp table caching.
   *
   * Limitation: source_filter must filter on the group key column itself.
   * Column-based filters are not re-applied when streaming rows (see use_group_pagination JSDoc).
   */
  private async validateGroupPagination(
    ctx: ValidationContext,
  ): Promise<{ errors: ValidationError[]; rowsChecked: number }> {
    const errors: ValidationError[] = [];
    let rowsChecked = 0;
    const { commonRule, defRules, affectCodeMap } = ctx;
    const { source, target } = commonRule.table_info;
    const tg = commonRule.transaction_grouping!;
    let sm = commonRule.schema_mappings;
    const tolerance = commonRule.defaults?.tolerance ?? 0;
    const oldKeyCol = tg.keys.old;
    const newKeyCol = tg.keys.new;
    const targetFetchKey = tg.target_fetch_key ?? newKeyCol;
    const sourceFilter = commonRule.table_info.source_filter;
    const GROUP_BATCH = 200;

    this.logger.log(
      `[TXN-GP] Validating ${source} → ${target} grouped by [${oldKeyCol}] (group-key pagination)`,
    );

    // ---- Schema check ----
    const colErrors = await this.checkMissingColumns(source, target, [
      ...(sm.exact_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: [m.new] })),
      ...(sm.split_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: m.new_cols })),
      ...(sm.transformed_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: [m.new] })),
      ...(sm.concat_matches ?? []).map((m) => ({ oldCols: m.old_cols, newCols: [m.new] })),
      ...(sm.formula_matches ?? []).map((m) => ({ oldCols: m.old_cols, newCols: [m.new] })),
      ...(sm.filtered_sum_matches ?? []).map((m) => ({
        oldCols: [
          m.old,
          ...(m.old_filter.affectcode_in?.length ? ['affectcode'] : []),
          ...(m.old_filter.debitcredit ? ['debitcredit'] : []),
          ...((m.old_filter.loantranshostcode_not_in?.length || m.old_filter.loantranshostcode_in?.length) ? ['loantranshostcode'] : []),
        ],
        newCols: [m.new],
      })),
    ]);
    if (colErrors.length > 0) {
      errors.push(...colErrors);
      this.logger.warn(`[TXN-GP] ${colErrors.length} column(s) missing — continuing with valid mappings only`);
      sm = this.filterMappingsAfterSchemaCheck(sm, colErrors);
    }
    errors.push(...await this.reportUnmappedColumns(source, target, sm, 'TXN-GP'));

    // ---- Noisy column detection ----
    const allOldCols = [
      ...(sm.exact_matches ?? []).map((m) => m.old),
      ...(sm.split_matches ?? []).map((m) => m.old),
      ...(sm.concat_matches ?? []).flatMap((m) => m.old_cols),
      ...(sm.formula_matches ?? []).flatMap((m) => m.old_cols),
      ...(sm.filtered_sum_matches ?? []).map((m) => m.old),
    ];
    const noisyMap = await this.detectNoisyColumns(source, allOldCols);
    for (const [col, type] of noisyMap) {
      if (type !== 'NORMAL') {
        this.logger.warn(`[TXN-GP] Column [${col}] is ${type} — name-only match`);
      }
    }

    // ---- Group-key pagination loop ----
    // getDistinctKeys paginates sysrefs alphabetically with source_filter applied.
    // streamRowsByKeys then fetches ALL rows for each batch — no carry-over needed
    // because groups are always complete (all rows for a sysref in one fetch).
    let lastGroupKey: string | null = null;

    while (true) {
      const groupKeys = await this.db.getDistinctKeys(
        source, oldKeyCol, GROUP_BATCH, lastGroupKey, sourceFilter,
      );
      if (groupKeys.length === 0) break;

      // Fetch ALL old rows for this batch of group keys
      const oldRows: Record<string, unknown>[] = [];
      await this.db.streamRowsByKeys(source, oldKeyCol, groupKeys, (row) => oldRows.push(row));

      // Fetch ALL new rows for this batch of group keys
      const newRows: Record<string, unknown>[] = [];
      await this.db.streamRowsByKeys(target, targetFetchKey, groupKeys, (row) => newRows.push(row));

      // Group old rows by group key
      const oldGroupMap = new Map<string, Record<string, unknown>[]>();
      for (const row of oldRows) {
        const key = this.normalizeKey(row[oldKeyCol], tg.transform_key);
        if (!key) continue;
        if (!oldGroupMap.has(key)) oldGroupMap.set(key, []);
        oldGroupMap.get(key)!.push(row);
        rowsChecked++;
      }

      // Group new rows by group key
      const newGroupMap = new Map<string, Record<string, unknown>[]>();
      for (const row of newRows) {
        const key = this.normalizeKey(row[newKeyCol], tg.transform_key);
        if (!key) continue;
        if (!newGroupMap.has(key)) newGroupMap.set(key, []);
        newGroupMap.get(key)!.push(row);
      }

      // Compare each old group against its new counterpart
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
        const groupErrors = this.validateGroup(groupKey, oldGroup, newGroup, sm, tolerance, noisyMap);
        errors.push(...groupErrors);
        if (groupErrors.length > 0 && tg.row_fingerprint?.length) {
          errors.push(...this.fingerprintDiff(groupKey, oldGroup, newGroup, tg.row_fingerprint));
        }
        errors.push(...this.runDefRules(groupKey, oldGroup, newGroup, defRules, affectCodeMap, tolerance));
      }

      // Report extra groups in target not present in source
      for (const [groupKey] of newGroupMap) {
        if (!oldGroupMap.has(groupKey)) {
          errors.push({
            errorType: 'ROW_MISSING',
            groupKey,
            message: `Transaction group [${groupKey}] found in target but not in source (extra row)`,
          });
        }
      }

      lastGroupKey = groupKeys[groupKeys.length - 1];
      if (groupKeys.length < GROUP_BATCH) break;
    }

    this.logger.log(`[TXN-GP] Done: ${errors.length} error(s), ${rowsChecked} rows checked`);
    return { errors, rowsChecked };
  }

  // ----------------------------------------------------------------
  // Sysref-sort mode (use_sysref_sort: true)
  // ----------------------------------------------------------------

  /**
   * Page old table sorted by sysref (group key) instead of id.
   * All rows for the same sysref are contiguous → scatter impossible.
   * Carry-over handles the single chunk-boundary split case, identical to default mode.
   *
   * ~10× fewer DB round-trips vs use_group_pagination (1 scan per chunk vs 2 per batch).
   */
  private async validateSysrefSort(
    ctx: ValidationContext,
  ): Promise<{ errors: ValidationError[]; rowsChecked: number }> {
    const errors: ValidationError[] = [];
    let rowsChecked = 0;
    const { commonRule, defRules, affectCodeMap } = ctx;
    const { source, target } = commonRule.table_info;
    const tg = commonRule.transaction_grouping!;
    let sm = commonRule.schema_mappings;
    const tolerance = commonRule.defaults?.tolerance ?? 0;
    const chunkSize = parseInt(process.env.CHUNK_SIZE ?? '5000');
    const oldKeyCol = tg.keys.old;
    const newKeyCol = tg.keys.new;
    const targetFetchKey = tg.target_fetch_key ?? newKeyCol;
    const sourceFilter = commonRule.table_info.source_filter;

    this.logger.log(`[TXN-SS] Validating ${source} → ${target} grouped by [${oldKeyCol}] (sysref-sort)`);

    // ---- Schema check ----
    const colErrors = await this.checkMissingColumns(source, target, [
      ...(sm.exact_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: [m.new] })),
      ...(sm.split_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: m.new_cols })),
      ...(sm.transformed_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: [m.new] })),
      ...(sm.concat_matches ?? []).map((m) => ({ oldCols: m.old_cols, newCols: [m.new] })),
      ...(sm.formula_matches ?? []).map((m) => ({ oldCols: m.old_cols, newCols: [m.new] })),
      ...(sm.filtered_sum_matches ?? []).map((m) => ({
        oldCols: [
          m.old,
          ...(m.old_filter.affectcode_in?.length ? ['affectcode'] : []),
          ...(m.old_filter.debitcredit ? ['debitcredit'] : []),
          ...((m.old_filter.loantranshostcode_not_in?.length || m.old_filter.loantranshostcode_in?.length) ? ['loantranshostcode'] : []),
        ],
        newCols: [m.new],
      })),
    ]);
    if (colErrors.length > 0) {
      errors.push(...colErrors);
      this.logger.warn(`[TXN-SS] ${colErrors.length} column(s) missing — continuing with valid mappings only`);
      sm = this.filterMappingsAfterSchemaCheck(sm, colErrors);
    }
    errors.push(...await this.reportUnmappedColumns(source, target, sm, 'TXN-SS'));

    // ---- Noisy column detection ----
    const allOldCols = [
      ...(sm.exact_matches ?? []).map((m) => m.old),
      ...(sm.split_matches ?? []).map((m) => m.old),
      ...(sm.concat_matches ?? []).flatMap((m) => m.old_cols),
      ...(sm.formula_matches ?? []).flatMap((m) => m.old_cols),
      ...(sm.filtered_sum_matches ?? []).map((m) => m.old),
    ];
    const noisyMap = await this.detectNoisyColumns(source, allOldCols);
    for (const [col, type] of noisyMap) {
      if (type !== 'NORMAL') this.logger.warn(`[TXN-SS] Column [${col}] is ${type} — name-only match`);
    }

    // ---- Sysref-sorted carry-over loop ----
    // No anchor key uniqueness check — sysref is not unique per row.
    // fetchChunk uses sysref as the keyset cursor → rows arrive in sysref order.
    let lastSysref: unknown = null;
    let carryOld = new Map<string, Record<string, unknown>[]>();
    let carryNew = new Map<string, Record<string, unknown>[]>();

    while (true) {
      const oldChunk = await this.db.fetchChunk(source, oldKeyCol, chunkSize, lastSysref, sourceFilter);
      if (oldChunk.length === 0) break;

      const oldGroupMap = new Map<string, Record<string, unknown>[]>(carryOld);
      const newGroupMap = new Map<string, Record<string, unknown>[]>(carryNew);
      carryOld = new Map();
      carryNew = new Map();

      const groupKeyVals = [
        ...new Set(oldChunk.map((r) => this.normalizeKey(r[oldKeyCol], tg.transform_key))),
      ].filter((k) => k !== '' && !newGroupMap.has(k));

      const newRows: Record<string, unknown>[] = [];
      await this.db.streamRowsByKeys(target, targetFetchKey, groupKeyVals, (row) => newRows.push(row));

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
      const carryKey = !isLastChunk ? [...oldGroupMap.keys()].at(-1) : undefined;
      if (carryKey) {
        carryOld.set(carryKey, oldGroupMap.get(carryKey)!);
        if (newGroupMap.has(carryKey)) carryNew.set(carryKey, newGroupMap.get(carryKey)!);
      }

      for (const [groupKey, oldGroup] of oldGroupMap) {
        if (groupKey === carryKey) continue;
        const newGroup = newGroupMap.get(groupKey) ?? [];
        if (newGroup.length === 0) {
          errors.push({ errorType: 'ROW_MISSING', groupKey, message: `Transaction group [${groupKey}] found in source but not in target` });
          continue;
        }
        const groupErrors = this.validateGroup(groupKey, oldGroup, newGroup, sm, tolerance, noisyMap);
        errors.push(...groupErrors);
        if (groupErrors.length > 0 && tg?.row_fingerprint?.length) {
          errors.push(...this.fingerprintDiff(groupKey, oldGroup, newGroup, tg.row_fingerprint));
        }
        errors.push(...this.runDefRules(groupKey, oldGroup, newGroup, defRules, affectCodeMap, tolerance));
      }

      for (const [groupKey] of newGroupMap) {
        if (groupKey === carryKey) continue;
        if (!oldGroupMap.has(groupKey)) {
          errors.push({ errorType: 'ROW_MISSING', groupKey, message: `Transaction group [${groupKey}] found in target but not in source (extra row)` });
        }
      }

      lastSysref = oldChunk[oldChunk.length - 1][oldKeyCol];
      if (isLastChunk) break;
    }

    // Flush carry
    for (const [groupKey, oldGroup] of carryOld) {
      const newGroup = carryNew.get(groupKey) ?? [];
      if (newGroup.length === 0) {
        errors.push({ errorType: 'ROW_MISSING', groupKey, message: `Transaction group [${groupKey}] found in source but not in target` });
        continue;
      }
      const groupErrors = this.validateGroup(groupKey, oldGroup, newGroup, sm, tolerance, noisyMap);
      errors.push(...groupErrors);
      if (groupErrors.length > 0 && tg?.row_fingerprint?.length) {
        errors.push(...this.fingerprintDiff(groupKey, oldGroup, newGroup, tg.row_fingerprint));
      }
      errors.push(...this.runDefRules(groupKey, oldGroup, newGroup, defRules, affectCodeMap, tolerance));
    }
    for (const [groupKey] of carryNew) {
      if (!carryOld.has(groupKey)) {
        errors.push({ errorType: 'ROW_MISSING', groupKey, message: `Transaction group [${groupKey}] found in target but not in source (extra row at chunk boundary)` });
      }
    }

    this.logger.log(`[TXN-SS] Done: ${errors.length} error(s), ${rowsChecked} rows checked`);
    return { errors, rowsChecked };
  }

  /**
   * Row-level fingerprint diff — called after validateGroup finds errors.
   *
   * Builds a fingerprint for each row by joining the configured column values
   * with '|', then diffs old vs new as multisets. Unmatched fingerprints are
   * reported as ROW_MISSING so engineers can see exactly which transaction
   * (identified by date, amount, etc.) is missing or extra in the group.
   *
   * Uses multisets (not sets) so duplicate-fingerprint rows are handled correctly:
   * if old has 3 rows with the same fingerprint and new has 2, we report 1 missing.
   */
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

    // filtered_sum_matches: SUM(old.col WHERE filter conditions) must equal new.col
    // Used for lv$lvhisthsum lvcredit*/lvdebit* columns derived by affectcode+debitcredit grouping.
    for (const mapping of sm.filtered_sum_matches ?? []) {
      if (this.isNoisyType(noisyMap.get(mapping.old))) continue;
      const f = mapping.old_filter;
      const filteredOld = oldGroup.filter((row) => {
        if (f.affectcode_in?.length && !f.affectcode_in.includes(String(row['affectcode'] ?? ''))) return false;
        if (f.debitcredit && String(row['debitcredit'] ?? '') !== f.debitcredit) return false;
        if (f.loantranshostcode_not_in?.includes(String(row['loantranshostcode'] ?? ''))) return false;
        if (f.loantranshostcode_in?.length && !f.loantranshostcode_in.includes(String(row['loantranshostcode'] ?? ''))) return false;
        return true;
      });
      const oldSum = this.sumColumn(filteredOld, mapping.old) ?? 0;
      const newTotal = this.sumColumn(newGroup, mapping.new) ?? 0;
      if (Math.abs(oldSum - newTotal) > tolerance) {
        const filterDesc = [
          f.affectcode_in?.length ? `affectcode∈[${f.affectcode_in.join(',')}]` : '',
          f.debitcredit ? `dc=${f.debitcredit}` : '',
        ].filter(Boolean).join(',');
        errors.push({
          errorType: 'VALUE_MISMATCH',
          oldColumn: `${mapping.old}[${filterDesc}]`,
          newColumn: mapping.new,
          oldValue: oldSum,
          newValue: newTotal,
          groupKey,
          message: `Filtered sum mismatch [${mapping.old}(${filterDesc})→${mapping.new}]: ${oldSum} ≠ ${newTotal} (group: ${groupKey})`,
        });
      }
    }

    return errors;
  }
}
