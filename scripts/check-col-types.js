const sql = require('mssql');
const cfg = {
  server: '172.18.1.153', port: 1433,
  user: 'adinan.s', password: 'Adninp#555',
  options: { encrypt: false, trustServerCertificate: true },
  requestTimeout: 15000, connectionTimeout: 15000,
};

async function run() {
  const pool = await sql.connect(cfg);

  // Check column types for systemreferenceno in old table
  const r = await pool.request().query(`
    SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
    FROM [ncs-conv-aging].INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'conv$vinpllvhistory'
      AND COLUMN_NAME IN ('systemreferenceno', 'id', 'accountno')
    ORDER BY COLUMN_NAME
  `);
  console.log('\n=== conv$vinpllvhistory column types ===');
  console.table(r.recordset);

  await pool.close();
}
run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
