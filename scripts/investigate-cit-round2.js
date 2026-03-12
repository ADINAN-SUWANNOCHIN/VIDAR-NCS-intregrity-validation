/**
 * INVESTIGATION ROUND 2: cithistory → lvhisthsum
 *
 * Round 1 findings:
 *  - lvhisthsum has 9.13M non-P/ADC rows (CE, RQ, IR, REV, Z#P, TS, AE, ...)
 *  - cithistory CE rows: accountno="" (empty), affectcode=null, debitcredit=null, transactionamount=0
 *    BUT invaccountno (old) and newinvaccountno (new account number) are populated
 *  - lvhisthsum CE rows: 3.37M rows have non-zero lv* columns, but affectcode=null, debitcredit=null
 *  - transactiondate: MATCH (pass-through from cithistory)
 *  - loantranshostcode does NOT exist in lvhisthsum (wrong column name used earlier)
 *  - vinpllvhistory ALSO has CE rows (44,554 for CE6302-000001)
 *
 * Hypotheses to test:
 *  H1: vinpllvhistory CE rows have per-account data → lv* grouped by (sysref+accountno)
 *  H2: cithistory principleamount/interestamount/otherchargeamount → lvformat* columns
 *  H3: cithistory newinvaccountno → lvhisthsum lvaccountno (account mapping)
 *  H4: lvhisthsum CE row = 1 row per (CE sysref × account), sourced from vinpllvhistory
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

async function run(pool, label, q) {
  console.log(`\n=== ${label} ===`);
  try {
    const r = await pool.request().query(q);
    if (!r.recordset || r.recordset.length === 0) console.log('  (no rows)');
    else r.recordset.forEach((row, i) => console.log(`  [${i}] ${JSON.stringify(row)}`));
  } catch(e) { console.log(`  ERROR: ${e.message}`); }
}

(async () => {
  const pool = await sql.connect(config);
  const OLD = '[ncs-conv-aging].dbo';
  const NEW = '[ncs-npl-aging].dbo';

  // ================================================================
  // SECTION A: lvhisthsum actual column names
  //            (loantranshostcode doesn't exist — find what does)
  // ================================================================
  console.log('\n========== SECTION A: lvhisthsum full column list ==========');

  await run(pool, 'lvhisthsum: ALL column names (to find correct names)',
    `SELECT COLUMN_NAME, DATA_TYPE, ORDINAL_POSITION
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_CATALOG = 'ncs-npl-aging'
       AND TABLE_SCHEMA = 'dbo'
       AND TABLE_NAME = 'lv$lvhisthsum'
     ORDER BY ORDINAL_POSITION`);

  // ================================================================
  // SECTION B: cithistory column names (different from vinpllvhistory)
  //            Find principleamount, gainamount, interestamount, etc.
  // ================================================================
  console.log('\n========== SECTION B: cithistory full column list ==========');

  await run(pool, 'cithistory: ALL column names',
    `SELECT COLUMN_NAME, DATA_TYPE, ORDINAL_POSITION
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_CATALOG = 'ncs-conv-aging'
       AND TABLE_SCHEMA = 'dbo'
       AND TABLE_NAME = 'conv$vinpllvcithistory'
     ORDER BY ORDINAL_POSITION`);

  // ================================================================
  // SECTION C: vinpllvhistory CE rows — do they have per-account data?
  //            If accountno is populated per-row → H1 is testable.
  // ================================================================
  console.log('\n========== SECTION C: vinpllvhistory CE rows — account + affectcode ==========');

  // Sample vinpllvhistory CE rows — check accountno, affectcode, debitcredit
  await run(pool, 'vinpllvhistory CE6302-000001: sample rows (accountno, affectcode, debitcredit, txamt)',
    `SELECT TOP 20 id, accountno, affectcode, debitcredit, loantranshostcode,
            TRY_CAST(transactionamount AS decimal(20,4)) AS txamt
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno = 'CE6302-000001'
     ORDER BY id`);

  // How many distinct accounts in vinpllvhistory for CE6302-000001?
  await run(pool, 'vinpllvhistory CE6302-000001: distinct account count',
    `SELECT COUNT(DISTINCT accountno) AS distinct_accounts, COUNT(*) AS total_rows
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno = 'CE6302-000001'`);

  // How many rows in lvhisthsum for CE6302-000001?
  await run(pool, 'lvhisthsum CE6302-000001: row count',
    `SELECT COUNT(*) AS total_rows, COUNT(DISTINCT lvaccountno) AS distinct_accounts
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno = 'CE6302-000001'`);

  // Compare account counts: cithistory invaccountno vs lvhisthsum lvaccountno
  await run(pool, 'cithistory CE6302-000001: distinct invaccountno count',
    `SELECT COUNT(DISTINCT invaccountno) AS distinct_invaccountno, COUNT(*) AS total_rows
     FROM ${OLD}.[conv$vinpllvcithistory]
     WHERE systemreferenceno = 'CE6302-000001'`);

  // ================================================================
  // SECTION D: H1 TEST — vinpllvhistory grouped by (sysref+accountno) → lv* in lvhisthsum
  //
  //            For a small CE sysref (CE6312-000002, 1 cithistory row):
  //            SUM(vinpllvhistory.txamt WHERE affectcode IN [I1..GG] AND dc=C AND lthc NOT IN [...])
  //            should = lvhisthsum.lvcreditinterestamount for that account
  // ================================================================
  console.log('\n========== SECTION D: H1 TEST — vinpllvhistory grouped by (CE sysref + accountno) ==========');

  const excList = ["'80000'","'81000'","'82100'","'90000'","'92090'","'99000'",
                   "'21300'","'21400'","'29300'","'29400'","'24100'","'25100'",
                   "'24200'","'25200'","'26100'","'26200'"].join(',');

  // For CE6312-000002: what does vinpllvhistory have? (accountno, affectcode, txamt per row)
  await run(pool, 'vinpllvhistory CE6312-000002: all rows',
    `SELECT id, accountno, affectcode, debitcredit, loantranshostcode,
            TRY_CAST(transactionamount AS decimal(20,4)) AS txamt
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno = 'CE6312-000002'
     ORDER BY id`);

  // For CE6312-000002: what does lvhisthsum show? (this sysref has 1 lvhisthsum row per our earlier finding)
  await run(pool, 'lvhisthsum CE6312-000002: all rows with lv* cols',
    `SELECT id, lvaccountno, affectcode, debitcredit___,
            transactionamount, paymentamount, currentbalanceb4t,
            lvcreditprincipleamount, lvdebitprincipleamount,
            lvcreditinterestamount, lvdebitinterestamount,
            lvcreditgaincash, lvdebitgaincash,
            lvcreditgainsettlement, lvdebitgainsettlement,
            lvcreditotherchargeamount, lvdebitotherchargeamount,
            lvformatprincipleamount, lvformatgaincash, lvformatgainsettlement,
            lvformatinterestamount, lvformatotherchargeamount, lvformattotalgain
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno = 'CE6312-000002'`);

  // cithistory CE6312-000002: all columns available
  await run(pool, 'cithistory CE6312-000002: all rows (principleamount, gainamount, interestamount, etc.)',
    `SELECT id, invaccountno, newinvaccountno, systemreferenceno, invaccounttype,
            transactiondate, effectivedate, gldate,
            transactionamount, principleamount, adjprincipleamount,
            gainamount, adjgainamount, interestamount, adjinterestamount,
            mischargeamount, adjmischargeamount, otherchargeamount, adjotherchargeamount,
            currentbalanceb4t, gainbalanceb4t, mischargeamountb4t, otherchargeamountb4t,
            nplaccrureinterest, citratio,
            txformatln_originalamount, txformatbalancecloseaccount, txformatbalancewriteoff,
            doctype, transactiontype, tellerid
     FROM ${OLD}.[conv$vinpllvcithistory]
     WHERE systemreferenceno = 'CE6312-000002'`);

  // ================================================================
  // SECTION E: Find a CE sysref where cithistory has non-zero principleamount or interestamount
  //            This tests H2: cithistory amounts → lvformat* columns
  // ================================================================
  console.log('\n========== SECTION E: Find cithistory rows with non-zero amounts ==========');

  await run(pool, 'cithistory: any CE row with non-zero principleamount?',
    `SELECT TOP 5 systemreferenceno, invaccountno, newinvaccountno,
            principleamount, interestamount, gainamount, otherchargeamount, currentbalanceb4t
     FROM ${OLD}.[conv$vinpllvcithistory]
     WHERE systemreferenceno LIKE 'CE%'
       AND principleamount != '0'
     ORDER BY id`);

  await run(pool, 'cithistory: any CE row with non-zero interestamount?',
    `SELECT TOP 5 systemreferenceno, invaccountno, newinvaccountno,
            principleamount, interestamount, gainamount, otherchargeamount, currentbalanceb4t
     FROM ${OLD}.[conv$vinpllvcithistory]
     WHERE systemreferenceno LIKE 'CE%'
       AND interestamount != '0'
     ORDER BY id`);

  await run(pool, 'cithistory: any row at all with non-zero principleamount?',
    `SELECT TOP 5 systemreferenceno, invaccountno,
            principleamount, interestamount, gainamount, otherchargeamount
     FROM ${OLD}.[conv$vinpllvcithistory]
     WHERE principleamount != '0'
     ORDER BY id`);

  await run(pool, 'cithistory: count of rows with non-zero principleamount/interestamount/gainamount',
    `SELECT
       SUM(CASE WHEN principleamount != '0' THEN 1 ELSE 0 END) AS nonzero_principle,
       SUM(CASE WHEN interestamount != '0' THEN 1 ELSE 0 END) AS nonzero_interest,
       SUM(CASE WHEN gainamount != '0' THEN 1 ELSE 0 END) AS nonzero_gain,
       SUM(CASE WHEN otherchargeamount != '0' THEN 1 ELSE 0 END) AS nonzero_othercharge,
       SUM(CASE WHEN currentbalanceb4t != '0' THEN 1 ELSE 0 END) AS nonzero_cb4t,
       COUNT(*) AS total
     FROM ${OLD}.[conv$vinpllvcithistory]`);

  // ================================================================
  // SECTION F: H3 TEST — cithistory newinvaccountno → lvhisthsum lvaccountno
  //            For CE6312-000002: does cithistory.newinvaccountno = lvhisthsum.lvaccountno?
  // ================================================================
  console.log('\n========== SECTION F: H3 TEST — newinvaccountno → lvaccountno mapping ==========');

  // CE6312-000002 has 1 cithistory row: newinvaccountno=14361003002
  // lvhisthsum CE6312-000002: lvaccountno=? (from Section D above)
  // Let's check directly
  await run(pool, 'H3: cithistory newinvaccountno vs lvhisthsum lvaccountno for CE6312-000002',
    `SELECT c.invaccountno, c.newinvaccountno, n.lvaccountno,
            CASE WHEN c.newinvaccountno = n.lvaccountno THEN 'MATCH' ELSE 'DIFF' END AS status
     FROM ${OLD}.[conv$vinpllvcithistory] c
     CROSS JOIN (
       SELECT lvaccountno FROM ${NEW}.[lv$lvhisthsum] WHERE systemreferenceno = 'CE6312-000002'
     ) n
     WHERE c.systemreferenceno = 'CE6312-000002'`);

  // Test on a larger sample: for CE rows, % match between cithistory.newinvaccountno and lvhisthsum.lvaccountno
  await run(pool, 'H3: newinvaccountno→lvaccountno match rate (sample CE6302-000001, 10 rows)',
    `SELECT TOP 10 c.invaccountno, c.newinvaccountno, n.lvaccountno,
            CASE WHEN c.newinvaccountno COLLATE Thai_CI_AS = n.lvaccountno THEN 'MATCH' ELSE 'DIFF' END AS status
     FROM ${OLD}.[conv$vinpllvcithistory] c
     JOIN ${NEW}.[lv$lvhisthsum] n
       ON c.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno
       AND c.newinvaccountno COLLATE Thai_CI_AS = n.lvaccountno
     WHERE c.systemreferenceno = 'CE6302-000001'
     ORDER BY c.id`);

  // ================================================================
  // SECTION G: H1 DEEP TEST — for a single (CE sysref, account) pair:
  //            vinpllvhistory grouped by (sysref+accountno) with affectcode filter
  //            vs lvhisthsum for same (sysref + account via newinvaccountno mapping)
  //
  //            Using CE6302-000001 + first account from cithistory
  // ================================================================
  console.log('\n========== SECTION G: H1 DEEP TEST — (sysref+account) grouping ==========');

  // Get the first account pair from cithistory for CE6302-000001
  await run(pool, 'cithistory CE6302-000001: first account (invaccountno → newinvaccountno)',
    `SELECT TOP 3 invaccountno, newinvaccountno, currentbalanceb4t,
            principleamount, interestamount, gainamount, otherchargeamount
     FROM ${OLD}.[conv$vinpllvcithistory]
     WHERE systemreferenceno = 'CE6302-000001'
     ORDER BY id`);

  // For the first account in vinpllvhistory for CE6302-000001:
  await run(pool, 'vinpllvhistory CE6302-000001: affectcode+debitcredit distribution per first accountno',
    `SELECT accountno, affectcode, debitcredit,
            SUM(TRY_CAST(transactionamount AS decimal(20,4))) AS sum_txamt,
            COUNT(*) AS cnt
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno = 'CE6302-000001'
       AND accountno = (
         SELECT TOP 1 accountno FROM ${OLD}.[conv$vinpllvhistory]
         WHERE systemreferenceno = 'CE6302-000001' AND accountno != ''
         ORDER BY id
       )
     GROUP BY accountno, affectcode, debitcredit
     ORDER BY affectcode, debitcredit`);

  // What does lvhisthsum show for CE6302-000001 + that same account?
  await run(pool, 'lvhisthsum CE6302-000001: first account row with all lv* cols',
    `SELECT TOP 3 lvaccountno,
            lvcreditprincipleamount, lvdebitprincipleamount,
            lvcreditinterestamount, lvdebitinterestamount,
            lvcreditgaincash, lvdebitgaincash,
            lvcreditgainsettlement, lvdebitgainsettlement,
            lvcreditotherchargeamount, lvdebitotherchargeamount,
            lvformatprincipleamount, lvformatgaincash, lvformatgainsettlement,
            lvformatinterestamount, lvformatotherchargeamount, lvformattotalgain,
            currentbalanceb4t, transactionamount, paymentamount,
            affectcode, debitcredit___
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno = 'CE6302-000001'
     ORDER BY id`);

  // ================================================================
  // SECTION H: Test the filtered sum on a specific account for CE
  //            Compute: SUM(vinpllvhistory.txamt WHERE sysref=CE6302-000001
  //                         AND accountno=X AND affectcode IN [I1,I2,...] AND dc=C
  //                         AND lthc NOT IN [...])
  //            Compare to lvhisthsum.lvcreditinterestamount for that account
  //
  //            If this MATCHES → same formula applies to CE, just grouped by (sysref+accountno)
  // ================================================================
  console.log('\n========== SECTION H: Filtered sum test for CE sysref+account ==========');

  // Step 1: Get first valid accountno from vinpllvhistory for CE6302-000001
  await run(pool, 'vinpllvhistory CE6302-000001: first 3 accountno values',
    `SELECT TOP 3 accountno FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno = 'CE6302-000001' AND accountno != ''
     ORDER BY id`);

  // Step 2: Compute filtered sums for a specific accountno
  // We'll use hardcoded accountno from above result (will be visible in output)
  // We compute ALL lv* sums for ALL affectcode+dc combos for that account
  await run(pool, 'vinpllvhistory CE6302-000001: filtered sums per affectcode+dc for all accounts (top 10)',
    `SELECT TOP 10 accountno,
       SUM(CASE WHEN affectcode = 'PP' AND debitcredit = 'C' AND loantranshostcode NOT IN (${excList}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS creditPP,
       SUM(CASE WHEN affectcode = 'PP' AND debitcredit = 'D' AND loantranshostcode NOT IN (${excList}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS debitPP,
       SUM(CASE WHEN affectcode IN ('I1','I2','I3','IN','IT','GG') AND debitcredit = 'C' AND loantranshostcode NOT IN (${excList}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS creditINT,
       SUM(CASE WHEN affectcode IN ('I1','I2','I3','IN','IT','GG') AND debitcredit = 'D' AND loantranshostcode NOT IN (${excList}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS debitINT,
       SUM(CASE WHEN affectcode IN ('GC') AND debitcredit = 'C' AND loantranshostcode NOT IN (${excList}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS creditGC,
       SUM(CASE WHEN affectcode IN ('GS') AND debitcredit = 'C' AND loantranshostcode NOT IN (${excList}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS creditGS,
       SUM(CASE WHEN affectcode IN ('OF','CF') AND debitcredit = 'C' AND loantranshostcode NOT IN (${excList}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS creditOF,
       COUNT(*) AS rows
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno = 'CE6302-000001'
       AND accountno != ''
     GROUP BY accountno
     ORDER BY accountno`);

  // Step 3: Get corresponding lvhisthsum rows for CE6302-000001 — lv* columns per lvaccountno
  await run(pool, 'lvhisthsum CE6302-000001: lv* per lvaccountno (first 10 accounts)',
    `SELECT TOP 10 lvaccountno,
            lvcreditprincipleamount, lvdebitprincipleamount,
            lvcreditinterestamount, lvdebitinterestamount,
            lvcreditgaincash, lvdebitgaincash,
            lvcreditgainsettlement, lvdebitgainsettlement,
            lvcreditotherchargeamount, lvdebitotherchargeamount,
            lvformatprincipleamount, lvformatgaincash, lvformatgainsettlement,
            lvformatinterestamount, lvformatotherchargeamount, lvformattotalgain,
            currentbalanceb4t
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno = 'CE6302-000001'
     ORDER BY lvaccountno`);

  // ================================================================
  // SECTION I: What maps to lvformat* columns?
  //            These 6 columns (lvformatprincipleamount, lvformatgaincash, etc.)
  //            have no equivalent in our current common.yaml.
  //            Options:
  //              (a) cithistory principleamount/gainamount/interestamount/otherchargeamount
  //              (b) vinpllvhistory sum with different affectcode filter
  //              (c) some formula of lvcredit - lvdebit
  //
  //            Test (c) first: lvformatprincipleamount == lvcreditprincipleamount - lvdebitprincipleamount?
  // ================================================================
  console.log('\n========== SECTION I: lvformat* columns — what feeds them? ==========');

  await run(pool, 'lvhisthsum: test lvformatprincipleamount == lvcreditPP - lvdebitPP (sample)',
    `SELECT TOP 10
       lvcreditprincipleamount, lvdebitprincipleamount,
       lvcreditprincipleamount - lvdebitprincipleamount AS computed_format,
       lvformatprincipleamount,
       CASE WHEN ABS((lvcreditprincipleamount - lvdebitprincipleamount) - lvformatprincipleamount) < 0.01
            THEN 'MATCH' ELSE 'DIFF' END AS status
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno LIKE 'P%'
       AND lvformatprincipleamount != 0`);

  await run(pool, 'lvhisthsum: test lvformatinterestamount == lvcreditINT - lvdebitINT (sample)',
    `SELECT TOP 10
       lvcreditinterestamount, lvdebitinterestamount,
       lvcreditinterestamount - lvdebitinterestamount AS computed_format,
       lvformatinterestamount,
       CASE WHEN ABS((lvcreditinterestamount - lvdebitinterestamount) - lvformatinterestamount) < 0.01
            THEN 'MATCH' ELSE 'DIFF' END AS status
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno LIKE 'P%'
       AND lvformatinterestamount != 0`);

  await run(pool, 'lvhisthsum: test lvformattotalgain == lvformatgaincash + lvformatgainsettlement (sample)',
    `SELECT TOP 10
       lvformatgaincash, lvformatgainsettlement,
       lvformatgaincash + lvformatgainsettlement AS computed_total,
       lvformattotalgain,
       CASE WHEN ABS((lvformatgaincash + lvformatgainsettlement) - lvformattotalgain) < 0.01
            THEN 'MATCH' ELSE 'DIFF' END AS status
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE lvformattotalgain != 0`);

  // Match rate across all P rows
  await run(pool, 'lvhisthsum P%: lvformat* == (credit - debit) match rate',
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN ABS((lvcreditprincipleamount - lvdebitprincipleamount) - lvformatprincipleamount) < 0.01 THEN 1 ELSE 0 END) AS pp_match,
       SUM(CASE WHEN ABS((lvcreditinterestamount - lvdebitinterestamount) - lvformatinterestamount) < 0.01 THEN 1 ELSE 0 END) AS int_match,
       SUM(CASE WHEN ABS((lvcreditgaincash - lvdebitgaincash) - lvformatgaincash) < 0.01 THEN 1 ELSE 0 END) AS gc_match,
       SUM(CASE WHEN ABS((lvcreditgainsettlement - lvdebitgainsettlement) - lvformatgainsettlement) < 0.01 THEN 1 ELSE 0 END) AS gs_match,
       SUM(CASE WHEN ABS((lvcreditotherchargeamount - lvdebitotherchargeamount) - lvformatotherchargeamount) < 0.01 THEN 1 ELSE 0 END) AS of_match
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno LIKE 'P%'`);

  // ================================================================
  // SECTION J: vinpllvhistory→lvhisthsum join test for CE rows
  //            Direct join: old.accountno → new.lvaccountno (via newinvaccountno)
  //            Does old accountno appear in lvhisthsum as lvaccountno?
  // ================================================================
  console.log('\n========== SECTION J: vinpllvhistory accountno → lvhisthsum lvaccountno join test ==========');

  await run(pool, 'vinpllvhistory CE6302-000001: accountno format (sample)',
    `SELECT TOP 5 accountno, affectcode, debitcredit, loantranshostcode,
            TRY_CAST(transactionamount AS decimal(20,4)) AS txamt
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno = 'CE6302-000001' AND accountno != ''
     ORDER BY id`);

  // Does vinpllvhistory.accountno == lvhisthsum.lvaccountno? (direct match test)
  await run(pool, 'CE6302-000001: vinpllvhistory accountno vs lvhisthsum lvaccountno — match test (sample)',
    `SELECT TOP 5
       o.accountno AS hist_accountno, n.lvaccountno,
       CASE WHEN o.accountno COLLATE Thai_CI_AS = n.lvaccountno THEN 'MATCH' ELSE 'DIFF' END AS status
     FROM (
       SELECT DISTINCT accountno FROM ${OLD}.[conv$vinpllvhistory]
       WHERE systemreferenceno = 'CE6302-000001' AND accountno != ''
     ) o
     JOIN ${NEW}.[lv$lvhisthsum] n ON n.systemreferenceno = 'CE6302-000001'
     ORDER BY o.accountno, n.lvaccountno`);

  // ================================================================
  // SECTION K: Full cross-check for CE6302-000001
  //            For a specific accountno present in both vinpllvhistory and lvhisthsum:
  //            compute filtered sums and compare to lvhisthsum lv* columns directly
  // ================================================================
  console.log('\n========== SECTION K: Full H1 cross-check for 1 account in CE6302-000001 ==========');

  // Get one accountno that appears in vinpllvhistory for CE6302-000001
  // Then check if it appears in lvhisthsum as lvaccountno
  await run(pool, 'CE6302-000001: find accountno that matches lvaccountno',
    `SELECT DISTINCT o.accountno
     FROM ${OLD}.[conv$vinpllvhistory] o
     WHERE o.systemreferenceno = 'CE6302-000001'
       AND o.accountno != ''
       AND EXISTS (
         SELECT 1 FROM ${NEW}.[lv$lvhisthsum] n
         WHERE n.systemreferenceno = 'CE6302-000001'
           AND n.lvaccountno = o.accountno COLLATE Thai_CI_AS
       )
     ORDER BY o.accountno
     OFFSET 0 ROWS FETCH NEXT 3 ROWS ONLY`);

  // For the matched account: compute filtered sums
  await run(pool, 'CE6302-000001 first matched account: computed lv* from vinpllvhistory',
    `DECLARE @acct nvarchar(50);
     SELECT TOP 1 @acct = o.accountno
     FROM ${OLD}.[conv$vinpllvhistory] o
     WHERE o.systemreferenceno = 'CE6302-000001'
       AND o.accountno != ''
       AND EXISTS (
         SELECT 1 FROM ${NEW}.[lv$lvhisthsum] n
         WHERE n.systemreferenceno = 'CE6302-000001'
           AND n.lvaccountno = o.accountno COLLATE Thai_CI_AS
       )
     ORDER BY o.accountno;

     SELECT @acct AS matched_accountno,
       SUM(CASE WHEN affectcode = 'PP' AND debitcredit = 'C' AND loantranshostcode NOT IN (${excList}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS computed_creditPP,
       SUM(CASE WHEN affectcode = 'PP' AND debitcredit = 'D' AND loantranshostcode NOT IN (${excList}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS computed_debitPP,
       SUM(CASE WHEN affectcode IN ('I1','I2','I3','IN','IT','GG') AND debitcredit = 'C' AND loantranshostcode NOT IN (${excList}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS computed_creditINT,
       SUM(CASE WHEN affectcode IN ('I1','I2','I3','IN','IT','GG') AND debitcredit = 'D' AND loantranshostcode NOT IN (${excList}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS computed_debitINT,
       SUM(CASE WHEN affectcode IN ('GC') AND debitcredit = 'C' AND loantranshostcode NOT IN (${excList}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS computed_creditGC,
       SUM(CASE WHEN affectcode IN ('GS') AND debitcredit = 'C' AND loantranshostcode NOT IN (${excList}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS computed_creditGS,
       SUM(CASE WHEN affectcode IN ('OF','CF') AND debitcredit = 'C' AND loantranshostcode NOT IN (${excList}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS computed_creditOF,
       COUNT(*) AS old_rows
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno = 'CE6302-000001'
       AND accountno = @acct`);

  await run(pool, 'CE6302-000001 first matched account: actual lv* from lvhisthsum',
    `DECLARE @acct nvarchar(50);
     SELECT TOP 1 @acct = o.accountno
     FROM ${OLD}.[conv$vinpllvhistory] o
     WHERE o.systemreferenceno = 'CE6302-000001'
       AND o.accountno != ''
       AND EXISTS (
         SELECT 1 FROM ${NEW}.[lv$lvhisthsum] n
         WHERE n.systemreferenceno = 'CE6302-000001'
           AND n.lvaccountno = o.accountno COLLATE Thai_CI_AS
       )
     ORDER BY o.accountno;

     SELECT lvaccountno,
            lvcreditprincipleamount, lvdebitprincipleamount,
            lvcreditinterestamount, lvdebitinterestamount,
            lvcreditgaincash, lvdebitgaincash,
            lvcreditgainsettlement, lvdebitgainsettlement,
            lvcreditotherchargeamount, lvdebitotherchargeamount,
            lvformatprincipleamount, lvformatinterestamount, lvformattotalgain,
            currentbalanceb4t, transactionamount, paymentamount
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno = 'CE6302-000001'
       AND lvaccountno = @acct`);

  // ================================================================
  // SECTION L: What is the grouping key for CE rows in lvhisthsum?
  //            Is it (systemreferenceno + lvaccountno) unique?
  //            Or is it just systemreferenceno (one summary row per batch)?
  // ================================================================
  console.log('\n========== SECTION L: Grouping key uniqueness for CE rows ==========');

  await run(pool, 'lvhisthsum CE%: is (systemreferenceno + lvaccountno) unique?',
    `SELECT COUNT(*) AS total_rows,
            COUNT(DISTINCT CONCAT(systemreferenceno, '|', lvaccountno)) AS unique_sysref_acct
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno LIKE 'CE%'`);

  // Check RQ as well
  await run(pool, 'lvhisthsum RQ%: is (systemreferenceno + lvaccountno) unique?',
    `SELECT COUNT(*) AS total_rows,
            COUNT(DISTINCT CONCAT(systemreferenceno, '|', lvaccountno)) AS unique_sysref_acct
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno LIKE 'RQ%'`);

  // Check P as well for comparison
  await run(pool, 'lvhisthsum P%: is (systemreferenceno + lvaccountno) unique?',
    `SELECT COUNT(*) AS total_rows,
            COUNT(DISTINCT CONCAT(systemreferenceno, '|', lvaccountno)) AS unique_sysref_acct
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno LIKE 'P%'`);

  await pool.close();
  console.log('\nDone.');
})();
