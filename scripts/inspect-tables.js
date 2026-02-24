const sql = require('mssql');

require('dotenv').config();
const strip = (v) => (v || '').replace(/^["']|["']$/g, '');
const HOST = strip(process.env.DB_HOST) || '172.18.1.153';
const USER = strip(process.env.DB_USER);
const PASS = strip(process.env.DB_PASSWORD);
const DB   = strip(process.env.DB_NAME);

// Try multiple TLS/encrypt combos — TLS mismatch shows as "Login failed" in tedious
const attempts = [
  {
    label: 'encrypt:true  + TLS min TLSv1  (old SQL Server)',
    cfg: { server: HOST, port: 1433, user: USER, password: PASS, database: DB, options: { encrypt: true,  trustServerCertificate: true, cryptoCredentialsDetails: { minVersion: 'TLSv1'  } } }
  },
  {
    label: 'encrypt:false + TLS min TLSv1',
    cfg: { server: HOST, port: 1433, user: USER, password: PASS, database: DB, options: { encrypt: false, trustServerCertificate: true, cryptoCredentialsDetails: { minVersion: 'TLSv1'  } } }
  },
  {
    label: 'encrypt:true  + TLS min TLSv1.2',
    cfg: { server: HOST, port: 1433, user: USER, password: PASS, database: DB, options: { encrypt: true,  trustServerCertificate: true, cryptoCredentialsDetails: { minVersion: 'TLSv1.2' } } }
  },
  {
    label: 'encrypt:false + no TLS override',
    cfg: { server: HOST, port: 1433, user: USER, password: PASS, database: DB, options: { encrypt: false, trustServerCertificate: true } }
  },
];

const tables = [
  { db: 'ncs-conv-aging', name: 'conv$vinpahistory',               label: 'OLD-1 (Multiple)' },
  { db: 'ncs-conv-aging', name: 'conv$vinpalrentalhistory',        label: 'OLD-2 (Multiple)' },
  { db: 'ncs-conv-aging', name: 'conv$vinpalrtrespasserhist',      label: 'OLD-3 (Multiple)' },
  { db: 'ncs-npl-aging',  name: 'la$lahistloantransactionhistory', label: 'NEW  (Multiple target)' },
  { db: 'ncs-conv-aging', name: 'conv$vinplhistory',               label: 'OLD  (Master)' },
  { db: 'ncs-npl-aging',  name: 'ln$lnhistloantransactionhistory', label: 'NEW  (Master target)' },
];

async function inspectTables(pool) {
  for (const t of tables) {
    const fullRef = `[${t.db}].dbo.[${t.name}]`;
    try {
      const colRes = await pool.request().query(`
        SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
        FROM [${t.db}].INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = '${t.name}'
        ORDER BY ORDINAL_POSITION
      `);
      const cntRes = await pool.request().query(`SELECT COUNT(*) as cnt FROM ${fullRef}`);
      const sampleRes = await pool.request().query(`SELECT TOP 2 * FROM ${fullRef}`);

      console.log(`\n${'='.repeat(70)}`);
      console.log(`${t.label}  |  ${fullRef}  |  rows: ${cntRes.recordset[0].cnt}`);
      console.log('─'.repeat(70));
      colRes.recordset.forEach(c => {
        console.log(`  ${String(c.COLUMN_NAME).padEnd(42)} ${String(c.DATA_TYPE).padEnd(15)} NULL:${c.IS_NULLABLE}`);
      });
      console.log('\n  Sample rows:');
      sampleRes.recordset.forEach((row, i) => {
        console.log(`  [${i}] ${JSON.stringify(row)}`);
      });
    } catch (e) {
      console.log(`  ERROR on ${fullRef}: ${e.message}`);
    }
  }
}

(async () => {
  for (const attempt of attempts) {
    console.log(`\nTrying: ${attempt.label}`);
    try {
      const pool = await sql.connect(attempt.cfg);
      console.log(`  ✓ Connected!`);
      await inspectTables(pool);
      await pool.close();
      break; // stop on first success
    } catch (e) {
      console.log(`  ✗ Failed: ${e.message.split('\n')[0]}`);
      sql.close(); // reset connection state
    }
  }
})();
