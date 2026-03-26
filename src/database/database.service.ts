import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sql from 'mssql';
import { PgCacheService } from './pg-cache.service';

/** Returns a safe FROM-clause reference: leaves full cross-db refs intact, wraps simple names in [] */
export function tableRef(t: string): string {
  return t.includes('[') || t.includes('.') ? t : `[${t}]`;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool: sql.ConnectionPool;

  /**
   * Monotonically increasing counter for unique temp table names.
   * Date.now() alone is not sufficient — two concurrent jobs processed within
   * the same millisecond get the same timestamp, causing name collision and
   * one job silently dropping the other's temp table.
   */
  private static cacheSeq = 0;
  static nextCacheSeq(): number { return ++DatabaseService.cacheSeq; }

  constructor(
    private readonly config: ConfigService,
    private readonly pg: PgCacheService,
  ) {}

  async onModuleInit() {
    const missing = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].filter(
      (k) => !this.config.get<string>(k),
    );
    if (missing.length > 0) {
      throw new Error(`Missing required env vars: ${missing.join(', ')} — ensure vidar-db-secret is applied to the cluster`);
    }

    const dbConfig: sql.config = {
      server: this.config.get<string>('DB_HOST') ?? '',   // TODO: ใส่ host
      port: parseInt(this.config.get<string>('DB_PORT') ?? '1433'),
      user: this.config.get<string>('DB_USER'),     // TODO: ใส่ user
      password: this.config.get<string>('DB_PASSWORD'), // TODO: ใส่ password
      database: this.config.get<string>('DB_NAME'), // TODO: ใส่ db name
      options: {
        encrypt: this.config.get<string>('DB_ENCRYPT') !== 'false', // defaults true; set DB_ENCRYPT=false for plain SQL Server
        trustServerCertificate: true,
        readOnlyIntent: true,
        cryptoCredentialsDetails: { minVersion: 'TLSv1' }, // required for older SQL Server
        // TCP keepalive — sends probes during long server-side operations (e.g. SELECT INTO for
        // 15M-row source cache) where no data flows back to Node.js. Without this, the network
        // firewall/LB sees the connection as idle and sends TCP RST → ECONNRESET.
        // initialDelay=30s ensures probes start well before any reasonable firewall idle timeout.
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore — keepAlive/keepAliveInitialDelayMs are valid node-mssql TCP options but not in IOptions typings
        keepAlive: true,
        keepAliveInitialDelayMs: 30000,
      },
      pool: {
        max: 10,
        min: 2,
        idleTimeoutMillis: 30000,
      },
      requestTimeout: 1800000, // 30 min per query (large table scans can take long)
    };

    this.pool = new sql.ConnectionPool(dbConfig);
    await this.pool.connect();
    this.logger.log('Connected to SQL Server');
  }

  async onModuleDestroy() {
    await this.pool.close();
  }

  getPool(): sql.ConnectionPool {
    return this.pool;
  }

  /**
   * ดึง distinct group keys แบบ keyset/cursor pagination
   * ใช้ lastKey แทน offset เพื่อให้ SQL Server seek ตรงตำแหน่งแทน scan ทั้งตาราง
   * lastKey = null → เริ่มจากต้น
   */
  async getGroupKeys(
    table: string,
    groupKeyColumn: string,
    chunkSize: number,
    lastKey: string | null,
  ): Promise<string[]> {
    const req = this.pool.request().input('chunkSize', sql.Int, chunkSize);

    const whereClause = lastKey === null
      ? `WHERE [${groupKeyColumn}] IS NOT NULL`
      : `WHERE [${groupKeyColumn}] > @lastKey AND [${groupKeyColumn}] IS NOT NULL`;

    if (lastKey !== null) {
      req.input('lastKey', sql.NVarChar, lastKey);
    }

    const result = await req.query(`
      SELECT DISTINCT [${groupKeyColumn}]
      FROM ${tableRef(table)}
      ${whereClause}
      ORDER BY [${groupKeyColumn}]
      OFFSET 0 ROWS FETCH NEXT @chunkSize ROWS ONLY
    `);
    return result.recordset.map((r) => r[groupKeyColumn]);
  }

  /**
   * Stream all rows from a table where keyColumn matches any value in keys[].
   *
   * Uses OPENJSON to pass keys as a single JSON array parameter instead of individual
   * @k0, @k1, ... parameters. This bypasses SQL Server's 2100 parameter limit and allows
   * batch sizes up to 10,000 keys per query — 5× fewer DB round-trips vs the old 2000-key
   * parameterized IN clause.
   *
   * COLLATE DATABASE_DEFAULT on the OPENJSON [value] column ensures the comparison uses
   * the target table's collation (e.g. Thai_CI_AS / Thai_CI_AI) and avoids collation
   * conflict errors on cross-database queries.
   *
   * Requires SQL Server 2016+ (OPENJSON support).
   */
  async streamRowsByKeys(
    table: string,
    keyColumn: string,
    keys: string[],
    callback: (row: Record<string, unknown>) => void,
  ): Promise<void> {
    if (keys.length === 0) return;

    const BATCH_SIZE = 10000;
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      const batch = keys.slice(i, i + BATCH_SIZE);

      const request = this.pool.request();
      request.stream = true;
      request.input('keys', sql.NVarChar(sql.MAX), JSON.stringify(batch));

      request.query(
        `SELECT * FROM ${tableRef(table)} WITH (NOLOCK) ` +
        `WHERE [${keyColumn}] IN (SELECT [value] COLLATE DATABASE_DEFAULT FROM OPENJSON(@keys))`,
      );

      await new Promise<void>((resolve, reject) => {
        request.on('row', callback);
        request.on('error', reject);
        request.on('done', resolve);
      });
    }
  }

  /**
   * Bind the keyset cursor @lastKey with the correct SQL type.
   * The mssql driver returns native JS types from the DB (INT → number, VARCHAR → string).
   * Always using NVarChar causes string-comparison ordering on numeric anchor keys
   * (e.g. '9' > '10'), which breaks keyset pagination. (C2)
   */
  private bindLastKey(req: sql.Request, value: unknown): void {
    if (typeof value === 'number') {
      Number.isInteger(value)
        ? req.input('lastKey', sql.BigInt, value)
        : req.input('lastKey', sql.Float, value);
    } else {
      req.input('lastKey', sql.NVarChar, String(value));
    }
  }

  /**
   * Stream ทุก row ของ table แบบ keyset/cursor pagination
   * ใช้สำหรับ Master / Header table ที่ไม่มี transaction group key
   *
   * anchorColumn ต้องเป็น column ที่ unique และ monotonic (เช่น account number)
   * — ค่า lastKey จาก row สุดท้ายของแต่ละ batch ถูกใช้เป็น cursor ของ batch ถัดไป
   */
  async streamAllRows(
    table: string,
    anchorColumn: string,
    callback: (row: Record<string, unknown>) => void,
    chunkSize = 5000,
  ): Promise<void> {
    let lastKey: unknown = null;
    let hasMore = true;

    while (hasMore) {
      const request = this.pool.request();
      request.stream = true;

      const whereClause = lastKey === null
        ? `WHERE [${anchorColumn}] IS NOT NULL`
        : `WHERE [${anchorColumn}] > @lastKey`;

      if (lastKey !== null) {
        this.bindLastKey(request, lastKey);
      }

      request.query(`
        SELECT * FROM ${tableRef(table)} WITH (NOLOCK)
        ${whereClause}
        ORDER BY [${anchorColumn}]
        OFFSET 0 ROWS FETCH NEXT ${chunkSize} ROWS ONLY
      `);

      let count = 0;
      let lastRow: Record<string, unknown> | null = null;

      await new Promise<void>((resolve, reject) => {
        request.on('row', (row) => { callback(row); lastRow = row; count++; });
        request.on('error', reject);
        request.on('done', resolve);
      });

      hasMore = count === chunkSize;
      if (lastRow !== null) {
        lastKey = (lastRow as Record<string, unknown>)[anchorColumn];
      }
    }
  }

  /**
   * คืน SUM ของ amountColumn จำแนกตาม groupColumn
   * ใช้สำหรับ aggregate cross-check อิสระจาก row comparison
   * ตัวอย่าง: SUM(transactionamount) GROUP BY affectcode
   */
  async querySumByGroup(
    table: string,
    amountColumn: string,
    groupColumn: string,
  ): Promise<Map<string, number>> {
    const result = await this.pool.request().query(`
      SELECT [${groupColumn}], SUM(CAST([${amountColumn}] AS FLOAT)) AS total
      FROM ${tableRef(table)}
      WHERE [${amountColumn}] IS NOT NULL AND [${groupColumn}] IS NOT NULL
      GROUP BY [${groupColumn}]
    `);
    const map = new Map<string, number>();
    for (const row of result.recordset) {
      map.set(String(row[groupColumn]), row.total ?? 0);
    }
    return map;
  }

  /**
   * Fetch a single keyset-paginated chunk as an array.
   * Used by MasterStrategy for chunk-by-chunk comparison without accumulating all rows.
   * lastKey = null → start from the beginning.
   */
  async fetchChunk(
    table: string,
    anchorColumn: string,
    chunkSize: number,
    lastKey: unknown,
    extraFilter?: string,
  ): Promise<Record<string, unknown>[]> {
    const request = this.pool.request();
    request.stream = true;

    const whereClause =
      lastKey === null
        ? `WHERE [${anchorColumn}] IS NOT NULL`
        : `WHERE [${anchorColumn}] > @lastKey`;

    const filterClause = extraFilter ? `AND (${extraFilter})` : '';

    if (lastKey !== null) {
      this.bindLastKey(request, lastKey);
    }

    request.query(`
      SELECT * FROM ${tableRef(table)} WITH (NOLOCK)
      ${whereClause} ${filterClause}
      ORDER BY [${anchorColumn}]
      OFFSET 0 ROWS FETCH NEXT ${chunkSize} ROWS ONLY
    `);

    const rows: Record<string, unknown>[] = [];
    return new Promise((resolve, reject) => {
      request.on('row', (row) => rows.push(row));
      request.on('error', reject);
      request.on('done', () => resolve(rows));
    });
  }

  /**
   * Fetch a keyset-paginated chunk of KEY VALUES ONLY — no SELECT *.
   *
   * Semantically identical to fetchChunk but returns only the anchor key column.
   * Used by MasterStrategy's reverse scan to detect extra rows in the target table
   * without loading full rows. At 15M rows this reduces per-chunk bandwidth by
   * ~100× compared to SELECT * — critical for the reverse scan's performance.
   *
   * Returns Record<string, unknown>[] (one field per row) so the raw typed value
   * is preserved for bindLastKey (prevents string-comparison ordering on INT keys).
   */
  async fetchChunkKeys(
    table: string,
    keyColumn: string,
    chunkSize: number,
    lastKey: unknown,
  ): Promise<Record<string, unknown>[]> {
    const request = this.pool.request();
    const whereClause =
      lastKey === null
        ? `WHERE [${keyColumn}] IS NOT NULL`
        : `WHERE [${keyColumn}] > @lastKey`;

    if (lastKey !== null) {
      this.bindLastKey(request, lastKey);
    }

    const result = await request.query(`
      SELECT [${keyColumn}]
      FROM ${tableRef(table)} WITH (NOLOCK)
      ${whereClause}
      ORDER BY [${keyColumn}]
      OFFSET 0 ROWS FETCH NEXT ${chunkSize} ROWS ONLY
    `);

    return result.recordset as Record<string, unknown>[];
  }

  /**
   * Fetch a small sample (TOP N) for noisy-column detection.
   * Strategies call this before the main loop to determine which columns
   * are all-null / all-zero / boolean-only and should use name-only matching.
   */
  async sampleRows(table: string, sampleSize = 1000): Promise<Record<string, unknown>[]> {
    const result = await this.pool
      .request()
      .query(`SELECT TOP ${sampleSize} * FROM ${tableRef(table)}`);
    return result.recordset as Record<string, unknown>[];
  }

  /**
   * Paginate through DISTINCT values of a key column.
   * Supports an optional SQL filter clause (appended with AND).
   * Used by composite-key validation to iterate sysrefs page by page.
   */
  async getDistinctKeys(
    table: string,
    keyColumn: string,
    batchSize: number,
    lastKey: string | null,
    filter?: string,
  ): Promise<string[]> {
    const request = this.pool.request();
    request.input('batchSize', sql.Int, batchSize);

    const filterClause = filter ? `AND (${filter})` : '';
    const whereClause =
      lastKey === null
        ? `WHERE [${keyColumn}] IS NOT NULL ${filterClause}`
        : `WHERE [${keyColumn}] > @lastKey ${filterClause}`;

    if (lastKey !== null) {
      // Use bindLastKey to preserve the correct SQL type for the cursor value.
      // Forcing NVarChar on a numeric key column causes string-comparison ordering ('9' > '10')
      // which breaks alphabetic pagination — same issue fixed in fetchChunk via bindLastKey.
      this.bindLastKey(request, lastKey);
    }

    const result = await request.query(`
      SELECT DISTINCT [${keyColumn}]
      FROM ${tableRef(table)} WITH (NOLOCK)
      ${whereClause}
      ORDER BY [${keyColumn}]
      OFFSET 0 ROWS FETCH NEXT @batchSize ROWS ONLY
    `);
    return result.recordset.map((r) => String(r[keyColumn]));
  }

  /**
   * Batch lookup: given a list of lookup values, return a Map of lookupValue → resultValue.
   * Fetches from a translation table (e.g. cithistory: invaccountno → newinvaccountno).
   * Handles >2000 values by batching (SQL Server param limit = 2100).
   * Uses DISTINCT so duplicate invaccountnos return one canonical mapping per value.
   */
  async batchLookup(
    table: string,
    lookupCol: string,
    resultCol: string,
    values: string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (values.length === 0) return map;

    const BATCH_SIZE = 2000;
    for (let i = 0; i < values.length; i += BATCH_SIZE) {
      const batch = values.slice(i, i + BATCH_SIZE);
      const request = this.pool.request();
      const placeholders = batch.map((_, j) => `@k${j}`).join(',');
      batch.forEach((k, j) => request.input(`k${j}`, sql.NVarChar, k));

      const result = await request.query(`
        SELECT DISTINCT [${lookupCol}], [${resultCol}]
        FROM ${tableRef(table)} WITH (NOLOCK)
        WHERE [${lookupCol}] IN (${placeholders})
          AND [${lookupCol}] IS NOT NULL
          AND [${resultCol}] IS NOT NULL
      `);
      for (const row of result.recordset) {
        const k = String(row[lookupCol] ?? '').trim();
        const v = String(row[resultCol] ?? '').trim();
        if (k && v && !map.has(k)) map.set(k, v); // first occurrence wins (1:1 verified)
      }
    }
    return map;
  }

  /** Execute คำสั่ง query ทั่วไป (Read-Only) */
  async query<T>(sql_query: string, inputs?: Record<string, unknown>): Promise<T[]> {
    const req = this.pool.request();
    if (inputs) {
      Object.entries(inputs).forEach(([k, v]) => req.input(k, v));
    }
    const result = await req.query(sql_query);
    return result.recordset as T[];
  }

  /**
   * Copies a full SQL Server table into a PostgreSQL cache table with an index.
   * Used by composite-key validation (validateCompositeKey) to avoid repeated
   * full table scans — replaces the old SQL Server ##temp table approach.
   *
   * Streams rows from SQL Server with pause/resume backpressure and inserts
   * them into PostgreSQL in batches. Index is created after all rows are inserted.
   */
  async createTargetCache(
    sourceTable: string,
    tempName: string,
    primaryIndexCol: string,
    secondaryIndexCol: string,
  ): Promise<void> {
    const filterClause = '';
    await this.copyToPostgres(sourceTable, tempName, filterClause, [primaryIndexCol, secondaryIndexCol], 'TgtCache');
  }

  /** Drops the PostgreSQL cache table created by createTargetCache. */
  async dropTargetCache(tempName: string): Promise<void> {
    try {
      await this.pg.dropCacheTable(tempName);
      this.logger.log(`[TgtCache] Dropped PG:${tempName}`);
    } catch (e: any) {
      this.logger.warn(`[TgtCache] Failed to drop PG:${tempName}: ${e.message}`);
    }
  }

  /**
   * Copies a source (old) table into a PostgreSQL cache table with an index on
   * (sysrefCol, idCol). Used by sysref-sort validation to eliminate scatter without
   * repeatedly sorting the full table per paginated chunk.
   *
   * Replaces the SQL Server ##temp table approach (which required tempdb write permission).
   * Data flows: SQL Server (stream) → Node.js (buffer) → PostgreSQL (batch insert).
   *
   * An optional filter (source_filter from common.yaml) limits which rows are copied so
   * excluded rows (BF, CAL_INT, B_DIFF) are never in the cache.
   */
  /**
   * Returns true if sysrefCol exists in the source table (and was indexed).
   * Returns false if sysrefCol is missing — caller should skip sysref-sort for this source.
   */
  async createSourceCache(
    sourceTable: string,
    tempName: string,
    sysrefCol: string,
    idCol: string,
    filter?: string,
  ): Promise<boolean> {
    const filterClause = filter ? `WHERE (${filter})` : '';
    const cols = await this.copyToPostgres(sourceTable, tempName, filterClause, [sysrefCol, idCol], 'SrcCache');
    const sysrefFound = cols.includes(sysrefCol);
    if (!sysrefFound) {
      this.logger.warn(`[SrcCache] Column "${sysrefCol}" not found in ${sourceTable} — sysref-sort skipped for this source`);
    }
    return sysrefFound;
  }

  /** Drops the PostgreSQL cache table created by createSourceCache. */
  async dropSourceCache(tempName: string): Promise<void> {
    try {
      await this.pg.dropCacheTable(tempName);
      this.logger.log(`[SrcCache] Dropped PG:${tempName}`);
    } catch (e: any) {
      this.logger.warn(`[SrcCache] Failed to drop PG:${tempName}: ${e.message}`);
    }
  }

  /**
   * Keyset-paginated fetch from a PostgreSQL cache table.
   * Drop-in replacement for fetchChunk() when the table is a PG cache (dv_src_* / dv_ck_*).
   */
  async fetchChunkCache(
    tableName: string,
    keyCol: string,
    chunkSize: number,
    lastKey: unknown,
  ): Promise<Record<string, unknown>[]> {
    return this.pg.fetchChunk(tableName, keyCol, chunkSize, lastKey);
  }

  /** Composite-keyset fetch for sysref-sorted caches. See PgCacheService.fetchChunkSysref. */
  async fetchChunkCacheSysref(
    tableName: string,
    sysrefCol: string,
    idCol: string,
    chunkSize: number,
    lastSysref: string | null,
    lastId: string | null,
  ): Promise<Record<string, unknown>[]> {
    return this.pg.fetchChunkSysref(tableName, sysrefCol, idCol, chunkSize, lastSysref, lastId);
  }

  /**
   * Fetch rows by key list from a PostgreSQL cache table.
   * Drop-in replacement for streamRowsByKeys() when the table is a PG cache.
   */
  async streamRowsByKeysCache(
    tableName: string,
    keyCol: string,
    keys: string[],
    callback: (row: Record<string, unknown>) => void,
  ): Promise<void> {
    if (keys.length === 0) return;
    const rows = await this.pg.fetchByKeys(tableName, keyCol, keys);
    for (const row of rows) callback(row);
  }

  /**
   * Internal helper: stream all rows from a SQL Server table and insert into a PG cache table.
   * Uses mssql streaming with pause/resume for backpressure — no unbounded memory accumulation.
   */
  private async copyToPostgres(
    sourceTable: string,
    tempName: string,
    filterClause: string,
    indexCols: string[],
    logPrefix: string,
  ): Promise<string[]> {
    await this.pg.dropCacheTable(tempName);
    this.logger.log(`[${logPrefix}] Copying ${sourceTable} → PG:${tempName}...`);

    let columnNames: string[] = [];
    let tableCreated = false;
    let buffer: Record<string, unknown>[] = [];
    let totalRows = 0;
    let pendingRows = 0;
    let streamDone = false;
    const FLUSH_SIZE = 1000;

    const request = this.pool.request();
    request.stream = true;
    (request as any).timeout = 0;
    request.query(`SELECT * FROM ${tableRef(sourceTable)} WITH (NOLOCK) ${filterClause}`);

    await new Promise<void>((resolve, reject) => {
      const tryResolve = () => {
        if (streamDone && pendingRows === 0) resolve();
      };

      request.on('row', (row: Record<string, unknown>) => {
        request.pause();
        pendingRows++;

        (async () => {
          try {
            if (!tableCreated) {
              columnNames = Object.keys(row);
              await this.pg.createCacheTable(tempName, columnNames);
              tableCreated = true;
            }
            buffer.push(row);
            if (buffer.length >= FLUSH_SIZE) {
              const batch = buffer.splice(0);
              await this.pg.batchInsert(tempName, batch, columnNames);
              totalRows += batch.length;
            }
            pendingRows--;
            tryResolve();
            request.resume();
          } catch (e) {
            reject(e);
          }
        })();
      });

      request.on('error', reject);

      request.on('done', () => {
        streamDone = true;
        // Flush remaining buffer then resolve (if all row handlers are already done)
        (async () => {
          try {
            if (buffer.length > 0) {
              await this.pg.batchInsert(tempName, buffer, columnNames);
              totalRows += buffer.length;
              buffer = [];
            }
            tryResolve();
          } catch (e) {
            reject(e);
          }
        })();
      });
    });

    this.logger.log(`[${logPrefix}] Inserted ${totalRows} rows → PG:${tempName}, building index...`);
    const validIndexCols = indexCols.filter((c) => columnNames.includes(c));
    if (validIndexCols.length > 0) {
      await this.pg.createIndex(tempName, validIndexCols);
    }
    this.logger.log(`[${logPrefix}] Ready: PG:${tempName}`);
    return columnNames;
  }
}
