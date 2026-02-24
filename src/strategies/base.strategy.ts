import { Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
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
      pivot_matches: sm.pivot_matches,
    };
  }

  protected mismatch(
    oldColumn: string,
    newColumn: string,
    oldValue: unknown,
    newValue: unknown,
    _extra?: unknown,
    rowIdentifier?: string,
  ): ValidationError {
    return {
      errorType: 'VALUE_MISMATCH',
      oldColumn,
      newColumn,
      oldValue,
      newValue,
      rowIdentifier,
      message: `Mismatch on [${oldColumn}→${newColumn}]: "${oldValue}" ≠ "${newValue}"${rowIdentifier ? ` (${rowIdentifier})` : ''}`,
    };
  }

  protected async getColumnNames(tableName: string): Promise<string[]> {
    const crossDb = tableName.match(/\[([^\]]+)\]\.(?:[^\[.]+\.)?\[([^\]]+)\]/);
    if (crossDb) {
      const [, db, tbl] = crossDb;
      const rows = await this.db.query<{ COLUMN_NAME: string }>(
        `SELECT COLUMN_NAME FROM [${db}].INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${tbl}'`,
      );
      return rows.map((r) => r.COLUMN_NAME);
    }
    const rows = await this.db.query<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${tableName}'`,
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
    } catch {
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
}
