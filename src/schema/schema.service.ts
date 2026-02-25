import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { TableType } from '../rules/rule.types';
import { matchColumns } from './column-matcher';
import { writeExcelReport } from './excel-report';
import { generateYaml } from './yaml-generator';

export interface AnalyzeSchemaDto {
  oldTable: string;
  newTable: string;
  tableType: TableType;
  sampleSize?: number;
}

export interface AnalyzeSchemaResult {
  excelBuffer: Buffer;
  filename: string;
  summary: {
    totalOldCols: number;
    matched: number;
    unmatched: number;
    manualCheck: number;
  };
}

@Injectable()
export class SchemaService {
  private readonly logger = new Logger(SchemaService.name);

  constructor(private readonly db: DatabaseService) {}

  async analyze(dto: AnalyzeSchemaDto): Promise<AnalyzeSchemaResult> {
    const sampleSize = dto.sampleSize ?? 2000;
    const { oldTable, newTable, tableType } = dto;

    this.logger.log(`Analyzing schema: ${oldTable} → ${newTable} (sample=${sampleSize})`);

    // Fetch column names from INFORMATION_SCHEMA
    const oldColumns = await this.getColumnNames(oldTable);
    const newColumns = await this.getColumnNames(newTable);

    this.logger.log(`Columns — old: ${oldColumns.length}, new: ${newColumns.length}`);

    // Sample rows
    const oldRows = await this.db.sampleRows(oldTable, sampleSize);
    const newRows = await this.db.sampleRows(newTable, sampleSize);

    this.logger.log(`Rows sampled — old: ${oldRows.length}, new: ${newRows.length}`);

    // Run matcher
    const result = matchColumns(oldRows, newRows, oldColumns, newColumns);

    // Generate YAML as string
    const yamlContent = generateYaml({ oldTable, newTable, tableType, result });

    // Generate Excel buffer (includes Draft YAML as Sheet 5)
    const excelBuffer = await writeExcelReport({
      oldTable, newTable, tableType, sampleSize, result, yamlContent,
    });

    // Derive filename from old table's last segment
    const simpleTableName = this.simpleTableName(oldTable);
    const filename = `${simpleTableName}_common01.xlsx`;

    this.logger.log(`Report generated: ${filename}`);

    // Build summary
    const { matches } = result;
    const matched     = matches.filter((m) => m.status === 'VERIFIED' || m.status === 'PROBABLE').length;
    const manualCheck = matches.filter((m) => m.status === 'MANUAL_CHECK').length;
    const unmatched   = matches.filter((m) => m.status === 'NO_MATCH').length;

    return {
      excelBuffer,
      filename,
      summary: {
        totalOldCols: matches.length,
        matched,
        unmatched,
        manualCheck,
      },
    };
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  /**
   * Parses any table reference format into { db, table }.
   * Handles: [db].[schema].[table], [db].schema.table, schema.table, table
   */
  private parseTableRef(tableName: string): { db: string | null; table: string } {
    const parts: string[] = [];
    let current = '';
    let inBracket = false;
    for (const ch of tableName) {
      if (ch === '[') { inBracket = true; current += ch; }
      else if (ch === ']') { inBracket = false; current += ch; }
      else if (ch === '.' && !inBracket) { parts.push(current); current = ''; }
      else { current += ch; }
    }
    if (current) parts.push(current);
    const strip = (s: string) => s.replace(/^\[|\]$/g, '');
    return {
      db: parts.length >= 2 ? strip(parts[0]) : null,
      table: strip(parts[parts.length - 1]),
    };
  }

  private async getColumnNames(tableName: string): Promise<string[]> {
    const { db, table } = this.parseTableRef(tableName);
    if (db) {
      const rows = await this.db.query<{ COLUMN_NAME: string }>(
        `SELECT COLUMN_NAME FROM [${db}].INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${table}' ORDER BY ORDINAL_POSITION`,
      );
      return rows.map((r) => r.COLUMN_NAME);
    }
    const rows = await this.db.query<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${table}' ORDER BY ORDINAL_POSITION`,
    );
    return rows.map((r) => r.COLUMN_NAME);
  }

  /** Extract the last segment of a table reference and lowercase it. */
  private simpleTableName(tableName: string): string {
    const { table } = this.parseTableRef(tableName);
    return table.toLowerCase();
  }
}
