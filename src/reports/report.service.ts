import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { ValidationError } from '../rules/rule.types';
import { PgCacheService } from '../database/pg-cache.service';

export interface BreakdownEntry {
  errorType: string;   // e.g. VALUE_MISMATCH, ROW_MISSING, DEFECT_VIOLATION
  defId?: string;      // populated for DEFECT_VIOLATION only (e.g. def001, vali001)
  count: number;       // number of error occurrences
  description: string; // first sentence of the error message (truncated)
}

export interface TableResult {
  tableName: string;
  sourceTable?: string;  // actual DB source table (from common.yaml table_info.source)
  targetTable?: string;  // actual DB target table (from common.yaml table_info.target)
  rowsChecked: number;   // total source rows processed by the engine
  pass: number;          // source rows in groups with 0 errors (independently tracked)
  fail: number;          // source rows in groups with ≥1 error (independently tracked)
  skipped: number;       // rowsChecked - (pass + fail) — should be 0; >0 indicates a bug
  total: number;         // true total error count (may exceed errors.length when capped)
  missing: number;       // ROW_MISSING + COLUMN_MISSING + DATA_MISSING count
  timeSpent: number;     // ms
  errors: ValidationError[];
  remarks?: string;      // pre-extracted structural error messages for summary (set before errors is cleared)
  breakdown?: BreakdownEntry[];  // per-type error counts (set before errors is cleared)
}

/**
 * Aggregate errors into a compact breakdown before the errors array is cleared.
 * DEFECT_VIOLATION entries are grouped by defId; all others by errorType only.
 * Exported as both a standalone function and a service method for flexibility.
 */
export function computeBreakdown(errors: ValidationError[]): BreakdownEntry[] {
  const map = new Map<string, BreakdownEntry>();

  for (const e of errors) {
    const isDefect = e.errorType === 'DEFECT_VIOLATION' && e.defId;
    const key = isDefect ? `${e.errorType}::${e.defId}` : e.errorType;

    if (!map.has(key)) {
      // First occurrence: extract a one-line description from the message
      const raw = (e.message ?? '').trim();
      const description = raw.split('\n')[0].replace(/\.\s*$/, '').trim().slice(0, 80);
      map.set(key, {
        errorType: e.errorType,
        defId: isDefect ? e.defId : undefined,
        count: 0,
        description,
      });
    }
    map.get(key)!.count++;
  }

  // Sort: DEFECT_VIOLATION entries first (sorted by defId), then others alphabetically
  return [...map.values()].sort((a, b) => {
    if (a.errorType === 'DEFECT_VIOLATION' && b.errorType !== 'DEFECT_VIOLATION') return -1;
    if (a.errorType !== 'DEFECT_VIOLATION' && b.errorType === 'DEFECT_VIOLATION') return 1;
    const aKey = (a.defId ?? '') + a.errorType;
    const bKey = (b.defId ?? '') + b.errorType;
    return aKey.localeCompare(bKey);
  });
}

@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);
  private readonly reportsDir: string;

  constructor(
    private readonly config: ConfigService,
    private readonly pg: PgCacheService,
  ) {
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
  // Incremental write API — used by ValidationService to flush errors
  // per-table so the errors array can be GC'd between tables.
  // ----------------------------------------------------------------

  /** Delegate to standalone computeBreakdown — called by ValidationService before errors are cleared. */
  computeBreakdown(errors: ValidationError[]): BreakdownEntry[] {
    return computeBreakdown(errors);
  }

  /** Open the detail log for a job. Call once before processing tables. */
  openDetailLog(jobId: string): { ws: fs.WriteStream; detailPath: string; jobDir: string } {
    const jobDir = path.join(this.reportsDir, jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    const detailPath = path.join(jobDir, 'Detail_Log.csv');
    const ws = fs.createWriteStream(detailPath, { encoding: 'utf8' });
    ws.write('\uFEFF');
    ws.write(csvRow([
      'Rule', 'Source Table', 'Target Table', 'Error Type',
      'Group Key', 'Row ID', 'Old Column', 'New Column',
      'Old Value', 'New Value', 'Def ID', 'Message',
    ]));
    return { ws, detailPath, jobDir };
  }

  /** Append one table's errors to an open detail log stream. Synchronous (buffered). */
  appendTableDetail(ws: fs.WriteStream, result: TableResult): void {
    for (const e of result.errors) {
      ws.write(csvRow([
        result.tableName,
        result.sourceTable ?? '',
        result.targetTable ?? '',
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

  /** Close the detail log and write the summary. Returns all report paths (summary + detail + per-def). */
  async writeFinalReports(
    jobId: string,
    jobDir: string,
    detailPath: string,
    detailWs: fs.WriteStream,
    results: TableResult[],
    extraPaths?: string[],
  ): Promise<string[]> {
    await closeStream(detailWs);
    const summaryPath = path.join(jobDir, 'Summary_Report.csv');
    await this.writeSummary(summaryPath, jobId, results);

    const allPaths = [summaryPath, detailPath, ...(extraPaths ?? [])];
    this.logger.log(`Reports written → ${allPaths.join(' | ')}`);

    // Persist all files to PostgreSQL so they survive pod restarts
    await Promise.all(
      allPaths.map((p) =>
        fs.promises.readFile(p).then((buf) => this.pg.saveReport(jobId, path.basename(p), buf)),
      ),
    ).catch((e) => this.logger.warn(`[Reports] PG persist failed: ${e.message}`));

    return allPaths;
  }

  // ----------------------------------------------------------------
  // Per-def report API — one CSV per def rule that declares report_fields.
  // The file is streamed row-by-row (same approach as Detail_Log).
  // ----------------------------------------------------------------

  /**
   * Open a per-def detail stream.
   * Writes the UTF-8 BOM and column header row, then returns the stream for row appending.
   */
  openDefDetailStream(filePath: string, columns: string[]): fs.WriteStream {
    const ws = fs.createWriteStream(filePath, { encoding: 'utf8' });
    ws.write('\uFEFF');
    ws.write(csvRow(['Rule', 'Group Key', ...columns]));
    return ws;
  }

  /**
   * Append one row to a per-def detail stream.
   * Columns must match the order used in openDefDetailStream.
   */
  appendDefDetailRow(
    ws: fs.WriteStream,
    columns: string[],
    tableName: string,
    err: ValidationError,
  ): void {
    const fields = err.reportFields ?? {};
    ws.write(csvRow([
      tableName,
      err.groupKey ?? '',
      ...columns.map((c) => (fields[c] != null ? String(fields[c]) : '')),
    ]));
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
    const passCount   = results.filter(r => r.fail === 0 && r.missing === 0 && r.skipped === 0 && r.total === 0).length;
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
      const status = r.fail === 0 && r.missing === 0 && r.skipped === 0 && r.total === 0 ? 'PASS' : 'FAIL';
      const remarks = r.remarks ?? r.errors
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

    // ---- Error Summary section ----
    // Aggregate breakdown entries across all tables, merging by (errorType + defId) key.
    const aggregated = new Map<string, BreakdownEntry>();
    for (const r of results) {
      for (const b of (r.breakdown ?? [])) {
        const key = b.defId ? `${b.errorType}::${b.defId}` : b.errorType;
        if (!aggregated.has(key)) {
          aggregated.set(key, { ...b, count: 0 });
        }
        aggregated.get(key)!.count += b.count;
      }
    }

    if (aggregated.size > 0) {
      ws.write('\r\n');
      ws.write(csvRow(['Error Summary']));
      ws.write(csvRow(['Count', 'Error Type', 'Rule', 'Description']));

      // Sort: DEFECT by defId first, then others alphabetically by errorType
      const sorted = [...aggregated.values()].sort((a, b) => {
        if (a.errorType === 'DEFECT_VIOLATION' && b.errorType !== 'DEFECT_VIOLATION') return -1;
        if (a.errorType !== 'DEFECT_VIOLATION' && b.errorType === 'DEFECT_VIOLATION') return 1;
        const aKey = (a.defId ?? '') + a.errorType;
        const bKey = (b.defId ?? '') + b.errorType;
        return aKey.localeCompare(bKey);
      });

      for (const b of sorted) {
        ws.write(csvRow([b.count, b.errorType, b.defId ?? '', b.description]));
      }
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
