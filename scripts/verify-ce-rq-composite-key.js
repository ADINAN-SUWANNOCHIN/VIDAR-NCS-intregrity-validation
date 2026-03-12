/**
 * STANDALONE VERIFICATION: CE/RQ composite key validation
 *
 * Confirmed logic:
 *   1. vinpllvhistory CE rows: one row per account per batch (accountno = old short code)
 *   2. cithistory: invaccountno (old) → newinvaccountno (new full account ID)
 *   3. lvhisthsum: lvaccountno = newinvaccountno, lv* = filtered_sum(vinpllvhistory) per account
 *
 * Group key: (systemreferenceno + accountno) on old side
 *            (systemreferenceno + lvaccountno) on new side
 *            Joined via: cithistory.invaccountno = vinpllvhistory.accountno
 *                        cithistory.newinvaccountno = lvhisthsum.lvaccountno
 *
 * This script:
 *   1. Picks sample CE and RQ sysrefs
 *   2. For each (sysref + accountno) group: computes filtered sums from vinpllvhistory
 *   3. Looks up newinvaccountno from cithistory
 *   4. Fetches actual lv* values from lvhisthsum for that (sysref + newinvaccountno)
 *   5. Compares and reports mismatches
 *   6. Reports scale stats: total accounts checked, match rate, mismatch examples
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

const TOL = 0.01;

const EXC = `'80000','81000','82100','90000','92090','99000',
             '21300','21400','29300','29400','24100','25100',
             '24200','25200','26100','26200'`;

// Compute filtered sums from vinpllvhistory, one row per (sysref, accountno)
// Returns { accountno → { creditPP, debitPP, creditINT, debitINT, creditGC, debitGC, creditGS, debitGS, creditOF, debitOF, rows } }
async function getOldSums(pool, OLD, sysref) {
  const r = await pool.request().query(`
    SELECT accountno,
      SUM(CASE WHEN affectcode = 'PP' AND debitcredit = 'C' AND loantranshostcode NOT IN (${EXC}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS creditPP,
      SUM(CASE WHEN affectcode = 'PP' AND debitcredit = 'D' AND loantranshostcode NOT IN (${EXC}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS debitPP,
      SUM(CASE WHEN affectcode IN ('I1','I2','I3','IN','IT','GG') AND debitcredit = 'C' AND loantranshostcode NOT IN (${EXC}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS creditINT,
      SUM(CASE WHEN affectcode IN ('I1','I2','I3','IN','IT','GG') AND debitcredit = 'D' AND loantranshostcode NOT IN (${EXC}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS debitINT,
      SUM(CASE WHEN affectcode = 'GC' AND debitcredit = 'C' AND loantranshostcode NOT IN (${EXC}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS creditGC,
      SUM(CASE WHEN affectcode = 'GC' AND debitcredit = 'D' AND loantranshostcode NOT IN (${EXC}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS debitGC,
      SUM(CASE WHEN affectcode = 'GS' AND debitcredit = 'C' AND loantranshostcode NOT IN (${EXC}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS creditGS,
      SUM(CASE WHEN affectcode = 'GS' AND debitcredit = 'D' AND loantranshostcode NOT IN (${EXC}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS debitGS,
      SUM(CASE WHEN affectcode IN ('OF','CF') AND debitcredit = 'C' AND loantranshostcode NOT IN (${EXC}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS creditOF,
      SUM(CASE WHEN affectcode IN ('OF','CF') AND debitcredit = 'D' AND loantranshostcode NOT IN (${EXC}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS debitOF,
      COUNT(*) AS rows
    FROM ${OLD}.[conv$vinpllvhistory]
    WHERE systemreferenceno = '${sysref}'
      AND accountno != ''
    GROUP BY accountno
  `);
  const map = {};
  for (const row of r.recordset) map[row.accountno] = row;
  return map;
}

// Get cithistory account mapping for this sysref: invaccountno → newinvaccountno
async function getCitMapping(pool, OLD, sysref) {
  const r = await pool.request().query(`
    SELECT invaccountno, newinvaccountno
    FROM ${OLD}.[conv$vinpllvcithistory]
    WHERE systemreferenceno = '${sysref}'
  `);
  const map = {};
  for (const row of r.recordset) map[row.invaccountno] = row.newinvaccountno;
  return map;
}

// Get lvhisthsum rows for this sysref, keyed by lvaccountno
async function getNewRows(pool, NEW, sysref) {
  const r = await pool.request().query(`
    SELECT lvaccountno,
           lvcreditprincipleamount, lvdebitprincipleamount,
           lvcreditinterestamount, lvdebitinterestamount,
           lvcreditgaincash, lvdebitgaincash,
           lvcreditgainsettlement, lvdebitgainsettlement,
           lvcreditotherchargeamount, lvdebitotherchargeamount
    FROM ${NEW}.[lv$lvhisthsum]
    WHERE systemreferenceno = '${sysref}'
  `);
  const map = {};
  for (const row of r.recordset) {
    if (!map[row.lvaccountno]) map[row.lvaccountno] = [];
    map[row.lvaccountno].push(row);
  }
  // Aggregate: sum lv* across multiple new rows per lvaccountno
  const agg = {};
  for (const [acct, rows] of Object.entries(map)) {
    agg[acct] = {
      creditPP:  rows.reduce((s, r) => s + Number(r.lvcreditprincipleamount||0), 0),
      debitPP:   rows.reduce((s, r) => s + Number(r.lvdebitprincipleamount||0), 0),
      creditINT: rows.reduce((s, r) => s + Number(r.lvcreditinterestamount||0), 0),
      debitINT:  rows.reduce((s, r) => s + Number(r.lvdebitinterestamount||0), 0),
      creditGC:  rows.reduce((s, r) => s + Number(r.lvcreditgaincash||0), 0),
      debitGC:   rows.reduce((s, r) => s + Number(r.lvdebitgaincash||0), 0),
      creditGS:  rows.reduce((s, r) => s + Number(r.lvcreditgainsettlement||0), 0),
      debitGS:   rows.reduce((s, r) => s + Number(r.lvdebitgainsettlement||0), 0),
      creditOF:  rows.reduce((s, r) => s + Number(r.lvcreditotherchargeamount||0), 0),
      debitOF:   rows.reduce((s, r) => s + Number(r.lvdebitotherchargeamount||0), 0),
      newRowCount: rows.length,
    };
  }
  return agg;
}

function diff(a, b) { return Math.abs(a - b) > TOL; }

function compareAccount(sysref, accountno, newinvaccountno, old, newAgg) {
  const n = newAgg[newinvaccountno];
  if (!n) return { ok: false, reason: 'NEW_ROW_MISSING', sysref, accountno, newinvaccountno };

  const mismatches = [];
  const pairs = [
    ['creditPP',  'lvcreditprincipleamount'],
    ['debitPP',   'lvdebitprincipleamount'],
    ['creditINT', 'lvcreditinterestamount'],
    ['debitINT',  'lvdebitinterestamount'],
    ['creditGC',  'lvcreditgaincash'],
    ['debitGC',   'lvdebitgaincash'],
    ['creditGS',  'lvcreditgainsettlement'],
    ['debitGS',   'lvdebitgainsettlement'],
    ['creditOF',  'lvcreditotherchargeamount'],
    ['debitOF',   'lvdebitotherchargeamount'],
  ];
  for (const [ok, nk] of pairs) {
    const ov = Number(old[ok] || 0), nv = Number(n[ok] || 0);
    if (diff(ov, nv)) mismatches.push({ col: nk, old: ov, new: nv });
  }
  return { ok: mismatches.length === 0, mismatches, sysref, accountno, newinvaccountno, newRowCount: n.newRowCount };
}

async function verifySysref(pool, OLD, NEW, sysref, verbose = false) {
  let oldSums, citMap, newAgg;
  try {
    [oldSums, citMap, newAgg] = await Promise.all([
      getOldSums(pool, OLD, sysref),
      getCitMapping(pool, OLD, sysref),
      getNewRows(pool, NEW, sysref),
    ]);
  } catch (e) {
    return { sysref, error: e.message, total: 0, matched: 0, missing: 0, mismatch: 0 };
  }

  let total = 0, matched = 0, missing = 0, mismatch = 0;
  const mismatches = [];
  const missingAccounts = [];

  for (const [accountno, old] of Object.entries(oldSums)) {
    const newinvaccountno = citMap[accountno];
    if (!newinvaccountno) {
      missing++;
      missingAccounts.push({ accountno, reason: 'NO_CIT_MAPPING' });
      continue;
    }
    total++;
    const result = compareAccount(sysref, accountno, newinvaccountno, old, newAgg);
    if (result.ok) {
      matched++;
    } else if (result.reason === 'NEW_ROW_MISSING') {
      missing++;
      missingAccounts.push({ accountno, newinvaccountno, reason: 'NEW_ROW_MISSING' });
    } else {
      mismatch++;
      if (mismatches.length < 3) mismatches.push(result); // cap examples
    }
  }

  // Also check for extra new rows (lvhisthsum rows with no old match via citmap)
  const citReverseMap = Object.fromEntries(Object.entries(citMap).map(([k,v]) => [v,k]));
  let extraNew = 0;
  for (const newinvaccountno of Object.keys(newAgg)) {
    const oldAcct = citReverseMap[newinvaccountno];
    if (!oldAcct || !oldSums[oldAcct]) extraNew++;
  }

  if (verbose) {
    console.log(`\n  [${sysref}] total=${total} matched=${matched} mismatch=${mismatch} missing=${missing} extraNew=${extraNew}`);
    if (mismatches.length > 0) {
      console.log(`  MISMATCHES (up to 3):`);
      mismatches.forEach(m => {
        console.log(`    accountno=${m.accountno} → ${m.newinvaccountno}`);
        m.mismatches.forEach(d => console.log(`      ${d.col}: old=${d.old} new=${d.new} diff=${Math.abs(d.old-d.new).toFixed(4)}`));
      });
    }
    if (missingAccounts.length > 0 && missingAccounts.length <= 5) {
      console.log(`  MISSING: ${JSON.stringify(missingAccounts)}`);
    } else if (missingAccounts.length > 5) {
      console.log(`  MISSING (first 5 of ${missingAccounts.length}): ${JSON.stringify(missingAccounts.slice(0,5))}`);
    }
  }

  return { sysref, total, matched, mismatch, missing, extraNew, mismatches, missingAccounts };
}

(async () => {
  const pool = await sql.connect(config);
  const OLD = '[ncs-conv-aging].dbo';
  const NEW = '[ncs-npl-aging].dbo';

  // ================================================================
  // STEP 1: Pick sample sysrefs for CE and RQ
  //         Use small sysrefs (few accounts) + a few medium ones
  // ================================================================
  console.log('\n========== STEP 1: Select sample sysrefs ==========');

  const ceSmall = await pool.request().query(`
    SELECT TOP 5 systemreferenceno, COUNT(*) AS acct_count
    FROM ${OLD}.[conv$vinpllvhistory]
    WHERE systemreferenceno LIKE 'CE%'
    GROUP BY systemreferenceno
    HAVING COUNT(*) BETWEEN 1 AND 10
    ORDER BY COUNT(*) ASC, systemreferenceno
  `);
  const ceMedium = await pool.request().query(`
    SELECT TOP 3 systemreferenceno, COUNT(*) AS acct_count
    FROM ${OLD}.[conv$vinpllvhistory]
    WHERE systemreferenceno LIKE 'CE%'
    GROUP BY systemreferenceno
    HAVING COUNT(*) BETWEEN 100 AND 500
    ORDER BY COUNT(*) ASC, systemreferenceno
  `);
  const rqSmall = await pool.request().query(`
    SELECT TOP 5 systemreferenceno, COUNT(*) AS acct_count
    FROM ${OLD}.[conv$vinpllvhistory]
    WHERE systemreferenceno LIKE 'RQ%'
    GROUP BY systemreferenceno
    HAVING COUNT(*) BETWEEN 1 AND 10
    ORDER BY COUNT(*) ASC, systemreferenceno
  `);
  const rqMedium = await pool.request().query(`
    SELECT TOP 3 systemreferenceno, COUNT(*) AS acct_count
    FROM ${OLD}.[conv$vinpllvhistory]
    WHERE systemreferenceno LIKE 'RQ%'
    GROUP BY systemreferenceno
    HAVING COUNT(*) BETWEEN 100 AND 500
    ORDER BY COUNT(*) ASC, systemreferenceno
  `);
  // One large CE to check scale
  const ceLarge = await pool.request().query(`
    SELECT TOP 1 systemreferenceno, COUNT(*) AS acct_count
    FROM ${OLD}.[conv$vinpllvhistory]
    WHERE systemreferenceno LIKE 'CE%'
    GROUP BY systemreferenceno
    HAVING COUNT(*) > 1000
    ORDER BY COUNT(*) ASC
  `);

  const sampleSysrefs = [
    ...ceSmall.recordset.map(r => ({ ...r, type: 'CE-SMALL' })),
    ...ceMedium.recordset.map(r => ({ ...r, type: 'CE-MEDIUM' })),
    ...rqSmall.recordset.map(r => ({ ...r, type: 'RQ-SMALL' })),
    ...rqMedium.recordset.map(r => ({ ...r, type: 'RQ-MEDIUM' })),
    ...ceLarge.recordset.map(r => ({ ...r, type: 'CE-LARGE' })),
  ];

  console.log('Selected sysrefs:');
  sampleSysrefs.forEach(s => console.log(`  [${s.type}] ${s.systemreferenceno} — ${s.acct_count} accounts`));

  // ================================================================
  // STEP 2: Verify each sysref
  // ================================================================
  console.log('\n========== STEP 2: Per-sysref verification ==========');

  const results = [];
  for (const s of sampleSysrefs) {
    process.stdout.write(`  Checking ${s.systemreferenceno} (${s.acct_count} accounts)... `);
    const t0 = Date.now();
    const r = await verifySysref(pool, OLD, NEW, s.systemreferenceno, true);
    r.type = s.type;
    r.acct_count = s.acct_count;
    results.push(r);
    console.log(`  done in ${Date.now()-t0}ms`);
  }

  // ================================================================
  // STEP 3: Summary
  // ================================================================
  console.log('\n========== STEP 3: Summary ==========');
  let totalAccts = 0, totalMatched = 0, totalMismatch = 0, totalMissing = 0, totalExtra = 0;
  for (const r of results) {
    totalAccts += r.total || 0;
    totalMatched += r.matched || 0;
    totalMismatch += r.mismatch || 0;
    totalMissing += r.missing || 0;
    totalExtra += r.extraNew || 0;
    const status = r.error ? 'ERROR' : (r.mismatch === 0 && r.missing === 0 ? 'PASS' : 'FAIL');
    console.log(`  [${status}] ${r.sysref} (${r.type}): total=${r.total} matched=${r.matched} mismatch=${r.mismatch} missing=${r.missing} extraNew=${r.extraNew}${r.error ? ' ERR='+r.error : ''}`);
  }
  console.log(`\n  GRAND TOTAL: accounts=${totalAccts} matched=${totalMatched} mismatch=${totalMismatch} missing=${totalMissing} extraNew=${totalExtra}`);
  const matchRate = totalAccts > 0 ? ((totalMatched / totalAccts) * 100).toFixed(2) : 'N/A';
  console.log(`  Match rate: ${matchRate}%`);

  // ================================================================
  // STEP 4: Investigate any mismatches in detail
  // ================================================================
  const hasMismatches = results.some(r => r.mismatches && r.mismatches.length > 0);
  if (hasMismatches) {
    console.log('\n========== STEP 4: Mismatch deep-dive ==========');
    for (const r of results) {
      if (!r.mismatches || r.mismatches.length === 0) continue;
      for (const m of r.mismatches) {
        console.log(`\n  Sysref: ${m.sysref}, accountno: ${m.accountno}, newinvaccountno: ${m.newinvaccountno}`);
        console.log(`  Column mismatches:`);
        m.mismatches.forEach(d => console.log(`    ${d.col}: old=${d.old} new=${d.new}`));

        // Pull raw old rows for this (sysref+accountno) to understand why
        try {
          const rawOld = await pool.request().query(`
            SELECT affectcode, debitcredit, loantranshostcode,
                   TRY_CAST(transactionamount AS decimal(20,4)) AS txamt
            FROM ${OLD}.[conv$vinpllvhistory]
            WHERE systemreferenceno = '${m.sysref}'
              AND accountno = '${m.accountno}'
            ORDER BY id
          `);
          console.log(`  Old rows (${rawOld.recordset.length} rows):`);
          rawOld.recordset.forEach(row => console.log(`    ${JSON.stringify(row)}`));
        } catch(e) { console.log(`  Could not pull old rows: ${e.message}`); }

        // Pull raw new rows for this (sysref+newinvaccountno)
        try {
          const rawNew = await pool.request().query(`
            SELECT lvaccountno,
                   lvcreditprincipleamount, lvdebitprincipleamount,
                   lvcreditinterestamount, lvdebitinterestamount,
                   lvcreditgaincash, lvdebitgaincash,
                   lvcreditgainsettlement, lvdebitgainsettlement,
                   lvcreditotherchargeamount, lvdebitotherchargeamount
            FROM ${NEW}.[lv$lvhisthsum]
            WHERE systemreferenceno = '${m.sysref}'
              AND lvaccountno = '${m.newinvaccountno}'
          `);
          console.log(`  New rows (${rawNew.recordset.length} rows):`);
          rawNew.recordset.forEach(row => console.log(`    ${JSON.stringify(row)}`));
        } catch(e) { console.log(`  Could not pull new rows: ${e.message}`); }
      }
    }
  } else {
    console.log('\n========== STEP 4: No mismatches found — skipping deep-dive ==========');
  }

  // ================================================================
  // STEP 5: Check if formula works on a larger batch (first 200 accounts of CE6302-000001)
  //         Direct SQL to avoid per-account round trips
  // ================================================================
  console.log('\n========== STEP 5: Large-scale SQL validation (CE6302-000001, first 200 accounts) ==========');

  try {
    const bulkCheck = await pool.request().query(`
      WITH old_sums AS (
        SELECT accountno,
          SUM(CASE WHEN affectcode IN ('I1','I2','I3','IN','IT','GG') AND debitcredit = 'C' AND loantranshostcode NOT IN (${EXC}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS creditINT,
          SUM(CASE WHEN affectcode IN ('I1','I2','I3','IN','IT','GG') AND debitcredit = 'D' AND loantranshostcode NOT IN (${EXC}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS debitINT,
          SUM(CASE WHEN affectcode = 'PP' AND debitcredit = 'C' AND loantranshostcode NOT IN (${EXC}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS creditPP,
          SUM(CASE WHEN affectcode = 'PP' AND debitcredit = 'D' AND loantranshostcode NOT IN (${EXC}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS debitPP,
          SUM(CASE WHEN affectcode IN ('OF','CF') AND debitcredit = 'C' AND loantranshostcode NOT IN (${EXC}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS creditOF,
          COUNT(*) AS old_rows
        FROM ${OLD}.[conv$vinpllvhistory]
        WHERE systemreferenceno = 'CE6302-000001'
          AND accountno != ''
        GROUP BY accountno
      ),
      cit_map AS (
        SELECT invaccountno, newinvaccountno
        FROM ${OLD}.[conv$vinpllvcithistory]
        WHERE systemreferenceno = 'CE6302-000001'
      ),
      new_sums AS (
        SELECT lvaccountno,
          SUM(lvcreditinterestamount) AS creditINT,
          SUM(lvdebitinterestamount) AS debitINT,
          SUM(lvcreditprincipleamount) AS creditPP,
          SUM(lvdebitprincipleamount) AS debitPP,
          SUM(lvcreditotherchargeamount) AS creditOF
        FROM ${NEW}.[lv$lvhisthsum]
        WHERE systemreferenceno = 'CE6302-000001'
        GROUP BY lvaccountno
      )
      SELECT
        COUNT(*) AS total_accounts,
        SUM(CASE WHEN ABS(o.creditINT - ISNULL(n.creditINT,0)) < 0.01
                 AND ABS(o.debitINT  - ISNULL(n.debitINT,0))  < 0.01
                 AND ABS(o.creditPP  - ISNULL(n.creditPP,0))  < 0.01
                 AND ABS(o.debitPP   - ISNULL(n.debitPP,0))   < 0.01
                 AND ABS(o.creditOF  - ISNULL(n.creditOF,0))  < 0.01
                 THEN 1 ELSE 0 END) AS fully_matched,
        SUM(CASE WHEN n.lvaccountno IS NULL THEN 1 ELSE 0 END) AS new_row_missing,
        SUM(CASE WHEN n.lvaccountno IS NOT NULL AND (
               ABS(o.creditINT - ISNULL(n.creditINT,0)) >= 0.01 OR
               ABS(o.debitINT  - ISNULL(n.debitINT,0))  >= 0.01 OR
               ABS(o.creditPP  - ISNULL(n.creditPP,0))  >= 0.01 OR
               ABS(o.debitPP   - ISNULL(n.debitPP,0))   >= 0.01 OR
               ABS(o.creditOF  - ISNULL(n.creditOF,0))  >= 0.01
             ) THEN 1 ELSE 0 END) AS value_mismatch
      FROM old_sums o
      JOIN cit_map c ON c.invaccountno = o.accountno COLLATE Thai_CI_AS
      LEFT JOIN new_sums n ON n.lvaccountno = c.newinvaccountno COLLATE Thai_CI_AS
    `);
    bulkCheck.recordset.forEach(row => console.log(`  CE6302-000001 bulk check: ${JSON.stringify(row)}`));
  } catch(e) { console.log(`  Bulk check error: ${e.message}`); }

  // Same bulk check for a RQ sysref
  const firstRQ = rqSmall.recordset[0]?.systemreferenceno;
  if (firstRQ) {
    console.log(`\n  Bulk check for ${firstRQ} (RQ):`);
    try {
      const rqBulk = await pool.request().query(`
        WITH old_sums AS (
          SELECT accountno,
            SUM(CASE WHEN affectcode IN ('I1','I2','I3','IN','IT','GG') AND debitcredit = 'C' AND loantranshostcode NOT IN (${EXC}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS creditINT,
            SUM(CASE WHEN affectcode IN ('I1','I2','I3','IN','IT','GG') AND debitcredit = 'D' AND loantranshostcode NOT IN (${EXC}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS debitINT,
            SUM(CASE WHEN affectcode = 'PP' AND debitcredit = 'C' AND loantranshostcode NOT IN (${EXC}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS creditPP,
            SUM(CASE WHEN affectcode = 'PP' AND debitcredit = 'D' AND loantranshostcode NOT IN (${EXC}) THEN TRY_CAST(transactionamount AS decimal(20,4)) ELSE 0 END) AS debitPP,
            COUNT(*) AS old_rows
          FROM ${OLD}.[conv$vinpllvhistory]
          WHERE systemreferenceno = '${firstRQ}'
            AND accountno != ''
          GROUP BY accountno
        ),
        cit_map AS (
          SELECT invaccountno, newinvaccountno
          FROM ${OLD}.[conv$vinpllvcithistory]
          WHERE systemreferenceno = '${firstRQ}'
        ),
        new_sums AS (
          SELECT lvaccountno,
            SUM(lvcreditinterestamount) AS creditINT,
            SUM(lvdebitinterestamount) AS debitINT,
            SUM(lvcreditprincipleamount) AS creditPP,
            SUM(lvdebitprincipleamount) AS debitPP
          FROM ${NEW}.[lv$lvhisthsum]
          WHERE systemreferenceno = '${firstRQ}'
          GROUP BY lvaccountno
        )
        SELECT
          COUNT(*) AS total_accounts,
          SUM(CASE WHEN ABS(o.creditINT - ISNULL(n.creditINT,0)) < 0.01
                   AND ABS(o.debitINT  - ISNULL(n.debitINT,0))  < 0.01
                   AND ABS(o.creditPP  - ISNULL(n.creditPP,0))  < 0.01
                   AND ABS(o.debitPP   - ISNULL(n.debitPP,0))   < 0.01
                   THEN 1 ELSE 0 END) AS fully_matched,
          SUM(CASE WHEN n.lvaccountno IS NULL THEN 1 ELSE 0 END) AS new_row_missing,
          SUM(CASE WHEN n.lvaccountno IS NOT NULL AND (
                 ABS(o.creditINT - ISNULL(n.creditINT,0)) >= 0.01 OR
                 ABS(o.debitINT  - ISNULL(n.debitINT,0))  >= 0.01 OR
                 ABS(o.creditPP  - ISNULL(n.creditPP,0))  >= 0.01 OR
                 ABS(o.debitPP   - ISNULL(n.debitPP,0))   >= 0.01
               ) THEN 1 ELSE 0 END) AS value_mismatch
        FROM old_sums o
        JOIN cit_map c ON c.invaccountno = o.accountno COLLATE Thai_CI_AS
        LEFT JOIN new_sums n ON n.lvaccountno = c.newinvaccountno COLLATE Thai_CI_AS
      `);
      rqBulk.recordset.forEach(row => console.log(`  ${firstRQ} bulk check: ${JSON.stringify(row)}`));
    } catch(e) { console.log(`  RQ bulk check error: ${e.message}`); }
  }

  await pool.close();
  console.log('\nDone.');
})();
