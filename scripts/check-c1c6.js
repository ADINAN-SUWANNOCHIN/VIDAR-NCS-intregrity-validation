const sql = require('mssql');
require('dotenv').config();
const strip = (v) => (v || '').replace(/^["']|["']$/g, '');

const config = {
  server: strip(process.env.DB_HOST), port: 1433,
  user: strip(process.env.DB_USER), password: strip(process.env.DB_PASSWORD),
  database: strip(process.env.DB_NAME),
  options: { encrypt: true, trustServerCertificate: true, cryptoCredentialsDetails: { minVersion: 'TLSv1' } },
  requestTimeout: 60000,
};

const OLD = '[ncs-conv-aging].dbo';
const NEW = '[ncs-npl-aging].dbo';

async function run(pool, label, q) {
  console.log(`\n=== ${label} ===`);
  try {
    const r = await pool.request().query(q);
    if (!r.recordset || r.recordset.length === 0) console.log('  (no rows)');
    else r.recordset.forEach((row, i) => console.log(`  [${i}] ${JSON.stringify(row)}`));
  } catch(e) {
    console.log(`  ERROR: ${e.message}`);
  }
}

(async () => {
  const pool = await sql.connect(config);

  // C1: interestb4t — does new table have any non-zero values?
  await run(pool, 'C1a: new interestb4t non-zero count',
    `SELECT COUNT(*) as cnt FROM ${NEW}.[lv$lvhistinvtransactionhistory]
     WHERE interestb4t IS NOT NULL AND interestb4t != 0`);

  await run(pool, 'C1b: old interestb4t non-zero count',
    `SELECT COUNT(*) as cnt FROM ${OLD}.[conv$vinpllvhistory]
     WHERE interestb4t IS NOT NULL AND TRY_CAST(interestb4t AS decimal(20,8)) != 0`);

  await run(pool, 'C1c: sample join — interestb4t old vs new (5 non-zero old rows)',
    `SELECT TOP 5
       o.systemreferenceno, o.debitcredit, o.affectcode,
       TRY_CAST(o.interestb4t AS decimal(20,8)) as old_interestb4t,
       n.interestb4t as new_interestb4t
     FROM ${OLD}.[conv$vinpllvhistory] o
     JOIN ${NEW}.[lv$lvhistinvtransactionhistory] n
       ON o.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno COLLATE Thai_CI_AS
     WHERE TRY_CAST(o.interestb4t AS decimal(20,8)) != 0
     ORDER BY o.id`);

  // C2: calculateintrate — same check
  await run(pool, 'C2a: new calculateintrate non-zero count',
    `SELECT COUNT(*) as cnt FROM ${NEW}.[lv$lvhistinvtransactionhistory]
     WHERE calculateintrate IS NOT NULL AND calculateintrate != 0`);

  await run(pool, 'C2b: sample join — calculateintrate old vs new',
    `SELECT TOP 5
       o.systemreferenceno,
       TRY_CAST(o.calculateintrate AS decimal(20,8)) as old_calculateintrate,
       n.calculateintrate as new_calculateintrate
     FROM ${OLD}.[conv$vinpllvhistory] o
     JOIN ${NEW}.[lv$lvhistinvtransactionhistory] n
       ON o.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno COLLATE Thai_CI_AS
     WHERE TRY_CAST(o.calculateintrate AS decimal(20,8)) != 0
     ORDER BY o.id`);

  // C3: newaccountno vs accountno → lvaccountno
  await run(pool, 'C3: join old vs new — account number columns (5 rows)',
    `SELECT TOP 5
       o.systemreferenceno,
       o.accountno       as old_accountno,
       o.newaccountno    as old_newaccountno,
       n.lvaccountno     as new_lvaccountno
     FROM ${OLD}.[conv$vinpllvhistory] o
     JOIN ${NEW}.[lv$lvhistinvtransactionhistory] n
       ON o.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno COLLATE Thai_CI_AS
     ORDER BY o.id`);

  // C4: chargetype → expensecode
  await run(pool, 'C4a: new expensecode sample (non-empty)',
    `SELECT TOP 5 expensecode, chargetype FROM ${NEW}.[lv$lvhistinvtransactionhistory]
     WHERE expensecode IS NOT NULL AND expensecode != ''`);

  await run(pool, 'C4b: join old chargetype vs new expensecode (5 rows)',
    `SELECT TOP 5
       o.systemreferenceno,
       o.chargetype      as old_chargetype,
       n.expensecode     as new_expensecode,
       n.chargetype      as new_chargetype
     FROM ${OLD}.[conv$vinpllvhistory] o
     JOIN ${NEW}.[lv$lvhistinvtransactionhistory] n
       ON o.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno COLLATE Thai_CI_AS
     WHERE o.chargetype IS NOT NULL AND o.chargetype != ''
     ORDER BY o.id`);

  // C5: gaincashbalanceb4t — is old ever non-zero?
  await run(pool, 'C5: old gaincashbalanceb4t non-zero count',
    `SELECT COUNT(*) as cnt FROM ${OLD}.[conv$vinpllvhistory]
     WHERE TRY_CAST(gaincashbalanceb4t AS decimal(20,8)) != 0`);

  // C6: keydate/_keydate vs createddate — compare times on a joined sample
  await run(pool, 'C6: keydate vs _keydate vs createddate (5 rows)',
    `SELECT TOP 5
       o.systemreferenceno,
       o.keydate         as old_keydate,
       o._keydate        as old__keydate,
       n.createddate     as new_createddate
     FROM ${OLD}.[conv$vinpllvhistory] o
     JOIN ${NEW}.[lv$lvhistinvtransactionhistory] n
       ON o.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno COLLATE Thai_CI_AS
     ORDER BY o.id`);

  await pool.close();
  console.log('\nDone.');
})();
