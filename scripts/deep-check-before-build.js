/**
 * DEEP CHECK BEFORE BUILD
 *
 * Verifies ALL assumptions before writing engine code for composite-key CE/RQ support:
 *
 * A. RQ11-113-000001 open TODO: lvdebitotherchargeamount (expected=2500, OF/D, lthc=43100)
 *    - Is lthc=43100 in exclusion list? (expected: NO — so should be included in sum)
 *    - Does old sum match new value?
 *
 * B. RQ short-format: invaccountno-only cithistory lookup reliability
 *    - Find all RQ sysrefs where cithistory has NO row for that sysref
 *    - Verify invaccountno-only lookup still finds the mapping
 *    - Confirm formula gives correct values
 *
 * C. Non-P/ADC prefix distribution in lvhisthsum
 *    - What prefixes exist and how many rows?
 *    - Which ones follow CE/RQ composite-key pattern?
 *
 * D. lvformat* formula re-verify (fresh sample)
 *    - Pick 5 random lvhisthsum rows, confirm lvformat* = lvdebit* - lvcredit*
 *
 * E. lvcredityieldamount / lvdebitirramount etc. — do they also follow filtered_sum?
 *    - Check if these have data, what affectcodes map to them
 *
 * F. cithistory invaccountno consistency check
 *    - Does one invaccountno always → same newinvaccountno regardless of sysref? (critical assumption)
 *
 * G. ADC-prefix sysrefs: are they really P-like (individual account, sysref-groupable)?
 *    - Quick cardinality check for ADC sysrefs
 *
 * H. lvhisthsum YI/IR affectcodes
 *    - Check if lvdebityieldamount/lvcredityieldamount/lvdebitirramount/lvcreditirramount have data in P rows
 *    - If yes, what affectcodes drive them?
 */

const sql = require('mssql');
require('dotenv').config();
const strip = (v) => (v || '').replace(/^["']|["']$/g, '');

const config = {
  server: strip(process.env.DB_HOST), port: 1433,
  user: strip(process.env.DB_USER), password: strip(process.env.DB_PASSWORD),
  database: strip(process.env.DB_NAME),
  options: { encrypt: true, trustServerCertificate: true, cryptoCredentialsDetails: { minVersion: 'TLSv1' } },
  requestTimeout: 300000,
};

const OLD = '[ncs-conv-aging].dbo';
const NEW = '[ncs-npl-aging].dbo';

const EXC_LIST = ['80000','81000','82100','90000','92090','99000',
                  '21300','21400','29300','29400','24100','25100',
                  '24200','25200','26100','26200'];
const EXC = EXC_LIST.map(v => `'${v}'`).join(',');

const TOL = 0.01;

function section(title) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

(async () => {
  const pool = await sql.connect(config);

  // ================================================================
  // A. RQ11-113-000001 open TODO
  // ================================================================
  section('A. RQ11-113-000001 — lvdebitotherchargeamount check');

  const rqSysref = 'RQ11-113-000001';

  // A1: check lthc=43100 in exclusion list?
  const inExcList = EXC_LIST.includes('43100');
  console.log(`  lthc=43100 in exclusion list? ${inExcList} (expected: false → should be INCLUDED in sum)`);

  // A2: pull raw vinpllvhistory rows for this sysref
  const rqRawOld = await pool.request().query(`
    SELECT accountno, affectcode, debitcredit, loantranshostcode,
           TRY_CAST(transactionamount AS decimal(20,4)) AS txamt
    FROM ${OLD}.[conv$vinpllvhistory]
    WHERE systemreferenceno = '${rqSysref}'
    ORDER BY accountno, id
  `);
  console.log(`\n  vinpllvhistory rows for ${rqSysref}: ${rqRawOld.recordset.length}`);
  rqRawOld.recordset.forEach(r => console.log(`    accountno=${r.accountno} ac=${r.affectcode} dc=${r.debitcredit} lthc=${r.loantranshostcode} txamt=${r.txamt}`));

  // A3: compute expected OF/D sum per accountno
  const ofDRows = rqRawOld.recordset.filter(r =>
    ['OF','CF'].includes(r.affectcode) && r.debitcredit === 'D' && !EXC_LIST.includes(String(r.loantranshostcode))
  );
  const ofDSum = ofDRows.reduce((s, r) => s + Number(r.txamt || 0), 0);
  console.log(`\n  Expected lvdebitotherchargeamount (OF+CF/D, lthc not in excl): ${ofDSum}`);
  console.log(`  OF/D contributing rows:`);
  ofDRows.forEach(r => console.log(`    accountno=${r.accountno} lthc=${r.loantranshostcode} txamt=${r.txamt}`));

  // A4: cithistory lookup — invaccountno only (no sysref filter)
  const rqAccounts = [...new Set(rqRawOld.recordset.map(r => r.accountno).filter(Boolean))];
  console.log(`\n  Distinct accountnos in vinpllvhistory: ${JSON.stringify(rqAccounts)}`);

  for (const acct of rqAccounts) {
    // Try sysref-based lookup first
    const citBySysref = await pool.request().query(`
      SELECT TOP 3 invaccountno, newinvaccountno, systemreferenceno
      FROM ${OLD}.[conv$vinpllvcithistory]
      WHERE systemreferenceno = '${rqSysref}' AND invaccountno = '${acct}'
    `);
    console.log(`\n  cithistory sysref-based (${rqSysref} + ${acct}): ${citBySysref.recordset.length} rows`);
    citBySysref.recordset.forEach(r => console.log(`    ${JSON.stringify(r)}`));

    // invaccountno-only lookup
    const citByAcct = await pool.request().query(`
      SELECT TOP 3 invaccountno, newinvaccountno, systemreferenceno
      FROM ${OLD}.[conv$vinpllvcithistory]
      WHERE invaccountno = '${acct}'
    `);
    console.log(`  cithistory acct-only (${acct}): ${citByAcct.recordset.length} rows`);
    citByAcct.recordset.forEach(r => console.log(`    ${JSON.stringify(r)}`));

    if (citByAcct.recordset.length > 0) {
      const newinv = citByAcct.recordset[0].newinvaccountno;
      // Check lvhisthsum for this sysref + newinvaccountno
      const newRow = await pool.request().query(`
        SELECT lvaccountno, lvcreditotherchargeamount, lvdebitotherchargeamount,
               lvcreditprincipleamount, lvdebitprincipleamount,
               lvcreditinterestamount, lvdebitinterestamount
        FROM ${NEW}.[lv$lvhisthsum]
        WHERE systemreferenceno = '${rqSysref}' AND lvaccountno = '${newinv}'
      `);
      console.log(`  lvhisthsum (${rqSysref} + ${newinv}): ${newRow.recordset.length} rows`);
      newRow.recordset.forEach(r => console.log(`    ${JSON.stringify(r)}`));
    }
  }

  // ================================================================
  // B. RQ short-format reliability: find more RQ sysrefs with no cithistory match by sysref
  // ================================================================
  section('B. RQ short-format: invaccountno-only lookup reliability');

  // Find RQ sysrefs where cithistory has 0 rows for that sysref (short-format)
  const rqNoCtit = await pool.request().query(`
    SELECT TOP 10 v.systemreferenceno, COUNT(DISTINCT v.accountno) AS accts,
           MIN(c.invaccountno) AS cit_found
    FROM ${OLD}.[conv$vinpllvhistory] v
    LEFT JOIN ${OLD}.[conv$vinpllvcithistory] c
      ON c.systemreferenceno = v.systemreferenceno
    WHERE v.systemreferenceno LIKE 'RQ%'
      AND v.accountno != ''
    GROUP BY v.systemreferenceno
    HAVING MIN(c.invaccountno) IS NULL
    ORDER BY COUNT(DISTINCT v.accountno) ASC
  `);
  console.log(`\n  RQ sysrefs with 0 cithistory rows by sysref (short-format): ${rqNoCtit.recordset.length}`);
  rqNoCtit.recordset.forEach(r => console.log(`    sysref=${r.systemreferenceno} accts=${r.accts}`));

  // For first 3, check if invaccountno-only lookup works
  for (const row of rqNoCtit.recordset.slice(0, 3)) {
    const sref = row.systemreferenceno;
    // Get accountnos from vinpllvhistory
    const accounts = await pool.request().query(`
      SELECT DISTINCT accountno FROM ${OLD}.[conv$vinpllvhistory]
      WHERE systemreferenceno = '${sref}' AND accountno != ''
    `);
    let allFound = 0, notFound = 0;
    for (const a of accounts.recordset) {
      const cit = await pool.request().query(`
        SELECT TOP 1 newinvaccountno FROM ${OLD}.[conv$vinpllvcithistory]
        WHERE invaccountno = '${a.accountno}'
      `);
      if (cit.recordset.length > 0) allFound++; else notFound++;
    }
    console.log(`\n  [${sref}] accts=${accounts.recordset.length}: found_in_cit=${allFound} not_found=${notFound}`);
  }

  // RQ sysrefs WITH cithistory rows by sysref (long-format)
  const rqWithCit = await pool.request().query(`
    SELECT TOP 5 v.systemreferenceno, COUNT(DISTINCT v.accountno) AS accts
    FROM ${OLD}.[conv$vinpllvhistory] v
    INNER JOIN ${OLD}.[conv$vinpllvcithistory] c
      ON c.systemreferenceno = v.systemreferenceno
    WHERE v.systemreferenceno LIKE 'RQ%'
      AND v.accountno != ''
    GROUP BY v.systemreferenceno
    ORDER BY COUNT(DISTINCT v.accountno) ASC
  `);
  console.log(`\n  RQ sysrefs WITH cithistory rows by sysref (long-format, first 5): ${rqWithCit.recordset.length}`);
  rqWithCit.recordset.forEach(r => console.log(`    sysref=${r.systemreferenceno} accts=${r.accts}`));

  // ================================================================
  // C. Non-P/ADC prefix distribution in lvhisthsum
  // ================================================================
  section('C. Non-P/ADC prefix distribution in lvhisthsum');

  const prefixDist = await pool.request().query(`
    SELECT LEFT(systemreferenceno, CHARINDEX('-', systemreferenceno + '-') - 1) AS prefix,
           COUNT(*) AS rows,
           COUNT(DISTINCT systemreferenceno) AS sysrefs,
           COUNT(DISTINCT lvaccountno) AS accounts
    FROM ${NEW}.[lv$lvhisthsum]
    WHERE systemreferenceno NOT LIKE 'P%' AND systemreferenceno NOT LIKE 'ADC%'
    GROUP BY LEFT(systemreferenceno, CHARINDEX('-', systemreferenceno + '-') - 1)
    ORDER BY COUNT(*) DESC
  `);
  console.log(`\n  Non-P/ADC prefixes in lvhisthsum:`);
  prefixDist.recordset.forEach(r => console.log(`    prefix=${r.prefix.padEnd(8)} rows=${String(r.rows).padStart(9)} sysrefs=${String(r.sysrefs).padStart(7)} accounts=${r.accounts}`));

  // Also check if vinpllvhistory has rows for these prefixes
  const prefixesInOld = await pool.request().query(`
    SELECT LEFT(systemreferenceno, CHARINDEX('-', systemreferenceno + '-') - 1) AS prefix,
           COUNT(*) AS rows
    FROM ${OLD}.[conv$vinpllvhistory]
    WHERE systemreferenceno NOT LIKE 'P%' AND systemreferenceno NOT LIKE 'ADC%'
    GROUP BY LEFT(systemreferenceno, CHARINDEX('-', systemreferenceno + '-') - 1)
    ORDER BY COUNT(*) DESC
  `);
  console.log(`\n  Non-P/ADC prefixes in vinpllvhistory:`);
  prefixesInOld.recordset.forEach(r => console.log(`    prefix=${r.prefix.padEnd(8)} rows=${r.rows}`));

  // ================================================================
  // D. lvformat* formula re-verify on fresh sample
  // ================================================================
  section('D. lvformat* formula re-verify (5 random rows)');

  const lvfmtSample = await pool.request().query(`
    SELECT TOP 5 systemreferenceno, lvaccountno,
           lvcreditprincipleamount,   lvdebitprincipleamount,   lvformatprincipleamount,
           lvcreditinterestamount,    lvdebitinterestamount,    lvformatinterestamount,
           lvcreditgaincash,          lvdebitgaincash,          lvformatgaincash,
           lvcreditgainsettlement,    lvdebitgainsettlement,    lvformatgainsettlement,
           lvcreditotherchargeamount, lvdebitotherchargeamount, lvformatotherchargeamount,
           lvformattotalgain
    FROM ${NEW}.[lv$lvhisthsum]
    WHERE systemreferenceno LIKE 'P%'
      AND (lvdebitprincipleamount != 0 OR lvdebitinterestamount != 0)
    ORDER BY NEWID()
  `);

  let fmtAllOk = true;
  for (const r of lvfmtSample.recordset) {
    const checks = [
      ['lvformatprincipleamount',   r.lvdebitprincipleamount   - r.lvcreditprincipleamount,   r.lvformatprincipleamount],
      ['lvformatinterestamount',    r.lvdebitinterestamount    - r.lvcreditinterestamount,    r.lvformatinterestamount],
      ['lvformatgaincash',          r.lvdebitgaincash          - r.lvcreditgaincash,          r.lvformatgaincash],
      ['lvformatgainsettlement',    r.lvdebitgainsettlement    - r.lvcreditgainsettlement,    r.lvformatgainsettlement],
      ['lvformatotherchargeamount', r.lvdebitotherchargeamount - r.lvcreditotherchargeamount, r.lvformatotherchargeamount],
      ['lvformattotalgain',         (r.lvformatgaincash||0)   + (r.lvformatgainsettlement||0), r.lvformattotalgain],
    ];
    const mismatches = checks.filter(([, expected, actual]) => Math.abs(Number(expected||0) - Number(actual||0)) > TOL);
    const status = mismatches.length === 0 ? 'PASS' : 'FAIL';
    console.log(`\n  [${status}] sysref=${r.systemreferenceno} acct=${r.lvaccountno}`);
    if (mismatches.length > 0) {
      fmtAllOk = false;
      mismatches.forEach(([col, exp, act]) => console.log(`    ${col}: expected=${exp} actual=${act}`));
    }
  }
  console.log(`\n  lvformat* formula: ${fmtAllOk ? 'CONFIRMED OK' : 'MISMATCH FOUND'}`);

  // ================================================================
  // E. YI/IR columns — do they have data, what affectcodes drive them?
  // ================================================================
  section('E. Yield/IRR columns — data presence and affectcodes');

  // Check if lvdebityieldamount / lvcredityieldamount have non-zero values
  const yieldCheck = await pool.request().query(`
    SELECT
      SUM(CASE WHEN ABS(ISNULL(lvdebityieldamount,0)) > 0 THEN 1 ELSE 0 END) AS debit_yield_nonzero,
      SUM(CASE WHEN ABS(ISNULL(lvcredityieldamount,0)) > 0 THEN 1 ELSE 0 END) AS credit_yield_nonzero,
      SUM(CASE WHEN ABS(ISNULL(lvdebitirramount,0)) > 0 THEN 1 ELSE 0 END) AS debit_irr_nonzero,
      SUM(CASE WHEN ABS(ISNULL(lvcreditirramount,0)) > 0 THEN 1 ELSE 0 END) AS credit_irr_nonzero,
      COUNT(*) AS total_rows
    FROM ${NEW}.[lv$lvhisthsum]
    WHERE systemreferenceno LIKE 'P%'
  `);
  console.log(`\n  P-prefix yield/irr column fill (lvhisthsum):`);
  yieldCheck.recordset.forEach(r => console.log(`    ${JSON.stringify(r)}`));

  // If they have data, find what affectcodes in vinpllvhistory might drive them
  const yc = yieldCheck.recordset[0];
  if (Number(yc.debit_yield_nonzero) > 0 || Number(yc.credit_yield_nonzero) > 0) {
    console.log(`\n  Yield columns have data — checking which affectcodes exist in vinpllvhistory...`);
    // Find sysrefs where lvdebityieldamount != 0
    const yieldSysrefs = await pool.request().query(`
      SELECT TOP 3 systemreferenceno, lvaccountno, lvdebityieldamount, lvcredityieldamount
      FROM ${NEW}.[lv$lvhisthsum]
      WHERE systemreferenceno LIKE 'P%'
        AND ABS(ISNULL(lvdebityieldamount,0)) > 0
    `);
    for (const yr of yieldSysrefs.recordset) {
      const oldRows = await pool.request().query(`
        SELECT affectcode, debitcredit, loantranshostcode,
               TRY_CAST(transactionamount AS decimal(20,4)) AS txamt
        FROM ${OLD}.[conv$vinpllvhistory]
        WHERE systemreferenceno = '${yr.systemreferenceno}'
        ORDER BY affectcode, debitcredit
      `);
      console.log(`\n  sysref=${yr.systemreferenceno} lvdebityield=${yr.lvdebityieldamount} lvcredityield=${yr.lvcredityieldamount}`);
      console.log(`  Old rows (${oldRows.recordset.length}):`);
      oldRows.recordset.forEach(r => console.log(`    ac=${r.affectcode} dc=${r.debitcredit} lthc=${r.loantranshostcode} amt=${r.txamt}`));
    }
  }

  if (Number(yc.debit_irr_nonzero) > 0 || Number(yc.credit_irr_nonzero) > 0) {
    console.log(`\n  IRR columns have data — spot checking...`);
    const irrSysrefs = await pool.request().query(`
      SELECT TOP 3 systemreferenceno, lvaccountno, lvdebitirramount, lvcreditirramount
      FROM ${NEW}.[lv$lvhisthsum]
      WHERE systemreferenceno LIKE 'P%'
        AND ABS(ISNULL(lvdebitirramount,0)) > 0
    `);
    for (const ir of irrSysrefs.recordset) {
      const oldRows = await pool.request().query(`
        SELECT affectcode, debitcredit, loantranshostcode,
               TRY_CAST(transactionamount AS decimal(20,4)) AS txamt
        FROM ${OLD}.[conv$vinpllvhistory]
        WHERE systemreferenceno = '${ir.systemreferenceno}'
        ORDER BY affectcode, debitcredit
      `);
      console.log(`\n  sysref=${ir.systemreferenceno} lvdebitirr=${ir.lvdebitirramount} lvcreditirr=${ir.lvcreditirramount}`);
      console.log(`  Old rows (${oldRows.recordset.length}):`);
      oldRows.recordset.forEach(r => console.log(`    ac=${r.affectcode} dc=${r.debitcredit} lthc=${r.loantranshostcode} amt=${r.txamt}`));
    }
  }

  // ================================================================
  // F. cithistory invaccountno consistency: does one invaccountno always → same newinvaccountno?
  // ================================================================
  section('F. cithistory invaccountno → newinvaccountno consistency');

  const citConsist = await pool.request().query(`
    SELECT invaccountno, COUNT(DISTINCT newinvaccountno) AS distinct_mappings
    FROM ${OLD}.[conv$vinpllvcithistory]
    WHERE invaccountno != '' AND invaccountno IS NOT NULL
    GROUP BY invaccountno
    HAVING COUNT(DISTINCT newinvaccountno) > 1
    ORDER BY COUNT(DISTINCT newinvaccountno) DESC
  `);
  console.log(`\n  invaccountnos with MORE THAN 1 distinct newinvaccountno: ${citConsist.recordset.length}`);
  if (citConsist.recordset.length === 0) {
    console.log(`  CONFIRMED: one invaccountno always maps to exactly one newinvaccountno`);
  } else {
    console.log(`  WARNING: inconsistent mappings found:`);
    citConsist.recordset.slice(0, 10).forEach(r =>
      console.log(`    invaccountno=${r.invaccountno} → ${r.distinct_mappings} different newinvaccountnos`)
    );
    // Show examples
    for (const c of citConsist.recordset.slice(0, 2)) {
      const ex = await pool.request().query(`
        SELECT DISTINCT invaccountno, newinvaccountno, systemreferenceno
        FROM ${OLD}.[conv$vinpllvcithistory]
        WHERE invaccountno = '${c.invaccountno}'
        ORDER BY systemreferenceno
      `);
      console.log(`\n  invaccountno=${c.invaccountno} maps to:`);
      ex.recordset.forEach(r => console.log(`    newinvaccountno=${r.newinvaccountno}  sysref=${r.systemreferenceno}`));
    }
  }

  // ================================================================
  // G. ADC-prefix sysrefs: individual or batch?
  // ================================================================
  section('G. ADC-prefix sysrefs — cardinality check');

  const adcCard = await pool.request().query(`
    SELECT TOP 10 systemreferenceno,
           COUNT(*) AS total_rows,
           COUNT(DISTINCT accountno) AS distinct_accounts
    FROM ${OLD}.[conv$vinpllvhistory]
    WHERE systemreferenceno LIKE 'ADC%'
    GROUP BY systemreferenceno
    ORDER BY COUNT(*) DESC
  `);
  console.log(`\n  ADC sysrefs (top 10 by row count):`);
  adcCard.recordset.forEach(r => console.log(`    sysref=${r.systemreferenceno} rows=${r.total_rows} distinct_accts=${r.distinct_accounts}`));

  const adcTotal = await pool.request().query(`
    SELECT COUNT(DISTINCT systemreferenceno) AS sysref_count,
           COUNT(*) AS total_rows,
           MAX(cnt) AS max_rows_per_sysref,
           AVG(CAST(cnt AS float)) AS avg_rows_per_sysref
    FROM (
      SELECT systemreferenceno, COUNT(*) AS cnt
      FROM ${OLD}.[conv$vinpllvhistory]
      WHERE systemreferenceno LIKE 'ADC%'
      GROUP BY systemreferenceno
    ) x
  `);
  console.log(`\n  ADC summary:`);
  adcTotal.recordset.forEach(r => console.log(`    ${JSON.stringify(r)}`));

  // ================================================================
  // H. What affectcodes appear in vinpllvhistory for CE rows?
  //    Confirms no hidden affectcodes beyond what filtered_sum_matches covers
  // ================================================================
  section('H. CE/RQ affectcode distribution in vinpllvhistory');

  const ceAffect = await pool.request().query(`
    SELECT affectcode, debitcredit,
           COUNT(*) AS rows,
           SUM(TRY_CAST(transactionamount AS decimal(20,4))) AS total_amt
    FROM ${OLD}.[conv$vinpllvhistory]
    WHERE systemreferenceno LIKE 'CE%'
      AND accountno != ''
    GROUP BY affectcode, debitcredit
    ORDER BY COUNT(*) DESC
  `);
  console.log(`\n  CE affectcode+debitcredit breakdown (vinpllvhistory):`);
  ceAffect.recordset.forEach(r => console.log(`    ac=${String(r.affectcode||'NULL').padEnd(4)} dc=${String(r.debitcredit||'NULL').padEnd(3)} rows=${String(r.rows).padStart(8)} total_amt=${r.total_amt}`));

  const rqAffect = await pool.request().query(`
    SELECT affectcode, debitcredit,
           COUNT(*) AS rows,
           SUM(TRY_CAST(transactionamount AS decimal(20,4))) AS total_amt
    FROM ${OLD}.[conv$vinpllvhistory]
    WHERE systemreferenceno LIKE 'RQ%'
      AND accountno != ''
    GROUP BY affectcode, debitcredit
    ORDER BY COUNT(*) DESC
  `);
  console.log(`\n  RQ affectcode+debitcredit breakdown (vinpllvhistory):`);
  rqAffect.recordset.forEach(r => console.log(`    ac=${String(r.affectcode||'NULL').padEnd(4)} dc=${String(r.debitcredit||'NULL').padEnd(3)} rows=${String(r.rows).padStart(8)} total_amt=${r.total_amt}`));

  // ================================================================
  // SUMMARY
  // ================================================================
  section('SUMMARY');
  console.log(`
  When this script completes, review:
  A — RQ11-113-000001: does old OF/D sum (lthc=43100 not excluded) match lvdebitotherchargeamount?
  B — Short-format RQ sysrefs: can all accountnos be found via invaccountno-only cithistory lookup?
  C — Which non-P/ADC prefixes in lvhisthsum are targetable with composite-key approach?
  D — lvformat* formula: still holds? (expected PASS)
  E — YI/IR columns: do they have data and what affectcodes drive them?
  F — cithistory consistency: one-to-one mapping? (expected YES)
  G — ADC prefix: individual accounts (like P) or batch (like CE)?
  H — CE/RQ affectcodes: any beyond PP/I1.../GC/GS/OF/CF that land in lv* columns?
  `);

  await pool.close();
  console.log('Done.');
})();
