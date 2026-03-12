/**
 * Deep check — sections F, G, H (no per-row loops, pure aggregation)
 */
const sql = require('mssql');
require('dotenv').config();
const strip = (v) => (v || '').replace(/^["']|["']$/g, '');

const config = {
  server: strip(process.env.DB_HOST), port: 1433,
  user: strip(process.env.DB_USER), password: strip(process.env.DB_PASSWORD),
  database: strip(process.env.DB_NAME),
  options: { encrypt: true, trustServerCertificate: true, cryptoCredentialsDetails: { minVersion: 'TLSv1' } },
  requestTimeout: 120000,
};

const OLD = '[ncs-conv-aging].dbo';
const NEW = '[ncs-npl-aging].dbo';

function section(title) {
  console.log(`\n${'='.repeat(60)}\n  ${title}\n${'='.repeat(60)}`);
}

(async () => {
  const pool = await sql.connect(config);

  // ================================================================
  // F. cithistory consistency
  // ================================================================
  section('F. cithistory invaccountno consistency');

  const citConsist = await pool.request().query(`
    SELECT COUNT(*) AS inconsistent_count
    FROM (
      SELECT invaccountno
      FROM ${OLD}.[conv$vinpllvcithistory]
      WHERE invaccountno != '' AND invaccountno IS NOT NULL
      GROUP BY invaccountno
      HAVING COUNT(DISTINCT newinvaccountno) > 1
    ) x
  `);
  const cnt = citConsist.recordset[0].inconsistent_count;
  console.log(`\n  invaccountnos with >1 distinct newinvaccountno: ${cnt}`);
  if (cnt === 0) {
    console.log(`  CONFIRMED: one-to-one mapping — safe to use invaccountno-only lookup`);
  } else {
    console.log(`  WARNING: inconsistencies exist`);
    const ex = await pool.request().query(`
      SELECT TOP 5 invaccountno, COUNT(DISTINCT newinvaccountno) AS maps,
             MIN(newinvaccountno) AS map1, MAX(newinvaccountno) AS map2
      FROM ${OLD}.[conv$vinpllvcithistory]
      WHERE invaccountno != '' AND invaccountno IS NOT NULL
      GROUP BY invaccountno
      HAVING COUNT(DISTINCT newinvaccountno) > 1
      ORDER BY COUNT(DISTINCT newinvaccountno) DESC
    `);
    ex.recordset.forEach(r => console.log(`    invaccountno=${r.invaccountno}: map1=${r.map1} map2=${r.map2}`));
  }

  // ================================================================
  // G. ADC-prefix cardinality
  // ================================================================
  section('G. ADC-prefix sysrefs — cardinality');

  const adcStats = await pool.request().query(`
    SELECT
      COUNT(DISTINCT systemreferenceno) AS total_sysrefs,
      COUNT(*) AS total_rows,
      MAX(cnt) AS max_rows_per_sysref,
      MIN(cnt) AS min_rows_per_sysref,
      AVG(CAST(cnt AS float)) AS avg_rows_per_sysref,
      SUM(CASE WHEN cnt = 1 THEN 1 ELSE 0 END) AS sysrefs_with_1row,
      SUM(CASE WHEN cnt > 10 THEN 1 ELSE 0 END) AS sysrefs_with_many_rows
    FROM (
      SELECT systemreferenceno, COUNT(*) AS cnt
      FROM ${OLD}.[conv$vinpllvhistory]
      WHERE systemreferenceno LIKE 'ADC%'
      GROUP BY systemreferenceno
    ) x
  `);
  console.log(`  vinpllvhistory ADC stats: ${JSON.stringify(adcStats.recordset[0])}`);

  const adcTop = await pool.request().query(`
    SELECT TOP 5 systemreferenceno, COUNT(*) AS rows, COUNT(DISTINCT accountno) AS accounts
    FROM ${OLD}.[conv$vinpllvhistory]
    WHERE systemreferenceno LIKE 'ADC%'
    GROUP BY systemreferenceno
    ORDER BY COUNT(*) DESC
  `);
  console.log(`\n  Top 5 ADC sysrefs by row count:`);
  adcTop.recordset.forEach(r => console.log(`    ${r.systemreferenceno}: rows=${r.rows} accounts=${r.accounts}`));

  const adcNew = await pool.request().query(`
    SELECT COUNT(*) AS rows, COUNT(DISTINCT systemreferenceno) AS sysrefs, COUNT(DISTINCT lvaccountno) AS accounts
    FROM ${NEW}.[lv$lvhisthsum]
    WHERE systemreferenceno LIKE 'ADC%'
  `);
  console.log(`\n  lvhisthsum ADC: ${JSON.stringify(adcNew.recordset[0])}`);

  // ================================================================
  // H. CE/RQ/IR affectcode distribution
  // ================================================================
  section('H. CE/RQ/IR affectcodes in vinpllvhistory');

  const ceAffect = await pool.request().query(`
    SELECT affectcode, debitcredit, COUNT(*) AS rows
    FROM ${OLD}.[conv$vinpllvhistory]
    WHERE systemreferenceno LIKE 'CE%' AND accountno != ''
    GROUP BY affectcode, debitcredit
    ORDER BY COUNT(*) DESC
  `);
  console.log(`\n  CE affectcode+dc:`);
  ceAffect.recordset.forEach(r => console.log(`    ac=${String(r.affectcode||'NULL').padEnd(4)} dc=${String(r.debitcredit||'NULL').padEnd(3)} rows=${r.rows}`));

  const rqAffect = await pool.request().query(`
    SELECT affectcode, debitcredit, COUNT(*) AS rows
    FROM ${OLD}.[conv$vinpllvhistory]
    WHERE systemreferenceno LIKE 'RQ%' AND accountno != ''
    GROUP BY affectcode, debitcredit
    ORDER BY COUNT(*) DESC
  `);
  console.log(`\n  RQ affectcode+dc:`);
  rqAffect.recordset.forEach(r => console.log(`    ac=${String(r.affectcode||'NULL').padEnd(4)} dc=${String(r.debitcredit||'NULL').padEnd(3)} rows=${r.rows}`));

  const irAffect = await pool.request().query(`
    SELECT affectcode, debitcredit, COUNT(*) AS rows
    FROM ${OLD}.[conv$vinpllvhistory]
    WHERE systemreferenceno LIKE 'IR%' AND accountno != ''
    GROUP BY affectcode, debitcredit
    ORDER BY COUNT(*) DESC
  `);
  console.log(`\n  IR-prefix affectcode+dc:`);
  irAffect.recordset.forEach(r => console.log(`    ac=${String(r.affectcode||'NULL').padEnd(4)} dc=${String(r.debitcredit||'NULL').padEnd(3)} rows=${r.rows}`));

  // ================================================================
  // EXTRA: What affectcodes go to yield vs irr columns?
  //   From section E: I2/lthc=25100 → yield, I3/lthc=25200 → irr
  //   Verify: lthc 25100 and 25200 are in exclusion list → would be excluded
  // ================================================================
  section('E-extra: lthc 25100 / 25200 in exclusion list?');
  const excList = ['80000','81000','82100','90000','92090','99000','21300','21400','29300','29400','24100','25100','24200','25200','26100','26200'];
  console.log(`  lthc=25100 in exclusion list: ${excList.includes('25100')} (if true → I2 rows excluded from interest sum → goes to yield column instead)`);
  console.log(`  lthc=25200 in exclusion list: ${excList.includes('25200')} (if true → I3 rows excluded from interest sum → goes to irr column instead)`);
  console.log(`  lthc=24100 in exclusion list: ${excList.includes('24100')}`);
  console.log(`  lthc=24200 in exclusion list: ${excList.includes('24200')}`);

  // So yield = I2/D/lthc=25100 (excluded from regular interest → separate column)
  // Verify: for P6002-007421 (I2/D/25100 = 61649.44), does SUM(I2/D NOT IN excl) = 0 and yield = 61649.44?
  const yieldVerify = await pool.request().query(`
    SELECT
      SUM(CASE WHEN affectcode = 'I2' AND debitcredit = 'D' THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS i2_total,
      SUM(CASE WHEN affectcode = 'I2' AND debitcredit = 'D' AND loantranshostcode NOT IN ('80000','81000','82100','90000','92090','99000','21300','21400','29300','29400','24100','25100','24200','25200','26100','26200') THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS i2_not_excl,
      SUM(CASE WHEN affectcode = 'I2' AND debitcredit = 'D' AND loantranshostcode IN ('25100') THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS i2_lthc25100
    FROM ${OLD}.[conv$vinpllvhistory]
    WHERE systemreferenceno = 'P6002-007421'
  `);
  console.log(`\n  P6002-007421 I2/D verification:`);
  yieldVerify.recordset.forEach(r => console.log(`    i2_total=${r.i2_total}  i2_not_excl(regular interest)=${r.i2_not_excl}  i2_lthc25100(yield)=${r.i2_lthc25100}`));
  console.log(`  Expected: lvdebityieldamount=61649.44`);
  console.log(`  Conclusion: yield = SUM(I2/D WHERE lthc=25100) — but 25100 IS in excl list, so regular interest formula gives 0 for this row`);
  console.log(`  This means yield/irr use a DIFFERENT lthc filter — probably lthc IN specific set rather than NOT IN excl`);

  await pool.close();
  console.log('\nDone.');
})();
