/**
 * INVESTIGATION: conv$vinpllvcithistory → lv$lvhisthsum
 *
 * Goal: find which columns cithistory feeds into lvhisthsum, and what the
 * migration logic is (filter / transform / pass-through?).
 *
 * Attack plan:
 *   A. Find non-P/ADC rows in lvhisthsum — confirm they exist and get their prefix.
 *   B. Pick sample sysrefs exclusively from cithistory (not in vinpllvhistory P/ADC).
 *   C. Pull raw cithistory rows + lvhisthsum rows side-by-side for those sysrefs.
 *   D. Find which cithistory invaccounttype lands in lvhisthsum.
 *   E. Check column-by-column: where values differ, where they match, where they're null.
 *   F. See if lv* columns in lvhisthsum are zero or non-zero for cithistory sysrefs.
 *   G. Check lvformat* columns — perhaps cithistory feeds those instead of lv* cols.
 *   H. Column fill-rate comparison: cithistory vs lvhisthsum for matched sysrefs.
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

async function run(pool, label, q, timeout = 300000) {
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
  // SECTION A: What sysref prefixes exist in lvhisthsum beyond P/ADC?
  // These rows CANNOT come from our current vinpllvhistory rule.
  // ================================================================
  console.log('\n========== SECTION A: lvhisthsum prefix breakdown ==========');

  await run(pool, 'lvhisthsum: all sysref prefix distribution (first 4 chars)',
    `SELECT LEFT(systemreferenceno, 4) AS prefix4, COUNT(*) AS cnt
     FROM ${NEW}.[lv$lvhisthsum]
     GROUP BY LEFT(systemreferenceno, 4)
     ORDER BY cnt DESC`);

  await run(pool, 'lvhisthsum: non-P non-ADC rows — how many and which prefixes?',
    `SELECT LEFT(systemreferenceno, 4) AS prefix4, COUNT(*) AS cnt
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno NOT LIKE 'P%'
       AND systemreferenceno NOT LIKE 'ADC%'
     GROUP BY LEFT(systemreferenceno, 4)
     ORDER BY cnt DESC`);

  await run(pool, 'lvhisthsum: total non-P non-ADC row count',
    `SELECT COUNT(*) AS total_non_p_adc
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno NOT LIKE 'P%'
       AND systemreferenceno NOT LIKE 'ADC%'`);

  // ================================================================
  // SECTION B: For non-P/ADC sysrefs — do they exist in cithistory?
  // Also check if any exist in vinpllvhistory (they might both have it).
  // ================================================================
  console.log('\n========== SECTION B: non-P/ADC rows — source tracing ==========');

  // Sample 10 non-P/ADC sysrefs from lvhisthsum
  await run(pool, 'lvhisthsum: sample 20 non-P/ADC sysrefs',
    `SELECT TOP 20 systemreferenceno
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno NOT LIKE 'P%'
       AND systemreferenceno NOT LIKE 'ADC%'
     ORDER BY id`);

  // For a CE sysref from lvhisthsum — does it exist in cithistory?
  await run(pool, 'cithistory: does CE6304-000001 appear?',
    `SELECT COUNT(*) AS cnt, MIN(invaccounttype) AS sample_invaccounttype
     FROM ${OLD}.[conv$vinpllvcithistory]
     WHERE systemreferenceno = 'CE6304-000001'`);

  // For a CE sysref from lvhisthsum — does it exist in vinpllvhistory?
  await run(pool, 'vinpllvhistory: does CE6304-000001 appear?',
    `SELECT COUNT(*) AS cnt
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno = 'CE6304-000001'`);

  // Key question: how many of the non-P/ADC lvhisthsum sysrefs are in cithistory vs vinpllvhistory?
  // Use TOP 500 sample to estimate (full scan may timeout)
  await run(pool, 'Sample 500 non-P/ADC lvhisthsum sysrefs: how many in cithistory?',
    `SELECT
       SUM(CASE WHEN EXISTS (
         SELECT 1 FROM ${OLD}.[conv$vinpllvcithistory] c
         WHERE c.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno
       ) THEN 1 ELSE 0 END) AS in_cit,
       SUM(CASE WHEN EXISTS (
         SELECT 1 FROM ${OLD}.[conv$vinpllvhistory] o
         WHERE o.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno
       ) THEN 1 ELSE 0 END) AS in_hist,
       COUNT(*) AS total
     FROM (
       SELECT TOP 500 systemreferenceno
       FROM ${NEW}.[lv$lvhisthsum]
       WHERE systemreferenceno NOT LIKE 'P%'
         AND systemreferenceno NOT LIKE 'ADC%'
       ORDER BY id
     ) n`);

  // ================================================================
  // SECTION C: invaccounttype distribution in cithistory for sysrefs
  //            that appear in lvhisthsum (non-P/ADC sysrefs)
  // Which invaccounttype routes to lvhisthsum?
  // ================================================================
  console.log('\n========== SECTION C: cithistory invaccounttype → lvhisthsum routing ==========');

  // Get top non-P/ADC sysrefs from lvhisthsum, then check invaccounttype in cithistory
  await run(pool, 'cithistory invaccounttype for non-P/ADC lvhisthsum sysrefs (sample 1000)',
    `SELECT c.invaccounttype, COUNT(*) AS cit_row_count
     FROM ${OLD}.[conv$vinpllvcithistory] c
     WHERE EXISTS (
       SELECT 1 FROM (
         SELECT TOP 1000 systemreferenceno
         FROM ${NEW}.[lv$lvhisthsum]
         WHERE systemreferenceno NOT LIKE 'P%'
           AND systemreferenceno NOT LIKE 'ADC%'
         ORDER BY id
       ) n WHERE n.systemreferenceno = c.systemreferenceno COLLATE Thai_CI_AS
     )
     GROUP BY c.invaccounttype
     ORDER BY cit_row_count DESC`);

  // Also check: what invaccounttype is in cithistory for CE sysrefs?
  await run(pool, 'cithistory: invaccounttype breakdown for CE% sysrefs',
    `SELECT invaccounttype, COUNT(*) AS cnt
     FROM ${OLD}.[conv$vinpllvcithistory]
     WHERE systemreferenceno LIKE 'CE%'
     GROUP BY invaccounttype
     ORDER BY cnt DESC`);

  await run(pool, 'cithistory: invaccounttype breakdown for RQ% sysrefs',
    `SELECT invaccounttype, COUNT(*) AS cnt
     FROM ${OLD}.[conv$vinpllvcithistory]
     WHERE systemreferenceno LIKE 'RQ%'
     GROUP BY invaccounttype
     ORDER BY cnt DESC`);

  // ================================================================
  // SECTION D: Side-by-side column comparison for a sample cithistory
  //            sysref that also appears in lvhisthsum.
  //
  //            Strategy:
  //            1. Find a CE sysref that's in both cithistory AND lvhisthsum.
  //            2. Pull cithistory rows for it.
  //            3. Pull lvhisthsum rows for it.
  //            4. Compare all non-lv* columns first (the "simple" columns).
  // ================================================================
  console.log('\n========== SECTION D: Side-by-side for a cithistory-origin sysref ==========');

  // Find a small CE sysref (few rows) for easy analysis
  await run(pool, 'cithistory: CE sysrefs with few rows (doable sample)',
    `SELECT TOP 10 systemreferenceno, COUNT(*) AS cnt
     FROM ${OLD}.[conv$vinpllvcithistory]
     WHERE systemreferenceno LIKE 'CE%'
     GROUP BY systemreferenceno
     HAVING COUNT(*) <= 5
     ORDER BY cnt, systemreferenceno`);

  // Pull cithistory rows for CE sysref with 1-2 rows
  await run(pool, 'cithistory: all columns for CE7001-000001 (or similar small sysref)',
    `SELECT TOP 5 *
     FROM ${OLD}.[conv$vinpllvcithistory]
     WHERE systemreferenceno IN (
       SELECT TOP 3 systemreferenceno
       FROM ${OLD}.[conv$vinpllvcithistory]
       WHERE systemreferenceno LIKE 'CE%'
       GROUP BY systemreferenceno
       HAVING COUNT(*) = 1
       ORDER BY systemreferenceno
     )
     ORDER BY systemreferenceno, id`);

  // Check if those same sysrefs are in lvhisthsum
  await run(pool, 'lvhisthsum: rows for those same CE sysrefs (all columns)',
    `SELECT TOP 5 *
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno IN (
       SELECT TOP 3 systemreferenceno
       FROM ${OLD}.[conv$vinpllvcithistory]
       WHERE systemreferenceno LIKE 'CE%'
       GROUP BY systemreferenceno
       HAVING COUNT(*) = 1
       ORDER BY systemreferenceno
     )`);

  // ================================================================
  // SECTION E: For cithistory sysrefs in lvhisthsum — column fill rate
  //            Which columns are non-null in cithistory vs lvhisthsum?
  //            Focus on key comparison columns.
  // ================================================================
  console.log('\n========== SECTION E: Column fill rate comparison ==========');

  // cithistory: fill rate on key columns for CE sysrefs
  await run(pool, 'cithistory CE%: fill rate on key columns',
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN affectcode IS NOT NULL THEN 1 ELSE 0 END) AS has_affectcode,
       SUM(CASE WHEN debitcredit IS NOT NULL THEN 1 ELSE 0 END) AS has_debitcredit,
       SUM(CASE WHEN transactionamount IS NOT NULL AND TRY_CAST(transactionamount AS decimal(20,4)) != 0 THEN 1 ELSE 0 END) AS has_txamt,
       SUM(CASE WHEN paymentamount IS NOT NULL AND TRY_CAST(paymentamount AS decimal(20,4)) != 0 THEN 1 ELSE 0 END) AS has_payamt,
       SUM(CASE WHEN accountno IS NOT NULL THEN 1 ELSE 0 END) AS has_accountno,
       SUM(CASE WHEN transactiondate IS NOT NULL THEN 1 ELSE 0 END) AS has_txdate,
       SUM(CASE WHEN effectivedate IS NOT NULL THEN 1 ELSE 0 END) AS has_effdate,
       SUM(CASE WHEN loantranshostcode IS NOT NULL THEN 1 ELSE 0 END) AS has_lthc,
       SUM(CASE WHEN chargetype IS NOT NULL THEN 1 ELSE 0 END) AS has_chargetype,
       SUM(CASE WHEN doctype IS NOT NULL THEN 1 ELSE 0 END) AS has_doctype,
       SUM(CASE WHEN tellerid IS NOT NULL THEN 1 ELSE 0 END) AS has_tellerid
     FROM ${OLD}.[conv$vinpllvcithistory]
     WHERE systemreferenceno LIKE 'CE%'`);

  // lvhisthsum: fill rate on lv* and standard columns for CE sysrefs
  await run(pool, 'lvhisthsum CE%: fill rate on lv* and standard columns',
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN affectcode IS NOT NULL THEN 1 ELSE 0 END) AS has_affectcode,
       SUM(CASE WHEN debitcredit___ IS NOT NULL THEN 1 ELSE 0 END) AS has_debitcredit,
       SUM(CASE WHEN transactionamount != 0 THEN 1 ELSE 0 END) AS has_txamt_nonzero,
       SUM(CASE WHEN paymentamount != 0 THEN 1 ELSE 0 END) AS has_payamt_nonzero,
       SUM(CASE WHEN lvaccountno IS NOT NULL THEN 1 ELSE 0 END) AS has_lvaccountno,
       SUM(CASE WHEN lvcreditprincipleamount != 0 THEN 1 ELSE 0 END) AS creditpp_nonzero,
       SUM(CASE WHEN lvcreditinterestamount != 0 THEN 1 ELSE 0 END) AS creditint_nonzero,
       SUM(CASE WHEN lvcreditotherchargeamount != 0 THEN 1 ELSE 0 END) AS creditof_nonzero,
       SUM(CASE WHEN lvcreditgaincash != 0 THEN 1 ELSE 0 END) AS creditgc_nonzero,
       SUM(CASE WHEN lvcreditgainsettlement != 0 THEN 1 ELSE 0 END) AS creditgs_nonzero,
       SUM(CASE WHEN lvcreditmischargeamount != 0 THEN 1 ELSE 0 END) AS creditmf_nonzero
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno LIKE 'CE%'`);

  // Are ALL lv* cols zero for CE rows in lvhisthsum?
  await run(pool, 'lvhisthsum CE%: any row with ANY non-zero lv* column?',
    `SELECT COUNT(*) AS rows_with_nonzero_lv
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno LIKE 'CE%'
       AND (
         lvcreditprincipleamount != 0 OR lvdebitprincipleamount != 0 OR
         lvcreditinterestamount != 0 OR lvdebitinterestamount != 0 OR
         lvcreditgaincash != 0 OR lvdebitgaincash != 0 OR
         lvcreditgainsettlement != 0 OR lvdebitgainsettlement != 0 OR
         lvcreditotherchargeamount != 0 OR lvdebitotherchargeamount != 0 OR
         lvcreditmischargeamount != 0 OR lvdebitmischargeamount != 0
       )`);

  // ================================================================
  // SECTION F: lvformat* columns — maybe cithistory feeds THESE instead
  // Check if lvformat* exists and has values for cithistory sysrefs
  // ================================================================
  console.log('\n========== SECTION F: lvformat* columns investigation ==========');

  // First check if lvformat* columns exist in lvhisthsum
  await run(pool, 'lvhisthsum: list column names containing "lvformat"',
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_CATALOG = 'ncs-npl-aging'
       AND TABLE_SCHEMA = 'dbo'
       AND TABLE_NAME = 'lv$lvhisthsum'
       AND COLUMN_NAME LIKE '%lvformat%'
     ORDER BY ORDINAL_POSITION`);

  // Check ALL column names in lvhisthsum that start with lv
  await run(pool, 'lvhisthsum: all lv* column names',
    `SELECT COLUMN_NAME, DATA_TYPE, ORDINAL_POSITION
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_CATALOG = 'ncs-npl-aging'
       AND TABLE_SCHEMA = 'dbo'
       AND TABLE_NAME = 'lv$lvhisthsum'
       AND COLUMN_NAME LIKE 'lv%'
     ORDER BY ORDINAL_POSITION`);

  // ================================================================
  // SECTION G: Does cithistory → lvhisthsum have 1:1 mapping?
  //            For sysrefs that appear ONLY in cithistory (not vinpllvhistory P/ADC),
  //            count how many old rows map to how many new rows.
  // ================================================================
  console.log('\n========== SECTION G: row cardinality cithistory→lvhisthsum ==========');

  // For 20 CE sysrefs in both tables — count old vs new rows
  await run(pool, 'Cithistory vs lvhisthsum: row count per sysref (sample 20 CE sysrefs)',
    `SELECT
       n.systemreferenceno,
       (SELECT COUNT(*) FROM ${OLD}.[conv$vinpllvcithistory] c WHERE c.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno) AS cit_rows,
       (SELECT COUNT(*) FROM ${OLD}.[conv$vinpllvhistory] o WHERE o.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno) AS hist_rows,
       COUNT(*) AS lvhisthsum_rows
     FROM ${NEW}.[lv$lvhisthsum] n
     WHERE systemreferenceno LIKE 'CE%'
     GROUP BY n.systemreferenceno
     ORDER BY n.systemreferenceno
     OFFSET 0 ROWS FETCH NEXT 20 ROWS ONLY`);

  // ================================================================
  // SECTION H: Concrete column comparison — pick one CE sysref that's
  //            in BOTH cithistory and lvhisthsum, show all non-null columns.
  // ================================================================
  console.log('\n========== SECTION H: Deep column trace — cithistory row vs lvhisthsum row ==========');

  // Find a CE sysref present in lvhisthsum
  await run(pool, 'First CE sysref in lvhisthsum',
    `SELECT TOP 1 systemreferenceno FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno LIKE 'CE%'
     ORDER BY id`);

  // Pull cithistory rows for it — all columns that are non-null
  await run(pool, 'cithistory: all key columns for first CE sysref in lvhisthsum',
    `DECLARE @sysref nvarchar(100);
     SELECT TOP 1 @sysref = n.systemreferenceno
     FROM ${NEW}.[lv$lvhisthsum] n
     WHERE n.systemreferenceno LIKE 'CE%'
     ORDER BY n.id;

     SELECT id, systemreferenceno, accountno, invaccounttype, affectcode, debitcredit,
            transactionamount, paymentamount, transactiondate, effectivedate, gldate,
            loantranshostcode, chargetype, doctype, tellerid, affectcode,
            noofdays, remark, orgsystemreferencenumber, auxilarytransaction,
            startinterestdate, endinterestdate, yieldrate, irrrate, calculateintrate,
            gaincashbalanceb4t, gainsettlementbalanceb4t, currentbalanceb4t, interestb4t,
            calprovisionamount
     FROM ${OLD}.[conv$vinpllvcithistory]
     WHERE systemreferenceno = @sysref
     ORDER BY id`);

  // Pull lvhisthsum rows for it — all key columns
  await run(pool, 'lvhisthsum: all key columns for same CE sysref',
    `DECLARE @sysref nvarchar(100);
     SELECT TOP 1 @sysref = n.systemreferenceno
     FROM ${NEW}.[lv$lvhisthsum] n
     WHERE n.systemreferenceno LIKE 'CE%'
     ORDER BY n.id;

     SELECT id, systemreferenceno, lvaccountno, affectcode, debitcredit___,
            transactionamount, paymentamount, transactiondate, effectivedate, gldate,
            loantranshostcode, chargetype, doctype, tellerid,
            noofdays, remark, orgsystemreferencenumber, auxilarytranscode,
            startinterestdate, endinterestdate, yieldrate, irrrate, calculateintrate,
            gaincashbalanceb4t, gainsettlementbalanceb4t, currentbalanceb4t, interestb4t,
            calprovisionamount,
            lvcreditprincipleamount, lvdebitprincipleamount,
            lvcreditinterestamount, lvdebitinterestamount,
            lvcreditgaincash, lvdebitgaincash,
            lvcreditgainsettlement, lvdebitgainsettlement,
            lvcreditotherchargeamount, lvdebitotherchargeamount,
            lvcreditmischargeamount, lvdebitmischargeamount
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno = @sysref
     ORDER BY id`);

  // ================================================================
  // SECTION I: RQ sysref investigation — same as CE?
  // ================================================================
  console.log('\n========== SECTION I: RQ sysref — cithistory vs lvhisthsum ==========');

  await run(pool, 'lvhisthsum: first RQ sysref',
    `SELECT TOP 1 systemreferenceno FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno LIKE 'RQ%'
     ORDER BY id`);

  await run(pool, 'cithistory: key columns for first RQ sysref in lvhisthsum',
    `DECLARE @sysref nvarchar(100);
     SELECT TOP 1 @sysref = n.systemreferenceno
     FROM ${NEW}.[lv$lvhisthsum] n
     WHERE n.systemreferenceno LIKE 'RQ%'
     ORDER BY n.id;

     SELECT id, systemreferenceno, accountno, invaccounttype, affectcode, debitcredit,
            transactionamount, paymentamount, transactiondate, loantranshostcode, chargetype,
            currentbalanceb4t, interestb4t, calprovisionamount
     FROM ${OLD}.[conv$vinpllvcithistory]
     WHERE systemreferenceno COLLATE Thai_CI_AS = @sysref
     ORDER BY id`);

  await run(pool, 'lvhisthsum: rows for same RQ sysref',
    `DECLARE @sysref nvarchar(100);
     SELECT TOP 1 @sysref = n.systemreferenceno
     FROM ${NEW}.[lv$lvhisthsum] n
     WHERE n.systemreferenceno LIKE 'RQ%'
     ORDER BY n.id;

     SELECT id, systemreferenceno, lvaccountno, affectcode, debitcredit___,
            transactionamount, paymentamount, transactiondate, loantranshostcode, chargetype,
            currentbalanceb4t, interestb4t, calprovisionamount,
            lvcreditprincipleamount, lvdebitprincipleamount,
            lvcreditinterestamount, lvdebitinterestamount,
            lvcreditotherchargeamount, lvdebitotherchargeamount
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno = @sysref
     ORDER BY id`);

  // ================================================================
  // SECTION J: Cross-table direct comparison
  //            For 5 cithistory-origin sysrefs: compare each old column value
  //            directly to the new column value to detect pass-through.
  //            This is the key test: is it 1:1, aggregated, or transformed?
  // ================================================================
  console.log('\n========== SECTION J: Direct old→new value comparison (pass-through test) ==========');

  // For CE rows: compare accountno (old) vs lvaccountno (new) — should match if 1:1
  await run(pool, 'CE rows: old accountno vs new lvaccountno (sample)',
    `SELECT TOP 10
       c.systemreferenceno, c.accountno AS old_accountno,
       n.lvaccountno AS new_lvaccountno,
       CASE WHEN c.accountno COLLATE Thai_CI_AS = n.lvaccountno THEN 'MATCH' ELSE 'DIFF' END AS status
     FROM ${OLD}.[conv$vinpllvcithistory] c
     JOIN ${NEW}.[lv$lvhisthsum] n
       ON c.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno
     WHERE c.systemreferenceno LIKE 'CE%'
     ORDER BY c.systemreferenceno, c.id`);

  // For CE rows: compare transactiondate — does cithistory transactiondate pass through?
  await run(pool, 'CE rows: old transactiondate vs new transactiondate (sample)',
    `SELECT TOP 10
       c.systemreferenceno,
       c.transactiondate AS old_txdate,
       n.transactiondate AS new_txdate,
       CASE WHEN c.transactiondate = n.transactiondate THEN 'MATCH' ELSE 'DIFF' END AS status
     FROM ${OLD}.[conv$vinpllvcithistory] c
     JOIN ${NEW}.[lv$lvhisthsum] n
       ON c.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno
     WHERE c.systemreferenceno LIKE 'CE%'
     ORDER BY c.systemreferenceno, c.id`);

  // For CE rows: compare paymentamount old vs new
  await run(pool, 'CE rows: old paymentamount vs new paymentamount (sample)',
    `SELECT TOP 10
       c.systemreferenceno,
       TRY_CAST(c.paymentamount AS decimal(20,4)) AS old_payamt,
       n.paymentamount AS new_payamt,
       CASE WHEN ABS(TRY_CAST(c.paymentamount AS decimal(20,4)) - n.paymentamount) < 0.01 THEN 'MATCH' ELSE 'DIFF' END AS status
     FROM ${OLD}.[conv$vinpllvcithistory] c
     JOIN ${NEW}.[lv$lvhisthsum] n
       ON c.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno
     WHERE c.systemreferenceno LIKE 'CE%'
     ORDER BY c.systemreferenceno, c.id`);

  // For CE rows: compare currentbalanceb4t
  await run(pool, 'CE rows: old currentbalanceb4t vs new currentbalanceb4t (sample)',
    `SELECT TOP 10
       c.systemreferenceno,
       TRY_CAST(c.currentbalanceb4t AS decimal(20,4)) AS old_cb4t,
       n.currentbalanceb4t AS new_cb4t,
       CASE WHEN ABS(TRY_CAST(c.currentbalanceb4t AS decimal(20,4)) - n.currentbalanceb4t) < 0.01 THEN 'MATCH' ELSE 'DIFF' END AS status
     FROM ${OLD}.[conv$vinpllvcithistory] c
     JOIN ${NEW}.[lv$lvhisthsum] n
       ON c.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno
     WHERE c.systemreferenceno LIKE 'CE%'
     ORDER BY c.systemreferenceno, c.id`);

  // For CE rows: compare loantranshostcode
  await run(pool, 'CE rows: old loantranshostcode vs new loantranshostcode (sample)',
    `SELECT TOP 10
       c.systemreferenceno,
       c.loantranshostcode AS old_lthc,
       n.loantranshostcode AS new_lthc,
       CASE WHEN c.loantranshostcode COLLATE Thai_CI_AS = n.loantranshostcode THEN 'MATCH' ELSE 'DIFF' END AS status
     FROM ${OLD}.[conv$vinpllvcithistory] c
     JOIN ${NEW}.[lv$lvhisthsum] n
       ON c.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno
     WHERE c.systemreferenceno LIKE 'CE%'
     ORDER BY c.systemreferenceno, c.id`);

  // ================================================================
  // SECTION K: Multiple accountno per sysref (CE is batch)
  //            Check: how many distinct accounts per CE sysref in cithistory?
  //            vs lvhisthsum for same sysref?
  // ================================================================
  console.log('\n========== SECTION K: accounts per CE sysref — batch detection ==========');

  await run(pool, 'cithistory: distinct accountno per CE sysref (sample 10 sysrefs)',
    `SELECT TOP 10 systemreferenceno,
       COUNT(*) AS cit_rows,
       COUNT(DISTINCT accountno) AS distinct_accounts
     FROM ${OLD}.[conv$vinpllvcithistory]
     WHERE systemreferenceno LIKE 'CE%'
     GROUP BY systemreferenceno
     ORDER BY cit_rows ASC`);

  await run(pool, 'lvhisthsum: distinct lvaccountno per CE sysref (sample 10 sysrefs)',
    `SELECT TOP 10 systemreferenceno,
       COUNT(*) AS lv_rows,
       COUNT(DISTINCT lvaccountno) AS distinct_accounts
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno LIKE 'CE%'
     GROUP BY systemreferenceno
     ORDER BY lv_rows ASC`);

  // ================================================================
  // SECTION L: For a single CE sysref with few accounts — trace all rows
  //            Find a CE sysref with exactly 1 account in both tables.
  // ================================================================
  console.log('\n========== SECTION L: 1:1 account trace (find single-account CE sysref) ==========');

  // Find CE sysrefs with exactly 1 account in cithistory AND in lvhisthsum
  await run(pool, 'CE sysrefs: 1 account in cithistory, check same in lvhisthsum',
    `SELECT TOP 5 c.systemreferenceno, c.accountno
     FROM (
       SELECT systemreferenceno, MIN(accountno) AS accountno
       FROM ${OLD}.[conv$vinpllvcithistory]
       WHERE systemreferenceno LIKE 'CE%'
       GROUP BY systemreferenceno
       HAVING COUNT(DISTINCT accountno) = 1
     ) c
     WHERE EXISTS (
       SELECT 1 FROM ${NEW}.[lv$lvhisthsum] n
       WHERE n.systemreferenceno = c.systemreferenceno COLLATE Thai_CI_AS
     )
     ORDER BY c.systemreferenceno`);

  // Full trace: old cithistory rows vs new lvhisthsum rows for that single-account sysref
  await run(pool, 'cithistory: ALL rows for single-account CE sysref',
    `DECLARE @sysref nvarchar(100), @acct nvarchar(50);
     SELECT TOP 1 @sysref = c.systemreferenceno, @acct = c.accountno
     FROM (
       SELECT systemreferenceno, MIN(accountno) AS accountno
       FROM ${OLD}.[conv$vinpllvcithistory]
       WHERE systemreferenceno LIKE 'CE%'
       GROUP BY systemreferenceno
       HAVING COUNT(DISTINCT accountno) = 1
     ) c
     WHERE EXISTS (
       SELECT 1 FROM ${NEW}.[lv$lvhisthsum] n
       WHERE n.systemreferenceno = c.systemreferenceno COLLATE Thai_CI_AS
     )
     ORDER BY c.systemreferenceno;

     SELECT id, systemreferenceno, accountno, invaccounttype, affectcode, debitcredit,
            loantranshostcode, transactionamount, paymentamount, transactiondate, effectivedate,
            chargetype, doctype, tellerid, noofdays, remark, currentbalanceb4t, interestb4t,
            calprovisionamount, yieldrate, irrrate
     FROM ${OLD}.[conv$vinpllvcithistory]
     WHERE systemreferenceno = @sysref
     ORDER BY id`);

  await run(pool, 'lvhisthsum: ALL rows for same single-account CE sysref',
    `DECLARE @sysref nvarchar(100);
     SELECT TOP 1 @sysref = c.systemreferenceno
     FROM (
       SELECT systemreferenceno, MIN(accountno) AS accountno
       FROM ${OLD}.[conv$vinpllvcithistory]
       WHERE systemreferenceno LIKE 'CE%'
       GROUP BY systemreferenceno
       HAVING COUNT(DISTINCT accountno) = 1
     ) c
     WHERE EXISTS (
       SELECT 1 FROM ${NEW}.[lv$lvhisthsum] n
       WHERE n.systemreferenceno = c.systemreferenceno COLLATE Thai_CI_AS
     )
     ORDER BY c.systemreferenceno;

     SELECT id, systemreferenceno, lvaccountno, affectcode, debitcredit___,
            loantranshostcode, transactionamount, paymentamount, transactiondate, effectivedate,
            chargetype, doctype, tellerid, noofdays, remark, currentbalanceb4t, interestb4t,
            calprovisionamount, yieldrate, irrrate,
            lvcreditprincipleamount, lvdebitprincipleamount,
            lvcreditinterestamount, lvdebitinterestamount,
            lvcreditgaincash, lvdebitgaincash,
            lvcreditgainsettlement, lvdebitgainsettlement,
            lvcreditotherchargeamount, lvdebitotherchargeamount
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno = @sysref
     ORDER BY id`);

  // Also pull vinpllvhistory for same sysref — does vinpllvhistory also contribute?
  await run(pool, 'vinpllvhistory: does same CE sysref appear? (should be 0 if purely cithistory)',
    `DECLARE @sysref nvarchar(100);
     SELECT TOP 1 @sysref = c.systemreferenceno
     FROM (
       SELECT systemreferenceno, MIN(accountno) AS accountno
       FROM ${OLD}.[conv$vinpllvcithistory]
       WHERE systemreferenceno LIKE 'CE%'
       GROUP BY systemreferenceno
       HAVING COUNT(DISTINCT accountno) = 1
     ) c
     WHERE EXISTS (
       SELECT 1 FROM ${NEW}.[lv$lvhisthsum] n
       WHERE n.systemreferenceno = c.systemreferenceno COLLATE Thai_CI_AS
     )
     ORDER BY c.systemreferenceno;

     SELECT COUNT(*) AS cnt
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno = @sysref`);

  await pool.close();
  console.log('\nDone.');
})();
