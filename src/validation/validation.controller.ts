import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  NotFoundException,
  HttpCode,
  HttpStatus,
  Header,
} from '@nestjs/common';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { ValidationService } from './validation.service';
import { PresetService } from './preset.service';
import { JobService } from '../job/job.service';
import { ValidationRequestDto } from '../dto/validation-request.dto';
import { JobRecord } from '../job/job.types';

class RunPresetDto {
  @IsOptional()
  @IsString()
  job_name?: string;

  @IsOptional()
  @IsString()
  case_name?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sources?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  def_list?: string[];
}

@Controller('validation')
export class ValidationController {
  constructor(
    private readonly validationService: ValidationService,
    private readonly jobService: JobService,
    private readonly presetService: PresetService,
  ) {}

  /**
   * GET /health
   * Kubernetes liveness + readiness probe target.
   * Returns 200 so the pod stays alive and receives traffic.
   */
  @Get('/health')
  @Header('Content-Type', 'application/json')
  health(): { status: string } {
    return { status: 'ok' };
  }

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
   * GET /validation/status/:jobId
   */
  @Get('status/:jobId')
  async getStatus(@Param('jobId') jobId: string): Promise<JobRecord> {
    const job = this.jobService.getStatus(jobId);
    if (!job) throw new NotFoundException(`Job ${jobId} not found`);
    return job;
  }

  /**
   * GET /validation/report/:jobId
   */
  @Get('report/:jobId')
  async getReport(
    @Param('jobId') jobId: string,
  ): Promise<{ reportPaths: string[]; message: string }> {
    const job = this.jobService.getStatus(jobId);
    if (!job) throw new NotFoundException(`Job ${jobId} not found`);

    if (job.status !== 'DONE') {
      return { reportPaths: [], message: `Job is still ${job.status}` };
    }

    return {
      reportPaths: job.reportPaths ?? [],
      message: 'Reports ready',
    };
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
      tables: entries.map((e) => ({
        table_name: e.table_name,
        rule_path: e.rule_path,
        def_list: body.def_list,  // undefined = load all; [] would filter out everything
      })),
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
