const sql = require('mssql');
require('dotenv').config();
const strip = (v) => (v || '').replace(/^["']|["']$/g, '');
const codes = require('../rules/global/transactioncode.json');

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

// ----------------------------------------------------------------
// PART 1: Analyze transactioncode.json
// ----------------------------------------------------------------
console.log('\n========== PART 1: transactioncode.json analysis ==========');

const cCodes = codes.filter(c => c.newlinehistconsolidate === 'C');
const nCodes = codes.filter(c => c.newlinehistconsolidate === 'N');

// Group consolidate=C by (affectcode, debitorcredit)
const grouped = {};
cCodes.forEach(c => {
  const key = (c.affectcode || 'EMPTY') + '|' + c.debitorcredit;
  if (!grouped[key]) grouped[key] = [];
  grouped[key].push(c.transactioncode);
});

console.log('\n--- consolidate=C grouped by (affectcode, D/C) ---');
Object.entries(grouped).sort().forEach(([k, v]) => {
  const [aff, dc] = k.split('|');
  console.log(JSON.stringify({ affectcode: aff, debit_credit: dc, tc_count: v.length, loantranshostcodes: v.slice(0, 10) }));
});

console.log('\n--- consolidate=N codes (excluded from lvhisthsum) ---');
nCodes.forEach(c => {
  console.log(JSON.stringify({ tc: c.transactioncode, desc: c.descriptionen, affect: c.affectcode, dc: c.debitorcredit }));
});

// Affectcodes in transactioncode.json NOT in affect_codes.json
const knownAffectCodes = require('../rules/global/affect_codes.json').codes.map(c => c.code);
const tcAffectCodes = [...new Set(codes.map(c => c.affectcode).filter(Boolean))];
const missing = tcAffectCodes.filter(a => !knownAffectCodes.includes(a));
console.log('\n--- affectcodes in transactioncode.json NOT in affect_codes.json ---');
console.log(missing.length ? missing : '(none — all known)');

(async () => {
  const pool = await sql.connect(config);
  const OLD = '[ncs-conv-aging].dbo';
  const NEW = '[ncs-npl-aging].dbo';

  // ----------------------------------------------------------------
  // PART 2: Which loantranshostcodes actually appear in P-prefix rows?
  // ----------------------------------------------------------------
  console.log('\n========== PART 2: loantranshostcodes in P-prefix conv$vinpllvhistory ==========');

  await run(pool, 'All loantranshostcodes with counts (P+ADC prefix)',
    `SELECT loantranshostcode, COUNT(*) AS cnt
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno LIKE 'P%' OR systemreferenceno LIKE 'ADC%'
     GROUP BY loantranshostcode
     ORDER BY cnt DESC`);

  // ----------------------------------------------------------------
  // PART 3: For multiple sysrefs — trace old rows → new lvhisthsum rows
  // to figure out which loantranshostcode → which lvcredit*/lvdebit* column
  // ----------------------------------------------------------------
  console.log('\n========== PART 3: old→new trace for 5 diverse sysrefs ==========');

  // Get 5 sysrefs that have multiple loantranshostcodes for richer tracing
  await run(pool, 'Find 5 sysrefs with many distinct loantranshostcodes',
    `SELECT TOP 5 systemreferenceno, COUNT(DISTINCT loantranshostcode) AS tc_count, COUNT(*) AS row_count
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno LIKE 'P%'
     GROUP BY systemreferenceno
     ORDER BY COUNT(DISTINCT loantranshostcode) DESC, COUNT(*) DESC`);

  // Deep trace for P6303-005209 (already known) — now show loantranshostcode explicitly
  await run(pool, 'OLD rows for P6303-005209 with loantranshostcode',
    `SELECT id, loantranshostcode, affectcode, debitcredit, transactionamount, paymentamount, interestb4t
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno = 'P6303-005209'
     ORDER BY id`);

  await run(pool, 'NEW lvhisthsum rows for P6303-005209 — all lv* columns',
    `SELECT loantranshostcode, affectcode, debitcredit___,
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

  // Trace 4 more sysrefs to confirm patterns
  await run(pool, 'Find sysrefs with gaincash/gainsettlement non-zero (to trace those lv* cols)',
    `SELECT TOP 3 systemreferenceno
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE lvcreditgaincash != 0 OR lvdebitgaincash != 0
        OR lvcreditgainsettlement != 0 OR lvdebitgainsettlement != 0`);

  await run(pool, 'Find sysrefs with mischarge/othercharge non-zero',
    `SELECT TOP 3 systemreferenceno
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE lvcreditmischargeamount != 0 OR lvdebitmischargeamount != 0
        OR lvcreditotherchargeamount != 0 OR lvdebitotherchargeamount != 0`);

  // ----------------------------------------------------------------
  // PART 4: Key hypothesis test
  // Is the loantranshostcode in the NEW lvhisthsum row = the source loantranshostcode?
  // If yes → direct lookup is possible
  // ----------------------------------------------------------------
  console.log('\n========== PART 4: Does new.loantranshostcode = old.loantranshostcode? ==========');

  await run(pool, 'New lvhisthsum: distinct (loantranshostcode, affectcode, debitcredit___) combos with counts',
    `SELECT loantranshostcode, affectcode, debitcredit___, COUNT(*) AS cnt
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE loantranshostcode IS NOT NULL
     GROUP BY loantranshostcode, affectcode, debitcredit___
     ORDER BY cnt DESC`);

  // For each distinct loantranshostcode in new, which lvcredit*/lvdebit* column is non-zero?
  await run(pool, 'New lvhisthsum: per loantranshostcode — which lv* column is non-zero (sample)',
    `SELECT loantranshostcode,
       SUM(CASE WHEN lvcreditprincipleamount    != 0 THEN 1 ELSE 0 END) AS has_creditpp,
       SUM(CASE WHEN lvdebitprincipleamount      != 0 THEN 1 ELSE 0 END) AS has_debitpp,
       SUM(CASE WHEN lvcreditgaincash            != 0 THEN 1 ELSE 0 END) AS has_creditgcash,
       SUM(CASE WHEN lvdebitgaincash             != 0 THEN 1 ELSE 0 END) AS has_debitgcash,
       SUM(CASE WHEN lvcreditgainsettlement      != 0 THEN 1 ELSE 0 END) AS has_creditgsettle,
       SUM(CASE WHEN lvdebitgainsettlement       != 0 THEN 1 ELSE 0 END) AS has_debitgsettle,
       SUM(CASE WHEN lvcreditinterestamount      != 0 THEN 1 ELSE 0 END) AS has_creditint,
       SUM(CASE WHEN lvdebitinterestamount       != 0 THEN 1 ELSE 0 END) AS has_debitint,
       SUM(CASE WHEN lvcreditmischargeamount     != 0 THEN 1 ELSE 0 END) AS has_creditmf,
       SUM(CASE WHEN lvdebitmischargeamount      != 0 THEN 1 ELSE 0 END) AS has_debitmf,
       SUM(CASE WHEN lvcreditotherchargeamount   != 0 THEN 1 ELSE 0 END) AS has_creditof,
       SUM(CASE WHEN lvdebitotherchargeamount    != 0 THEN 1 ELSE 0 END) AS has_debitof,
       COUNT(*) AS total_rows
     FROM ${NEW}.[lv$lvhisthsum]
     GROUP BY loantranshostcode
     ORDER BY total_rows DESC`);

  await pool.close();
  console.log('\nDone.');
})();
