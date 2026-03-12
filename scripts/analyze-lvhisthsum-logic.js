const sql = require('mssql');
require('dotenv').config();
const strip = (v) => (v || '').replace(/^["']|["']$/g, '');
const allCodes = require('../rules/global/transactioncode.json');

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

  // ----------------------------------------------------------------
  // PART 1: What does lv$lvhisthsum actually look like per-row?
  // Get affectcode + debitcredit___ + which lv* col is non-zero
  // ----------------------------------------------------------------
  console.log('\n========== PART 1: lvhisthsum per-row structure ==========');

  await run(pool, 'lvhisthsum: affectcode+debitcredit___ distribution',
    `SELECT affectcode, debitcredit___, COUNT(*) AS cnt
     FROM ${NEW}.[lv$lvhisthsum]
     GROUP BY affectcode, debitcredit___
     ORDER BY cnt DESC`);

  await run(pool, 'lvhisthsum: which lv* col is non-zero per (affectcode, debitcredit___)',
    `SELECT affectcode, debitcredit___,
       SUM(CASE WHEN lvcreditprincipleamount   != 0 THEN 1 ELSE 0 END) AS creditpp,
       SUM(CASE WHEN lvdebitprincipleamount     != 0 THEN 1 ELSE 0 END) AS debitpp,
       SUM(CASE WHEN lvcreditgaincash           != 0 THEN 1 ELSE 0 END) AS creditgcash,
       SUM(CASE WHEN lvdebitgaincash            != 0 THEN 1 ELSE 0 END) AS debitgcash,
       SUM(CASE WHEN lvcreditgainsettlement     != 0 THEN 1 ELSE 0 END) AS creditgsettle,
       SUM(CASE WHEN lvdebitgainsettlement      != 0 THEN 1 ELSE 0 END) AS debitgsettle,
       SUM(CASE WHEN lvcreditinterestamount     != 0 THEN 1 ELSE 0 END) AS creditint,
       SUM(CASE WHEN lvdebitinterestamount      != 0 THEN 1 ELSE 0 END) AS debitint,
       SUM(CASE WHEN lvcreditmischargeamount    != 0 THEN 1 ELSE 0 END) AS creditmf,
       SUM(CASE WHEN lvdebitmischargeamount     != 0 THEN 1 ELSE 0 END) AS debitmf,
       SUM(CASE WHEN lvcreditotherchargeamount  != 0 THEN 1 ELSE 0 END) AS creditof,
       SUM(CASE WHEN lvdebitotherchargeamount   != 0 THEN 1 ELSE 0 END) AS debitof,
       COUNT(*) AS total_rows
     FROM ${NEW}.[lv$lvhisthsum]
     GROUP BY affectcode, debitcredit___
     ORDER BY total_rows DESC`);

  // ----------------------------------------------------------------
  // PART 2: New rows for P6303-005209 with full columns including affectcode
  // ----------------------------------------------------------------
  console.log('\n========== PART 2: P6303-005209 full new row trace ==========');

  await run(pool, 'NEW lvhisthsum for P6303-005209 — affectcode + debitcredit___ + all lv* cols',
    `SELECT affectcode, debitcredit___,
            lvcreditprincipleamount, lvdebitprincipleamount,
            lvcreditgaincash, lvdebitgaincash,
            lvcreditgainsettlement, lvdebitgainsettlement,
            lvcreditinterestamount, lvdebitinterestamount,
            lvcreditmischargeamount, lvdebitmischargeamount,
            lvcreditotherchargeamount, lvdebitotherchargeamount,
            transactionamount, paymentamount, currentbalanceb4t
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno = 'P6303-005209'
     ORDER BY id`);

  // ----------------------------------------------------------------
  // PART 3: For sysrefs with gaincash/gainsettlement — trace old→new
  // ----------------------------------------------------------------
  console.log('\n========== PART 3: gaincash / gainsettlement trace ==========');

  await run(pool, 'OLD rows for P6102-009721',
    `SELECT loantranshostcode, affectcode, debitcredit, transactionamount, paymentamount
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno = 'P6102-009721'
     ORDER BY id`);

  await run(pool, 'NEW lvhisthsum for P6102-009721',
    `SELECT affectcode, debitcredit___,
            lvcreditprincipleamount, lvdebitprincipleamount,
            lvcreditgaincash, lvdebitgaincash,
            lvcreditgainsettlement, lvdebitgainsettlement,
            lvcreditinterestamount, lvdebitinterestamount,
            transactionamount, paymentamount
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno = 'P6102-009721'
     ORDER BY id`);

  // ----------------------------------------------------------------
  // PART 4: For sysrefs with othercharge — trace old→new
  // ----------------------------------------------------------------
  console.log('\n========== PART 4: othercharge (OF/CF) trace ==========');

  await run(pool, 'OLD rows for P6401-909712',
    `SELECT loantranshostcode, affectcode, debitcredit, transactionamount, paymentamount
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno = 'P6401-909712'
     ORDER BY id`);

  await run(pool, 'NEW lvhisthsum for P6401-909712',
    `SELECT affectcode, debitcredit___,
            lvcreditprincipleamount, lvdebitprincipleamount,
            lvcreditgaincash, lvdebitgaincash,
            lvcreditgainsettlement, lvdebitgainsettlement,
            lvcreditinterestamount, lvdebitinterestamount,
            lvcreditmischargeamount, lvdebitmischargeamount,
            lvcreditotherchargeamount, lvdebitotherchargeamount,
            transactionamount, paymentamount
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno = 'P6401-909712'
     ORDER BY id`);

  // ----------------------------------------------------------------
  // PART 5: What are loantranshostcodes 24100, 25100, 26100, 24200, 25200, 26200?
  // These are common but NOT in transactioncode.json
  // ----------------------------------------------------------------
  console.log('\n========== PART 5: Unknown loantranshostcodes 24100, 25100, etc. ==========');

  await run(pool, 'Sample old rows with loantranshostcode 24100',
    `SELECT TOP 3 loantranshostcode, affectcode, debitcredit, transactionamount, systemreferenceno
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE loantranshostcode = '24100' AND (systemreferenceno LIKE 'P%' OR systemreferenceno LIKE 'ADC%')
     ORDER BY id`);

  await run(pool, 'Sample old rows with loantranshostcode 25100',
    `SELECT TOP 3 loantranshostcode, affectcode, debitcredit, transactionamount, systemreferenceno
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE loantranshostcode = '25100' AND (systemreferenceno LIKE 'P%' OR systemreferenceno LIKE 'ADC%')
     ORDER BY id`);

  // Trace one of those sysrefs to see if 24100/25100 rows end up in lvhisthsum
  await run(pool, 'All old rows for sysref containing 24100/25100 — check if new lvhisthsum has them',
    `SELECT o.loantranshostcode, o.affectcode, o.debitcredit, o.transactionamount,
            n.affectcode AS new_affect, n.debitcredit___ AS new_dc,
            n.lvcreditinterestamount, n.lvdebitinterestamount,
            n.lvcreditmischargeamount, n.lvdebitmischargeamount,
            n.lvcreditotherchargeamount, n.lvdebitotherchargeamount
     FROM ${OLD}.[conv$vinpllvhistory] o
     LEFT JOIN ${NEW}.[lv$lvhisthsum] n ON o.systemreferenceno = n.systemreferenceno
     WHERE o.systemreferenceno = (
       SELECT TOP 1 systemreferenceno FROM ${OLD}.[conv$vinpllvhistory]
       WHERE loantranshostcode = '24100' AND systemreferenceno LIKE 'P%'
     )
     ORDER BY o.id, n.id`);

  // ----------------------------------------------------------------
  // PART 6: Verify the mapping hypothesis:
  // old.transactionamount WHERE (consolidate=C, affectcode=X, debitcredit=C) → lvcreditXamount
  // Test: for P6303-005209 — does SUM(old txamt WHERE affectcode=I1,dc=C,consolidate=C) = lvcreditinterestamount?
  // Also test: does SUM(old txamt WHERE affectcode=I1,dc=C) - (20000 row) match?
  // ----------------------------------------------------------------
  console.log('\n========== PART 6: Hypothesis — which old rows sum to each lv* col ==========');

  // For P6303-005209: what's the SUM per (affectcode, debitcredit) group — all consolidate=C rows
  // Exclude consolidate=N loantranshostcodes: 80000, 81000, 90000, 99000, 82100, 92090, 21300, 21400, 29300, 29400
  const excludeTCs = ['80000','81000','90000','99000','82100','92090','21300','21400','29300','29400'];
  const excList = excludeTCs.map(t => `'${t}'`).join(',');

  await run(pool, `P6303-005209: SUM(old txamt) per (affectcode, debitcredit) — consolidate=C only`,
    `SELECT affectcode, debitcredit,
            SUM(TRY_CAST(transactionamount AS decimal(20,4))) AS sum_txamt,
            COUNT(*) AS cnt
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno = 'P6303-005209'
       AND loantranshostcode NOT IN (${excList})
     GROUP BY affectcode, debitcredit
     ORDER BY affectcode, debitcredit`);

  await run(pool, 'P6303-005209: NEW lvcredit*/lvdebit* col values for comparison',
    `SELECT affectcode, debitcredit___,
            lvcreditprincipleamount, lvdebitprincipleamount,
            lvcreditinterestamount, lvdebitinterestamount,
            lvcreditotherchargeamount, lvdebitotherchargeamount,
            lvcreditmischargeamount, lvdebitmischargeamount,
            lvcreditgaincash, lvdebitgaincash
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno = 'P6303-005209'`);

  // Test on a richer sysref (more lv* columns filled)
  await run(pool, 'P6102-009721: SUM(old txamt) per (affectcode, debitcredit) — consolidate=C only',
    `SELECT affectcode, debitcredit,
            SUM(TRY_CAST(transactionamount AS decimal(20,4))) AS sum_txamt,
            COUNT(*) AS cnt
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno = 'P6102-009721'
       AND loantranshostcode NOT IN (${excList})
     GROUP BY affectcode, debitcredit
     ORDER BY affectcode, debitcredit`);

  await run(pool, 'P6102-009721: NEW lvhisthsum rows for comparison',
    `SELECT affectcode, debitcredit___,
            lvcreditprincipleamount, lvdebitprincipleamount,
            lvcreditgaincash, lvdebitgaincash,
            lvcreditgainsettlement, lvdebitgainsettlement,
            lvcreditinterestamount, lvdebitinterestamount,
            lvcreditotherchargeamount, lvdebitotherchargeamount
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno = 'P6102-009721'`);

  await pool.close();
  console.log('\nDone.');
})();
