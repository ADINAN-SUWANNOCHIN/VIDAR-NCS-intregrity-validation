const sql = require('mssql');

const cfg = {
  server: '172.18.1.153', port: 1433,
  user: 'adinan.s', password: 'Adninp#555',
  options: { encrypt: false, trustServerCertificate: true },
  requestTimeout: 120000, connectionTimeout: 30000,
};

async function run() {
  const pool = await sql.connect(cfg);

  // ---- Q1: how many P/ADC sysrefs exist in old table? ----
  const q1 = await pool.request().query(`
    SELECT COUNT(DISTINCT systemreferenceno) AS distinct_sysrefs,
           COUNT(*) AS total_rows
    FROM [ncs-conv-aging].dbo.[conv$vinpllvhistory]
    WHERE systemreferenceno LIKE 'P%' OR systemreferenceno LIKE 'ADC%'
  `);
  console.log('\n=== Q1: P/ADC sysref count in old table ===');
  console.table(q1.recordset);

  // ---- Q2: aggregate SUM comparison per affectcode (same logic as runAggregateSumCheck) ----
  // Shows which affectcodes have SUM mismatches between old and new
  const q2old = await pool.request().query(`
    SELECT affectcode,
           SUM(CAST(transactionamount AS DECIMAL(18,2))) AS old_sum
    FROM [ncs-conv-aging].dbo.[conv$vinpllvhistory]
    WHERE (systemreferenceno LIKE 'P%' OR systemreferenceno LIKE 'ADC%')
    GROUP BY affectcode
    ORDER BY affectcode
  `);
  const q2new = await pool.request().query(`
    SELECT affectcode,
           SUM(transactionamount) AS new_sum
    FROM [ncs-npl-aging].dbo.[lv$lvhisthsum]
    WHERE (systemreferenceno LIKE 'P%' OR systemreferenceno LIKE 'ADC%')
    GROUP BY affectcode
    ORDER BY affectcode
  `);

  // Cross-reference
  const oldMap = new Map(q2old.recordset.map(r => [r.affectcode, r.old_sum]));
  const newMap = new Map(q2new.recordset.map(r => [r.affectcode, r.new_sum]));
  const allCodes = new Set([...oldMap.keys(), ...newMap.keys()]);

  console.log('\n=== Q2: aggregate SUM comparison per affectcode ===');
  const rows = [];
  for (const code of [...allCodes].sort()) {
    const oldVal = oldMap.get(code) ?? 0;
    const newVal = newMap.get(code) ?? 0;
    const diff = Math.abs(oldVal - newVal);
    rows.push({ affectcode: code, old_sum: oldVal, new_sum: newVal, diff: diff.toFixed(2), match: diff <= 0.01 ? 'OK' : 'MISMATCH' });
  }
  console.table(rows);

  await pool.close();
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
