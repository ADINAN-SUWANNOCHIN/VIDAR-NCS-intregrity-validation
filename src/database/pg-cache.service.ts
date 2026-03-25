import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { JobRecord, JobStatus } from '../job/job.types';

/**
 * PostgreSQL-backed cache + job persistence service.
 *
 * Owns two responsibilities:
 *   1. Job persistence — stores job records in the `jobs` table so they
 *      survive container restarts (replaces the in-memory + jobs.json approach).
 *   2. Cache tables — dv_src_* and dv_ck_* are created here instead of in
 *      SQL Server tempdb (which requires permissions the app login does not have).
 *      Data is streamed from SQL Server → inserted here → queried here.
 */
@Injectable()
export class PgCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PgCacheService.name);
  private readonly schema = 'cache';
  private pool: Pool;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    this.pool = new Pool({
      host: this.config.get<string>('CACHE_DB_HOST'),
      port: parseInt(this.config.get<string>('CACHE_DB_PORT') ?? '5432'),
      user: this.config.get<string>('CACHE_DB_USER'),
      password: this.config.get<string>('CACHE_DB_PASSWORD'),
      database: this.config.get<string>('CACHE_DB_NAME') ?? 'postgres',
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    try {
      const client = await this.pool.connect();
      client.release();
      this.logger.log('Connected to PostgreSQL cache DB');

      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS ${this.schema}.jobs (
          job_id   TEXT PRIMARY KEY,
          record   JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      // Drop any orphan cache tables left from a previous crashed run
      const orphans = await this.pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = '${this.schema}'
          AND (table_name LIKE 'dv_src_%' OR table_name LIKE 'dv_ck_%')
      `);
      for (const row of orphans.rows) {
        await this.pool.query(`DROP TABLE IF EXISTS ${this.schema}."${row.table_name}"`);
        this.logger.log(`[Cleanup] Dropped orphan cache table: ${row.table_name}`);
      }

      this.logger.log('PgCacheService ready');
    } catch (e: any) {
      this.logger.error(`PostgreSQL cache DB unavailable: ${e.message}`);
      this.logger.warn('Job persistence and cache tables disabled — validation jobs requiring cache will fail at runtime');
      await this.pool.end().catch(() => {});
      this.pool = null as any;
    }
  }

  get isAvailable(): boolean { return this.pool != null; }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) await this.pool.end();
  }

  // ----------------------------------------------------------------
  // Job persistence
  // ----------------------------------------------------------------

  async upsertJob(record: JobRecord): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO ${this.schema}.jobs (job_id, record, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (job_id) DO UPDATE SET record = $2::jsonb, updated_at = NOW()`,
        [record.jobId, JSON.stringify(record)],
      );
    } catch (e: any) {
      this.logger.warn(`[Jobs] Failed to persist job ${record.jobId}: ${e.message}`);
    }
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    if (!this.pool) return null;
    const res = await this.pool.query(`SELECT record FROM ${this.schema}.jobs WHERE job_id = $1`, [jobId]);
    return res.rows[0]?.record ?? null;
  }

  async listJobs(): Promise<JobRecord[]> {
    if (!this.pool) return [];
    const res = await this.pool.query(
      `SELECT record FROM ${this.schema}.jobs ORDER BY (record->>'createdAt') DESC`,
    );
    return res.rows.map((r) => r.record as JobRecord);
  }

  // ----------------------------------------------------------------
  // Cache table management
  // ----------------------------------------------------------------

  private assertAvailable(): void {
    if (!this.pool) throw new Error('PostgreSQL cache DB is unavailable — check CACHE_DB_* env vars and network connectivity');
  }

  async dropCacheTable(tableName: string): Promise<void> {
    this.assertAvailable();
    await this.pool.query(`DROP TABLE IF EXISTS ${this.schema}."${tableName}"`);
  }

  /** Create a cache table with all-TEXT columns (SQL Server types are irrelevant here). */
  async createCacheTable(tableName: string, columnNames: string[]): Promise<void> {
    this.assertAvailable();
    const cols = columnNames.map((c) => `"${c}" TEXT`).join(', ');
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.schema}."${tableName}" (${cols})`);
  }

  /** Batch-insert rows into a cache table. All values are coerced to TEXT. */
  async batchInsert(
    tableName: string,
    rows: Record<string, unknown>[],
    columnNames: string[],
  ): Promise<void> {
    this.assertAvailable();
    if (rows.length === 0) return;

    // PG wire protocol uses Int16 for parameter count — hard limit 65535.
    // Cap rows-per-batch so (rows × columns) never exceeds 65000.
    const BATCH = columnNames.length > 0 ? Math.min(500, Math.floor(65000 / columnNames.length)) : 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const valueRows: string[] = [];
      const params: (string | null)[] = [];
      let idx = 1;

      for (const row of batch) {
        const placeholders = columnNames.map(() => `$${idx++}`).join(', ');
        valueRows.push(`(${placeholders})`);
        for (const col of columnNames) {
          const v = row[col];
          params.push(v == null ? null : String(v));
        }
      }

      const cols = columnNames.map((c) => `"${c}"`).join(', ');
      await this.pool.query(
        `INSERT INTO ${this.schema}."${tableName}" (${cols}) VALUES ${valueRows.join(', ')}`,
        params,
      );
    }
  }

  async createIndex(tableName: string, cols: string[]): Promise<void> {
    this.assertAvailable();
    const colList = cols.map((c) => `"${c}"`).join(', ');
    await this.pool.query(`CREATE INDEX ON ${this.schema}."${tableName}" (${colList})`);
  }

  /**
   * Keyset-paginated fetch from a cache table.
   * All cache columns are TEXT — sysref keys are always strings so string ordering is correct.
   * lastKey = null → start from the beginning.
   */
  async fetchChunk(
    tableName: string,
    keyCol: string,
    chunkSize: number,
    lastKey: unknown,
  ): Promise<Record<string, unknown>[]> {
    this.assertAvailable();
    const res =
      lastKey == null
        ? await this.pool.query(
            `SELECT * FROM ${this.schema}."${tableName}" ORDER BY "${keyCol}" LIMIT $1`,
            [chunkSize],
          )
        : await this.pool.query(
            `SELECT * FROM ${this.schema}."${tableName}" WHERE "${keyCol}" > $1 ORDER BY "${keyCol}" LIMIT $2`,
            [String(lastKey), chunkSize],
          );
    return res.rows as Record<string, unknown>[];
  }

  /** Fetch all rows whose keyCol value is in the given keys list. */
  async fetchByKeys(
    tableName: string,
    keyCol: string,
    keys: string[],
  ): Promise<Record<string, unknown>[]> {
    this.assertAvailable();
    if (keys.length === 0) return [];
    const res = await this.pool.query(
      `SELECT * FROM ${this.schema}."${tableName}" WHERE "${keyCol}" = ANY($1::text[])`,
      [keys],
    );
    return res.rows as Record<string, unknown>[];
  }
}
