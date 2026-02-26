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
import { ValidationService } from './validation.service';
import { JobService } from '../job/job.service';
import { ValidationRequestDto } from '../dto/validation-request.dto';
import { JobRecord } from '../job/job.types';

@Controller('validation')
export class ValidationController {
  constructor(
    private readonly validationService: ValidationService,
    private readonly jobService: JobService,
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
}
