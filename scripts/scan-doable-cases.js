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
  // CASE 1: vinpllvhistory → lvhisthsum
  // Check: do regular (non-lv*) columns actually match group-level?
  // ================================================================
  console.log('\n========== CASE 1: vinpllvhistory → lvhisthsum (regular columns) ==========');

  // Pick 3 P-prefix sysrefs with exactly 1 new lvhisthsum row (simple case)
  await run(pool, 'Find P-prefix sysrefs with exactly 1 lvhisthsum row',
    `SELECT TOP 5 systemreferenceno, COUNT(*) AS new_row_count
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno LIKE 'P6%'
     GROUP BY systemreferenceno
     HAVING COUNT(*) = 1
     ORDER BY systemreferenceno`);

  // For one of those sysrefs — compare regular columns old vs new
  // Check: transactiondate, effectivedate, accountno, affectcode, tellerid, etc.
  await run(pool, 'vinpllvhistory rows for P6303-005209 (regular cols)',
    `SELECT TOP 3 id, loantranshostcode, affectcode, debitcredit,
            transactiondate, effectivedate, gldate,
            accountno, tellerid, transactionamount, paymentamount,
            currentbalanceb4t, interestb4t
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno = 'P6303-005209'
     ORDER BY id`);

  await run(pool, 'lvhisthsum row for P6303-005209 (regular cols)',
    `SELECT affectcode, debitcredit___, transactiondate, effectivedate, gldate,
            lvaccountno, tellerid, transactionamount, paymentamount,
            currentbalanceb4t, interestb4t,
            lvcreditprincipleamount, lvcreditinterestamount, lvdebitinterestamount
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno = 'P6303-005209'
     ORDER BY id`);

  // How many distinct values per column in old rows for P6303-005209?
  // (to understand: are these columns uniform across old rows, or vary?)
  await run(pool, 'P6303-005209: distinct values per key column in old',
    `SELECT
       COUNT(DISTINCT accountno) AS d_accountno,
       COUNT(DISTINCT transactiondate) AS d_txdate,
       COUNT(DISTINCT effectivedate) AS d_effdate,
       COUNT(DISTINCT gldate) AS d_gldate,
       COUNT(DISTINCT tellerid) AS d_tellerid,
       COUNT(DISTINCT TRY_CAST(currentbalanceb4t AS decimal(20,4))) AS d_balance,
       COUNT(DISTINCT TRY_CAST(interestb4t AS decimal(20,4))) AS d_interest,
       COUNT(*) AS total_rows
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno = 'P6303-005209'`);

  // Pick a sysref with multiple new rows to understand structure
  await run(pool, 'Find sysrefs with 3+ new lvhisthsum rows (P-prefix)',
    `SELECT TOP 3 systemreferenceno, COUNT(*) AS new_rows
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno LIKE 'P6%'
     GROUP BY systemreferenceno
     HAVING COUNT(*) >= 3
     ORDER BY new_rows DESC`);

  // ================================================================
  // CASE 1b: lv* formula verification on a CE-prefix sysref
  // ================================================================
  console.log('\n========== CASE 1b: CE-prefix sysref lv* formula check ==========');

  // Find a CE sysref with only a few rows (manageable trace)
  await run(pool, 'Find small CE sysref in vinpllvhistory',
    `SELECT TOP 3 systemreferenceno, COUNT(*) AS cnt
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno LIKE 'CE%'
     GROUP BY systemreferenceno
     HAVING COUNT(*) <= 5
     ORDER BY cnt DESC`);

  // ================================================================
  // CASE 2: cithistory → lvhisthsum
  // Which cithistory sysrefs actually have non-zero data in lvhisthsum?
  // ================================================================
  console.log('\n========== CASE 2: cithistory → lvhisthsum ==========');

  // Find cithistory sysrefs that appear in lvhisthsum with non-zero values
  await run(pool, 'cithistory sysrefs in lvhisthsum with non-zero lv* or transactionamount',
    `SELECT TOP 5 n.systemreferenceno,
            n.lvcreditprincipleamount, n.lvdebitprincipleamount,
            n.lvcreditinterestamount, n.lvdebitinterestamount,
            n.transactionamount, n.paymentamount
     FROM ${NEW}.[lv$lvhisthsum] n
     WHERE (n.lvcreditprincipleamount != 0 OR n.lvdebitprincipleamount != 0
         OR n.lvcreditinterestamount != 0 OR n.lvdebitinterestamount != 0
         OR n.transactionamount != 0)
       AND EXISTS (
         SELECT 1 FROM ${OLD}.[conv$vinpllvcithistory] c
         WHERE c.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno
       )
       AND NOT EXISTS (
         SELECT 1 FROM ${OLD}.[conv$vinpllvhistory] o
         WHERE o.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno
       )`);

  // What columns does cithistory actually populate in lvhisthsum?
  // Take a cithistory-matched sysref and compare columns
  await run(pool, 'cithistory: sample non-zero rows (what cols have data?)',
    `SELECT TOP 5 systemreferenceno, invaccounttype,
            TRY_CAST(transactionamount AS decimal(20,4)) AS txamt,
            TRY_CAST(paymentamount AS decimal(20,4)) AS payamt,
            affectcode, debitcredit,
            transactiondate, effectivedate
     FROM ${OLD}.[conv$vinpllvcithistory]
     WHERE TRY_CAST(transactionamount AS decimal(20,4)) != 0
       AND systemreferenceno NOT LIKE 'CE%'
     ORDER BY id`);

  // How many cithistory rows have non-zero transactionamount?
  await run(pool, 'cithistory: count rows with non-zero transactionamount',
    `SELECT invaccounttype,
            COUNT(*) AS total_rows,
            SUM(CASE WHEN TRY_CAST(transactionamount AS decimal(20,4)) != 0 THEN 1 ELSE 0 END) AS nonzero_txamt,
            SUM(CASE WHEN affectcode IS NOT NULL THEN 1 ELSE 0 END) AS has_affectcode
     FROM ${OLD}.[conv$vinpllvcithistory]
     GROUP BY invaccounttype`);

  // ================================================================
  // CASE 2b: What columns in lvhisthsum are populated by cithistory-only sysrefs?
  // ================================================================
  await run(pool, 'lvhisthsum: column fill rates for non-P sysrefs',
    `SELECT
       SUM(CASE WHEN lvcreditprincipleamount  != 0 THEN 1 ELSE 0 END) AS pp_c,
       SUM(CASE WHEN lvdebitprincipleamount   != 0 THEN 1 ELSE 0 END) AS pp_d,
       SUM(CASE WHEN lvcreditinterestamount   != 0 THEN 1 ELSE 0 END) AS int_c,
       SUM(CASE WHEN lvdebitinterestamount    != 0 THEN 1 ELSE 0 END) AS int_d,
       SUM(CASE WHEN lvcreditgaincash         != 0 THEN 1 ELSE 0 END) AS gc_c,
       SUM(CASE WHEN lvcreditgainsettlement   != 0 THEN 1 ELSE 0 END) AS gs_c,
       SUM(CASE WHEN lvcreditotherchargeamount!= 0 THEN 1 ELSE 0 END) AS of_c,
       SUM(CASE WHEN transactionamount        != 0 THEN 1 ELSE 0 END) AS txamt,
       COUNT(*) AS total
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno NOT LIKE 'P%'
       AND systemreferenceno NOT LIKE 'ADC%'`);

  // Same but for P-prefix rows only (baseline)
  await run(pool, 'lvhisthsum: column fill rates for P-prefix sysrefs only',
    `SELECT
       SUM(CASE WHEN lvcreditprincipleamount  != 0 THEN 1 ELSE 0 END) AS pp_c,
       SUM(CASE WHEN lvdebitprincipleamount   != 0 THEN 1 ELSE 0 END) AS pp_d,
       SUM(CASE WHEN lvcreditinterestamount   != 0 THEN 1 ELSE 0 END) AS int_c,
       SUM(CASE WHEN lvdebitinterestamount    != 0 THEN 1 ELSE 0 END) AS int_d,
       SUM(CASE WHEN lvcreditgaincash         != 0 THEN 1 ELSE 0 END) AS gc_c,
       SUM(CASE WHEN lvcreditgainsettlement   != 0 THEN 1 ELSE 0 END) AS gs_c,
       SUM(CASE WHEN lvcreditotherchargeamount!= 0 THEN 1 ELSE 0 END) AS of_c,
       SUM(CASE WHEN transactionamount        != 0 THEN 1 ELSE 0 END) AS txamt,
       COUNT(*) AS total
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno LIKE 'P%'`);

  // ================================================================
  // CASE 3: How many rows per sysref in lvhisthsum? (grouping pattern)
  // Need to understand: 1 new row per old group, or multiple?
  // ================================================================
  console.log('\n========== CASE 3: New row count per sysref in lvhisthsum ==========');

  await run(pool, 'lvhisthsum: distribution of rows-per-sysref',
    `SELECT new_row_count, COUNT(*) AS sysref_count
     FROM (
       SELECT systemreferenceno, COUNT(*) AS new_row_count
       FROM ${NEW}.[lv$lvhisthsum]
       WHERE systemreferenceno LIKE 'P6%'
       GROUP BY systemreferenceno
     ) t
     GROUP BY new_row_count
     ORDER BY new_row_count`);

  // Same for CE-prefix
  await run(pool, 'lvhisthsum: rows-per-sysref distribution for CE-prefix',
    `SELECT new_row_count, COUNT(*) AS sysref_count
     FROM (
       SELECT systemreferenceno, COUNT(*) AS new_row_count
       FROM ${NEW}.[lv$lvhisthsum]
       WHERE systemreferenceno LIKE 'CE%'
       GROUP BY systemreferenceno
     ) t
     GROUP BY new_row_count
     ORDER BY new_row_count`);

  await pool.close();
  console.log('\nDone.');
})();
