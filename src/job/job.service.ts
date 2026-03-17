import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { JobRecord, JobStatus, TableSummary } from './job.types';

/**
 * Job registry backed by an in-memory Map + a JSON file on disk.
 *
 * The JSON file is written on every state change and read back on startup.
 * This survives process restarts within the same pod (e.g. NestJS hot-reload,
 * manual restart) and makes past jobs queryable after restart.
 *
 * Does NOT survive pod replacement (no PVC) — get a PVC for full persistence.
 */
@Injectable()
export class JobService implements OnModuleInit {
  private readonly logger = new Logger(JobService.name);
  private readonly jobs = new Map<string, JobRecord>();
  private readonly persistPath: string;

  constructor(private readonly config: ConfigService) {
    const reportsDir = this.config.get<string>('REPORTS_DIR') ?? './reports';
    this.persistPath = path.join(reportsDir, 'jobs.json');
  }

  onModuleInit(): void {
    this.loadFromDisk();
  }

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
    this.persist();
    return jobId;
  }

  start(jobId: string): void {
    const job = this.getOrThrow(jobId);
    job.status = JobStatus.RUNNING;
    job.startedAt = new Date();
    this.persist();
  }

  incrementDone(jobId: string): void {
    const job = this.getOrThrow(jobId);
    job.doneTables += 1;
    this.persist();
  }

  complete(jobId: string, reportPaths: string[], summary: TableSummary[]): void {
    const job = this.getOrThrow(jobId);
    job.status = JobStatus.DONE;
    job.finishedAt = new Date();
    job.reportPaths = reportPaths;
    job.summary = summary;
    this.persist();
  }

  fail(jobId: string, errorMessage: string): void {
    const job = this.getOrThrow(jobId);
    job.status = JobStatus.FAILED;
    job.finishedAt = new Date();
    job.errorMessage = errorMessage;
    this.persist();
  }

  getStatus(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  listJobs(): JobRecord[] {
    return [...this.jobs.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  // ----------------------------------------------------------------
  // Persistence helpers
  // ----------------------------------------------------------------

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const records = [...this.jobs.values()];
      fs.writeFileSync(this.persistPath, JSON.stringify(records, null, 2), 'utf-8');
    } catch (e: any) {
      this.logger.warn(`Failed to persist jobs to disk: ${e.message}`);
    }
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const records: JobRecord[] = JSON.parse(raw);
      let recovered = 0;
      for (const r of records) {
        // Revive date strings back to Date objects
        r.createdAt = new Date(r.createdAt);
        if (r.startedAt) r.startedAt = new Date(r.startedAt);
        if (r.finishedAt) r.finishedAt = new Date(r.finishedAt);
        // Any job that was RUNNING when the process died is now effectively failed
        if (r.status === JobStatus.RUNNING) {
          r.status = JobStatus.FAILED;
          r.errorMessage = 'Process restarted while job was running — results may be incomplete';
        }
        this.jobs.set(r.jobId, r);
        recovered++;
      }
      this.logger.log(`Recovered ${recovered} job(s) from disk`);
    } catch (e: any) {
      this.logger.warn(`Failed to load jobs from disk: ${e.message}`);
    }
  }

  private getOrThrow(jobId: string): JobRecord {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    return job;
  }
}
