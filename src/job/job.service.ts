import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PgCacheService } from '../database/pg-cache.service';
import { JobRecord, JobStatus, TableSummary } from './job.types';

/**
 * Job registry backed by an in-memory Map + PostgreSQL persistence.
 *
 * In-memory Map provides fast reads (no DB round-trip for status polling).
 * PostgreSQL provides durability — jobs survive container restarts.
 *
 * Write path: update in-memory Map immediately, then fire-and-forget upsert to PG.
 * Read path: always reads from in-memory Map (populated from PG on startup).
 */
@Injectable()
export class JobService implements OnModuleInit {
  private readonly logger = new Logger(JobService.name);
  private readonly jobs = new Map<string, JobRecord>();

  constructor(private readonly pg: PgCacheService) {}

  async onModuleInit(): Promise<void> {
    await this.loadFromDb();
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
    this.persist(jobId);
    return jobId;
  }

  start(jobId: string): void {
    const job = this.getOrThrow(jobId);
    job.status = JobStatus.RUNNING;
    job.startedAt = new Date();
    this.persist(jobId);
  }

  incrementDone(jobId: string): void {
    const job = this.getOrThrow(jobId);
    job.doneTables += 1;
    this.persist(jobId);
  }

  complete(jobId: string, reportPaths: string[], summary: TableSummary[]): void {
    const job = this.getOrThrow(jobId);
    job.status = JobStatus.DONE;
    job.finishedAt = new Date();
    job.reportPaths = reportPaths;
    job.summary = summary;
    this.persist(jobId);
  }

  fail(jobId: string, errorMessage: string): void {
    const job = this.getOrThrow(jobId);
    job.status = JobStatus.FAILED;
    job.finishedAt = new Date();
    job.errorMessage = errorMessage;
    this.persist(jobId);
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

  private persist(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    // Fire-and-forget — in-memory Map is the source of truth for reads
    this.pg.upsertJob(job).catch((e) =>
      this.logger.warn(`[Jobs] PG persist failed for ${jobId}: ${e.message}`),
    );
  }

  private async loadFromDb(): Promise<void> {
    try {
      const records = await this.pg.listJobs();
      let recovered = 0;
      for (const r of records) {
        // Revive date strings back to Date objects
        r.createdAt = new Date(r.createdAt);
        if (r.startedAt) r.startedAt = new Date(r.startedAt);
        if (r.finishedAt) r.finishedAt = new Date(r.finishedAt);
        // Any job that was RUNNING when the pod died is now effectively failed
        if (r.status === JobStatus.RUNNING) {
          r.status = JobStatus.FAILED;
          r.errorMessage = 'Pod restarted while job was running — results may be incomplete';
          this.pg.upsertJob(r).catch(() => {});
        }
        this.jobs.set(r.jobId, r);
        recovered++;
      }
      this.logger.log(`Recovered ${recovered} job(s) from PostgreSQL`);
    } catch (e: any) {
      this.logger.warn(`Failed to load jobs from PostgreSQL: ${e.message}`);
    }
  }

  private getOrThrow(jobId: string): JobRecord {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    return job;
  }
}
