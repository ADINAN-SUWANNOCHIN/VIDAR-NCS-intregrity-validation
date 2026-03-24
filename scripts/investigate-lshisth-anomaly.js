const sql = require('mssql');

const cfg = {
  server: '172.18.1.153', port: 1433,
  user: 'adinan.s', password: 'Adninp#555',
  options: { encrypt: false, trustServerCertificate: true },
  requestTimeout: 120000, connectionTimeout: 30000,
};

const SYSREF = 'ITEM6307001488';

async function run() {
  const pool = await sql.connect(cfg);

  console.log(`\n=== Q1: ls$lshisthinvtransactionhistoryh (H-table / new) ===`);
  const q1 = await pool.request().query(`
    SELECT * FROM [ncs-npl-aging].dbo.[ls$lshisthinvtransactionhistoryh]
    WHERE systemreferenceno = '${SYSREF}'
  `);
  console.table(q1.recordset);
  console.log(`Rows: ${q1.recordset.length}`);

  console.log(`\n=== Q2: conv$vinpainvesthist (old / source) ===`);
  const q2 = await pool.request().query(`
    SELECT * FROM [ncs-conv-aging].dbo.[conv$vinpainvesthist]
    WHERE systemreferencenumber = '${SYSREF}'
  `);
  console.table(q2.recordset);
  console.log(`Rows: ${q2.recordset.length}`);

  console.log(`\n=== Q3: ls$lshistinvtransactionhistory (regular / new) ===`);
  const q3 = await pool.request().query(`
    SELECT * FROM [ncs-npl-aging].dbo.[ls$lshistinvtransactionhistory]
    WHERE systemreferenceno = '${SYSREF}'
  `);
  console.table(q3.recordset);
  console.log(`Rows: ${q3.recordset.length}`);

  // ---- Anomaly check: compare numeric columns across all rows ----
  console.log(`\n=== ANOMALY CHECK: numeric columns in H-table ===`);
  if (q1.recordset.length > 0) {
    const numericCols = Object.keys(q1.recordset[0]).filter(k => {
      const v = q1.recordset[0][k];
      return typeof v === 'number' || (typeof v === 'string' && !isNaN(parseFloat(v)));
    });
    console.log('Numeric columns:', numericCols);

    for (const col of numericCols) {
      const values = q1.recordset.map(r => parseFloat(r[col]) || 0);
      const allSame = values.every(v => v === values[0]);
      const anyNonZero = values.some(v => v !== 0);
      if (allSame && anyNonZero && q1.recordset.length > 1) {
        console.log(`  [SUSPECT] ${col}: all rows = ${values[0]} (same non-zero value repeated ${values.length}x)`);
      }
    }
  }

  // ---- Cross-check: old vs regular new vs H-table ----
  console.log(`\n=== CROSS-CHECK: row counts ===`);
  console.log(`  conv$vinpainvesthist (old):              ${q2.recordset.length} rows`);
  console.log(`  ls$lshistinvtransactionhistory (new):    ${q3.recordset.length} rows`);
  console.log(`  ls$lshisthinvtransactionhistoryh (H):    ${q1.recordset.length} rows`);

  await pool.close();
}

run().catch(console.error);
