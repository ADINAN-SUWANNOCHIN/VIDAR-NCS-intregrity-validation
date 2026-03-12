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

  // ----------------------------------------------------------------
  // PART 1: ADJ prefix — what exactly is it?
  // ----------------------------------------------------------------
  console.log('\n========== PART 1: ADJ prefix investigation ==========');

  // Check all AD* variations in vinpllvhistory (ADC, ADJ, ADE, etc.)
  await run(pool, 'vinpllvhistory: all AD* prefix sysrefs (3-char breakdown)',
    `SELECT LEFT(systemreferenceno, 3) AS prefix3, COUNT(*) AS cnt
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno LIKE 'AD%'
     GROUP BY LEFT(systemreferenceno, 3)
     ORDER BY cnt DESC`);

  await run(pool, 'vinpllvcithistory: all AD* prefix sysrefs (3-char breakdown)',
    `SELECT LEFT(systemreferenceno, 3) AS prefix3, COUNT(*) AS cnt
     FROM ${OLD}.[conv$vinpllvcithistory]
     WHERE systemreferenceno LIKE 'AD%'
     GROUP BY LEFT(systemreferenceno, 3)
     ORDER BY cnt DESC`);

  // Sample ADJ rows from vinpllvhistory
  await run(pool, 'vinpllvhistory: sample ADJ rows',
    `SELECT TOP 5 systemreferenceno, loantranshostcode, affectcode, debitcredit,
            transactionamount, paymentamount
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno LIKE 'ADJ%'
     ORDER BY id`);

  // Does ADJ appear in lvhisthsum?
  await run(pool, 'lvhisthsum: ADJ rows',
    `SELECT LEFT(systemreferenceno, 3) AS prefix3, COUNT(*) AS cnt
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno LIKE 'ADJ%'
     GROUP BY LEFT(systemreferenceno, 3)`);

  // Does ADC appear in lvhisthsum?
  await run(pool, 'lvhisthsum: ADC rows',
    `SELECT LEFT(systemreferenceno, 3) AS prefix3, COUNT(*) AS cnt
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno LIKE 'ADC%'
     GROUP BY LEFT(systemreferenceno, 3)`);

  // Full 3-char breakdown of AD* in lvhisthsum
  await run(pool, 'lvhisthsum: all AD* variations (3-char)',
    `SELECT LEFT(systemreferenceno, 3) AS prefix3, COUNT(*) AS cnt
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno LIKE 'AD%'
     GROUP BY LEFT(systemreferenceno, 3)
     ORDER BY cnt DESC`);

  // What do ADJ rows look like in lvhisthsum (lv* cols)?
  await run(pool, 'lvhisthsum: sample ADJ rows with lv* cols',
    `SELECT TOP 3 systemreferenceno,
            lvcreditprincipleamount, lvdebitprincipleamount,
            lvcreditinterestamount, lvdebitinterestamount,
            lvcreditotherchargeamount, transactionamount
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno LIKE 'ADJ%'`);

  // ----------------------------------------------------------------
  // PART 2: Cithistory → lvhisthsum — verify via collation-safe approach
  // Use a TEMP table join to avoid collation conflict
  // ----------------------------------------------------------------
  console.log('\n========== PART 2: cithistory → lvhisthsum verification ==========');

  // Count distinct sysrefs in lvhisthsum that exist in cithistory
  // Use COLLATE to fix the collation conflict
  await run(pool, 'lvhisthsum sysrefs that exist in cithistory (COLLATE fix)',
    `SELECT COUNT(DISTINCT n.systemreferenceno) AS in_both
     FROM ${NEW}.[lv$lvhisthsum] n
     WHERE EXISTS (
       SELECT 1 FROM ${OLD}.[conv$vinpllvcithistory] c
       WHERE c.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno
     )`);

  await run(pool, 'lvhisthsum sysrefs that exist in vinpllvhistory (COLLATE fix)',
    `SELECT COUNT(DISTINCT n.systemreferenceno) AS in_both
     FROM ${NEW}.[lv$lvhisthsum] n
     WHERE EXISTS (
       SELECT 1 FROM ${OLD}.[conv$vinpllvhistory] o
       WHERE o.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno
     )`);

  // Are there lvhisthsum sysrefs with NO match in vinpllvhistory?
  await run(pool, 'lvhisthsum sysrefs with NO match in vinpllvhistory (cithistory-only?)',
    `SELECT COUNT(DISTINCT n.systemreferenceno) AS no_lv_match
     FROM ${NEW}.[lv$lvhisthsum] n
     WHERE NOT EXISTS (
       SELECT 1 FROM ${OLD}.[conv$vinpllvhistory] o
       WHERE o.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno
     )`);

  // Sample those unmatched sysrefs
  await run(pool, 'lvhisthsum: sample sysrefs with no vinpllvhistory match',
    `SELECT TOP 5 n.systemreferenceno,
            n.lvcreditprincipleamount, n.lvdebitprincipleamount,
            n.lvcreditinterestamount, n.lvdebitinterestamount,
            n.transactionamount
     FROM ${NEW}.[lv$lvhisthsum] n
     WHERE NOT EXISTS (
       SELECT 1 FROM ${OLD}.[conv$vinpllvhistory] o
       WHERE o.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno
     )`);

  await pool.close();
  console.log('\nDone.');
})();
