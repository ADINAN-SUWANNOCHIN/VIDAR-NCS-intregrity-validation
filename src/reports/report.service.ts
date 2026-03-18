import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
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

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF2F5496' },
};

const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };

function styleHeader(sheet: ExcelJS.Worksheet): void {
  const header = sheet.getRow(1);
  header.font = HEADER_FONT;
  header.fill = HEADER_FILL;
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };
  header.height = 20;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
}

function autoWidth(sheet: ExcelJS.Worksheet, minWidth = 10, maxWidth = 60): void {
  sheet.columns.forEach((col) => {
    let max = minWidth;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const len = String(cell.value ?? '').length;
      if (len > max) max = len;
    });
    col.width = Math.min(max + 2, maxWidth);
  });
}

function tableLabel(r: TableResult): string {
  return r.tableName;
}
function sourceLabel(r: TableResult): string {
  return r.sourceTable ?? '';
}
function targetLabel(r: TableResult): string {
  return r.targetTable ?? '';
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

    const xlsxPath = path.join(jobDir, 'Validation_Report.xlsx');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'VIDAR DV Engine';
    workbook.created = new Date();

    this.buildSummarySheet(workbook, results);
    this.buildValueMismatchSheet(workbook, results);
    this.buildRowMissingSheet(workbook, results);
    this.buildDefViolationSheet(workbook, results);

    await workbook.xlsx.writeFile(xlsxPath);
    this.logger.log(`Excel report written: ${xlsxPath}`);

    return [xlsxPath];
  }

  // ----------------------------------------------------------------
  // Sheet 1 — Summary
  // ----------------------------------------------------------------
  private buildSummarySheet(wb: ExcelJS.Workbook, results: TableResult[]): void {
    const sheet = wb.addWorksheet('Summary');

    sheet.columns = [
      { header: 'Rule',           key: 'rule',        width: 30 },
      { header: 'Source Table',   key: 'source',      width: 28 },
      { header: 'Target Table',   key: 'target',      width: 28 },
      { header: 'Rows Checked',   key: 'rowsChecked', width: 14 },
      { header: 'Pass (rows)',    key: 'pass',        width: 12 },
      { header: 'Fail (rows)',    key: 'fail',        width: 12 },
      { header: 'Skipped',        key: 'skipped',     width: 10 },
      { header: 'Total Errors',   key: 'total',       width: 13 },
      { header: 'Missing',        key: 'missing',     width: 10 },
      { header: 'Time (sec)',     key: 'timeSec',     width: 11 },
      { header: 'Status',         key: 'status',      width: 10 },
      { header: 'Remarks',        key: 'remarks',     width: 50 },
    ];

    for (const r of results) {
      const status = r.fail === 0 && r.missing === 0 && r.skipped === 0 ? 'PASS' : 'FAIL';
      const remarkErrors = r.errors.filter((e) =>
        ['COLUMN_MISSING', 'DATA_MISSING', 'TRANSFORM_ERROR'].includes(e.errorType),
      );
      const remarks = remarkErrors.map((e) => e.message).join(' | ');

      const row = sheet.addRow({
        rule:        tableLabel(r),
        source:      sourceLabel(r),
        target:      targetLabel(r),
        rowsChecked: r.rowsChecked,
        pass:        r.pass,
        fail:        r.fail,
        skipped:     r.skipped,
        total:       r.total,
        missing:     r.missing,
        timeSec:     parseFloat((r.timeSpent / 1000).toFixed(2)),
        status,
        remarks,
      });

      // Colour-code status cell
      const statusCell = row.getCell('status');
      statusCell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      statusCell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: status === 'PASS' ? 'FF1F7A45' : 'FFC00000' },
      };
      statusCell.alignment = { horizontal: 'center' };
    }

    styleHeader(sheet);
  }

  // ----------------------------------------------------------------
  // Sheet 2 — Value Mismatch
  // ----------------------------------------------------------------
  private buildValueMismatchSheet(wb: ExcelJS.Workbook, results: TableResult[]): void {
    const sheet = wb.addWorksheet('Value_Mismatch');

    sheet.columns = [
      { header: 'Rule',        key: 'rule',      width: 30 },
      { header: 'Source',      key: 'source',    width: 25 },
      { header: 'Target',      key: 'target',    width: 25 },
      { header: 'Group Key',   key: 'groupKey',  width: 20 },
      { header: 'Row ID',      key: 'rowId',     width: 15 },
      { header: 'Old Column',  key: 'oldCol',    width: 22 },
      { header: 'New Column',  key: 'newCol',    width: 22 },
      { header: 'Old Value',   key: 'oldVal',    width: 20 },
      { header: 'New Value',   key: 'newVal',    width: 20 },
      { header: 'Message',     key: 'message',   width: 60 },
    ];

    for (const r of results) {
      for (const e of r.errors) {
        if (e.errorType !== 'VALUE_MISMATCH') continue;
        sheet.addRow({
          rule:     tableLabel(r),
          source:   sourceLabel(r),
          target:   targetLabel(r),
          groupKey: e.groupKey ?? '',
          rowId:    e.rowIdentifier ?? '',
          oldCol:   e.oldColumn ?? '',
          newCol:   e.newColumn ?? '',
          oldVal:   e.oldValue ?? '',
          newVal:   e.newValue ?? '',
          message:  e.message ?? '',
        });
      }
    }

    styleHeader(sheet);
    autoWidth(sheet);
  }

  // ----------------------------------------------------------------
  // Sheet 3 — Row Missing
  // ----------------------------------------------------------------
  private buildRowMissingSheet(wb: ExcelJS.Workbook, results: TableResult[]): void {
    const sheet = wb.addWorksheet('Row_Missing');

    sheet.columns = [
      { header: 'Rule',       key: 'rule',     width: 30 },
      { header: 'Source',     key: 'source',   width: 25 },
      { header: 'Target',     key: 'target',   width: 25 },
      { header: 'Group Key',  key: 'groupKey', width: 20 },
      { header: 'Message',    key: 'message',  width: 80 },
    ];

    for (const r of results) {
      for (const e of r.errors) {
        if (e.errorType !== 'ROW_MISSING') continue;
        sheet.addRow({
          rule:     tableLabel(r),
          source:   sourceLabel(r),
          target:   targetLabel(r),
          groupKey: e.groupKey ?? '',
          message:  e.message ?? '',
        });
      }
    }

    styleHeader(sheet);
    autoWidth(sheet);
  }

  // ----------------------------------------------------------------
  // Sheet 4 — Def Violation
  // ----------------------------------------------------------------
  private buildDefViolationSheet(wb: ExcelJS.Workbook, results: TableResult[]): void {
    const sheet = wb.addWorksheet('Def_Violation');

    sheet.columns = [
      { header: 'Rule',       key: 'rule',     width: 30 },
      { header: 'Source',     key: 'source',   width: 25 },
      { header: 'Target',     key: 'target',   width: 25 },
      { header: 'Def ID',     key: 'defId',    width: 12 },
      { header: 'Group Key',  key: 'groupKey', width: 20 },
      { header: 'Message',    key: 'message',  width: 80 },
    ];

    for (const r of results) {
      for (const e of r.errors) {
        if (e.errorType !== 'DEFECT_VIOLATION') continue;
        sheet.addRow({
          rule:     tableLabel(r),
          source:   sourceLabel(r),
          target:   targetLabel(r),
          defId:    e.defId ?? '',
          groupKey: e.groupKey ?? '',
          message:  e.message ?? '',
        });
      }
    }

    styleHeader(sheet);
    autoWidth(sheet);
  }
}
