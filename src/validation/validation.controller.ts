import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  NotFoundException,
  HttpCode,
  HttpStatus,
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
   * POST /validation/run
   * Body: ValidationRequestDto
   * Response: { jobId: string }
   *
   * ตัวอย่าง Postman body:
   * {
   *   "job_name": "Nightly_Val_01",
   *   "tables": [
   *     { "table_name": "conv$vinplhistory", "def_list": ["def01", "def02"] },
   *     { "table_name": "conv$vinpahistory" }
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
   * Response: JobRecord (status, progress, etc.)
   */
  @Get('status/:jobId')
  async getStatus(@Param('jobId') jobId: string): Promise<JobRecord> {
    const job = this.jobService.getStatus(jobId);
    if (!job) throw new NotFoundException(`Job ${jobId} not found`);
    return job;
  }

  /**
   * GET /validation/report/:jobId
   * คืน list ของ report file paths ที่สามารถ download ได้
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
   * Returns all available preset modules and their categories.
   *
   * Example response:
   * { "npl": ["eir", "tax", "sbt", "cit"], "npa": ["eir", "tax", "sbt", "cit"] }
   */
  @Get('presets')
  getPresets(): Record<string, string[]> {
    return this.presetService.listPresets();
  }

  /**
   * POST /validation/run/preset/:module/:category
   * Fires a validation job using a stored preset configuration.
   * No need to type table names — they are loaded from presets/{module}/{category}.yaml
   *
   * Default: runs all tables in the preset with NO def rules.
   * Optional body:
   * {
   *   "job_name": "My_Run",          (optional label)
   *   "def_list": ["def01", "def02"] (optional — applies to ALL tables in preset)
   * }
   *
   * Examples:
   *   POST /validation/run/preset/npl/eir             → no defs
   *   POST /validation/run/preset/npl/eir  { "def_list": ["def01"] } → with def01
   */
  @Post('run/preset/:module/:category')
  @HttpCode(HttpStatus.ACCEPTED)
  async runPreset(
    @Param('module') module: string,
    @Param('category') category: string,
    @Body() body: RunPresetDto,
  ): Promise<{ jobId: string; message: string }> {
    const preset = this.presetService.loadPreset(module, category);
    if (!preset) {
      throw new NotFoundException(
        `Preset [${module}/${category}] not found. Use GET /validation/presets to see available options.`,
      );
    }

    const dto: ValidationRequestDto = {
      job_name: body.job_name ?? `${module.toUpperCase()}_${category.toUpperCase()}`,
      tables: preset.tables.map((t) => ({
        table_name: t.table_name,
        def_list: body.def_list ?? [],  // default: no defs
      })),
    };

    const jobId = await this.validationService.startJob(dto);
    return {
      jobId,
      message: `Preset [${module}/${category}] started with ${preset.tables.length} table(s). Use GET /validation/status/${jobId} to check progress.`,
    };
  }
}
