import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sql from 'mssql';

/** Returns a safe FROM-clause reference: leaves full cross-db refs intact, wraps simple names in [] */
export function tableRef(t: string): string {
  return t.includes('[') || t.includes('.') ? t : `[${t}]`;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool: sql.ConnectionPool;

  constructor(private readonly config: ConfigService) {}

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
   * Stream แถวทั้งหมดของกลุ่ม keys ที่กำหนด
   * callback รับ row ทีละแถวเพื่อลด memory
   *
   * SQL Server จำกัด parameters ต่อ query ที่ 2100 ดังนั้นถ้า keys มีมากกว่า 2000
   * จะแตก batch แล้ว query ทีละ batch แทน
   */
  async streamRowsByKeys(
    table: string,
    keyColumn: string,
    keys: string[],
    callback: (row: Record<string, unknown>) => void,
  ): Promise<void> {
    if (keys.length === 0) return;

    const BATCH_SIZE = 2000;
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      const batch = keys.slice(i, i + BATCH_SIZE);

      const request = this.pool.request();
      request.stream = true;

      // Parameterize key list เพื่อป้องกัน SQL injection
      const placeholders = batch.map((_, j) => `@k${j}`).join(',');
      batch.forEach((k, j) => request.input(`k${j}`, k));

      request.query(`SELECT * FROM ${tableRef(table)} WITH (NOLOCK) WHERE [${keyColumn}] IN (${placeholders})`);

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

  /** Execute คำสั่ง query ทั่วไป (Read-Only) */
  async query<T>(sql_query: string, inputs?: Record<string, unknown>): Promise<T[]> {
    const req = this.pool.request();
    if (inputs) {
      Object.entries(inputs).forEach(([k, v]) => req.input(k, v));
    }
    const result = await req.query(sql_query);
    return result.recordset as T[];
  }
}
