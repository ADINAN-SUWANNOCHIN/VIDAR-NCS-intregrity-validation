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
  // PART 1: Row counts for all sources and targets
  // ----------------------------------------------------------------
  console.log('\n========== PART 1: Row counts ==========');

  for (const tbl of [
    `${OLD}.[conv$vinpllvhistory]`,
    `${OLD}.[conv$vinpllvcithistory]`,
    `${NEW}.[lv$lvhisthsum]`,
    `${NEW}.[lv$lvhisthinvtransactionhistoryh]`,
    `${NEW}.[lv$lvhisth_fbo]`,
    `${NEW}.[lv$lvhisth_truesale]`,
    `${NEW}.[lv$lvhisth_fbo_truesale]`,
  ]) {
    await run(pool, `COUNT ${tbl}`, `SELECT COUNT(*) AS cnt FROM ${tbl}`);
  }

  // ----------------------------------------------------------------
  // PART 2: Source sysref prefix distribution
  // ----------------------------------------------------------------
  console.log('\n========== PART 2: Source sysref prefix distribution ==========');

  await run(pool, 'conv$vinpllvhistory: sysref prefix counts',
    `SELECT LEFT(systemreferenceno, 2) AS prefix, COUNT(*) AS cnt
     FROM ${OLD}.[conv$vinpllvhistory]
     GROUP BY LEFT(systemreferenceno, 2)
     ORDER BY cnt DESC`);

  await run(pool, 'conv$vinpllvcithistory: sysref prefix counts',
    `SELECT LEFT(systemreferenceno, 2) AS prefix, COUNT(*) AS cnt
     FROM ${OLD}.[conv$vinpllvcithistory]
     GROUP BY LEFT(systemreferenceno, 2)
     ORDER BY cnt DESC`);

  await run(pool, 'conv$vinpllvcithistory: distinct invaccounttype values',
    `SELECT invaccounttype, COUNT(*) AS cnt
     FROM ${OLD}.[conv$vinpllvcithistory]
     GROUP BY invaccounttype
     ORDER BY cnt DESC`);

  // ----------------------------------------------------------------
  // PART 3: Target sysref prefix distribution (what ends up where)
  // ----------------------------------------------------------------
  console.log('\n========== PART 3: Target sysref prefix distribution ==========');

  for (const tbl of [
    `${NEW}.[lv$lvhisthsum]`,
    `${NEW}.[lv$lvhisthinvtransactionhistoryh]`,
    `${NEW}.[lv$lvhisth_fbo]`,
    `${NEW}.[lv$lvhisth_truesale]`,
    `${NEW}.[lv$lvhisth_fbo_truesale]`,
  ]) {
    await run(pool, `${tbl}: sysref prefix`,
      `SELECT LEFT(systemreferenceno, 2) AS prefix, COUNT(*) AS cnt
       FROM ${tbl}
       GROUP BY LEFT(systemreferenceno, 2)
       ORDER BY cnt DESC`);
  }

  // ----------------------------------------------------------------
  // PART 4: Column comparison — do all 5 targets share the same schema?
  // ----------------------------------------------------------------
  console.log('\n========== PART 4: Column count per target ==========');

  await run(pool, 'Column counts per target table',
    `SELECT TABLE_NAME, COUNT(*) AS col_count
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = 'dbo'
       AND TABLE_NAME IN (
         'lv$lvhisthsum','lv$lvhisthinvtransactionhistoryh',
         'lv$lvhisth_fbo','lv$lvhisth_truesale','lv$lvhisth_fbo_truesale'
       )
     GROUP BY TABLE_NAME
     ORDER BY col_count DESC`);

  // Columns in lvhisthsum NOT in lvhisthinvtransactionhistoryh
  await run(pool, 'Columns in lvhisthsum only (not in lvhisthinvtransactionhistoryh)',
    `SELECT a.COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS a
     WHERE a.TABLE_NAME = 'lv$lvhisthsum' AND a.TABLE_SCHEMA = 'dbo'
       AND a.COLUMN_NAME NOT IN (
         SELECT b.COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS b
         WHERE b.TABLE_NAME = 'lv$lvhisthinvtransactionhistoryh' AND b.TABLE_SCHEMA = 'dbo'
       )
     ORDER BY a.ORDINAL_POSITION`);

  // Columns in lvhisthinvtransactionhistoryh NOT in lvhisthsum
  await run(pool, 'Columns in lvhisthinvtransactionhistoryh only (not in lvhisthsum)',
    `SELECT a.COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS a
     WHERE a.TABLE_NAME = 'lv$lvhisthinvtransactionhistoryh' AND a.TABLE_SCHEMA = 'dbo'
       AND a.COLUMN_NAME NOT IN (
         SELECT b.COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS b
         WHERE b.TABLE_NAME = 'lv$lvhisthsum' AND b.TABLE_SCHEMA = 'dbo'
       )
     ORDER BY a.ORDINAL_POSITION`);

  // Are lv$lvhisth_fbo/truesale/fbo_truesale identical schema to lvhisthinvtransactionhistoryh?
  await run(pool, 'Columns in lv$lvhisth_fbo NOT in lvhisthinvtransactionhistoryh',
    `SELECT a.COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS a
     WHERE a.TABLE_NAME = 'lv$lvhisth_fbo' AND a.TABLE_SCHEMA = 'dbo'
       AND a.COLUMN_NAME NOT IN (
         SELECT b.COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS b
         WHERE b.TABLE_NAME = 'lv$lvhisthinvtransactionhistoryh' AND b.TABLE_SCHEMA = 'dbo'
       )`);

  await run(pool, 'Columns in lv$lvhisth_truesale NOT in lvhisthinvtransactionhistoryh',
    `SELECT a.COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS a
     WHERE a.TABLE_NAME = 'lv$lvhisth_truesale' AND a.TABLE_SCHEMA = 'dbo'
       AND a.COLUMN_NAME NOT IN (
         SELECT b.COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS b
         WHERE b.TABLE_NAME = 'lv$lvhisthinvtransactionhistoryh' AND b.TABLE_SCHEMA = 'dbo'
       )`);

  // ----------------------------------------------------------------
  // PART 5: lv$lvhisthsum — do CE/RQ sysrefs end up in it? (cithistory→lvhisthsum path)
  // ----------------------------------------------------------------
  console.log('\n========== PART 5: Is there a cithistory→lvhisthsum path? ==========');

  await run(pool, 'lvhisthsum: sample CE/RQ rows (do they have lv* cols populated?)',
    `SELECT TOP 3 systemreferenceno,
            lvcreditprincipleamount, lvdebitprincipleamount,
            lvcreditinterestamount, lvdebitinterestamount,
            lvcreditotherchargeamount, transactionamount
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno LIKE 'CE%'`);

  await run(pool, 'lvhisthsum: sample RQ rows',
    `SELECT TOP 3 systemreferenceno,
            lvcreditprincipleamount, lvdebitprincipleamount,
            lvcreditinterestamount, lvdebitinterestamount,
            transactionamount
     FROM ${NEW}.[lv$lvhisthsum]
     WHERE systemreferenceno LIKE 'RQ%'`);

  // ----------------------------------------------------------------
  // PART 6: Does conv$vinpllvcithistory have the same columns as conv$vinpllvhistory?
  // ----------------------------------------------------------------
  console.log('\n========== PART 6: Old source column comparison ==========');

  await run(pool, 'Columns in conv$vinpllvcithistory NOT in conv$vinpllvhistory',
    `SELECT a.COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS a
     WHERE a.TABLE_NAME = 'conv$vinpllvcithistory' AND a.TABLE_SCHEMA = 'dbo'
       AND a.COLUMN_NAME NOT IN (
         SELECT b.COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS b
         WHERE b.TABLE_NAME = 'conv$vinpllvhistory' AND b.TABLE_SCHEMA = 'dbo'
       )
     ORDER BY a.ORDINAL_POSITION`);

  await run(pool, 'Columns in conv$vinpllvhistory NOT in conv$vinpllvcithistory',
    `SELECT a.COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS a
     WHERE a.TABLE_NAME = 'conv$vinpllvhistory' AND a.TABLE_SCHEMA = 'dbo'
       AND a.COLUMN_NAME NOT IN (
         SELECT b.COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS b
         WHERE b.TABLE_NAME = 'conv$vinpllvcithistory' AND b.TABLE_SCHEMA = 'dbo'
       )
     ORDER BY a.ORDINAL_POSITION`);

  await pool.close();
  console.log('\nDone.');
})();
