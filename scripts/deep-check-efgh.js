/**
 * Deep check — sections E, F, G, H only
 * (A-D already completed in deep-check-before-build.js)
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
const EXC_LIST = ['80000','81000','82100','90000','92090','99000',
                  '21300','21400','29300','29400','24100','25100',
                  '24200','25200','26100','26200'];
const EXC = EXC_LIST.map(v => `'${v}'`).join(',');

function section(title) {
  console.log(`\n${'='.repeat(60)}\n  ${title}\n${'='.repeat(60)}`);
}

(async () => {
  const pool = await sql.connect(config);

  // ================================================================
  // E. Yield/IRR columns — data presence
  // ================================================================
  section('E. Yield/IRR columns — data presence (P-prefix rows)');

  const yieldCheck = await pool.request().query(`
    SELECT
      SUM(CASE WHEN ABS(ISNULL(lvdebityieldamount,0)) > 0 THEN 1 ELSE 0 END)   AS debit_yield_nonzero,
      SUM(CASE WHEN ABS(ISNULL(lvcredityieldamount,0)) > 0 THEN 1 ELSE 0 END)  AS credit_yield_nonzero,
      SUM(CASE WHEN ABS(ISNULL(lvdebitirramount,0)) > 0 THEN 1 ELSE 0 END)     AS debit_irr_nonzero,
      SUM(CASE WHEN ABS(ISNULL(lvcreditirramount,0)) > 0 THEN 1 ELSE 0 END)    AS credit_irr_nonzero,
      COUNT(*) AS total_rows
    FROM ${NEW}.[lv$lvhisthsum]
    WHERE systemreferenceno LIKE 'P%'
  `);
  const yc = yieldCheck.recordset[0];
  console.log(`  P-prefix yield/irr fill: debit_yield=${yc.debit_yield_nonzero}/${yc.total_rows}, credit_yield=${yc.credit_yield_nonzero}/${yc.total_rows}, debit_irr=${yc.debit_irr_nonzero}/${yc.total_rows}, credit_irr=${yc.credit_irr_nonzero}/${yc.total_rows}`);

  // If yield has data, what affectcodes drive it
  if (Number(yc.debit_yield_nonzero) > 0 || Number(yc.credit_yield_nonzero) > 0) {
    const yieldSysrefs = await pool.request().query(`
      SELECT TOP 3 systemreferenceno, lvaccountno, lvdebityieldamount, lvcredityieldamount
      FROM ${NEW}.[lv$lvhisthsum]
      WHERE systemreferenceno LIKE 'P%' AND ABS(ISNULL(lvdebityieldamount,0)) > 0
    `);
    for (const yr of yieldSysrefs.recordset) {
      console.log(`\n  sysref=${yr.systemreferenceno} lvdebityield=${yr.lvdebityieldamount} lvcredityield=${yr.lvcredityieldamount}`);
      const oldRows = await pool.request().query(`
        SELECT affectcode, debitcredit, loantranshostcode,
               TRY_CAST(transactionamount AS decimal(20,4)) AS txamt
        FROM ${OLD}.[conv$vinpllvhistory]
        WHERE systemreferenceno = '${yr.systemreferenceno}'
        ORDER BY affectcode, debitcredit
      `);
      console.log(`  Old rows (${oldRows.recordset.length}):`);
      oldRows.recordset.forEach(r => console.log(`    ac=${r.affectcode} dc=${r.debitcredit} lthc=${r.loantranshostcode} amt=${r.txamt}`));
    }
  } else {
    console.log(`  Yield columns: ALL ZERO in P-prefix rows (no mapping needed)`);
  }

  if (Number(yc.debit_irr_nonzero) > 0 || Number(yc.credit_irr_nonzero) > 0) {
    const irrSysrefs = await pool.request().query(`
      SELECT TOP 3 systemreferenceno, lvaccountno, lvdebitirramount, lvcreditirramount
      FROM ${NEW}.[lv$lvhisthsum]
      WHERE systemreferenceno LIKE 'P%' AND ABS(ISNULL(lvdebitirramount,0)) > 0
    `);
    for (const ir of irrSysrefs.recordset) {
      console.log(`\n  sysref=${ir.systemreferenceno} lvdebitirr=${ir.lvdebitirramount} lvcreditirr=${ir.lvcreditirramount}`);
      const oldRows = await pool.request().query(`
        SELECT affectcode, debitcredit, loantranshostcode,
               TRY_CAST(transactionamount AS decimal(20,4)) AS txamt
        FROM ${OLD}.[conv$vinpllvhistory]
        WHERE systemreferenceno = '${ir.systemreferenceno}'
        ORDER BY affectcode, debitcredit
      `);
      console.log(`  Old rows (${oldRows.recordset.length}):`);
      oldRows.recordset.forEach(r => console.log(`    ac=${r.affectcode} dc=${r.debitcredit} lthc=${r.loantranshostcode} amt=${r.txamt}`));
    }
  } else {
    console.log(`  IRR columns: ALL ZERO in P-prefix rows (no mapping needed)`);
  }

  // ================================================================
  // F. cithistory consistency: one invaccountno → one newinvaccountno?
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
  const inconsistCount = citConsist.recordset[0].inconsistent_count;
  console.log(`\n  invaccountnos with >1 distinct newinvaccountno: ${inconsistCount}`);
  if (inconsistCount === 0) {
    console.log(`  CONFIRMED: one-to-one mapping — invaccountno always → same newinvaccountno`);
  } else {
    console.log(`  WARNING: ${inconsistCount} inconsistencies — need to investigate`);
    // Show top examples
    const examples = await pool.request().query(`
      SELECT TOP 5 invaccountno, COUNT(DISTINCT newinvaccountno) AS distinct_maps
      FROM ${OLD}.[conv$vinpllvcithistory]
      WHERE invaccountno != '' AND invaccountno IS NOT NULL
      GROUP BY invaccountno
      HAVING COUNT(DISTINCT newinvaccountno) > 1
      ORDER BY COUNT(DISTINCT newinvaccountno) DESC
    `);
    examples.recordset.forEach(r => console.log(`    invaccountno=${r.invaccountno} → ${r.distinct_maps} different newinvaccountnos`));
  }

  // ================================================================
  // G. ADC-prefix cardinality
  // ================================================================
  section('G. ADC-prefix sysrefs — cardinality check');

  const adcCard = await pool.request().query(`
    SELECT
      COUNT(DISTINCT systemreferenceno) AS total_sysrefs,
      COUNT(*) AS total_rows,
      MAX(cnt) AS max_rows_per_sysref,
      MIN(cnt) AS min_rows_per_sysref,
      AVG(CAST(cnt AS float)) AS avg_rows_per_sysref,
      SUM(CASE WHEN cnt = 1 THEN 1 ELSE 0 END) AS sysrefs_with_1_row,
      SUM(CASE WHEN cnt > 10 THEN 1 ELSE 0 END) AS sysrefs_with_many_rows
    FROM (
      SELECT systemreferenceno, COUNT(*) AS cnt
      FROM ${OLD}.[conv$vinpllvhistory]
      WHERE systemreferenceno LIKE 'ADC%'
      GROUP BY systemreferenceno
    ) x
  `);
  console.log(`\n  ADC sysref stats (vinpllvhistory):`);
  adcCard.recordset.forEach(r => console.log(`    ${JSON.stringify(r)}`));

  // Top 5 largest ADC sysrefs
  const adcTop = await pool.request().query(`
    SELECT TOP 5 systemreferenceno, COUNT(*) AS rows, COUNT(DISTINCT accountno) AS accounts
    FROM ${OLD}.[conv$vinpllvhistory]
    WHERE systemreferenceno LIKE 'ADC%'
    GROUP BY systemreferenceno
    ORDER BY COUNT(*) DESC
  `);
  console.log(`\n  Top 5 ADC sysrefs by row count:`);
  adcTop.recordset.forEach(r => console.log(`    ${r.systemreferenceno}: rows=${r.rows} accounts=${r.accounts}`));

  // Also check lvhisthsum for ADC
  const adcNew = await pool.request().query(`
    SELECT COUNT(*) AS rows, COUNT(DISTINCT systemreferenceno) AS sysrefs, COUNT(DISTINCT lvaccountno) AS accounts
    FROM ${NEW}.[lv$lvhisthsum]
    WHERE systemreferenceno LIKE 'ADC%'
  `);
  console.log(`\n  lvhisthsum ADC rows: ${JSON.stringify(adcNew.recordset[0])}`);

  // ================================================================
  // H. CE/RQ affectcode distribution in vinpllvhistory
  // ================================================================
  section('H. CE/RQ affectcodes in vinpllvhistory');

  const ceAffect = await pool.request().query(`
    SELECT affectcode, debitcredit,
           COUNT(*) AS rows,
           SUM(TRY_CAST(CASE WHEN transactionamount != '' THEN transactionamount ELSE '0' END AS decimal(20,4))) AS total_amt
    FROM ${OLD}.[conv$vinpllvhistory]
    WHERE systemreferenceno LIKE 'CE%' AND accountno != ''
    GROUP BY affectcode, debitcredit
    ORDER BY COUNT(*) DESC
  `);
  console.log(`\n  CE affectcode+dc breakdown:`);
  ceAffect.recordset.forEach(r =>
    console.log(`    ac=${String(r.affectcode||'NULL').padEnd(4)} dc=${String(r.debitcredit||'NULL').padEnd(3)} rows=${String(r.rows).padStart(8)} total=${r.total_amt}`)
  );

  const rqAffect = await pool.request().query(`
    SELECT affectcode, debitcredit,
           COUNT(*) AS rows,
           SUM(TRY_CAST(CASE WHEN transactionamount != '' THEN transactionamount ELSE '0' END AS decimal(20,4))) AS total_amt
    FROM ${OLD}.[conv$vinpllvhistory]
    WHERE systemreferenceno LIKE 'RQ%' AND accountno != ''
    GROUP BY affectcode, debitcredit
    ORDER BY COUNT(*) DESC
  `);
  console.log(`\n  RQ affectcode+dc breakdown:`);
  rqAffect.recordset.forEach(r =>
    console.log(`    ac=${String(r.affectcode||'NULL').padEnd(4)} dc=${String(r.debitcredit||'NULL').padEnd(3)} rows=${String(r.rows).padStart(8)} total=${r.total_amt}`)
  );

  // Also check IR-prefix affectcodes (to confirm they follow same pattern)
  const irAffect = await pool.request().query(`
    SELECT affectcode, debitcredit, COUNT(*) AS rows
    FROM ${OLD}.[conv$vinpllvhistory]
    WHERE systemreferenceno LIKE 'IR%' AND accountno != ''
    GROUP BY affectcode, debitcredit
    ORDER BY COUNT(*) DESC
  `);
  console.log(`\n  IR-prefix affectcode+dc breakdown (sysref-level, like P):`);
  irAffect.recordset.forEach(r =>
    console.log(`    ac=${String(r.affectcode||'NULL').padEnd(4)} dc=${String(r.debitcredit||'NULL').padEnd(3)} rows=${r.rows}`)
  );

  await pool.close();
  console.log('\nDone.');
})();
