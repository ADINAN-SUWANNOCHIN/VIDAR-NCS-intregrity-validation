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

async function checkIndexes(pool, db, table) {
  const label = `[${db}].dbo.[${table}]`;
  try {
    const r = await pool.request().query(
      `SELECT
         i.name AS index_name,
         i.type_desc AS type,
         CASE WHEN i.is_primary_key=1 THEN 'YES' ELSE 'NO' END AS is_pk,
         CASE WHEN i.is_unique=1 THEN 'YES' ELSE 'NO' END AS is_unique,
         (SELECT STRING_AGG(c2.name, ', ') WITHIN GROUP (ORDER BY ic2.key_ordinal)
          FROM [${db}].sys.index_columns ic2
          JOIN [${db}].sys.columns c2 ON ic2.object_id=c2.object_id AND ic2.column_id=c2.column_id
          WHERE ic2.object_id=i.object_id AND ic2.index_id=i.index_id AND ic2.is_included_column=0
         ) AS key_columns
       FROM [${db}].sys.indexes i
       JOIN [${db}].sys.objects  o ON i.object_id=o.object_id
       WHERE o.name='${table}' AND o.type='U' AND i.type>0
       ORDER BY i.type_desc DESC, i.is_primary_key DESC`
    );
    if (!r.recordset || r.recordset.length === 0) {
      console.log(`  ${label}  →  (no indexes or table not found)`);
    } else {
      r.recordset.forEach(row => {
        const pk    = row.is_pk === 'YES' ? '[PK]' : '    ';
        const uniq  = row.is_unique === 'YES' ? '[UNIQUE]' : '        ';
        console.log(`  ${label}  ${pk}${uniq} ${row.type.padEnd(14)} key: ${row.key_columns}`);
      });
    }
  } catch(e) {
    console.log(`  ${label}  ERROR: ${e.message}`);
  }
}

// Also check if a specific column has an index on a table
async function hasIndexOn(pool, db, table, colName) {
  try {
    const r = await pool.request().query(
      `SELECT COUNT(*) AS cnt
       FROM [${db}].sys.indexes i
       JOIN [${db}].sys.objects  o  ON i.object_id=o.object_id
       JOIN [${db}].sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
       JOIN [${db}].sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
       WHERE o.name='${table}' AND c.name='${colName}' AND ic.is_included_column=0 AND i.type>0`
    );
    return r.recordset[0].cnt > 0;
  } catch { return false; }
}

(async () => {
  const pool = await sql.connect(config);
  const OLD = 'ncs-conv-aging';
  const NEW = 'ncs-npl-aging';

  // ============================================================
  // CASE 1: NPA rights MULTIPLE 3:1
  // conv$vinpahistory + conv$vinpalrentalhistory + conv$vinpalrtrespasserhist
  // → la$lahistloantransactionhistory
  // ============================================================
  console.log('\n========== CASE 1: NPA rights (3 → la$lahistloantransactionhistory) ==========');
  await checkIndexes(pool, OLD, 'conv$vinpahistory');
  await checkIndexes(pool, OLD, 'conv$vinpalrentalhistory');
  await checkIndexes(pool, OLD, 'conv$vinpalrtrespasserhist');
  await checkIndexes(pool, NEW, 'la$lahistloantransactionhistory');

  // ============================================================
  // CASE 2: NPA rights H MULTIPLE 5:1
  // conv$vinpahistory + conv$vinpainvcithistoryh + conv$vinpalnsbthistory
  // + conv$vinpalrentalhistory + conv$vinpalrtrespasserhist
  // → la$lahisthloantransactionhistoryh
  // ============================================================
  console.log('\n========== CASE 2: NPA rights H (5 → la$lahisthloantransactionhistoryh) ==========');
  // vinpahistory, rentalhistory, respasserhist already checked above
  await checkIndexes(pool, OLD, 'conv$vinpainvcithistoryh');
  await checkIndexes(pool, OLD, 'conv$vinpalnsbthistory');
  await checkIndexes(pool, NEW, 'la$lahisthloantransactionhistoryh');

  // ============================================================
  // CASE 3: NPA EIR TRANSACTION
  // conv$vinpainvesthist → ls$lshistinvtransactionhistory
  //                      → ls$lshisthinvtransactionhistoryh
  // ============================================================
  console.log('\n========== CASE 3: NPA EIR (conv$vinpainvesthist → ls$ tables) ==========');
  await checkIndexes(pool, OLD, 'conv$vinpainvesthist');
  await checkIndexes(pool, NEW, 'ls$lshistinvtransactionhistory');
  await checkIndexes(pool, NEW, 'ls$lshisthinvtransactionhistoryh');

  // ============================================================
  // CASE 4: NPL rights TRANSACTION
  // conv$vinplhistory → ln$lnhistloantransactionhistory
  // ============================================================
  console.log('\n========== CASE 4: NPL rights (conv$vinplhistory → ln$lnhistloantransactionhistory) ==========');
  await checkIndexes(pool, OLD, 'conv$vinplhistory');
  await checkIndexes(pool, NEW, 'ln$lnhistloantransactionhistory');  // already known — reprinting for full picture

  // ============================================================
  // CASE 5: NPL rights H MULTIPLE 2:1
  // conv$vinplhistory + conv$vinplsbthistory → ln$lnhisthloantransactionhistoryh
  // ============================================================
  console.log('\n========== CASE 5: NPL rights H (2 → ln$lnhisthloantransactionhistoryh) ==========');
  await checkIndexes(pool, OLD, 'conv$vinplsbthistory');
  await checkIndexes(pool, NEW, 'ln$lnhisthloantransactionhistoryh');  // already known — reprinting

  // ============================================================
  // CASE 6: invest lv TRANSACTION
  // conv$vinpllvhistory → lv$lvhistinvtransactionhistory
  // ============================================================
  console.log('\n========== CASE 6: invest lv (conv$vinpllvhistory → lv$lvhistinvtransactionhistory) ==========');
  await checkIndexes(pool, OLD, 'conv$vinpllvhistory');
  await checkIndexes(pool, NEW, 'lv$lvhistinvtransactionhistory');  // already known — reprinting

  // ============================================================
  // CASE 7: invest lv MULTIPLE
  // conv$vinpllvhistory + conv$vinpllvcithistory
  // → lv$lvhisthsum
  // → lv$lvhisthinvtransactionhistoryh
  // ============================================================
  console.log('\n========== CASE 7: invest lv MULTIPLE (2 → lv$ summary tables) ==========');
  await checkIndexes(pool, OLD, 'conv$vinpllvcithistory');
  await checkIndexes(pool, NEW, 'lv$lvhisthsum');                       // already known
  await checkIndexes(pool, NEW, 'lv$lvhisthinvtransactionhistoryh');    // already known

  // ============================================================
  // USABILITY SUMMARY — check which group-key columns are indexed
  // Group keys we actually use per case:
  //   NPA: systemreferencenumber (old) / systemreferenceno (new)
  //   NPL: systemreferencenumber (old) / systemreferenceno (new)
  //   EIR: systemreferencenumber (old) / systemreferenceno (new)
  //   LV:  systemreferenceno (both)
  // ============================================================
  console.log('\n========== USABILITY CHECK: which tables have the GROUP KEY indexed? ==========');

  const checks = [
    // [db, table, colToCheck]
    [OLD, 'conv$vinpahistory',               'systemreferencenumber'],
    [OLD, 'conv$vinpalrentalhistory',         'systemreferencenumber'],
    [OLD, 'conv$vinpalrtrespasserhist',       'systemreferencenumber'],
    [OLD, 'conv$vinpainvcithistoryh',         'systemreferencenumber'],
    [OLD, 'conv$vinpalnsbthistory',           'systemreferencenumber'],
    [OLD, 'conv$vinpainvesthist',             'systemreferencenumber'],
    [OLD, 'conv$vinplhistory',                'systemreferencenumber'],
    [OLD, 'conv$vinplsbthistory',             'systemreferenceno'],
    [OLD, 'conv$vinpllvhistory',              'systemreferenceno'],
    [OLD, 'conv$vinpllvcithistory',           'systemreferenceno'],
    [NEW, 'la$lahistloantransactionhistory',  'systemreferenceno'],
    [NEW, 'la$lahisthloantransactionhistoryh','systemreferenceno'],
    [NEW, 'ls$lshistinvtransactionhistory',   'systemreferenceno'],
    [NEW, 'ls$lshisthinvtransactionhistoryh', 'systemreferenceno'],
    [NEW, 'ln$lnhistloantransactionhistory',  'systemreferenceno'],
    [NEW, 'ln$lnhisthloantransactionhistoryh','systemreferenceno'],
    [NEW, 'lv$lvhistinvtransactionhistory',   'systemreferenceno'],
    [NEW, 'lv$lvhisthsum',                    'systemreferenceno'],
    [NEW, 'lv$lvhisthinvtransactionhistoryh', 'systemreferenceno'],
  ];

  // Also check accountno/lvaccountno as fallback index candidates
  const fallbacks = [
    [NEW, 'la$lahistloantransactionhistory',  'accountno'],
    [NEW, 'la$lahisthloantransactionhistoryh','accountno'],
    [NEW, 'ls$lshistinvtransactionhistory',   'lsaccountno'],
    [NEW, 'ls$lshisthinvtransactionhistoryh', 'lsaccountno'],
    [NEW, 'ln$lnhistloantransactionhistory',  'accountno'],
    [NEW, 'ln$lnhisthloantransactionhistoryh','accountno'],
    [NEW, 'lv$lvhistinvtransactionhistory',   'lvaccountno'],
    [NEW, 'lv$lvhisthsum',                    'lvaccountno'],
    [NEW, 'lv$lvhisthinvtransactionhistoryh', 'lvaccountno'],
    // journalseqno — sometimes maps to sysref
    [NEW, 'la$lahistloantransactionhistory',  'journalseqno'],
    [NEW, 'la$lahisthloantransactionhistoryh','journalseqno'],
    [NEW, 'ls$lshistinvtransactionhistory',   'journalseqno'],
    [NEW, 'ls$lshisthinvtransactionhistoryh', 'journalseqno'],
  ];

  console.log('\n--- Primary group key (systemreferenceno/number) ---');
  for (const [db, table, col] of checks) {
    const has = await hasIndexOn(pool, db, table, col);
    console.log(`  ${has ? '[YES]' : '[NO ]'} [${db}].dbo.[${table}].${col}`);
  }

  console.log('\n--- Fallback candidates (accountno / lvaccountno / journalseqno) ---');
  for (const [db, table, col] of fallbacks) {
    const has = await hasIndexOn(pool, db, table, col);
    console.log(`  ${has ? '[YES]' : '[NO ]'} [${db}].dbo.[${table}].${col}`);
  }

  await pool.close();
  console.log('\nDone.');
})();
