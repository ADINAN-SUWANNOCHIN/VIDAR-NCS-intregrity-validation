import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { JobRecord, JobStatus } from './job.types';

/**
 * In-memory job store.
 * สำหรับ production scale ควรเปลี่ยนเป็น Redis หรือ DB table
 */
@Injectable()
export class JobService {
  private readonly jobs = new Map<string, JobRecord>();

  createJob(totalTables: number, label?: string): string {
    const jobId = uuidv4();
    this.jobs.set(jobId, {
      jobId,
      label,
      status: JobStatus.PENDING,
      createdAt: new Date(),
      totalTables,
      doneTables: 0,
    });
    return jobId;
  }

  start(jobId: string): void {
    const job = this.getOrThrow(jobId);
    job.status = JobStatus.RUNNING;
    job.startedAt = new Date();
  }

  incrementDone(jobId: string): void {
    const job = this.getOrThrow(jobId);
    job.doneTables += 1;
  }

  complete(jobId: string, reportPaths: string[]): void {
    const job = this.getOrThrow(jobId);
    job.status = JobStatus.DONE;
    job.finishedAt = new Date();
    job.reportPaths = reportPaths;
  }

  fail(jobId: string, errorMessage: string): void {
    const job = this.getOrThrow(jobId);
    job.status = JobStatus.FAILED;
    job.finishedAt = new Date();
    job.errorMessage = errorMessage;
  }

  getStatus(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  private getOrThrow(jobId: string): JobRecord {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    return job;
  }
}
