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

  // ---------------------------------------------------------------
  // B3: What sysref prefix patterns exist in conv$vinpllvhistory?
  // Goal: determine the exact source_filter for lvhisthsum (P-prefix only).
  // If vinpllvhistory has non-P rows, those must be excluded.
  // ---------------------------------------------------------------
  await run(pool, 'B3a: sysref prefix distribution in conv$vinpllvhistory (top 20)',
    `SELECT TOP 20
       LEFT(systemreferenceno, 3) as prefix,
       COUNT(*) as cnt
     FROM ${OLD}.[conv$vinpllvhistory]
     GROUP BY LEFT(systemreferenceno, 3)
     ORDER BY cnt DESC`);

  await run(pool, 'B3b: distinct full prefix patterns (P, ADC, CE, RQ, etc.) — first char',
    `SELECT
       LEFT(systemreferenceno, 1) as first_char,
       COUNT(*) as cnt
     FROM ${OLD}.[conv$vinpllvhistory]
     GROUP BY LEFT(systemreferenceno, 1)
     ORDER BY cnt DESC`);

  await run(pool, 'B3c: sample non-P sysrefs in conv$vinpllvhistory (5 rows)',
    `SELECT TOP 5 id, systemreferenceno
     FROM ${OLD}.[conv$vinpllvhistory]
     WHERE systemreferenceno NOT LIKE 'P%'
     ORDER BY id`);

  await run(pool, 'B3d: how many P-prefix rows in old vs how many match in lv$lvhisthsum',
    `SELECT
       (SELECT COUNT(*) FROM ${OLD}.[conv$vinpllvhistory]
        WHERE systemreferenceno LIKE 'P%') as old_P_rows,
       (SELECT COUNT(*) FROM ${NEW}.[lv$lvhisthsum]
        WHERE systemreferenceno LIKE 'P%') as new_P_rows`);

  // ---------------------------------------------------------------
  // B4: What is the real column name for debitcredit in lv$lvhisthsum?
  // Goal: fix the `debitcredit___` typo in lvhisthsum/common.yaml.
  // ---------------------------------------------------------------
  await run(pool, 'B4a: all column names in lv$lvhisthsum',
    `SELECT COLUMN_NAME, DATA_TYPE
     FROM [ncs-npl-aging].INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_NAME = 'lv$lvhisthsum'
     ORDER BY ORDINAL_POSITION`);

  await run(pool, 'B4b: sample row from lv$lvhisthsum (debitcredit-related columns)',
    `SELECT TOP 1 * FROM ${NEW}.[lv$lvhisthsum]`);

  // ---------------------------------------------------------------
  // B6: Double-counting check for SBT tax columns in lnhisthloantransactionhistoryh
  // Goal: verify whether totaltax/sbtamount/localtax is stored in BOTH H rows
  //       (credit + debit) or only in one.
  // If stored in both → SUM(new.totaltax) = 2× old value → VALUE_MISMATCH flood.
  // ---------------------------------------------------------------
  await run(pool, 'B6a: sample H rows for a sysref with non-zero totaltax (both rows)',
    `SELECT TOP 10
       n.systemreferenceno,
       n.totaltax,
       n.sbtamount,
       n.localtax,
       n.transactionamount,
       n.creditinterestamount,
       n.debitinterestamount
     FROM ${NEW}.[ln$lnhisthloantransactionhistoryh] n
     WHERE n.systemreferenceno IN (
       SELECT TOP 5 systemreferenceno
       FROM ${NEW}.[ln$lnhisthloantransactionhistoryh]
       WHERE totaltax IS NOT NULL AND totaltax != 0
     )
     ORDER BY n.systemreferenceno`);

  await run(pool, 'B6b: for matched sysrefs — SUM comparison old.sbttotalamount vs new.totaltax',
    `SELECT TOP 5
       o.systemreferenceno,
       TRY_CAST(o.sbttotalamount AS decimal(20,8)) as old_sbttotal,
       SUM(n.totaltax) as sum_new_totaltax,
       COUNT(n.id) as new_row_count
     FROM ${OLD}.[conv$vinplsbthistory] o
     JOIN ${NEW}.[ln$lnhisthloantransactionhistoryh] n
       ON o.systemreferenceno COLLATE Thai_CI_AS = n.systemreferenceno COLLATE Thai_CI_AS
     WHERE TRY_CAST(o.sbttotalamount AS decimal(20,8)) != 0
     GROUP BY o.systemreferenceno, o.sbttotalamount
     ORDER BY o.id`);

  await run(pool, 'B6c: count H rows per sysref (should be 2 for normal, 1 for ADJ)',
    `SELECT TOP 5
       systemreferenceno,
       COUNT(*) as h_row_count,
       SUM(totaltax) as sum_totaltax,
       SUM(creditinterestamount) as sum_credit,
       SUM(debitinterestamount) as sum_debit
     FROM ${NEW}.[ln$lnhisthloantransactionhistoryh]
     WHERE totaltax IS NOT NULL AND totaltax != 0
       AND systemreferenceno NOT LIKE 'ADJ-%'
     GROUP BY systemreferenceno
     ORDER BY systemreferenceno`);

  await pool.close();
  console.log('\nDone.');
})();
