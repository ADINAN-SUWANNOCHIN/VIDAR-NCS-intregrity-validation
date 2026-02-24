const sql = require('mssql');
require('dotenv').config();
const strip = (v) => (v || '').replace(/^["']|["']$/g, '');

const config = {
  server: strip(process.env.DB_HOST), port: 1433,
  user: strip(process.env.DB_USER), password: strip(process.env.DB_PASSWORD),
  database: strip(process.env.DB_NAME),
  options: { encrypt: true, trustServerCertificate: true, cryptoCredentialsDetails: { minVersion: 'TLSv1' } },
  requestTimeout: 60000,
};

(async () => {
  const pool = await sql.connect(config);
  // Only get column schema — no COUNT/SELECT * to avoid timeout
  const cols = await pool.request().query(`
    SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
    FROM [ncs-conv-aging].INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'conv$vinplhistory'
    ORDER BY ORDINAL_POSITION
  `);
  console.log('=== conv$vinplhistory columns ===');
  cols.recordset.forEach(c =>
    console.log(`  ${String(c.COLUMN_NAME).padEnd(42)} ${String(c.DATA_TYPE).padEnd(15)} NULL:${c.IS_NULLABLE}`)
  );
  // Get 2 sample rows with TOP (fast)
  const sample = await pool.request().query(`SELECT TOP 2 * FROM [ncs-conv-aging].dbo.[conv$vinplhistory]`);
  console.log('\nSample rows:');
  sample.recordset.forEach((r, i) => console.log(`[${i}] ${JSON.stringify(r)}`));
  await pool.close();
})().catch(console.error);
