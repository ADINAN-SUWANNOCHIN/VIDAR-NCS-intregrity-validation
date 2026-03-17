const sql = require('mssql');

const cfg = {
  server: '172.18.1.153', port: 1433,
  user: 'adinan.s', password: 'Adninp#555',
  options: { encrypt: false, trustServerCertificate: true },
  requestTimeout: 0,  // unlimited, same as createSourceCache
  connectionTimeout: 30000,
};

const SOURCE = '[ncs-conv-aging].dbo.[conv$vinpllvhistory]';
const SOURCE_FILTER = "systemreferenceno LIKE 'P%' OR systemreferenceno LIKE 'ADC%'";
const TEMP = '##dv_test_cache';

async function run() {
  const pool = await sql.connect(cfg);

  // Step 1: drop if exists (same as createSourceCache)
  await pool.request().query(
    `IF OBJECT_ID('tempdb..[${TEMP}]') IS NOT NULL DROP TABLE [${TEMP}]`
  );
  console.log('Creating source cache (SELECT * INTO) — may take 1-3 min...');
  const t0 = Date.now();

  const insertReq = pool.request();
  insertReq.timeout = 0;
  await insertReq.query(
    `SELECT * INTO [${TEMP}] FROM ${SOURCE} WITH (NOLOCK) WHERE (${SOURCE_FILTER})`
  );
  console.log(`Cache created in ${((Date.now()-t0)/1000).toFixed(1)}s`);

  // Step 2: build index (same as createSourceCache)
  console.log('Building clustered index...');
  const t1 = Date.now();
  const idxReq = pool.request();
  idxReq.timeout = 0;
  await idxReq.query(
    `CREATE CLUSTERED INDEX [ix_dv_src] ON [${TEMP}] ([systemreferenceno], [id])`
  );
  console.log(`Index built in ${((Date.now()-t1)/1000).toFixed(1)}s`);

  // Step 3: count rows in temp table (confirms it's populated)
  const countReq = pool.request();
  const countResult = await countReq.query(`SELECT COUNT(*) AS cnt FROM [${TEMP}]`);
  console.log(`Rows in temp table: ${countResult.recordset[0].cnt}`);

  // Step 4: fetchChunk test (first chunk, lastSysref=null → same as validateSysrefSort)
  console.log('Fetching first chunk (lastSysref=null)...');
  const fetchReq = pool.request();
  fetchReq.stream = true;
  fetchReq.query(`
    SELECT * FROM [${TEMP}] WITH (NOLOCK)
    WHERE [systemreferenceno] IS NOT NULL
    ORDER BY [systemreferenceno]
    OFFSET 0 ROWS FETCH NEXT 5000 ROWS ONLY
  `);
  const rows = [];
  await new Promise((resolve, reject) => {
    fetchReq.on('row', r => rows.push(r));
    fetchReq.on('error', reject);
    fetchReq.on('done', () => resolve(rows));
  });
  console.log(`First chunk rows: ${rows.length}`);
  if (rows.length > 0) {
    console.log(`  First sysref: ${rows[0].systemreferenceno}`);
    console.log(`  Last sysref:  ${rows[rows.length-1].systemreferenceno}`);
  }

  // Cleanup
  await pool.request().query(`IF OBJECT_ID('tempdb..[${TEMP}]') IS NOT NULL DROP TABLE [${TEMP}]`);
  console.log('Temp table dropped.');
  await pool.close();
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
