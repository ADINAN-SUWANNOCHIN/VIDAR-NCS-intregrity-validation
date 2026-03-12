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
  // PART 1: For a CE sysref — check both old sources + new lvhisthsum
  // Theory: CE rows in lvhisthsum come from vinpllvhistory (lv* formula applies)
  //         NOT from vinpllvcithistory (which goes to lvhisthinvtransactionhistoryh only)
  // ----------------------------------------------------------------
  console.log('\n========== PART 1: CE sysref trace ==========');

  const ceRef = 'CE6304-000001'; // has lvdebitinterestamount=1852.34 in lvhisthsum

  await run(pool, `vinpllvhistory rows for ${ceRef}`,
    `SELECT loantranshostcode, affectcode, debitcredit, transactionamount, paymentamount
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno = '${ceRef}'
     ORDER BY id`);

  await run(pool, `vinpllvcithistory rows for ${ceRef}`,
    `SELECT id, affectcode, debitcredit, transactionamount, paymentamount, invaccounttype
     FROM ${OLD}.[conv$vinpllvcithistory]
     WHERE systemreferenceno = '${ceRef}'
     ORDER BY id`);

  await run(pool, `lvhisthsum rows for ${ceRef}`,
    `SELECT lvcreditprincipleamount, lvdebitprincipleamount,
            lvcreditinterestamount, lvdebitinterestamount,
            lvcreditotherchargeamount, lvdebitotherchargeamount,
            lvcreditgaincash, lvdebitgaincash,
            transactionamount, paymentamount
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno = '${ceRef}'`);

  await run(pool, `lvhisthinvtransactionhistoryh rows for ${ceRef}`,
    `SELECT id, transactionamount, paymentamount, affectcode, debitcredit
     FROM ${NEW}.[lv$lvhisthinvtransactionhistoryh]
     WHERE systemreferenceno = '${ceRef}'
     ORDER BY id`);

  // ----------------------------------------------------------------
  // PART 2: Check a TD sysref (TD is from vinpllvhistory only — TD=0 in cithistory)
  // Theory: TD in lvhisthsum comes ONLY from vinpllvhistory
  // ----------------------------------------------------------------
  console.log('\n========== PART 2: TD sysref trace ==========');

  await run(pool, 'Find a TD sysref in lvhisthsum with non-zero lv* cols',
    `SELECT TOP 1 systemreferenceno, lvcreditprincipleamount, lvdebitprincipleamount,
            lvcreditinterestamount, lvdebitinterestamount, transactionamount
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno LIKE 'TD%'
       AND (lvcreditprincipleamount != 0 OR lvcreditinterestamount != 0
            OR lvdebitinterestamount != 0)`);

  await run(pool, 'vinpllvhistory: sample TD sysref rows',
    `SELECT TOP 1 systemreferenceno, loantranshostcode, affectcode, debitcredit, transactionamount
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno LIKE 'TD%'
     ORDER BY id`);

  await run(pool, 'vinpllvcithistory: any TD rows?',
    `SELECT TOP 3 systemreferenceno, invaccounttype, transactionamount
     FROM ${OLD}.[conv$vinpllvcithistory]
     WHERE systemreferenceno LIKE 'TD%'`);

  // ----------------------------------------------------------------
  // PART 3: For the CE sysref — verify lv* formula
  // Does SUM(vinpllvhistory transactionamount WHERE I1/D consolidate=C) = lvdebitinterestamount?
  // ----------------------------------------------------------------
  console.log('\n========== PART 3: Verify formula for CE sysref ==========');

  const excList = ['80000','81000','82100','90000','92090','99000','21300','21400','29300','29400','24100','25100','24200','25200','26100','26200'].map(t=>`'${t}'`).join(',');

  await run(pool, `${ceRef}: SUM per (affectcode, debitcredit) consolidate=C (vinpllvhistory)`,
    `SELECT affectcode, debitcredit,
            SUM(TRY_CAST(transactionamount AS decimal(20,4))) AS sum_txamt,
            COUNT(*) AS cnt
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno = '${ceRef}'
       AND loantranshostcode NOT IN (${excList})
     GROUP BY affectcode, debitcredit
     ORDER BY affectcode, debitcredit`);

  // ----------------------------------------------------------------
  // PART 4: How many sysrefs are ADJ types (BF/CAL_INT/B_DIFF) in lvhisthsum?
  // ----------------------------------------------------------------
  console.log('\n========== PART 4: ADJ (BF/CAL_INT/B_DIFF) in sources ==========');

  await run(pool, 'vinpllvhistory: BF/CAL_INT/B_DIFF row counts',
    `SELECT systemreferenceno, COUNT(*) AS cnt
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno IN ('BF','CAL_INT','B_DIFF')
     GROUP BY systemreferenceno`);

  await run(pool, 'vinpllvcithistory: BF/CAL_INT/B_DIFF row counts',
    `SELECT systemreferenceno, COUNT(*) AS cnt
     FROM ${OLD}.[conv$vinpllvcithistory]
     WHERE systemreferenceno IN ('BF','CAL_INT','B_DIFF')
     GROUP BY systemreferenceno`);

  await run(pool, 'lvhisthsum: rows with sysref BF/CAL_INT/B_DIFF?',
    `SELECT systemreferenceno, COUNT(*) AS cnt
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno IN ('BF','CAL_INT','B_DIFF')
     GROUP BY systemreferenceno`);

  // ----------------------------------------------------------------
  // PART 5: For cithistory → lvhisthsum:
  // Does cithistory contribute to lvhisthsum directly?
  // Check: are there CE sysrefs in lvhisthsum that have no match in vinpllvhistory?
  // ----------------------------------------------------------------
  console.log('\n========== PART 5: cithistory-only sysrefs in lvhisthsum? ==========');

  await run(pool, 'CE sysrefs in lvhisthsum with NO rows in vinpllvhistory (cithistory-only)',
    `SELECT TOP 5 n.systemreferenceno
     FROM ${NEW}.[lv$lvhisthsum] n
     WHERE n.systemreferenceno LIKE 'CE%'
       AND NOT EXISTS (
         SELECT 1 FROM ${OLD}.[conv$vinpllvhistory] o
         WHERE o.systemreferenceno = n.systemreferenceno
       )`);

  await run(pool, 'CE sysrefs in lvhisthsum WITH rows in vinpllvhistory (vinpllvhistory-fed)',
    `SELECT TOP 3 n.systemreferenceno
     FROM ${NEW}.[lv$lvhisthsum] n
     WHERE n.systemreferenceno LIKE 'CE%'
       AND EXISTS (
         SELECT 1 FROM ${OLD}.[conv$vinpllvhistory] o
         WHERE o.systemreferenceno = n.systemreferenceno
       )`);

  // How many CE in lvhisthsum come from cithistory only vs vinpllvhistory?
  await run(pool, 'CE in lvhisthsum: count with vinpllvhistory match vs without',
    `SELECT
       SUM(CASE WHEN EXISTS (SELECT 1 FROM ${OLD}.[conv$vinpllvhistory] o WHERE o.systemreferenceno = n.systemreferenceno) THEN 1 ELSE 0 END) AS has_vinpllvhistory,
       SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM ${OLD}.[conv$vinpllvhistory] o WHERE o.systemreferenceno = n.systemreferenceno) THEN 1 ELSE 0 END) AS no_vinpllvhistory,
       COUNT(*) AS total
     FROM ${NEW}.[lv$lvhisthsum] n
     WHERE n.systemreferenceno LIKE 'CE%'`);

  await pool.close();
  console.log('\nDone.');
})();
