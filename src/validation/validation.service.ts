import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService, tableRef } from '../database/database.service';
import { RuleLoaderService } from '../rules/rule-loader.service';
import { JobService } from '../job/job.service';
import { ReportService, TableResult } from '../reports/report.service';
import { StrategyFactory } from '../strategies/strategy.factory';
import { ValidationRequestDto } from '../dto/validation-request.dto';
import { CommonRule, ValidationError } from '../rules/rule.types';

@Injectable()
export class ValidationService {
  private readonly logger = new Logger(ValidationService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly ruleLoader: RuleLoaderService,
    private readonly jobService: JobService,
    private readonly reportService: ReportService,
    private readonly strategyFactory: StrategyFactory,
  ) {}

  // ----------------------------------------------------------------
  // สร้าง Job แล้วรันแบบ Background (Fire-and-forget)
  // ----------------------------------------------------------------
  async startJob(dto: ValidationRequestDto): Promise<string> {
    const jobId = this.jobService.createJob(dto.tables.length, dto.job_name);
    this.logger.log(`[Job:${jobId}] Created for ${dto.tables.length} table(s)`);

    // รันใน background – ไม่ await เพื่อให้ response กลับทันที
    this.runJob(jobId, dto).catch((err) => {
      this.logger.error(`[Job:${jobId}] Fatal error: ${err.message}`);
      this.jobService.fail(jobId, err.message);
    });

    return jobId;
  }

  // ----------------------------------------------------------------
  // Core Job Runner
  // ----------------------------------------------------------------
  private async runJob(jobId: string, dto: ValidationRequestDto): Promise<void> {
    this.jobService.start(jobId);
    const results: TableResult[] = [];

    // โหลด global affect codes ครั้งเดียว
    const globalCodes = this.ruleLoader.loadGlobalAffectCodes();
    const affectCodeMap = new Map(globalCodes.codes.map((c) => [c.code.toUpperCase(), c.description]));

    for (const tableConfig of dto.tables) {
      const tableName = tableConfig.table_name;
      const start = Date.now();

      this.logger.log(`[Job:${jobId}] Processing table: ${tableName}`);

      const rulePath = tableConfig.rule_path;

      // ---- ตรวจว่ามี rule directory ----
      if (!this.ruleLoader.hasRuleDirectory(tableName, rulePath)) {
        this.logger.warn(`[Job:${jobId}] No rule directory for ${tableName}, skipping`);
        results.push({
          tableName,
          rowsChecked: 0,
          total: 0,
          pass: 0,
          fail: 0,
          missing: 1,
          timeSpent: Date.now() - start,
          errors: [{ errorType: 'DATA_MISSING', message: `No rule directory found for table ${tableName}` }],
        });
        this.jobService.incrementDone(jobId);
        continue;
      }

      // ---- โหลด common rule ----
      const commonRule = this.ruleLoader.loadCommonRule(tableName, rulePath);
      if (!commonRule) {
        results.push({
          tableName,
          total: 0,
          pass: 0,
          fail: 0,
          missing: 1,
          timeSpent: Date.now() - start,
          rowsChecked: 0,
        errors: [{ errorType: 'DATA_MISSING', message: `common.yaml not found or parse error for ${tableName}` }],
        });
        this.jobService.incrementDone(jobId);
        continue;
      }

      // ---- โหลด def rules ----
      const defRules = this.ruleLoader.loadDefRules(tableName, tableConfig.def_list, rulePath);

      // ---- เลือก Strategy ----
      let errors: ValidationError[] = [];
      let rowsChecked = 0;
      try {
        const strategy = this.strategyFactory.create(commonRule.table_info.table_type);
        const result = await strategy.validate({ commonRule, defRules, affectCodeMap });
        errors = result.errors;
        rowsChecked = result.rowsChecked;
      } catch (err) {
        this.logger.error(`[Job:${jobId}] Strategy error for ${tableName}: ${err.message}`);
        errors = [{ errorType: 'TRANSFORM_ERROR', message: `Runtime error: ${err.message}` }];
      }

      // ---- Aggregate SUM cross-check (independent of row comparison) ----
      const sumErrors = await this.runAggregateSumCheck(tableName, commonRule, errors);
      errors.push(...sumErrors);

      // ---- สรุปผล ----
      const valueErrors = errors.filter((e) => e.errorType === 'VALUE_MISMATCH' || e.errorType === 'DEFECT_VIOLATION');
      const missingErrors = errors.filter((e) => e.errorType === 'ROW_MISSING' || e.errorType === 'COLUMN_MISSING' || e.errorType === 'DATA_MISSING');

      results.push({
        tableName,
        rowsChecked,
        total: errors.length,
        pass: errors.length === 0 ? 1 : 0,
        fail: valueErrors.length,
        missing: missingErrors.length,
        timeSpent: Date.now() - start,
        errors,
      });

      this.jobService.incrementDone(jobId);
      this.logger.log(`[Job:${jobId}] Table ${tableName} done: ${errors.length} error(s)`);
    }

    // ---- เขียน reports ----
    const reportPaths = await this.reportService.writeReports(jobId, results);
    this.jobService.complete(jobId, reportPaths);
    this.logger.log(`[Job:${jobId}] All done. Reports: ${reportPaths.join(', ')}`);
  }

  // ----------------------------------------------------------------
  // Aggregate SUM cross-check
  // Runs independently of row comparison — if SUM(old) ≠ SUM(new)
  // per affectcode, that's evidence of missing/wrong data regardless
  // of what the row comparison found.
  // ----------------------------------------------------------------
  private async runAggregateSumCheck(
    tableName: string,
    commonRule: CommonRule,
    existingErrors: ValidationError[],
  ): Promise<ValidationError[]> {
    const errors: ValidationError[] = [];

    // Only run if schema_mappings has a transactionamount → transactionamount mapping
    // and the table has transaction_grouping (so affectcode makes sense)
    // L2: find any amount-type column instead of hardcoding 'transactionamount'.
    // Tables with different naming conventions (e.g. 'txnamount', 'debitamount') will now
    // also get the aggregate check instead of silently skipping it.
    const amountMapping = [
      ...(commonRule.schema_mappings.transformed_matches ?? []),
      ...(commonRule.schema_mappings.exact_matches ?? []),
    ].find((m) =>
      m.old.toLowerCase().includes('amount') && m.new.toLowerCase().includes('amount'),
    );

    if (!amountMapping || !commonRule.transaction_grouping) return errors;

    const { source, target } = commonRule.table_info;
    const tolerance = commonRule.defaults?.tolerance ?? 0.01;

    // L2: affectcode column name variants — DB stores short codes like "A1", "PP", "BC".
    // Primary attempt is 'affectcode'; outer try/catch logs a warning if column name differs.
    // Confirmed from affect_codes.json: codes are 2-char uppercase strings (A1, BC, PP, ...).
    const AFFECT_CODE_VARIANTS = ['affectcode', 'affect_code', 'afcode', 'affcode', 'affect_cd'];
    const affectCol = { old: AFFECT_CODE_VARIANTS[0], new: AFFECT_CODE_VARIANTS[0] };

    try {
      // C9: For UNION tables (multiple sources), aggregate SUM across ALL sources per affectcode.
      // Previous code used only sources[0], silently ignoring discrepancies in sources[1..n].
      const allSources = source.split(',').map((s) => s.trim());
      const oldSumsAgg = new Map<string, number>();
      for (const src of allSources) {
        const srcSums = await this.db.querySumByGroup(src, amountMapping.old, affectCol.old);
        for (const [code, total] of srcSums) {
          oldSumsAgg.set(code, (oldSumsAgg.get(code) ?? 0) + total);
        }
      }
      const newSums = await this.db.querySumByGroup(target, amountMapping.new, affectCol.new);

      for (const [code, oldTotal] of oldSumsAgg) {
        const newTotal = newSums.get(code) ?? 0;
        if (Math.abs(oldTotal - newTotal) > tolerance) {
          errors.push({
            errorType: 'VALUE_MISMATCH',
            oldColumn: `SUM(transactionamount) WHERE affectcode='${code}'`,
            newColumn: `SUM(transactionamount) WHERE affectcode='${code}'`,
            oldValue: oldTotal,
            newValue: newTotal,
            message: `[AGGREGATE] SUM mismatch for affectcode=${code}: old=${oldTotal.toFixed(2)}, new=${newTotal.toFixed(2)}, diff=${Math.abs(oldTotal - newTotal).toFixed(2)}`,
          });
        }
      }

      if (errors.length === 0) {
        this.logger.log(`[${tableName}] Aggregate SUM check PASSED for ${oldSumsAgg.size} affect code(s) across ${allSources.length} source(s)`);
      } else {
        this.logger.warn(`[${tableName}] Aggregate SUM check found ${errors.length} discrepancy(ies)`);
      }
    } catch (err) {
      this.logger.warn(`[${tableName}] Aggregate SUM check skipped: ${err.message}`);
    }

    return errors;
  }
}
