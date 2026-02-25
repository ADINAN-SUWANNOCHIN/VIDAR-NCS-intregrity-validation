import { DatabaseService, tableRef } from '../database/database.service';
import { ValidationError } from '../rules/rule.types';
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
    const tolerance = commonRule.defaults?.tolerance ?? 0;

    this.logger.log(`[SPLIT] Validating ${source} → ${target}`);

    // ---- Schema check — resilient (Issue #1) ----
    const colErrors = await this.checkMissingColumns(source, target, [
      ...(sm.exact_matches ?? []).map((m) => ({ oldCols: [m.old], newCols: [m.new] })),
    ]);
    if (colErrors.length > 0) {
      errors.push(...colErrors);
      this.logger.warn(`[SPLIT] ${colErrors.length} column(s) missing — continuing with valid mappings only`);
      sm = this.filterMappingsAfterSchemaCheck(sm, colErrors);
    }

    // Noisy column detection (Fix #5)
    const allOldCols = (sm.exact_matches ?? []).map((m) => m.old);
    const noisyMap = await this.detectNoisyColumns(source, allOldCols);
    for (const [col, type] of noisyMap) {
      if (type !== 'NORMAL') {
        this.logger.warn(`[SPLIT] Column [${col}] classified as ${type} — name-only match`);
      }
    }

    for (const mapping of sm.exact_matches ?? []) {
      // Skip noisy columns (Fix #5)
      if (this.isNoisyType(noisyMap.get(mapping.old))) continue;

      const oldRows = await this.db.query<Record<string, unknown>>(
        `SELECT [${mapping.old}] FROM ${tableRef(source)} WHERE [${mapping.old}] IS NOT NULL`
      );
      const newRows = await this.db.query<Record<string, unknown>>(
        `SELECT [${mapping.new}] FROM ${tableRef(target)} WHERE [${mapping.new}] IS NOT NULL`
      );

      const oldVals = oldRows.map((r) => String(r[mapping.old] ?? '').trim());
      const newVals = new Set(newRows.map((r) => String(r[mapping.new] ?? '').trim()));
      rowsChecked += oldRows.length;

      for (const val of oldVals) {
        const transformed = mapping.transform_rule
          ? (TransformUtils.apply(val, mapping.transform_rule) ?? val)
          : val;
        if (!newVals.has(transformed)) {
          errors.push({
            errorType: 'ROW_MISSING',
            oldColumn: mapping.old,
            newColumn: mapping.new,
            oldValue: val,
            message: `Value [${val}] from ${source}.${mapping.old} not found in ${target}.${mapping.new}`,
          });
        }
      }
    }

    this.logger.log(`[SPLIT] Done: ${errors.length} error(s)`);
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

    // Fallback: if no pivot_config or pivot_matches, do row-count check only
    if (!pc || pm.length === 0) {
      this.logger.warn(
        `[HEADER] No pivot_config/pivot_matches in common.yaml — falling back to row count check. ` +
          `Add pivot_config.identity_key, pivot_config.pivot_key, and schema_mappings.pivot_matches for full validation.`,
      );
      const [oldCount] = await this.db.query<{ cnt: number }>(
        `SELECT COUNT(DISTINCT [id]) as cnt FROM ${tableRef(source)}`,
      );
      const [newCount] = await this.db.query<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM ${tableRef(target)}`,
      );
      if (oldCount?.cnt !== newCount?.cnt) {
        errors.push({
          errorType: 'ROW_MISSING',
          oldValue: oldCount?.cnt,
          newValue: newCount?.cnt,
          message: `Row count mismatch after pivot: source distinct=${oldCount?.cnt}, target rows=${newCount?.cnt}`,
        });
      }
      return { errors, rowsChecked: oldCount?.cnt ?? 0 };
    }

    const oldIdCol = pc.identity_key.old;
    const newIdCol = pc.identity_key.new;
    const pivotKey = pc.pivot_key;

    // ---- 1. Build old pivot map: identity → pivot_key_value → value_col → value ----
    // Query: SELECT identity_key, pivot_key, value_col(s) FROM source
    const valueCols = [...new Set(pm.map((p) => p.value_col))];
    const oldQuery = `
      SELECT [${oldIdCol}], [${pivotKey}], ${valueCols.map((c) => `[${c}]`).join(', ')}
      FROM ${tableRef(source)}
      ORDER BY [${oldIdCol}], [${pivotKey}]
    `;
    const oldRows = await this.db.query<Record<string, unknown>>(oldQuery);
    rowsChecked = oldRows.length;

    // Build map: identity → Map<pivotKeyValue, Map<valueCol, value>>
    const oldMap = new Map<string, Map<string, Map<string, unknown>>>();
    for (const row of oldRows) {
      const id = String(row[oldIdCol] ?? '').trim();
      const pkVal = String(row[pivotKey] ?? '').trim();
      if (!oldMap.has(id)) oldMap.set(id, new Map());
      if (!oldMap.get(id)!.has(pkVal)) oldMap.get(id)!.set(pkVal, new Map());
      for (const vc of valueCols) {
        oldMap.get(id)!.get(pkVal)!.set(vc, row[vc]);
      }
    }

    // ---- 2. Query new (wide) table ----
    const newCols = pm.map((p) => p.new_col);
    const newQuery = `
      SELECT [${newIdCol}], ${newCols.map((c) => `[${c}]`).join(', ')}
      FROM ${tableRef(target)}
      ORDER BY [${newIdCol}]
    `;
    const newRows = await this.db.query<Record<string, unknown>>(newQuery);

    // Build map: identity → row
    const newMap = new Map<string, Record<string, unknown>>();
    for (const row of newRows) {
      newMap.set(String(row[newIdCol] ?? '').trim(), row);
    }

    // ---- 3. Compare ----
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

    // Check for new rows that have no source counterpart
    for (const newId of newMap.keys()) {
      if (!oldMap.has(newId)) {
        errors.push({
          errorType: 'ROW_MISSING',
          rowIdentifier: newId,
          message: `[HEADER] Identity [${newId}] found in target but not in source`,
        });
      }
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
    ]);
    if (colErrors.length > 0) {
      errors.push(...colErrors);
      this.logger.warn(`[UNION] ${colErrors.length} column(s) missing — continuing with valid mappings only`);
      sm = this.filterMappingsAfterSchemaCheck(sm, colErrors);
    }

    // Noisy column detection on first source (Fix #5)
    const allOldCols = [
      ...(sm.exact_matches ?? []).map((m) => m.old),
      ...(sm.transformed_matches ?? []).map((m) => m.old),
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
    for (const src of sources) {
      this.logger.log(`[UNION] Processing source: ${src}`);
      let lastAnchorKey: unknown = null;
      let carryOld = new Map<string, Record<string, unknown>[]>();
      let carryNew = new Map<string, Record<string, unknown>[]>();

      while (true) {
        const oldChunk = await this.db.fetchChunk(src, anchorKeyOld, chunkSize, lastAnchorKey);
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

        lastAnchorKey = oldChunk[oldChunk.length - 1][anchorKeyOld];
        if (isLastChunk) break;
      }

      // Flush remaining carry for this source
      for (const [groupKey, oldGroup] of carryOld) {
        compareUnionGroup(src, groupKey, oldGroup, carryNew.get(groupKey) ?? []);
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
    return String(vals[0] ?? '').trim();
  }
}

// ============================================================
// MULTIPLE Strategy (N:N)
//
// Fix #4: Routes each mapping to the correct (src_table, tgt_table) pair
//          using the optional src_table / tgt_table fields on ExactMatch /
//          TransformedMatch. Falls back to the first source/target pair if
//          not specified.
//
// Fix #5: Noisy columns are detected per source table and skipped.
// ============================================================
export class MultipleStrategy extends BaseStrategy {
  constructor(db: DatabaseService) { super(db); }

  async validate(ctx: ValidationContext): Promise<{ errors: ValidationError[]; rowsChecked: number }> {
    const errors: ValidationError[] = [];
    let rowsChecked = 0;
    const { commonRule } = ctx;
    const { source, target } = commonRule.table_info;
    const sm = commonRule.schema_mappings;
    const tolerance = commonRule.defaults?.tolerance ?? 0;
    const anchorKeyOld = commonRule.anchor_key.old;
    const anchorKeyNew = commonRule.anchor_key.new;

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
    }

    const pairMap = new Map<string, PairMappings & MappingPair>();

    const getOrCreate = (srcTable: string, tgtTable: string) => {
      const key = pairKey({ srcTable, tgtTable });
      if (!pairMap.has(key)) {
        pairMap.set(key, { srcTable, tgtTable, exact: [], transformed: [], concat: [] });
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

    // Process each pair independently
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

      // Stream old rows, look up matching new rows by anchor key
      let lastKey: unknown = null;
      const chunkSize = parseInt(process.env.CHUNK_SIZE ?? '5000');

      while (true) {
        const oldChunk = await this.db.fetchChunk(srcTable, anchorKeyOld, chunkSize, lastKey);
        if (oldChunk.length === 0) break;

        const anchorVals = oldChunk.map((r) => String(r[anchorKeyOld] ?? '').trim());

        // Fetch matching new rows by anchor key values
        const newRows = await this.db.query<Record<string, unknown>>(
          `SELECT * FROM ${tableRef(tgtTable)}
           WHERE [${anchorKeyNew}] IN (${anchorVals.map((_, i) => `@a${i}`).join(',')})`,
          Object.fromEntries(anchorVals.map((v, i) => [`a${i}`, v])),
        );
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
}
