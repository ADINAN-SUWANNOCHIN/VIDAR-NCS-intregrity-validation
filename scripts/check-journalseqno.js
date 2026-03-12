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
  const NEW = '[ncs-npl-aging].dbo';

  // For each new table: compare journalseqno vs systemreferenceno on sample rows
  // If they match → we can use journalseqno index to fetch rows by sysref

  await run(pool, 'la$lahistloantransactionhistory — journalseqno vs systemreferenceno (10 rows)',
    `SELECT TOP 10 journalseqno, systemreferenceno,
       CASE WHEN journalseqno = systemreferenceno THEN 'MATCH' ELSE 'DIFF' END AS result
     FROM ${NEW}.[la$lahistloantransactionhistory]
     WHERE journalseqno IS NOT NULL AND systemreferenceno IS NOT NULL
     ORDER BY id`);

  await run(pool, 'la$lahistloantransactionhistory — how many rows mismatch (sample 10000)',
    `SELECT
       SUM(CASE WHEN journalseqno = systemreferenceno THEN 1 ELSE 0 END) AS match_count,
       SUM(CASE WHEN journalseqno != systemreferenceno THEN 1 ELSE 0 END) AS diff_count,
       COUNT(*) AS total
     FROM (SELECT TOP 10000 journalseqno, systemreferenceno
           FROM ${NEW}.[la$lahistloantransactionhistory]
           ORDER BY id) t`);

  await run(pool, 'la$lahisthloantransactionhistoryh — journalseqno vs systemreferenceno (10 rows)',
    `SELECT TOP 10 journalseqno, systemreferenceno,
       CASE WHEN journalseqno = systemreferenceno THEN 'MATCH' ELSE 'DIFF' END AS result
     FROM ${NEW}.[la$lahisthloantransactionhistoryh]
     WHERE journalseqno IS NOT NULL AND systemreferenceno IS NOT NULL
     ORDER BY id`);

  await run(pool, 'la$lahisthloantransactionhistoryh — match rate (sample 10000)',
    `SELECT
       SUM(CASE WHEN journalseqno = systemreferenceno THEN 1 ELSE 0 END) AS match_count,
       SUM(CASE WHEN journalseqno != systemreferenceno THEN 1 ELSE 0 END) AS diff_count,
       COUNT(*) AS total
     FROM (SELECT TOP 10000 journalseqno, systemreferenceno
           FROM ${NEW}.[la$lahisthloantransactionhistoryh]
           ORDER BY id) t`);

  await run(pool, 'ls$lshistinvtransactionhistory — journalseqno vs systemreferenceno (10 rows)',
    `SELECT TOP 10 journalseqno, systemreferenceno,
       CASE WHEN journalseqno = systemreferenceno THEN 'MATCH' ELSE 'DIFF' END AS result
     FROM ${NEW}.[ls$lshistinvtransactionhistory]
     WHERE journalseqno IS NOT NULL AND systemreferenceno IS NOT NULL
     ORDER BY id`);

  await run(pool, 'ls$lshisthinvtransactionhistoryh — journalseqno vs systemreferenceno (10 rows)',
    `SELECT TOP 10 journalseqno, systemreferenceno,
       CASE WHEN journalseqno = systemreferenceno THEN 'MATCH' ELSE 'DIFF' END AS result
     FROM ${NEW}.[ls$lshisthinvtransactionhistoryh]
     WHERE journalseqno IS NOT NULL AND systemreferenceno IS NOT NULL
     ORDER BY id`);

  await run(pool, 'ln$lnhistloantransactionhistory — journalseqno vs systemreferenceno (10 rows)',
    `SELECT TOP 10 journalseqno, systemreferenceno,
       CASE WHEN journalseqno = systemreferenceno THEN 'MATCH' ELSE 'DIFF' END AS result
     FROM ${NEW}.[ln$lnhistloantransactionhistory]
     WHERE journalseqno IS NOT NULL AND systemreferenceno IS NOT NULL
     ORDER BY id`);

  await run(pool, 'ln$lnhistloantransactionhistory — match rate (sample 10000)',
    `SELECT
       SUM(CASE WHEN journalseqno = systemreferenceno THEN 1 ELSE 0 END) AS match_count,
       SUM(CASE WHEN journalseqno != systemreferenceno THEN 1 ELSE 0 END) AS diff_count,
       COUNT(*) AS total
     FROM (SELECT TOP 10000 journalseqno, systemreferenceno
           FROM ${NEW}.[ln$lnhistloantransactionhistory]
           ORDER BY id) t`);

  await run(pool, 'ln$lnhisthloantransactionhistoryh — journalseqno vs systemreferenceno (10 rows)',
    `SELECT TOP 10 journalseqno, systemreferenceno,
       CASE WHEN journalseqno = systemreferenceno THEN 'MATCH' ELSE 'DIFF' END AS result
     FROM ${NEW}.[ln$lnhisthloantransactionhistoryh]
     WHERE journalseqno IS NOT NULL AND systemreferenceno IS NOT NULL
     ORDER BY id`);

  await run(pool, 'lv$lvhistinvtransactionhistory — journalseqno vs systemreferenceno (10 rows)',
    `SELECT TOP 10 journalseqno, systemreferenceno,
       CASE WHEN journalseqno = systemreferenceno THEN 'MATCH' ELSE 'DIFF' END AS result
     FROM ${NEW}.[lv$lvhistinvtransactionhistory]
     WHERE journalseqno IS NOT NULL AND systemreferenceno IS NOT NULL
     ORDER BY id`);

  await run(pool, 'lv$lvhisthinvtransactionhistoryh — journalseqno vs systemreferenceno (10 rows)',
    `SELECT TOP 10 journalseqno, systemreferenceno,
       CASE WHEN journalseqno = systemreferenceno THEN 'MATCH' ELSE 'DIFF' END AS result
     FROM ${NEW}.[lv$lvhisthinvtransactionhistoryh]
     WHERE journalseqno IS NOT NULL AND systemreferenceno IS NOT NULL
     ORDER BY id`);

  // lv$lvhisthsum has systemreferenceno column — already confirmed same pattern
  await run(pool, 'lv$lvhisthsum — journalseqno vs systemreferenceno (10 rows)',
    `SELECT TOP 10 journalseqno, systemreferenceno,
       CASE WHEN journalseqno = systemreferenceno THEN 'MATCH' ELSE 'DIFF' END AS result
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE journalseqno IS NOT NULL AND systemreferenceno IS NOT NULL
     ORDER BY id`);

  await pool.close();
  console.log('\nDone.');
})();
