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

  // ---- Get H-table column names ----
  console.log('\n=== H-table columns ===');
  const cols = await pool.request().query(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_CATALOG = 'ncs-npl-aging' AND TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME = 'ls$lshisthinvtransactionhistoryh'
    ORDER BY ORDINAL_POSITION
  `);
  const colNames = cols.recordset.map(r => r.COLUMN_NAME);
  console.log(colNames.join(', '));

  // ---- Which rows are in H-table? ----
  console.log('\n=== H-table rows (key columns only) ===');
  const h = await pool.request().query(`
    SELECT *
    FROM [ncs-npl-aging].dbo.[ls$lshisthinvtransactionhistoryh]
    WHERE systemreferenceno = '${SYSREF}'
  `);
  console.table(h.recordset);

  // ---- What old rows exist? ----
  console.log('\n=== Old rows (key columns only) ===');
  const old = await pool.request().query(`
    SELECT affectcode, debitcredit, loantransaction, transactionamount,
           lsformatcreditpp, laformatsumintpayment, lsformatbfaccint,
           lsformatdiffincome, laformatbfaccint, laformatcreditpp,
           laformatbfggpayment, laformatggpayment
    FROM [ncs-conv-aging].dbo.[conv$vinpainvesthist]
    WHERE systemreferencenumber = '${SYSREF}'
    ORDER BY affectcode, debitcredit
  `);
  console.table(old.recordset);

  // ---- Which affectcode combos are in old but NOT in H-table ----
  console.log('\n=== Missing in H-table (old affectcode not found in H) ===');
  const hAfCodes = h.recordset.map(r => r.affectcode);
  const oldAfCodes = old.recordset.map(r => `${r.affectcode}|${r.debitcredit}|${r.transactionamount}`);
  console.log('H-table affectcodes:', hAfCodes);
  console.log('Old affectcodes:', old.recordset.map(r => `${r.affectcode}(${r.debitcredit})`));

  // ---- Check if QQ exists in H-table at all (any sysref) ----
  console.log('\n=== QQ rows in H-table (any sysref) — top 5 ===');
  const qq = await pool.request().query(`
    SELECT TOP 5 affectcode, transactionamount, systemreferenceno
    FROM [ncs-npl-aging].dbo.[ls$lshisthinvtransactionhistoryh]
    WHERE affectcode = 'QQ'
  `);
  console.table(qq.recordset);
  console.log(`QQ rows in H-table: ${qq.recordset.length}`);

  // ---- Check lsformat*/laformat* cols that exist in H-table ----
  const formatCols = colNames.filter(c => c.startsWith('lsformat') || c.startsWith('laformat'));
  console.log('\n=== lsformat*/laformat* columns in H-table ===');
  console.log(formatCols.join(', '));
  console.log('\n=== Their values across the 3 H-table rows ===');
  for (const col of formatCols) {
    const vals = h.recordset.map(r => r[col]);
    const distinct = [...new Set(vals)];
    const allSame = distinct.length === 1;
    const nonZero = distinct.some(v => v !== 0 && v !== null);
    if (nonZero) console.log(`  ${col}: [${vals.join(', ')}]${allSame ? ' ← SAME ON ALL ROWS' : ' ← DIFFERENT'}`);
  }

  // ---- Sample: is QQ always absent? ----
  console.log('\n=== Sample: 10 sysrefs with QQ in old — do they appear in H-table? ===');
  const sampleQQ = await pool.request().query(`
    SELECT TOP 10 o.systemreferencenumber, o.affectcode, o.transactionamount,
           h.affectcode AS h_affectcode, h.transactionamount AS h_amount
    FROM [ncs-conv-aging].dbo.[conv$vinpainvesthist] o
    LEFT JOIN [ncs-npl-aging].dbo.[ls$lshisthinvtransactionhistoryh] h
      ON h.systemreferenceno = o.systemreferencenumber AND h.affectcode = o.affectcode
    WHERE o.affectcode = 'QQ'
  `);
  console.table(sampleQQ.recordset);

  await pool.close();
}

run().catch(console.error);
