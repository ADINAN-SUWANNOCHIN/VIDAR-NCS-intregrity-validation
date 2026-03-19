import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { ValidationError } from '../rules/rule.types';

export interface TableResult {
  tableName: string;
  sourceTable?: string;  // actual DB source table (from common.yaml table_info.source)
  targetTable?: string;  // actual DB target table (from common.yaml table_info.target)
  rowsChecked: number;   // total source rows processed by the engine
  pass: number;          // source rows in groups with 0 errors (independently tracked)
  fail: number;          // source rows in groups with ≥1 error (independently tracked)
  skipped: number;       // rowsChecked - (pass + fail) — should be 0; >0 indicates a bug
  total: number;         // total error count (errors.length)
  missing: number;       // ROW_MISSING + COLUMN_MISSING + DATA_MISSING count
  timeSpent: number;     // ms
  errors: ValidationError[];
}

@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);
  private readonly reportsDir: string;

  constructor(private readonly config: ConfigService) {
    this.reportsDir = this.config.get<string>('REPORTS_DIR') ?? './reports';
    fs.mkdirSync(this.reportsDir, { recursive: true });
  }

  async writeReports(jobId: string, results: TableResult[]): Promise<string[]> {
    const jobDir = path.join(this.reportsDir, jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    const summaryPath = path.join(jobDir, 'Summary_Report.csv');
    const detailPath  = path.join(jobDir, 'Detail_Log.csv');

    await this.writeSummary(summaryPath, jobId, results);
    await this.writeDetail(detailPath, results);

    this.logger.log(`Reports written → ${summaryPath} | ${detailPath}`);
    return [summaryPath, detailPath];
  }

  // ----------------------------------------------------------------
  // File 1: Summary_Report.csv
  // One row per validated table.
  // Opens correctly in Excel (UTF-8 BOM, CRLF line endings).
  // ----------------------------------------------------------------
  private async writeSummary(
    filePath: string,
    jobId: string,
    results: TableResult[],
  ): Promise<void> {
    const ws = fs.createWriteStream(filePath, { encoding: 'utf8' });
    ws.write('\uFEFF'); // UTF-8 BOM — lets Excel open Thai/unicode without encoding dialog

    // ---- Job meta block ----
    const generatedAt = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
    const passCount   = results.filter(r => r.fail === 0 && r.missing === 0 && r.skipped === 0).length;
    const failCount   = results.length - passCount;

    ws.write(csvRow(['Job ID',       jobId]));
    ws.write(csvRow(['Generated',    generatedAt]));
    ws.write(csvRow(['Total Tables', results.length]));
    ws.write(csvRow(['Overall PASS', passCount]));
    ws.write(csvRow(['Overall FAIL', failCount]));
    ws.write('\r\n'); // blank separator line

    // ---- Column headers ----
    ws.write(csvRow([
      'Rule',
      'Source Table',
      'Target Table',
      'Status',
      'Rows Checked',
      'Pass (rows)',
      'Fail (rows)',
      'Skipped',
      'Total Errors',
      'Missing',
      'Time (sec)',
      'Remarks',
    ]));

    // ---- Data rows ----
    for (const r of results) {
      const status = r.fail === 0 && r.missing === 0 && r.skipped === 0 ? 'PASS' : 'FAIL';
      const remarks = r.errors
        .filter(e => ['COLUMN_MISSING', 'DATA_MISSING', 'TRANSFORM_ERROR'].includes(e.errorType))
        .map(e => e.message)
        .join(' | ');

      ws.write(csvRow([
        r.tableName,
        r.sourceTable ?? '',
        r.targetTable ?? '',
        status,
        r.rowsChecked,
        r.pass,
        r.fail,
        r.skipped,
        r.total,
        r.missing,
        (r.timeSpent / 1000).toFixed(2),
        remarks,
      ]));
    }

    await closeStream(ws);
  }

  // ----------------------------------------------------------------
  // File 2: Detail_Log.csv
  // One row per error across all tables — all error types combined.
  // Filter by "Error Type" column in Excel to focus on one type.
  // Streamed line by line — no memory spike regardless of error count.
  // ----------------------------------------------------------------
  private async writeDetail(filePath: string, results: TableResult[]): Promise<void> {
    const ws = fs.createWriteStream(filePath, { encoding: 'utf8' });
    ws.write('\uFEFF');

    // ---- Column headers ----
    ws.write(csvRow([
      'Rule',
      'Source Table',
      'Target Table',
      'Error Type',
      'Group Key',
      'Row ID',
      'Old Column',
      'New Column',
      'Old Value',
      'New Value',
      'Def ID',
      'Message',
    ]));

    // ---- Data rows ----
    for (const r of results) {
      for (const e of r.errors) {
        ws.write(csvRow([
          r.tableName,
          r.sourceTable ?? '',
          r.targetTable ?? '',
          e.errorType,
          e.groupKey      ?? '',
          e.rowIdentifier ?? '',
          e.oldColumn     ?? '',
          e.newColumn     ?? '',
          e.oldValue != null ? String(e.oldValue) : '',
          e.newValue != null ? String(e.newValue) : '',
          e.defId   ?? '',
          e.message,
        ]));
      }
    }

    await closeStream(ws);
  }
}

// ----------------------------------------------------------------
// CSV helpers
// ----------------------------------------------------------------

/** Escape one cell value per RFC 4180. */
function csvCell(v: unknown): string {
  const s = String(v ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** Join cells into a CRLF-terminated CSV row. */
function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',') + '\r\n';
}

/** Cleanly end a WriteStream and resolve when fully flushed to disk. */
function closeStream(ws: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.end();
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
}
