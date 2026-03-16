import { DatabaseService, tableRef } from '../database/database.service';
import { NoisyColumnType, SchemaMappings, ValidationError } from '../rules/rule.types';
import { BaseStrategy, ValidationContext } from './base.strategy';
import { TransformUtils } from './transform.utils';

// ============================================================
// SPLIT Strategy (1:N)
// One legacy table maps to multiple new tables.
// Validates that values from the source appear in the correct target table.
// Fix #5: noisy columns are skipped.
// Fix (Issue #1): resilient schema check — missing columns are warned and skipped.
// ============================================================
export class SplitStrategy extends BaseStrategy {
  constructor(db: DatabaseService) { super(db); }

  async validate(ctx: ValidationContext): Promise<{ errors: ValidationError[]; rowsChecked: number }> {
    const errors: ValidationError[] = [];
    let rowsChecked = 0;
    const { commonRule } = ctx;
    const { source, target } = commonRule.table_info;
    let sm = commonRule.schema_mappings;
    const anchorKeyOld = commonRule.anchor_key.old;
    const anchorKeyNew = commonRule.anchor_key.new;
    const chunkSize = parseInt(process.env.CHUNK_SIZE ?? '5000');

    this.logger.log(`[SPLIT] Validating ${source} → ${target}`);

    // ---- Schema check ----
    const colErrors = await this.checkMissingColumns(source, target, [
      ...(sm.exact_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: [m.new] })),
    ]);
    if (colErrors.length > 0) {
      errors.push(...colErrors);
      this.logger.warn(`[SPLIT] ${colErrors.length} column(s) missing — continuing with valid mappings only`);
      sm = this.filterMappingsAfterSchemaCheck(sm, colErrors);
    }
    errors.push(...await this.reportUnmappedColumns(source, target, sm, 'SPLIT'));

    // Noisy column detection
    const allOldCols = (sm.exact_matches ?? []).map((m) => m.old);
    const noisyMap = await this.detectNoisyColumns(source, allOldCols);
    for (const [col, type] of noisyMap) {
      if (type !== 'NORMAL') {
        this.logger.warn(`[SPLIT] Column [${col}] classified as ${type} — name-only match`);
      }
    }

    for (const mapping of sm.exact_matches ?? []) {
      if (this.isNoisyType(noisyMap.get(mapping.old))) continue;

      // ---- Stream new column values into a Set (O(distinct values) memory, not O(rows)) ----
      // streamAllRows streams in chunks — only chunkSize rows in memory at any time.
      // We accumulate only the mapped column value, not full row objects.
      const newVals = new Set<string>();
      await this.db.streamAllRows(target, anchorKeyNew, (row) => {
        const v = row[mapping.new];
        if (v !== null && v !== undefined && String(v).trim() !== '') {
          newVals.add(String(v).trim());
        }
      }, chunkSize);

      // ---- Stream old rows, check each value against the Set on the fly ----
      // Never accumulates old rows — constant memory regardless of table size.
      const oldValsSet = new Set<string>();
      await this.db.streamAllRows(source, anchorKeyOld, (row) => {
        const val = row[mapping.old];
        if (val === null || val === undefined || String(val).trim() === '') return;
        rowsChecked++;

        const transformed = mapping.transform_rule
          ? (TransformUtils.apply(val, mapping.transform_rule) ?? String(val).trim())
          : String(val).trim();

        oldValsSet.add(transformed);

        if (!newVals.has(transformed)) {
          errors.push({
            errorType: 'ROW_MISSING',
            oldColumn: mapping.old,
            newColumn: mapping.new,
            oldValue: val,
            message: `Value [${val}] from ${source}.${mapping.old} not found in ${target}.${mapping.new}`,
          });
        }
      }, chunkSize);

      // Reverse check — extra values in target with no source counterpart
      for (const newVal of newVals) {
        if (!oldValsSet.has(newVal)) {
          errors.push({
            errorType: 'ROW_MISSING',
            oldColumn: mapping.old,
            newColumn: mapping.new,
            newValue: newVal,
            message: `Value [${newVal}] in ${target}.${mapping.new} not found in source ${source}.${mapping.old} (extra in target)`,
          });
        }
      }
    }

    this.logger.log(`[SPLIT] Done: ${errors.length} error(s), ${rowsChecked} values checked`);
    return { errors, rowsChecked };
  }
}

// ============================================================
// HEADER Strategy – Long Format → Wide Format (Pivot)
//
// Fix #3: Implements actual pivot validation using pivot_config and pivot_matches.
//
// Algorithm:
//   1. Group old table by identity_key.old → pivot_key → value
//   2. For each (identity, pivot_key_value) pair defined in pivot_matches,
//      look up the corresponding new table column and compare values.
// ============================================================
export class HeaderStrategy extends BaseStrategy {
  constructor(db: DatabaseService) { super(db); }

  async validate(ctx: ValidationContext): Promise<{ errors: ValidationError[]; rowsChecked: number }> {
    const errors: ValidationError[] = [];
    let rowsChecked = 0;
    const { commonRule } = ctx;
    const { source, target } = commonRule.table_info;
    const pc = commonRule.pivot_config;
    const pm = commonRule.schema_mappings.pivot_matches ?? [];
    const tolerance = commonRule.defaults?.tolerance ?? 0;

    this.logger.log(`[HEADER] Validating pivot ${source} → ${target}`);

    // Fallback: pivot_config or pivot_matches not defined — cannot validate without knowing
    // the identity key and pivot structure. Any column-based count guess would be unreliable
    // (system-generated IDs differ between old/new; anchor_key may repeat per pivot row).
    // Instead: report a config gap and verify the target is at least not empty.
    if (!pc || pm.length === 0) {
      this.logger.warn(
        `[HEADER] pivot_config/pivot_matches not defined in common.yaml — proper pivot validation skipped. ` +
          `Add pivot_config.identity_key, pivot_config.pivot_key, and schema_mappings.pivot_matches.`,
      );
      errors.push({
        errorType: 'DATA_MISSING',
        message:
          `[HEADER] ${source}: pivot_config not defined — pivot validation skipped. ` +
          `Define pivot_config and schema_mappings.pivot_matches in common.yaml to enable full validation.`,
      });

      // Sanity check: target table should not be empty
      const [newCount] = await this.db.query<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM ${tableRef(target)}`,
      );
      if ((newCount?.cnt ?? 0) === 0) {
        errors.push({
          errorType: 'ROW_MISSING',
          message: `[HEADER] Target table ${target} is empty — migration may have failed entirely`,
        });
      }

      return { errors, rowsChecked: 0 };
    }

    const oldIdCol = pc.identity_key.old;
    const newIdCol = pc.identity_key.new;
    const pivotKey = pc.pivot_key;
    const valueCols = [...new Set(pm.map((p) => p.value_col))];
    const chunkSize = parseInt(process.env.CHUNK_SIZE ?? '5000');

    // ---- Chunked pivot comparison ----
    // Paginate by distinct identity keys from old table (getGroupKeys uses keyset, no OFFSET).
    // For each batch: fetch old pivot rows + matching new wide rows → compare → discard.
    // Memory at any point: O(chunkSize × avg_pivot_depth) — never the full table.
    let lastIdentityKey: string | null = null;

    while (true) {
      const identityKeys = await this.db.getGroupKeys(source, oldIdCol, chunkSize, lastIdentityKey);
      if (identityKeys.length === 0) break;

      // Fetch old pivot rows for this identity batch
      const oldChunkRows: Record<string, unknown>[] = [];
      await this.db.streamRowsByKeys(source, oldIdCol, identityKeys, (row) => oldChunkRows.push(row));
      rowsChecked += oldChunkRows.length;

      // Fetch matching new wide rows for this identity batch
      const newChunkRows: Record<string, unknown>[] = [];
      await this.db.streamRowsByKeys(target, newIdCol, identityKeys, (row) => newChunkRows.push(row));

      // Build old pivot map: identity → pivotKeyValue → valueCol → value
      const oldMap = new Map<string, Map<string, Map<string, unknown>>>();
      for (const row of oldChunkRows) {
        const id = String(row[oldIdCol] ?? '').trim();
        const pkVal = String(row[pivotKey] ?? '').trim();
        if (!oldMap.has(id)) oldMap.set(id, new Map());
        if (!oldMap.get(id)!.has(pkVal)) oldMap.get(id)!.set(pkVal, new Map());
        for (const vc of valueCols) {
          oldMap.get(id)!.get(pkVal)!.set(vc, row[vc]);
        }
      }

      // Build new map: identity → wide row
      // M1: detect duplicate identities in target — migration bug creates extra rows in the
      // wide-format table. Without this check, the second row silently overwrites the first
      // in the Map, causing the comparison to use wrong data (false mismatches or false passes).
      // Fix: keep the first occurrence, push TRANSFORM_ERROR for every duplicate so the
      // migration bug is visible in the report.
      const newMap = new Map<string, Record<string, unknown>>();
      for (const row of newChunkRows) {
        const id = String(row[newIdCol] ?? '').trim();
        if (newMap.has(id)) {
          errors.push({
            errorType: 'TRANSFORM_ERROR',
            rowIdentifier: id,
            message:
              `[HEADER] Duplicate identity [${id}] found in target ${target} — ` +
              `migration created extra rows; first occurrence used for comparison`,
          });
          continue; // skip duplicate — keep first row
        }
        newMap.set(id, row);
      }

      // Compare pivot values for each identity in this batch
      for (const [id, pivotValues] of oldMap) {
        const newRow = newMap.get(id);
        if (!newRow) {
          errors.push({
            errorType: 'ROW_MISSING',
            rowIdentifier: id,
            message: `[HEADER] Identity [${id}] found in source but not in target`,
          });
          continue;
        }

        for (const pivotMatch of pm) {
          const oldVal = pivotValues.get(pivotMatch.pivot_key_value)?.get(pivotMatch.value_col);
          const newVal = newRow[pivotMatch.new_col];

          if (!TransformUtils.isEqual(oldVal, newVal, tolerance)) {
            errors.push({
              errorType: 'VALUE_MISMATCH',
              oldColumn: `${pivotKey}='${pivotMatch.pivot_key_value}'.${pivotMatch.value_col}`,
              newColumn: pivotMatch.new_col,
              oldValue: oldVal,
              newValue: newVal,
              rowIdentifier: id,
              message:
                `[HEADER] Pivot mismatch for id=[${id}], ` +
                `${pivotKey}='${pivotMatch.pivot_key_value}': ` +
                `${pivotMatch.value_col}=${oldVal} ≠ ${pivotMatch.new_col}=${newVal}`,
            });
          }
        }
      }

      // Extra new rows in this batch (new ids fetched but not in old)
      for (const newId of newMap.keys()) {
        if (!oldMap.has(newId)) {
          errors.push({
            errorType: 'ROW_MISSING',
            rowIdentifier: newId,
            message: `[HEADER] Identity [${newId}] found in target but not in source`,
          });
        }
      }

      lastIdentityKey = identityKeys[identityKeys.length - 1];
      if (identityKeys.length < chunkSize) break;
    }

    this.logger.log(`[HEADER] Done: ${errors.length} error(s), ${rowsChecked} old rows checked`);
    return { errors, rowsChecked };
  }
}

// ============================================================
// UNION Strategy – N sources → 1 target
//
// Fix (Issue #1): Resilient schema check — missing columns are warned and skipped.
// Fix (Issue #2): No longer uses getGroupKeys (SELECT DISTINCT on groupKey).
//   Instead, streams by anchorKey (reliable ordering) and groups rows by
//   groupKey in memory. No index on groupKey required.
// ============================================================
export class UnionStrategy extends BaseStrategy {
  constructor(db: DatabaseService) { super(db); }

  async validate(ctx: ValidationContext): Promise<{ errors: ValidationError[]; rowsChecked: number }> {
    const errors: ValidationError[] = [];
    let rowsChecked = 0;
    const { commonRule } = ctx;
    const { source, target } = commonRule.table_info;
    const sources = source.split(',').map((s) => s.trim());
    const tg = commonRule.transaction_grouping;
    let sm = commonRule.schema_mappings;
    const tolerance = commonRule.defaults?.tolerance ?? 0;
    const anchorKeyOld = commonRule.anchor_key.old;
    const anchorKeyNew = commonRule.anchor_key.new;
    const chunkSize = parseInt(process.env.CHUNK_SIZE ?? '5000');

    this.logger.log(`[UNION] Validating ${sources.length} source(s) → ${target}`);

    if (!tg) {
      errors.push({
        errorType: 'TRANSFORM_ERROR',
        message: `UNION table has no transaction_grouping defined — cannot correlate source rows to target`,
      });
      return { errors, rowsChecked: 0 };
    }

    const oldKeyCol = tg.keys.old;
    const newKeyCol = tg.keys.new;

    // ---- Schema check — resilient (Issue #1) ----
    // Check against the first source (all sources in a UNION share the same column schema)
    const colErrors = await this.checkMissingColumns(sources[0], target, [
      ...(sm.exact_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: [m.new] })),
      ...(sm.transformed_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: [m.new] })),
      ...(sm.split_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: m.new_cols })),
    ]);
    if (colErrors.length > 0) {
      errors.push(...colErrors);
      this.logger.warn(`[UNION] ${colErrors.length} column(s) missing — continuing with valid mappings only`);
      sm = this.filterMappingsAfterSchemaCheck(sm, colErrors);
    }
    errors.push(...await this.reportUnmappedColumns(sources[0], target, sm, 'UNION'));

    // Noisy column detection on first source (Fix #5)
    const allOldCols = [
      ...(sm.exact_matches ?? []).map((m) => m.old),
      ...(sm.transformed_matches ?? []).map((m) => m.old),
      ...(sm.split_matches ?? []).map((m) => m.old),
    ];
    const noisyMap = await this.detectNoisyColumns(sources[0], allOldCols);
    for (const [col, type] of noisyMap) {
      if (type !== 'NORMAL') {
        this.logger.warn(`[UNION] Column [${col}] classified as ${type} — name-only match`);
      }
    }

    // ---- Anchor key uniqueness check — one per source table ----
    for (const src of sources) {
      const anchorDupErr = await this.checkAnchorKeyUnique(src, anchorKeyOld);
      if (anchorDupErr) {
        errors.push(anchorDupErr);
        this.logger.warn(`[UNION] ${anchorDupErr.message}`);
      }
    }

    // Inner helper: compare a fully-assembled group (reused by main loop and carry-flush)
    const compareUnionGroup = (
      src: string,
      groupKey: string,
      oldGroup: Record<string, unknown>[],
      newGroup: Record<string, unknown>[],
    ): void => {
      if (newGroup.length === 0) {
        errors.push({
          errorType: 'ROW_MISSING',
          groupKey,
          message: `[UNION] Transaction group [${groupKey}] from ${src} not found in target`,
        });
        return;
      }

      for (const mapping of sm.exact_matches ?? []) {
        if (this.isNoisyType(noisyMap.get(mapping.old))) continue;
        const oldTotal = this.sumOrFirst(oldGroup, mapping.old);
        const newTotal = this.sumOrFirst(newGroup, mapping.new);
        if (oldTotal !== null && newTotal !== null) {
          if (!TransformUtils.isEqual(oldTotal, newTotal, tolerance)) {
            errors.push({
              errorType: 'VALUE_MISMATCH',
              oldColumn: mapping.old,
              newColumn: mapping.new,
              oldValue: oldTotal,
              newValue: newTotal,
              groupKey,
              message: `[UNION] Group mismatch [${mapping.old}→${mapping.new}]: ${oldTotal} ≠ ${newTotal} (group: ${groupKey})`,
            });
          }
        }
      }

      for (const mapping of sm.transformed_matches ?? []) {
        if (this.isNoisyType(noisyMap.get(mapping.old))) continue;
        const oldVal = oldGroup[0]?.[mapping.old];
        const newVal = newGroup[0]?.[mapping.new];
        const transformedOld = TransformUtils.apply(oldVal, mapping.transform_rule);
        const transformedNew = TransformUtils.apply(newVal, 'NONE');
        if (!TransformUtils.isEqual(transformedOld, transformedNew, tolerance)) {
          errors.push({
            errorType: 'VALUE_MISMATCH',
            oldColumn: mapping.old,
            newColumn: mapping.new,
            oldValue: oldVal,
            newValue: newVal,
            groupKey,
            message: `[UNION] Transform mismatch [${mapping.old}→${mapping.new}]: "${transformedOld}" ≠ "${transformedNew}" (group: ${groupKey})`,
          });
        }
      }
    };

    // ---- Anchor-key streaming with carry-over ----
    // Stream each source by anchorKey → fetch matching target rows → group by groupKey in memory.
    // Carry-over: if the last group in a chunk might continue in the next chunk, hold it back
    // and merge it before comparing. This prevents wrong group-level sums at chunk boundaries.
    const sourceFilter = commonRule.table_info.source_filter;

    for (const src of sources) {
      this.logger.log(`[UNION] Processing source: ${src}`);
      let lastAnchorKey: unknown = null;
      let carryOld = new Map<string, Record<string, unknown>[]>();
      let carryNew = new Map<string, Record<string, unknown>[]>();

      while (true) {
        const oldChunk = await this.db.fetchChunk(src, anchorKeyOld, chunkSize, lastAnchorKey, sourceFilter);
        if (oldChunk.length === 0) break;

        // Unique anchor key values in this chunk
        const anchorVals = [...new Set(oldChunk.map((r) => String(r[anchorKeyOld] ?? '').trim()))];

        // Fetch matching target rows by anchor key
        const newRows: Record<string, unknown>[] = [];
        await this.db.streamRowsByKeys(target, anchorKeyNew, anchorVals, (row) => newRows.push(row));

        // Seed group maps with carry-over from previous chunk
        const oldGroupMap = new Map<string, Record<string, unknown>[]>(carryOld);
        const newGroupMap = new Map<string, Record<string, unknown>[]>(carryNew);
        carryOld = new Map();
        carryNew = new Map();

        for (const row of oldChunk) {
          const key = String(row[oldKeyCol] ?? '').trim();
          if (!oldGroupMap.has(key)) oldGroupMap.set(key, []);
          oldGroupMap.get(key)!.push(row);
          rowsChecked++;
        }
        for (const row of newRows) {
          const key = String(row[newKeyCol] ?? '').trim();
          if (!newGroupMap.has(key)) newGroupMap.set(key, []);
          newGroupMap.get(key)!.push(row);
        }

        const isLastChunk = oldChunk.length < chunkSize;

        // Hold back the last group if more chunks may follow
        const carryKey = !isLastChunk ? [...oldGroupMap.keys()].at(-1) : undefined;
        if (carryKey) {
          carryOld.set(carryKey, oldGroupMap.get(carryKey)!);
          if (newGroupMap.has(carryKey)) carryNew.set(carryKey, newGroupMap.get(carryKey)!);
        }

        // Compare all committed groups
        for (const [groupKey, oldGroup] of oldGroupMap) {
          if (groupKey === carryKey) continue;
          compareUnionGroup(src, groupKey, oldGroup, newGroupMap.get(groupKey) ?? []);
        }

        // Extra groups in target not matched by this source's committed groups
        for (const [groupKey] of newGroupMap) {
          if (groupKey === carryKey) continue;
          if (!oldGroupMap.has(groupKey)) {
            errors.push({
              errorType: 'ROW_MISSING',
              groupKey,
              message: `[UNION] Transaction group [${groupKey}] found in target but not in source ${src} (extra row)`,
            });
          }
        }

        lastAnchorKey = oldChunk[oldChunk.length - 1][anchorKeyOld];
        if (isLastChunk) break;
      }

      // Flush remaining carry for this source
      for (const [groupKey, oldGroup] of carryOld) {
        compareUnionGroup(src, groupKey, oldGroup, carryNew.get(groupKey) ?? []);
      }

      // Extra groups still in carry target
      for (const [groupKey] of carryNew) {
        if (!carryOld.has(groupKey)) {
          errors.push({
            errorType: 'ROW_MISSING',
            groupKey,
            message: `[UNION] Transaction group [${groupKey}] found in target but not in source ${src} (extra row in carry)`,
          });
        }
      }
    }

    this.logger.log(`[UNION] Done: ${errors.length} error(s), ${rowsChecked} rows checked`);
    return { errors, rowsChecked };
  }

  private sumOrFirst(rows: Record<string, unknown>[], col: string): unknown {
    if (rows.length === 0) return null;
    const vals = rows.map((r) => r[col]);
    const nums = vals.map((v) => parseFloat(String(v ?? '')));
    if (nums.every((n) => !isNaN(n))) {
      return nums.reduce((a, b) => a + b, 0);
    }
    // Non-numeric: return sorted distinct non-empty values joined by '|'.
    // Sorted + deduplicated → order-independent comparison regardless of SQL row ordering.
    // The CSV report will show e.g. "val1|val2" which is still human-readable.
    const unique = [
      ...new Set(vals.map((v) => String(v ?? '').trim()).filter((v) => v !== '')),
    ].sort();
    return unique.length > 0 ? unique.join('|') : null;
  }
}

// ============================================================
// MULTIPLE Strategy (N:N or N:1)
//
// Fix #4: Routes each mapping to the correct (src_table, tgt_table) pair
//          using the optional src_table / tgt_table fields on ExactMatch /
//          TransformedMatch. Falls back to the first source/target pair if
//          not specified.
//
// Fix #5: Noisy columns are detected per source table and skipped.
//
// Group-mode: When transaction_grouping is defined, uses carry-over streaming
//   (like TransactionStrategy) instead of 1:1 row lookup. This supports N:1
//   cases (e.g. 3 old tables → 1 new table) where there is no unique per-row
//   anchor key. Old rows are paginated by anchor_key.old; target rows are
//   fetched by transaction_grouping.keys.new (the shared group key).
// ============================================================
export class MultipleStrategy extends BaseStrategy {
  constructor(db: DatabaseService) { super(db); }

  async validate(ctx: ValidationContext): Promise<{ errors: ValidationError[]; rowsChecked: number }> {
    const errors: ValidationError[] = [];
    let rowsChecked = 0;
    const { commonRule } = ctx;
    const { source, target } = commonRule.table_info;
    const sm = commonRule.schema_mappings;
    const tg = commonRule.transaction_grouping;
    const tolerance = commonRule.defaults?.tolerance ?? 0;
    const anchorKeyOld = commonRule.anchor_key.old;
    const chunkSize = parseInt(process.env.CHUNK_SIZE ?? '5000');

    const sources = source.split(',').map((s) => s.trim());
    const targets = target.split(',').map((t) => t.trim());

    this.logger.log(`[MULTIPLE] Validating ${sources.length} source(s) → ${targets.length} target(s)`);

    // Group all mappings by (src_table, tgt_table) pair.
    // Mappings without explicit src_table/tgt_table fall into the first pair.
    type MappingPair = { srcTable: string; tgtTable: string };
    const pairKey = (p: MappingPair) => `${p.srcTable}::${p.tgtTable}`;

    const defaultSrc = sources[0];
    const defaultTgt = targets[0];

    interface PairMappings {
      exact: typeof sm.exact_matches;
      transformed: typeof sm.transformed_matches;
      concat: typeof sm.concat_matches;
      split: typeof sm.split_matches;
      formula: typeof sm.formula_matches;
    }

    const pairMap = new Map<string, PairMappings & MappingPair>();

    const getOrCreate = (srcTable: string, tgtTable: string) => {
      const key = pairKey({ srcTable, tgtTable });
      if (!pairMap.has(key)) {
        pairMap.set(key, { srcTable, tgtTable, exact: [], transformed: [], concat: [], split: [], formula: [] });
      }
      return pairMap.get(key)!;
    };

    for (const m of sm.exact_matches ?? []) {
      getOrCreate(m.src_table ?? defaultSrc, m.tgt_table ?? defaultTgt).exact!.push(m);
    }
    for (const m of sm.transformed_matches ?? []) {
      getOrCreate(m.src_table ?? defaultSrc, m.tgt_table ?? defaultTgt).transformed!.push(m);
    }
    for (const m of sm.concat_matches ?? []) {
      getOrCreate(m.src_table ?? defaultSrc, m.tgt_table ?? defaultTgt).concat!.push(m);
    }
    // split_matches and formula_matches have no src_table/tgt_table — always assigned to default pair
    for (const m of sm.split_matches ?? []) {
      getOrCreate(defaultSrc, defaultTgt).split!.push(m);
    }
    for (const m of sm.formula_matches ?? []) {
      getOrCreate(defaultSrc, defaultTgt).formula!.push(m);
    }
    errors.push(...await this.reportUnmappedColumns(defaultSrc, defaultTgt, sm, 'MULTIPLE'));

    // ---- Group-mode: transaction_grouping defined → carry-over streaming ----
    // Used when there is no unique per-row anchor key shared between old and new tables
    // (e.g. 3 old tables → 1 new table, id is regenerated in new system).
    // Old rows are paginated by anchor_key.old for keyset ordering.
    // Target rows are fetched by transaction_grouping.keys.new (the shared group identifier).
    if (tg) {
      const oldKeyCol = tg.keys.old;
      const newKeyCol = tg.keys.new;
      // target_fetch_key: use an indexed column for the WHERE IN query on the target side.
      // Verified equal to keys.new on all tables (journalseqno = systemreferenceno, 100% match).
      const targetFetchKey = tg.target_fetch_key ?? newKeyCol;

      // Schema check per pair — mirrors TransactionStrategy (Issue #1).
      // Without this, missing columns produce silent null comparisons, not COLUMN_MISSING errors.
      for (const pair of pairMap.values()) {
        const pairColErrors = await this.checkMissingColumns(pair.srcTable, pair.tgtTable, [
          ...(pair.exact ?? []).map((m) => ({ oldCols: [m.old], newCols: [m.new] })),
          ...(pair.transformed ?? []).map((m) => ({ oldCols: [m.old], newCols: [m.new] })),
          ...(pair.concat ?? []).map((m) => ({ oldCols: m.old_cols ?? [], newCols: [m.new] })),
        ]);
        if (pairColErrors.length > 0) {
          errors.push(...pairColErrors);
          this.logger.warn(
            `[MULTIPLE:GROUP] ${pairColErrors.length} column(s) missing in ` +
            `${pair.srcTable} → ${pair.tgtTable} — those mappings will be silently skipped`,
          );
        }
      }

      for (const pair of pairMap.values()) {
        const { srcTable, tgtTable, exact, transformed, concat, split, formula } = pair;

        // Per-source group key: use source_key_aliases if defined for this source,
        // otherwise fall back to tg.keys.old (the shared default).
        const srcKeyCol = tg.source_key_aliases?.[srcTable] ?? oldKeyCol;

        // Apply source_filter only to the primary (default) source.
        // Secondary sources may have different column names that would cause a SQL error.
        const srcFilter = srcTable === defaultSrc ? commonRule.table_info.source_filter : undefined;

        this.logger.log(`[MULTIPLE:GROUP] Processing ${srcTable} → ${tgtTable} (grouped by [${srcKeyCol}])`);

        // Noisy column detection
        const allOldCols = [
          ...(exact ?? []).map((m) => m.old),
          ...(transformed ?? []).map((m) => m.old),
          ...(concat ?? []).flatMap((m) => m.old_cols),
          ...(split ?? []).map((m) => m.old),
          ...(formula ?? []).flatMap((m) => m.old_cols),
        ];
        const noisyMap = await this.detectNoisyColumns(srcTable, allOldCols);

        // ---- Sysref-sort mode (use_sysref_sort: true) ----
        // Page old table sorted by sysref (srcKeyCol) — eliminates scatter, carry-over at boundary.
        // ~10× fewer DB round-trips vs use_group_pagination (1 scan per chunk vs 2 per batch).
        if (tg.use_sysref_sort) {
          let lastKey: unknown = null;
          let carryOld = new Map<string, Record<string, unknown>[]>();
          let carryNew = new Map<string, Record<string, unknown>[]>();

          while (true) {
            const oldChunk = await this.db.fetchChunk(srcTable, srcKeyCol, chunkSize, lastKey, srcFilter);
            if (oldChunk.length === 0) break;

            const oldGroupMap = new Map<string, Record<string, unknown>[]>(carryOld);
            const newGroupMap = new Map<string, Record<string, unknown>[]>(carryNew);
            carryOld = new Map();
            carryNew = new Map();

            const groupKeyVals = [
              ...new Set(oldChunk.map((r) => String(r[srcKeyCol] ?? '').trim())),
            ].filter((k) => k !== '' && !newGroupMap.has(k));

            const newRows: Record<string, unknown>[] = [];
            await this.db.streamRowsByKeys(tgtTable, targetFetchKey, groupKeyVals, (row) => newRows.push(row));

            for (const row of oldChunk) {
              const key = String(row[srcKeyCol] ?? '').trim();
              if (!oldGroupMap.has(key)) oldGroupMap.set(key, []);
              oldGroupMap.get(key)!.push(row);
              rowsChecked++;
            }
            for (const row of newRows) {
              const key = String(row[newKeyCol] ?? '').trim();
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
                errors.push({ errorType: 'ROW_MISSING', groupKey, message: `[MULTIPLE] Group [${groupKey}] from ${srcTable} not found in ${tgtTable}` });
                continue;
              }
              const pairSm: SchemaMappings = { exact_matches: exact, transformed_matches: transformed, concat_matches: concat, split_matches: split, formula_matches: formula };
              const groupErrors = this.validateGroup(groupKey, oldGroup, newGroup, pairSm, tolerance, noisyMap);
              errors.push(...groupErrors);
              if (groupErrors.length > 0 && tg.row_fingerprint?.length) {
                errors.push(...this.fingerprintDiff(groupKey, oldGroup, newGroup, tg.row_fingerprint));
              }
              errors.push(...this.runDefRules(groupKey, oldGroup, newGroup, ctx.defRules, ctx.affectCodeMap, tolerance));
            }

            for (const [groupKey] of newGroupMap) {
              if (groupKey === carryKey) continue;
              if (!oldGroupMap.has(groupKey)) {
                errors.push({ errorType: 'ROW_MISSING', groupKey, message: `[MULTIPLE] Group [${groupKey}] found in ${tgtTable} but not in ${srcTable} (extra row)` });
              }
            }

            lastKey = oldChunk[oldChunk.length - 1][srcKeyCol];
            if (isLastChunk) break;
          }

          // Flush carry
          for (const [groupKey, oldGroup] of carryOld) {
            const newGroup = carryNew.get(groupKey) ?? [];
            if (newGroup.length === 0) {
              errors.push({ errorType: 'ROW_MISSING', groupKey, message: `[MULTIPLE] Group [${groupKey}] from ${srcTable} not found in ${tgtTable}` });
              continue;
            }
            const pairSmFlush: SchemaMappings = { exact_matches: exact, transformed_matches: transformed, concat_matches: concat, split_matches: split, formula_matches: formula };
            errors.push(...this.validateGroup(groupKey, oldGroup, newGroup, pairSmFlush, tolerance, noisyMap));
            errors.push(...this.runDefRules(groupKey, oldGroup, newGroup, ctx.defRules, ctx.affectCodeMap, tolerance));
          }
          for (const [groupKey] of carryNew) {
            if (!carryOld.has(groupKey)) {
              errors.push({ errorType: 'ROW_MISSING', groupKey, message: `[MULTIPLE] Group [${groupKey}] found in ${tgtTable} but not in ${srcTable} (extra row in carry)` });
            }
          }

          continue; // skip anchor-key streaming for this pair
        }

        // ---- Group-key pagination mode (use_group_pagination: true) ----
        // Mirrors TransactionStrategy.validateGroupPagination.
        // Use when group rows are SCATTERED in anchor-key (id) order — carry-over streaming
        // compares partial groups per chunk → false VALUE_MISMATCH errors.
        if (tg.use_group_pagination) {
          const GROUP_BATCH = 200;
          let lastGroupKey: string | null = null;
          while (true) {
            const groupKeys = await this.db.getDistinctKeys(
              srcTable, srcKeyCol, GROUP_BATCH, lastGroupKey, srcFilter,
            );
            if (groupKeys.length === 0) break;

            const oldRows: Record<string, unknown>[] = [];
            await this.db.streamRowsByKeys(srcTable, srcKeyCol, groupKeys, (row) => oldRows.push(row));
            const newRows: Record<string, unknown>[] = [];
            await this.db.streamRowsByKeys(tgtTable, targetFetchKey, groupKeys, (row) => newRows.push(row));

            const oldGroupMap = new Map<string, Record<string, unknown>[]>();
            for (const row of oldRows) {
              const key = String(row[srcKeyCol] ?? '').trim();
              if (!key) continue;
              if (!oldGroupMap.has(key)) oldGroupMap.set(key, []);
              oldGroupMap.get(key)!.push(row);
              rowsChecked++;
            }

            const newGroupMap = new Map<string, Record<string, unknown>[]>();
            for (const row of newRows) {
              const key = String(row[newKeyCol] ?? '').trim();
              if (!key) continue;
              if (!newGroupMap.has(key)) newGroupMap.set(key, []);
              newGroupMap.get(key)!.push(row);
            }

            for (const [groupKey, oldGroup] of oldGroupMap) {
              const newGroup = newGroupMap.get(groupKey) ?? [];
              if (newGroup.length === 0) {
                errors.push({
                  errorType: 'ROW_MISSING',
                  groupKey,
                  message: `[MULTIPLE] Group [${groupKey}] from ${srcTable} not found in ${tgtTable}`,
                });
                continue;
              }
              const pairSm: SchemaMappings = { exact_matches: exact, transformed_matches: transformed, concat_matches: concat, split_matches: split, formula_matches: formula };
              const groupErrors = this.validateGroup(groupKey, oldGroup, newGroup, pairSm, tolerance, noisyMap);
              errors.push(...groupErrors);
              if (groupErrors.length > 0 && tg.row_fingerprint?.length) {
                errors.push(...this.fingerprintDiff(groupKey, oldGroup, newGroup, tg.row_fingerprint));
              }
              errors.push(...this.runDefRules(groupKey, oldGroup, newGroup, ctx.defRules, ctx.affectCodeMap, tolerance));
            }

            for (const [groupKey] of newGroupMap) {
              if (!oldGroupMap.has(groupKey)) {
                errors.push({
                  errorType: 'ROW_MISSING',
                  groupKey,
                  message: `[MULTIPLE] Group [${groupKey}] found in ${tgtTable} but not in ${srcTable} (extra row)`,
                });
              }
            }

            lastGroupKey = groupKeys[groupKeys.length - 1];
            if (groupKeys.length < GROUP_BATCH) break;
          }
          continue; // skip carry-over streaming for this pair
        }

        // Anchor key uniqueness check (ensures keyset pagination works correctly)
        const anchorDupErr = await this.checkAnchorKeyUnique(srcTable, anchorKeyOld);
        if (anchorDupErr) {
          errors.push(anchorDupErr);
          this.logger.warn(`[MULTIPLE:GROUP] ${anchorDupErr.message}`);
        }

        let lastKey: unknown = null;
        let carryOld = new Map<string, Record<string, unknown>[]>();
        let carryNew = new Map<string, Record<string, unknown>[]>();

        while (true) {
          const oldChunk = await this.db.fetchChunk(srcTable, anchorKeyOld, chunkSize, lastKey, srcFilter);
          if (oldChunk.length === 0) break;

          // Seed group maps with carry-over from previous chunk BEFORE computing groupKeyVals
          // so we can exclude already-fetched carry groups (Bug 2 fix — mirrors TransactionStrategy).
          // Without this, the carry group's target rows are re-fetched and appended → doubled sums.
          const oldGroupMap = new Map<string, Record<string, unknown>[]>(carryOld);
          const newGroupMap = new Map<string, Record<string, unknown>[]>(carryNew);
          carryOld = new Map();
          carryNew = new Map();

          // Collect unique group key values, excluding keys already in newGroupMap (carry)
          const groupKeyVals = [
            ...new Set(oldChunk.map((r) => String(r[srcKeyCol] ?? '').trim())),
          ].filter((k) => k !== '' && !newGroupMap.has(k));

          // Fetch target rows by GROUP KEY (not by anchor key — old id has no match in new)
          const newRows: Record<string, unknown>[] = [];
          await this.db.streamRowsByKeys(tgtTable, targetFetchKey, groupKeyVals, (row) => newRows.push(row));

          for (const row of oldChunk) {
            const key = String(row[srcKeyCol] ?? '').trim();
            if (!oldGroupMap.has(key)) oldGroupMap.set(key, []);
            oldGroupMap.get(key)!.push(row);
            rowsChecked++;
          }
          for (const row of newRows) {
            const key = String(row[newKeyCol] ?? '').trim();
            if (!newGroupMap.has(key)) newGroupMap.set(key, []);
            newGroupMap.get(key)!.push(row);
          }

          const isLastChunk = oldChunk.length < chunkSize;
          const carryKey = !isLastChunk ? [...oldGroupMap.keys()].at(-1) : undefined;
          if (carryKey) {
            carryOld.set(carryKey, oldGroupMap.get(carryKey)!);
            if (newGroupMap.has(carryKey)) carryNew.set(carryKey, newGroupMap.get(carryKey)!);
          }

          // Compare all committed groups
          for (const [groupKey, oldGroup] of oldGroupMap) {
            if (groupKey === carryKey) continue;
            const newGroup = newGroupMap.get(groupKey) ?? [];
            if (newGroup.length === 0) {
              errors.push({
                errorType: 'ROW_MISSING',
                groupKey,
                message: `[MULTIPLE] Group [${groupKey}] from ${srcTable} not found in ${tgtTable}`,
              });
              continue;
            }
            const pairSmCo: SchemaMappings = { exact_matches: exact, transformed_matches: transformed, concat_matches: concat, split_matches: split, formula_matches: formula };
            errors.push(...this.validateGroup(groupKey, oldGroup, newGroup, pairSmCo, tolerance, noisyMap));
            errors.push(...this.runDefRules(groupKey, oldGroup, newGroup, ctx.defRules, ctx.affectCodeMap, tolerance));
          }

          // Extra groups in target not present in this source
          for (const [groupKey] of newGroupMap) {
            if (groupKey === carryKey) continue;
            if (!oldGroupMap.has(groupKey)) {
              errors.push({
                errorType: 'ROW_MISSING',
                groupKey,
                message: `[MULTIPLE] Group [${groupKey}] found in ${tgtTable} but not in ${srcTable} (extra row)`,
              });
            }
          }

          lastKey = oldChunk[oldChunk.length - 1][anchorKeyOld];
          if (isLastChunk) break;
        }

        // Flush carry
        for (const [groupKey, oldGroup] of carryOld) {
          const newGroup = carryNew.get(groupKey) ?? [];
          if (newGroup.length === 0) {
            errors.push({
              errorType: 'ROW_MISSING',
              groupKey,
              message: `[MULTIPLE] Group [${groupKey}] from ${srcTable} not found in ${tgtTable}`,
            });
            continue;
          }
          const pairSmFlush: SchemaMappings = { exact_matches: exact, transformed_matches: transformed, concat_matches: concat, split_matches: split, formula_matches: formula };
          errors.push(...this.validateGroup(groupKey, oldGroup, newGroup, pairSmFlush, tolerance, noisyMap));
          errors.push(...this.runDefRules(groupKey, oldGroup, newGroup, ctx.defRules, ctx.affectCodeMap, tolerance));
        }
        for (const [groupKey] of carryNew) {
          if (!carryOld.has(groupKey)) {
            errors.push({
              errorType: 'ROW_MISSING',
              groupKey,
              message: `[MULTIPLE] Group [${groupKey}] found in ${tgtTable} but not in ${srcTable} (extra row in carry)`,
            });
          }
        }
      }

      this.logger.log(`[MULTIPLE] Done: ${errors.length} error(s), ${rowsChecked} rows checked`);
      return { errors, rowsChecked };
    }

    // ---- Row-mode: no transaction_grouping → 1:1 anchor key lookup (original behavior) ----
    const anchorKeyNew = commonRule.anchor_key.new;

    for (const pair of pairMap.values()) {
      const { srcTable, tgtTable, exact, transformed, concat } = pair;

      this.logger.log(`[MULTIPLE] Processing ${srcTable} → ${tgtTable}`);

      // Noisy column detection (Fix #5)
      const allOldCols = [
        ...(exact ?? []).map((m) => m.old),
        ...(transformed ?? []).map((m) => m.old),
        ...(concat ?? []).flatMap((m) => m.old_cols),
      ];
      const noisyMap = await this.detectNoisyColumns(srcTable, allOldCols);

      let lastKey: unknown = null;

      while (true) {
        const oldChunk = await this.db.fetchChunk(srcTable, anchorKeyOld, chunkSize, lastKey);
        if (oldChunk.length === 0) break;

        // M4: deduplicate anchor values — consistent with TRANSACTION and UNION strategies.
        // Duplicate params waste batch slots (2000-param limit) without changing query results.
        const anchorVals = [...new Set(oldChunk.map((r) => String(r[anchorKeyOld] ?? '').trim()))];

        // Fetch matching new rows via streamRowsByKeys which handles the 2100 SQL Server
        // parameter limit by batching keys in 2000-key chunks internally.
        const newRows: Record<string, unknown>[] = [];
        await this.db.streamRowsByKeys(tgtTable, anchorKeyNew, anchorVals, (row) => newRows.push(row));
        const newMap = new Map(newRows.map((r) => [String(r[anchorKeyNew] ?? '').trim(), r]));

        for (const oldRow of oldChunk) {
          rowsChecked++;
          const key = String(oldRow[anchorKeyOld] ?? '').trim();
          const newRow = newMap.get(key);

          if (!newRow) {
            errors.push({
              errorType: 'ROW_MISSING',
              rowIdentifier: key,
              message: `[MULTIPLE] Row [${key}] from ${srcTable} not found in ${tgtTable}`,
            });
            continue;
          }

          // exact matches
          for (const m of exact ?? []) {
            if (this.isNoisyType(noisyMap.get(m.old))) continue;
            const oldVal = oldRow[m.old];
            const newVal = newRow[m.new];
            const transformedOld = m.transform_rule
              ? TransformUtils.apply(oldVal, m.transform_rule)
              : String(oldVal ?? '').trim();
            const transformedNew = String(newVal ?? '').trim();
            if (!TransformUtils.isEqual(transformedOld, transformedNew, tolerance)) {
              errors.push({
                errorType: 'VALUE_MISMATCH',
                oldColumn: m.old,
                newColumn: m.new,
                oldValue: oldVal,
                newValue: newVal,
                rowIdentifier: key,
                message: `[MULTIPLE] Mismatch [${m.old}→${m.new}]: "${oldVal}" ≠ "${newVal}" (${key})`,
              });
            }
          }

          // transformed matches
          for (const m of transformed ?? []) {
            if (this.isNoisyType(noisyMap.get(m.old))) continue;
            const oldVal = oldRow[m.old];
            const newVal = newRow[m.new];
            const transformedOld = TransformUtils.apply(oldVal, m.transform_rule);
            const transformedNew = TransformUtils.apply(newVal, 'NONE');
            if (!TransformUtils.isEqual(transformedOld, transformedNew, tolerance)) {
              errors.push({
                errorType: 'VALUE_MISMATCH',
                oldColumn: m.old,
                newColumn: m.new,
                oldValue: oldVal,
                newValue: newVal,
                rowIdentifier: key,
                message: `[MULTIPLE] Transform mismatch [${m.old}→${m.new}]: "${transformedOld}" ≠ "${transformedNew}" (${key})`,
              });
            }
          }

          // concat matches (Fix #6)
          for (const m of concat ?? []) {
            if (m.old_cols.some((c) => this.isNoisyType(noisyMap.get(c)))) continue;
            const sep = m.separator ?? '';
            const concatenated = m.old_cols.map((c) => String(oldRow[c] ?? '').trim()).join(sep);
            const newVal = String(newRow[m.new] ?? '').trim();
            if (!TransformUtils.isEqual(concatenated, newVal, tolerance)) {
              errors.push({
                errorType: 'VALUE_MISMATCH',
                oldColumn: m.old_cols.join('+'),
                newColumn: m.new,
                oldValue: concatenated,
                newValue: newVal,
                rowIdentifier: key,
                message: `[MULTIPLE] Concat mismatch [${m.old_cols.join('+')}→${m.new}]: "${concatenated}" ≠ "${newVal}" (${key})`,
              });
            }
          }
        }

        lastKey = oldChunk[oldChunk.length - 1][anchorKeyOld];
        if (oldChunk.length < chunkSize) break;
      }
    }

    this.logger.log(`[MULTIPLE] Done: ${errors.length} error(s), ${rowsChecked} rows checked`);
    return { errors, rowsChecked };
  }

  // ----------------------------------------------------------------
  // Group-mode aggregate comparison (used in group-mode path)
  // ----------------------------------------------------------------

  private validateGroup(
    groupKey: string,
    oldGroup: Record<string, unknown>[],
    newGroup: Record<string, unknown>[],
    mappings: SchemaMappings,
    tolerance: number,
    noisyMap: Map<string, NoisyColumnType>,
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const m of mappings.exact_matches ?? []) {
      if (this.isNoisyType(noisyMap.get(m.old))) continue;
      const oldTotal = this.sumColumn(oldGroup, m.old);
      const newTotal = this.sumColumn(newGroup, m.new);
      if (oldTotal !== null && newTotal !== null && Math.abs(oldTotal - newTotal) > tolerance) {
        errors.push({
          errorType: 'VALUE_MISMATCH',
          oldColumn: m.old,
          newColumn: m.new,
          oldValue: oldTotal,
          newValue: newTotal,
          groupKey,
          message: `[MULTIPLE] Group sum mismatch [${m.old}→${m.new}]: ${oldTotal} ≠ ${newTotal} (group: ${groupKey})`,
        });
      }
    }

    for (const m of mappings.transformed_matches ?? []) {
      if (this.isNoisyType(noisyMap.get(m.old))) continue;
      const oldTotal = this.sumColumn(oldGroup, m.old);
      const newTotal = this.sumColumn(newGroup, m.new);
      if (oldTotal !== null && newTotal !== null && Math.abs(oldTotal - newTotal) > tolerance) {
        errors.push({
          errorType: 'VALUE_MISMATCH',
          oldColumn: m.old,
          newColumn: m.new,
          oldValue: oldTotal,
          newValue: newTotal,
          groupKey,
          message: `[MULTIPLE] Group transform mismatch [${m.old}→${m.new}]: ${oldTotal} ≠ ${newTotal} (group: ${groupKey})`,
        });
      }
    }

    for (const m of mappings.concat_matches ?? []) {
      if (m.old_cols.some((c) => this.isNoisyType(noisyMap.get(c)))) continue;
      // concat in group mode: concatenate all distinct old values, compare to all distinct new values
      const sep = m.separator ?? '';
      const oldVals = [...new Set(oldGroup.map((r) => m.old_cols.map((c) => String(r[c] ?? '').trim()).join(sep)))].sort().join('|');
      const newVals = [...new Set(newGroup.map((r) => String(r[m.new] ?? '').trim()))].sort().join('|');
      if (oldVals !== newVals) {
        errors.push({
          errorType: 'VALUE_MISMATCH',
          oldColumn: m.old_cols.join('+'),
          newColumn: m.new,
          oldValue: oldVals,
          newValue: newVals,
          groupKey,
          message: `[MULTIPLE] Group concat mismatch [${m.old_cols.join('+')}→${m.new}] (group: ${groupKey})`,
        });
      }
    }

    for (const m of mappings.split_matches ?? []) {
      if (this.isNoisyType(noisyMap.get(m.old))) continue;
      const oldTotal = this.sumColumn(oldGroup, m.old);
      const newTotals = m.new_cols.map((c) => this.sumColumn(newGroup, c));
      if (oldTotal !== null) {
        const computed = TransformUtils.evaluateFormula(m.formula, newTotals);
        if (Math.abs(oldTotal - computed) > tolerance) {
          errors.push({
            errorType: 'VALUE_MISMATCH',
            oldColumn: m.old,
            newColumn: m.new_cols.join('+'),
            oldValue: oldTotal,
            newValue: computed,
            groupKey,
            message: `[MULTIPLE] Group split mismatch: ${m.old}=${oldTotal}, ${m.formula}(${m.new_cols.join(',')})=${computed} (group: ${groupKey})`,
          });
        }
      }
    }

    for (const m of mappings.formula_matches ?? []) {
      if (m.old_cols.some((c) => this.isNoisyType(noisyMap.get(c)))) continue;
      const oldInputs = m.old_cols.map((c) => this.sumColumn(oldGroup, c));
      if (oldInputs.some((v) => v === null)) continue;
      const oldComputed = TransformUtils.evaluateFormula(m.formula, oldInputs);
      const newTotal = this.sumColumn(newGroup, m.new);
      if (newTotal !== null && Math.abs(oldComputed - newTotal) > tolerance) {
        errors.push({
          errorType: 'VALUE_MISMATCH',
          oldColumn: m.old_cols.join(m.formula === 'SUBTRACT' ? '-' : '+'),
          newColumn: m.new,
          oldValue: oldComputed,
          newValue: newTotal,
          groupKey,
          message: `[MULTIPLE] Group formula mismatch [${m.formula}(${m.old_cols.join(',')})→${m.new}]: ${oldComputed} ≠ ${newTotal} (group: ${groupKey})`,
        });
      }
    }

    return errors;
  }
}
