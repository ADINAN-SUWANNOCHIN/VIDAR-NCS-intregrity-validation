import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { createObjectCsvWriter } from 'csv-writer';
import { ValidationError } from '../rules/rule.types';

export interface TableResult {
  tableName: string;
  rowsChecked: number;  // actual rows validated — must equal expected total for PASS to be trustworthy
  total: number;
  pass: number;
  fail: number;
  missing: number;
  timeSpent: number; // ms
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

    const paths: string[] = [];

    // ---- Summary Report ----
    const summaryPath = path.join(jobDir, 'Summary_Report.csv');
    const summaryWriter = createObjectCsvWriter({
      path: summaryPath,
      header: [
        { id: 'tableName', title: 'Table Name' },
        { id: 'rowsChecked', title: 'Rows Checked' },
        { id: 'total', title: 'Total Errors' },
        { id: 'pass', title: 'Pass' },
        { id: 'fail', title: 'Fail' },
        { id: 'missing', title: 'Missing' },
        { id: 'timeSpentSec', title: 'Time Spent (sec)' },
        { id: 'status', title: 'Status' },
      ],
    });

    await summaryWriter.writeRecords(
      results.map((r) => ({
        tableName: r.tableName,
        rowsChecked: r.rowsChecked,
        total: r.total,
        pass: r.pass,
        fail: r.fail,
        missing: r.missing,
        timeSpentSec: (r.timeSpent / 1000).toFixed(2),
        status: r.fail === 0 && r.missing === 0 ? 'PASS' : 'FAIL',
      })),
    );
    paths.push(summaryPath);
    this.logger.log(`Summary report written: ${summaryPath}`);

    // ---- Detail Log per Table ----
    for (const result of results) {
      if (result.errors.length === 0) continue;

      const detailPath = path.join(jobDir, `Detail_Log_${result.tableName}.csv`);
      const detailWriter = createObjectCsvWriter({
        path: detailPath,
        header: [
          { id: 'errorType', title: 'Error Type' },
          { id: 'defId', title: 'Def ID' },
          { id: 'groupKey', title: 'Group Key' },
          { id: 'rowIdentifier', title: 'Row ID' },
          { id: 'oldColumn', title: 'Old Column' },
          { id: 'newColumn', title: 'New Column' },
          { id: 'oldValue', title: 'Old Value' },
          { id: 'newValue', title: 'New Value' },
          { id: 'message', title: 'Message' },
        ],
      });

      await detailWriter.writeRecords(
        result.errors.map((e) => ({
          errorType: e.errorType,
          defId: e.defId ?? '',
          groupKey: e.groupKey ?? '',
          rowIdentifier: e.rowIdentifier ?? '',
          oldColumn: e.oldColumn ?? '',
          newColumn: e.newColumn ?? '',
          oldValue: e.oldValue ?? '',
          newValue: e.newValue ?? '',
          message: e.message,
        })),
      );

      paths.push(detailPath);
      this.logger.log(`Detail log written: ${detailPath}`);
    }

    return paths;
  }
}
