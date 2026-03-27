import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  Body,
  Res,
  NotFoundException,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import * as express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import archiver = require('archiver');
import { ValidationService } from './validation.service';
import { PresetService } from './preset.service';
import { JobService } from '../job/job.service';
import { PgCacheService } from '../database/pg-cache.service';
import { ValidationRequestDto } from '../dto/validation-request.dto';
import { JobRecord } from '../job/job.types';

class RunPresetDto {
  @ApiPropertyOptional({ description: 'Label for this job', example: 'NPA_Full_Run' })
  @IsOptional()
  @IsString()
  job_name?: string;

  @ApiPropertyOptional({ description: 'Run only this case (omit = all cases)', example: 'lahisthloantransactionhistoryh' })
  @IsOptional()
  @IsString()
  case_name?: string;

  @ApiPropertyOptional({ description: 'Run only these source tables (omit = all)', type: [String], example: ['conv$vinpainvcithistoryh'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sources?: string[];

  @ApiPropertyOptional({ description: 'Vali rule IDs to run (omit = all, [] = skip all)', type: [String], example: ['vali001'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  vali_list?: string[];

  @ApiPropertyOptional({ description: 'Def rule IDs to run (omit = all, [] = skip all)', type: [String], example: ['def001'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  def_list?: string[];

  @ApiPropertyOptional({
    description: 'Shorthand: comma-separated rule IDs auto-routed by prefix. vali* → vali_list, def* → def_list. Takes precedence over vali_list/def_list.',
    example: 'def001,vali001,vali002',
  })
  @IsOptional()
  @IsString()
  rules?: string;
}

/** Parse a comma-separated rules string into separate vali/def ID lists. */
function parseRulesFilter(rules: string | undefined): { valiList: string[] | undefined; defList: string[] | undefined } {
  if (!rules || rules.trim() === '') return { valiList: undefined, defList: undefined };
  const ids = rules.split(',').map((s) => s.trim()).filter(Boolean);
  const valiList = ids.filter((id) => id.toLowerCase().startsWith('vali'));
  const defList  = ids.filter((id) => id.toLowerCase().startsWith('def'));
  return {
    valiList: valiList.length > 0 ? valiList : undefined,
    defList:  defList.length  > 0 ? defList  : undefined,
  };
}

@Controller('validation')
export class ValidationController {
  constructor(
    private readonly validationService: ValidationService,
    private readonly jobService: JobService,
    private readonly presetService: PresetService,
    private readonly pg: PgCacheService,
  ) {}

  /**
   * POST /validation/run
   * Manual run — supply table names and optional rule_path directly.
   *
   * Body:
   * {
   *   "job_name": "My_Test",
   *   "tables": [
   *     {
   *       "table_name": "conv$vinpahistory",
   *       "rule_path": "rights_npa/lahistloantransactionhistory",
   *       "def_list": ["def001"]
   *     }
   *   ]
   * }
   */
  @Post('run')
  @HttpCode(HttpStatus.ACCEPTED)
  async run(@Body() dto: ValidationRequestDto): Promise<{ jobId: string; message: string }> {
    const jobId = await this.validationService.startJob(dto);
    return {
      jobId,
      message: `Job started. Use GET /validation/status/${jobId} to check progress.`,
    };
  }

  /**
   * GET /validation/jobs
   * List all jobs (most recent first). Survives restarts — loaded from jobs.json on startup.
   */
  @Get('jobs')
  listJobs() {
    return this.jobService.listJobs();
  }

  /**
   * GET /validation/status/:jobId
   * Returns job record including inline summary table when status is DONE.
   */
  @Get('status/:jobId')
  async getStatus(@Param('jobId') jobId: string): Promise<JobRecord> {
    const job = this.jobService.getStatus(jobId);
    if (!job) throw new NotFoundException(`Job ${jobId} not found`);
    return job;
  }

  /**
   * GET /validation/download/:jobId
   * Downloads all report files for a job as a ZIP archive.
   * Optional ?file= param to download a single file by name instead.
   *
   * Examples:
   *   GET /validation/download/abc123                          → ZIP with all reports
   *   GET /validation/download/abc123?file=Summary_Report.csv → single file
   *   GET /validation/download/abc123?file=Detail_Log.csv     → single file
   */
  @Get('download/:jobId')
  async downloadReport(
    @Param('jobId') jobId: string,
    @Query('file') file: string | undefined,
    @Res() res: express.Response,
  ): Promise<void> {
    const job = this.jobService.getStatus(jobId);
    if (!job) throw new NotFoundException(`Job ${jobId} not found`);
    if (job.status !== 'DONE') throw new BadRequestException(`Job is still ${job.status}`);

    const reportPaths = job.reportPaths ?? [];
    if (reportPaths.length === 0) {
      throw new NotFoundException(`No report files found for job ${jobId}`);
    }

    // Single-file download when ?file= is specified
    if (file) {
      const reportPath = reportPaths.find((p) => path.basename(p) === path.basename(file));
      if (!reportPath) {
        throw new NotFoundException(
          `File "${file}" not found. Available: ${reportPaths.map((p) => path.basename(p)).join(', ')}`,
        );
      }
      const absPath = path.resolve(reportPath);
      const filename = path.basename(absPath);
      const contentType = filename.endsWith('.xlsx')
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'text/csv; charset=utf-8';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      if (fs.existsSync(absPath)) {
        fs.createReadStream(absPath).pipe(res);
      } else {
        // Disk file missing (pod restarted) — serve from PostgreSQL
        const buf = await this.pg.loadReport(jobId, filename);
        if (!buf) throw new NotFoundException(`Report not found on disk or in database: ${filename}`);
        res.end(buf);
      }
      return;
    }

    // Default: stream all report files as a ZIP
    const zipName = `validation_${jobId.slice(0, 8)}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(res);

    for (const p of reportPaths) {
      const absPath = path.resolve(p);
      const filename = path.basename(absPath);
      if (fs.existsSync(absPath)) {
        archive.file(absPath, { name: filename });
      } else {
        // Fall back to PG for files missing from disk
        const buf = await this.pg.loadReport(jobId, filename);
        if (buf) archive.append(buf, { name: filename });
      }
    }

    await archive.finalize();
  }

  /**
   * GET /validation/presets
   * Returns all available presets with their cases and source tables.
   * Use this to discover valid values for case_name and sources filters.
   *
   * Example response:
   * {
   *   "npa": {
   *     "rights": {
   *       "cases": [
   *         { "name": "lahistloantransactionhistory", "tables": ["conv$vinpahistory"] },
   *         { "name": "lahisthloantransactionhistoryh", "tables": ["conv$vinpahistory", "conv$vinpainvcithistoryh", ...] }
   *       ]
   *     }
   *   }
   * }
   */
  @Get('presets')
  getPresets() {
    return this.presetService.listPresets();
  }

  /**
   * POST /validation/run/all
   * Run every table across every module and every category in one shot.
   *
   * Optional body:
   * {
   *   "job_name": "FULL_RUN",   — label for this job (default: ALL_MODULES)
   *   "def_list": ["def001"]    — apply def rules to all tables (omit = load all defs)
   * }
   */
  @Post('run/all')
  @HttpCode(HttpStatus.ACCEPTED)
  async runAll(
    @Body() body: RunPresetDto,
  ): Promise<{ jobId: string; queued: number; tables: string[]; message: string }> {
    const entries = this.presetService.resolveAllTables();

    if (entries.length === 0) {
      throw new NotFoundException(
        'No presets found. Use GET /validation/presets to see available options.',
      );
    }

    const dto: ValidationRequestDto = {
      job_name: body.job_name ?? 'ALL_MODULES',
      tables: entries.map((e) => {
        const { valiList, defList } = body.rules ? parseRulesFilter(body.rules) : { valiList: body.vali_list, defList: body.def_list };
        return { table_name: e.table_name, rule_path: e.rule_path, vali_list: valiList, def_list: defList };
      }),
    };

    const jobId = await this.validationService.startJob(dto);
    const tableNames = entries.map((e) => e.table_name);

    return {
      jobId,
      queued: entries.length,
      tables: tableNames,
      message: `Queued ${entries.length} table(s). Use GET /validation/status/${jobId} to track progress.`,
    };
  }

  /**
   * POST /validation/run/preset/:module
   * Run ALL categories for an entire module in one shot.
   * e.g. POST /validation/run/preset/npa  → runs rights + eir for npa
   *      POST /validation/run/preset/npl  → runs rights for npl
   *      POST /validation/run/preset/invest_lv → runs all invest_lv tables
   *
   * Optional body:
   * {
   *   "job_name": "NPA_Full_Run",   — label for this job (default: MODULE_ALL)
   *   "def_list": ["def001"]        — apply def rules to all tables (omit = load all defs)
   * }
   */
  @Post('run/preset/:module')
  @HttpCode(HttpStatus.ACCEPTED)
  async runPresetModule(
    @Param('module') module: string,
    @Body() body: RunPresetDto,
  ): Promise<{ jobId: string; queued: number; tables: string[]; message: string }> {
    const entries = this.presetService.resolveTablesForModule(module);

    if (entries.length === 0) {
      throw new NotFoundException(
        `No preset found for module [${module}]. Use GET /validation/presets to see available options.`,
      );
    }

    const dto: ValidationRequestDto = {
      job_name: body.job_name ?? `${module.toUpperCase()}_ALL`,
      tables: entries.map((e) => {
        const { valiList, defList } = body.rules ? parseRulesFilter(body.rules) : { valiList: body.vali_list, defList: body.def_list };
        return { table_name: e.table_name, rule_path: e.rule_path, vali_list: valiList, def_list: defList };
      }),
    };

    const jobId = await this.validationService.startJob(dto);
    const tableNames = entries.map((e) => e.table_name);

    return {
      jobId,
      queued: entries.length,
      tables: tableNames,
      message: `Queued ${entries.length} table(s). Use GET /validation/status/${jobId} to track progress.`,
    };
  }

  /**
   * POST /validation/run/preset/:module/:category
   * Run all or a filtered subset of tables from a preset.
   *
   * Optional body filters:
   * {
   *   "job_name":  "My_Run",                     — label for this job
   *   "case_name": "lahisthloantransactionhistoryh", — run only this case (omit = all cases)
   *   "sources":   ["conv$vinpainvcithistoryh"],  — run only these source tables (omit = all)
   *   "def_list":  ["def001"]                    — apply def rules to all selected tables
   * }
   *
   * Examples:
   *   POST /validation/run/preset/npa/rights
   *     → runs ALL cases, ALL source tables
   *
   *   POST /validation/run/preset/npa/rights  { "case_name": "lahisthloantransactionhistoryh" }
   *     → runs all 5 source tables for Case 2 only
   *
   *   POST /validation/run/preset/npa/rights  { "case_name": "lahisthloantransactionhistoryh", "sources": ["conv$vinpainvcithistoryh"] }
   *     → runs only the CIT source table for Case 2
   */
  @Post('run/preset/:module/:category')
  @HttpCode(HttpStatus.ACCEPTED)
  async runPreset(
    @Param('module') module: string,
    @Param('category') category: string,
    @Body() body: RunPresetDto,
  ): Promise<{ jobId: string; queued: number; tables: string[]; message: string }> {
    const entries = this.presetService.resolveTablesForRun(
      module,
      category,
      body.case_name,
      body.sources,
    );

    if (entries.length === 0) {
      throw new NotFoundException(
        `No tables matched for [${module}/${category}]` +
          (body.case_name ? ` case="${body.case_name}"` : '') +
          (body.sources ? ` sources=${JSON.stringify(body.sources)}` : '') +
          `. Use GET /validation/presets to see available options.`,
      );
    }

    const dto: ValidationRequestDto = {
      job_name: body.job_name ?? `${module.toUpperCase()}_${category.toUpperCase()}`,
      tables: entries.map((e) => {
        const { valiList, defList } = body.rules ? parseRulesFilter(body.rules) : { valiList: body.vali_list, defList: body.def_list };
        return { table_name: e.table_name, rule_path: e.rule_path, vali_list: valiList, def_list: defList };
      }),
    };

    const jobId = await this.validationService.startJob(dto);
    const tableNames = entries.map((e) => e.table_name);

    return {
      jobId,
      queued: entries.length,
      tables: tableNames,
      message: `Queued ${entries.length} table(s). Use GET /validation/status/${jobId} to track progress.`,
    };
  }
}
