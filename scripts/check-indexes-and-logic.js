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
    if (!r.recordset || r.recordset.length === 0) console.log('  (no rows / no indexes)');
    else r.recordset.forEach((row, i) => console.log(`  [${i}] ${JSON.stringify(row)}`));
  } catch(e) {
    console.log(`  ERROR: ${e.message}`);
  }
}

// Check indexes on a table — shows PK, unique, and regular indexes with their key columns
async function checkIndexes(pool, db, table) {
  await run(pool, `INDEX CHECK: [${db}].dbo.[${table}]`,
    `SELECT
       i.name                                                    AS index_name,
       i.type_desc                                               AS type,
       CASE WHEN i.is_primary_key = 1 THEN 'YES' ELSE 'NO' END  AS is_pk,
       CASE WHEN i.is_unique      = 1 THEN 'YES' ELSE 'NO' END  AS is_unique,
       (SELECT STRING_AGG(c2.name, ', ') WITHIN GROUP (ORDER BY ic2.key_ordinal)
        FROM [${db}].sys.index_columns ic2
        JOIN [${db}].sys.columns c2
          ON ic2.object_id = c2.object_id AND ic2.column_id = c2.column_id
        WHERE ic2.object_id = i.object_id
          AND ic2.index_id  = i.index_id
          AND ic2.is_included_column = 0) AS key_columns
     FROM [${db}].sys.indexes  i
     JOIN [${db}].sys.objects   o ON i.object_id = o.object_id
     JOIN [${db}].sys.schemas   s ON o.schema_id = s.schema_id
     WHERE o.name  = '${table}'
       AND s.name  = 'dbo'
       AND i.type  > 0          -- exclude heap (type=0)
     ORDER BY i.is_primary_key DESC, i.index_id`);
}

(async () => {
  const pool = await sql.connect(config);
  const OLD = 'ncs-conv-aging';
  const NEW = 'ncs-npl-aging';

  // ================================================================
  // PART 1 — INDEX CHECKS (all tables used by our rules)
  // Goal: confirm which columns are indexed so we know if
  //       keyset pagination (id) and target lookup (sysref) are fast.
  // ================================================================
  console.log('\n\n========== PART 1: INDEX CHECKS ==========');

  // --- OLD TABLES ---
  await checkIndexes(pool, OLD, 'conv$vinplhistory');          // rights_npl case 1
  await checkIndexes(pool, OLD, 'conv$vinplsbthistory');       // rights_npl cases 2 & 3
  await checkIndexes(pool, OLD, 'conv$vinpllvcithistory');     // invest_lv cases 1,3,4,5
  await checkIndexes(pool, OLD, 'conv$vinpllvhistory');        // invest_lv cases 2 & 6

  // --- NEW TABLES ---
  await checkIndexes(pool, NEW, 'ln$lnhistloantransactionhistory');      // rights_npl case 1
  await checkIndexes(pool, NEW, 'ln$lnhisthloantransactionhistoryh');    // rights_npl cases 2 & 3
  await checkIndexes(pool, NEW, 'lv$lvhisthinvtransactionhistoryh');     // invest_lv case 1
  await checkIndexes(pool, NEW, 'lv$lvhisthsum');                        // invest_lv case 2
  await checkIndexes(pool, NEW, 'lv$lvhisth_fbo');                       // invest_lv case 3
  await checkIndexes(pool, NEW, 'lv$lvhisth_truesale');                  // invest_lv case 4
  await checkIndexes(pool, NEW, 'lv$lvhisth_fbo_truesale');              // invest_lv case 5
  await checkIndexes(pool, NEW, 'lv$lvhistinvtransactionhistory');       // invest_lv case 6

  // ================================================================
  // PART 2 — BUSINESS LOGIC TRACE: lv$lvhisthsum (invest_lv Case 2)
  //
  // lvhisthsum is a summary/pivot table. Each sysref produces 1 row
  // in new (wide format) from N rows in old (long format, debitcredit=C/D).
  // Goal: find 1 sysref, show all old rows + the 1 new row side by side
  //       to understand how each calculated column was derived.
  // ================================================================
  console.log('\n\n========== PART 2: lvhisthsum BUSINESS LOGIC TRACE ==========');

  // Pick a P-prefix sysref that exists in both tables and has non-trivial data
  await run(pool, 'LVSUM-1: find a P-prefix sysref with multiple old rows and non-zero amounts',
    `SELECT TOP 5
       o.systemreferenceno,
       COUNT(*)                                   AS old_row_count,
       COUNT(DISTINCT o.debitcredit)              AS distinct_dc,
       SUM(TRY_CAST(o.transactionamount AS decimal(20,8))) AS sum_txamt
     FROM [${OLD}].dbo.[conv$vinpllvhistory] o
     WHERE o.systemreferenceno LIKE 'P%'
       AND TRY_CAST(o.transactionamount AS decimal(20,8)) != 0
     GROUP BY o.systemreferenceno
     HAVING COUNT(*) > 1 AND COUNT(DISTINCT o.debitcredit) > 1
     ORDER BY SUM(TRY_CAST(o.transactionamount AS decimal(20,8))) DESC`);

  // --- Use a known active sysref. We'll pick from the result above or hardcode a known one ---
  // Using P6303-005209 (confirmed from earlier C1c query to have multiple rows)
  const SYSREF = 'P6303-005209';

  await run(pool, `LVSUM-2: ALL old rows for sysref [${SYSREF}] (full detail)`,
    `SELECT
       id, systemreferenceno, debitcredit, affectcode,
       TRY_CAST(transactionamount     AS decimal(20,8)) AS transactionamount,
       TRY_CAST(paymentamount         AS decimal(20,8)) AS paymentamount,
       TRY_CAST(currentbalanceb4t     AS decimal(20,8)) AS currentbalanceb4t,
       TRY_CAST(interestb4t           AS decimal(20,8)) AS interestb4t,
       TRY_CAST(gaincashbalanceb4t    AS decimal(20,8)) AS gaincashbalanceb4t,
       TRY_CAST(gainsettlementbalanceb4t AS decimal(20,8)) AS gainsettlementbalanceb4t,
       TRY_CAST(yieldrate             AS decimal(20,8)) AS yieldrate,
       TRY_CAST(irrrate               AS decimal(20,8)) AS irrrate,
       TRY_CAST(calculateintrate      AS decimal(20,8)) AS calculateintrate,
       TRY_CAST(calprovisionamount    AS decimal(20,8)) AS calprovisionamount,
       tellerid, loantranshostcode, doctype, auxilarytransaction, inputsourcesystem
     FROM [${OLD}].dbo.[conv$vinpllvhistory]
     WHERE systemreferenceno = '${SYSREF}'
     ORDER BY id`);

  await run(pool, `LVSUM-3: lvhisthsum row for sysref [${SYSREF}] (key calculated columns)`,
    `SELECT
       systemreferenceno,
       -- Credit/Debit split columns
       lvcreditprincipleamount, lvdebitprincipleamount,
       lvcreditgaincash,        lvdebitgaincash,
       lvcreditgainsettlement,  lvdebitgainsettlement,
       lvcreditinterestamount,  lvdebitinterestamount,
       lvcreditmischargeamount, lvdebitmischargeamount,
       lvcreditotherchargeamount, lvdebitotherchargeamount,
       -- Format (net) columns
       lvformatprincipleamount, lvformatgaincash, lvformatgainsettlement,
       lvformatinterestamount,  lvformatotherchargeamount, lvformattotalgain,
       -- Balance b4t columns (should match old running balance columns)
       currentbalanceb4t, gaincashbalanceb4t, gainsettlementbalanceb4t,
       interestb4t, miscchargeamountb4t, otherchargeamountb4t,
       -- Transaction amount
       transactionamount, paymentamount,
       -- Rates
       yieldrate, irrrate, calculateintrate, ceir, calprovisionamount
     FROM [${NEW}].dbo.[lv$lvhisthsum]
     WHERE systemreferenceno = '${SYSREF}'`);

  // Cross-check: manually verify the credit/debit split calculation
  await run(pool, `LVSUM-4: verify lvcreditprincipleamount = SUM(old.transactionamount WHERE debitcredit=C)`,
    `SELECT
       'transactionamount' AS column_pair,
       SUM(CASE WHEN o.debitcredit = 'C' THEN TRY_CAST(o.transactionamount AS decimal(20,8)) ELSE 0 END) AS old_credit_sum,
       SUM(CASE WHEN o.debitcredit = 'D' THEN TRY_CAST(o.transactionamount AS decimal(20,8)) ELSE 0 END) AS old_debit_sum,
       MAX(n.lvcreditprincipleamount) AS new_lvcredit,
       MAX(n.lvdebitprincipleamount)  AS new_lvdebit,
       MAX(n.lvformatprincipleamount) AS new_lvformat
     FROM [${OLD}].dbo.[conv$vinpllvhistory] o
     JOIN [${NEW}].dbo.[lv$lvhisthsum]       n
       ON o.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno COLLATE Thai_CI_AS
     WHERE o.systemreferenceno = '${SYSREF}'`);

  // Same check for interest, gaincash, gainsettlement
  await run(pool, `LVSUM-5: verify interest and gain credit/debit split`,
    `SELECT
       SUM(CASE WHEN o.debitcredit='C' THEN TRY_CAST(o.transactionamount AS decimal(20,8)) ELSE 0 END) AS old_tx_C,
       SUM(CASE WHEN o.debitcredit='D' THEN TRY_CAST(o.transactionamount AS decimal(20,8)) ELSE 0 END) AS old_tx_D,
       SUM(CASE WHEN o.debitcredit='C' THEN TRY_CAST(o.gaincashbalanceb4t AS decimal(20,8)) ELSE 0 END) AS old_gaincash_C,
       SUM(CASE WHEN o.debitcredit='D' THEN TRY_CAST(o.gaincashbalanceb4t AS decimal(20,8)) ELSE 0 END) AS old_gaincash_D,
       MAX(n.lvcreditgaincash)   AS new_lvcreditgaincash,
       MAX(n.lvdebitgaincash)    AS new_lvdebitgaincash,
       MAX(n.lvcreditinterestamount) AS new_lvcreditinterest,
       MAX(n.lvdebitinterestamount)  AS new_lvdebitinterest,
       MAX(n.currentbalanceb4t)      AS new_currentbalanceb4t,
       MAX(TRY_CAST(o.currentbalanceb4t AS decimal(20,8))) AS old_currentbalanceb4t,
       MAX(n.interestb4t)            AS new_interestb4t,
       MAX(TRY_CAST(o.interestb4t AS decimal(20,8)))       AS old_interestb4t
     FROM [${OLD}].dbo.[conv$vinpllvhistory] o
     JOIN [${NEW}].dbo.[lv$lvhisthsum]       n
       ON o.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno COLLATE Thai_CI_AS
     WHERE o.systemreferenceno = '${SYSREF}'`);

  // Test on 3 more sysrefs to confirm the pattern holds generally
  await run(pool, 'LVSUM-6: verify same pattern on 3 more P-prefix sysrefs',
    `SELECT TOP 3
       o.systemreferenceno,
       SUM(CASE WHEN o.debitcredit='C' THEN TRY_CAST(o.transactionamount AS decimal(20,8)) ELSE 0 END) AS old_tx_C,
       MAX(n.lvcreditprincipleamount) AS new_lvcredit,
       SUM(CASE WHEN o.debitcredit='D' THEN TRY_CAST(o.transactionamount AS decimal(20,8)) ELSE 0 END) AS old_tx_D,
       MAX(n.lvdebitprincipleamount)  AS new_lvdebit,
       CASE WHEN ABS(
         SUM(CASE WHEN o.debitcredit='C' THEN TRY_CAST(o.transactionamount AS decimal(20,8)) ELSE 0 END)
         - MAX(n.lvcreditprincipleamount)) < 0.01
       THEN 'MATCH' ELSE 'MISMATCH' END AS credit_match,
       CASE WHEN ABS(
         SUM(CASE WHEN o.debitcredit='D' THEN TRY_CAST(o.transactionamount AS decimal(20,8)) ELSE 0 END)
         - MAX(n.lvdebitprincipleamount)) < 0.01
       THEN 'MATCH' ELSE 'MISMATCH' END AS debit_match
     FROM [${OLD}].dbo.[conv$vinpllvhistory] o
     JOIN [${NEW}].dbo.[lv$lvhisthsum]       n
       ON o.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno COLLATE Thai_CI_AS
     WHERE o.systemreferenceno LIKE 'P%'
       AND TRY_CAST(o.transactionamount AS decimal(20,8)) != 0
     GROUP BY o.systemreferenceno
     HAVING COUNT(*) > 1
     ORDER BY o.systemreferenceno`);

  // ================================================================
  // PART 3 — lvhistinvtransactionhistory (invest_lv Case 6)
  //   This is the DETAIL table (1 row per old row, no pivot).
  //   Check if the lv credit/debit columns map directly or need logic.
  // ================================================================
  console.log('\n\n========== PART 3: lvhistinvtransactionhistory LOGIC TRACE ==========');

  await run(pool, `LVTX-1: sample join old→new for sysref [${SYSREF}]`,
    `SELECT TOP 10
       o.id              AS old_id,
       o.systemreferenceno,
       o.debitcredit,
       TRY_CAST(o.transactionamount  AS decimal(20,8)) AS old_txamt,
       TRY_CAST(o.paymentamount      AS decimal(20,8)) AS old_payamt,
       TRY_CAST(o.currentbalanceb4t  AS decimal(20,8)) AS old_cbalb4t,
       n.transactionamount  AS new_txamt,
       n.paymentamount      AS new_payamt,
       n.currentbalanceb4t  AS new_cbalb4t,
       n.lvaccountno,
       n.expensecode
     FROM [${OLD}].dbo.[conv$vinpllvhistory] o
     JOIN [${NEW}].dbo.[lv$lvhistinvtransactionhistory] n
       ON o.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno COLLATE Thai_CI_AS
     WHERE o.systemreferenceno = '${SYSREF}'
     ORDER BY o.id`);

  // ================================================================
  // PART 4 — ln$lnhistloantransactionhistory (rights_npl Case 1)
  //   Check a sysref with multiple old rows: does new have same count?
  // ================================================================
  console.log('\n\n========== PART 4: lnhistloantransactionhistory LOGIC TRACE ==========');

  await run(pool, 'LNTX-1: find a sysref with multiple old rows',
    `SELECT TOP 3
       systemreferencenumber,
       COUNT(*) AS old_row_count
     FROM [${OLD}].dbo.[conv$vinplhistory]
     WHERE systemreferencenumber IS NOT NULL AND systemreferencenumber != ''
     GROUP BY systemreferencenumber
     HAVING COUNT(*) > 1
     ORDER BY COUNT(*) DESC`);

  await run(pool, 'LNTX-2: sample join old→new — check row count and key columns',
    `SELECT TOP 10
       o.id, o.systemreferencenumber AS old_sysref,
       o.debitcredit, o.affectcode,
       TRY_CAST(o.transactionamount AS decimal(20,8)) AS old_txamt,
       TRY_CAST(o.currentbalanceb4t AS decimal(20,8)) AS old_cbalb4t,
       n.systemreferenceno AS new_sysref,
       n.transactionamount AS new_txamt,
       n.currentbalanceb4t AS new_cbalb4t,
       n.accountno
     FROM [${OLD}].dbo.[conv$vinplhistory]             o
     JOIN [${NEW}].dbo.[ln$lnhistloantransactionhistory] n
       ON o.systemreferencenumber COLLATE Thai_CI_AS = n.systemreferenceno COLLATE Thai_CI_AS
     WHERE o.systemreferencenumber IN (
       SELECT TOP 1 systemreferencenumber
       FROM [${OLD}].dbo.[conv$vinplhistory]
       GROUP BY systemreferencenumber HAVING COUNT(*) > 1
       ORDER BY COUNT(*) DESC)
     ORDER BY o.id`);

  // ================================================================
  // PART 5 — ln$lnhisthloantransactionhistoryh (rights_npl Case 2)
  //   Already analyzed but confirm: how many H rows per sysref?
  //   Are transactionamount/totaltax stored in only 1 H row?
  // ================================================================
  console.log('\n\n========== PART 5: lnhisthloantransactionhistoryh LOGIC TRACE ==========');

  await run(pool, 'LNHH-1: find a normal sysref (non-ADJ) with non-zero interestpaid in sbt',
    `SELECT TOP 3
       systemreferenceno,
       TRY_CAST(interestpaid AS decimal(20,8)) AS interestpaid,
       TRY_CAST(sbttotalamount AS decimal(20,8)) AS sbttotalamount
     FROM [${OLD}].dbo.[conv$vinplsbthistory]
     WHERE systemreferenceno NOT LIKE 'ADJ-%'
       AND TRY_CAST(interestpaid AS decimal(20,8)) != 0
     ORDER BY id`);

  await run(pool, 'LNHH-2: H rows for that sysref — confirm credit/debit structure',
    `SELECT
       n.systemreferenceno,
       n.creditinterestamount,
       n.debitinterestamount,
       n.totaltax,
       n.sbtamount,
       n.localtax,
       n.transactionamount,
       n.currentbalanceb4t,
       n.interestb4t,
       o.interestpaid      AS old_interestpaid,
       o.sbttotalamount    AS old_sbttotalamount,
       o.sbtrevenue        AS old_sbtrevenue,
       o.sbtrevenueamount  AS old_sbtrevenueamount,
       o.interestb4t       AS old_interestb4t
     FROM [${OLD}].dbo.[conv$vinplsbthistory] o
     JOIN [${NEW}].dbo.[ln$lnhisthloantransactionhistoryh] n
       ON o.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno COLLATE Thai_CI_AS
     WHERE o.systemreferenceno IN (
       SELECT TOP 1 systemreferenceno FROM [${OLD}].dbo.[conv$vinplsbthistory]
       WHERE systemreferenceno NOT LIKE 'ADJ-%'
         AND TRY_CAST(interestpaid AS decimal(20,8)) != 0
       ORDER BY id)
     ORDER BY n.creditinterestamount DESC`);

  await pool.close();
  console.log('\nDone.');
})();
