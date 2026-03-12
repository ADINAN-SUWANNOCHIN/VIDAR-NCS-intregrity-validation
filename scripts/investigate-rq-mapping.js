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
const OLD = '[ncs-conv-aging].dbo';
const NEW = '[ncs-npl-aging].dbo';

async function run(pool, label, q) {
  console.log('\n=== ' + label + ' ===');
  try {
    const r = await pool.request().query(q);
    if (!r.recordset.length) console.log('  (no rows)');
    else r.recordset.forEach((row, i) => console.log('  [' + i + '] ' + JSON.stringify(row)));
  } catch (e) { console.log('  ERROR: ' + e.message); }
}

(async () => {
  const pool = await sql.connect(config);

  // 1. Does cithistory have RQ11-113-000001 at all?
  await run(pool, 'cithistory: RQ11-113-000001 rows',
    `SELECT invaccountno, newinvaccountno, systemreferenceno FROM ${OLD}.[conv$vinpllvcithistory] WHERE systemreferenceno = 'RQ11-113-000001'`);

  // 2. What accountno does vinpllvhistory have for RQ11-113-000001?
  await run(pool, 'vinpllvhistory: RQ11-113-000001',
    `SELECT accountno, affectcode, debitcredit, TRY_CAST(transactionamount AS decimal(20,4)) AS txamt, loantranshostcode FROM ${OLD}.[conv$vinpllvhistory] WHERE systemreferenceno = 'RQ11-113-000001'`);

  // 3. What does lvhisthsum have for RQ11-113-000001?
  await run(pool, 'lvhisthsum: RQ11-113-000001',
    `SELECT lvaccountno, lvcreditinterestamount, lvdebitinterestamount, lvcreditprincipleamount, lvdebitprincipleamount FROM ${NEW}.[lv$lvhisthsum] WHERE systemreferenceno = 'RQ11-113-000001'`);

  // 4. Is lvaccountno = old accountno directly (no translation for RQ)?
  // vinpllvhistory accountno for RQ11-113-000001 = "847927" — does lvhisthsum have lvaccountno="847927"?
  await run(pool, 'lvhisthsum: does lvaccountno=847927 for RQ11-113-000001?',
    `SELECT lvaccountno FROM ${NEW}.[lv$lvhisthsum] WHERE systemreferenceno = 'RQ11-113-000001' AND lvaccountno = '847927'`);

  // 5. What RQ sysref formats does cithistory have?
  await run(pool, 'cithistory: sample RQ sysrefs (all formats)',
    `SELECT TOP 10 systemreferenceno, invaccountno, newinvaccountno FROM ${OLD}.[conv$vinpllvcithistory] WHERE systemreferenceno LIKE 'RQ%' ORDER BY systemreferenceno`);

  // 6. RQ sysref format in vinpllvhistory
  await run(pool, 'vinpllvhistory: RQ sysref format breakdown',
    `SELECT LEFT(systemreferenceno, 12) AS prefix12, COUNT(*) AS cnt FROM ${OLD}.[conv$vinpllvhistory] WHERE systemreferenceno LIKE 'RQ%' GROUP BY LEFT(systemreferenceno, 12) ORDER BY cnt DESC OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY`);

  // 7. Does the RQ sysref in cithistory match a different format?
  //    e.g. cithistory might store "RQ17-120-013257" (long format) but vinpllvhistory uses "RQ11-113-000001" (short)
  await run(pool, 'cithistory: all RQ sysref formats (first 4 chars after RQ)',
    `SELECT LEFT(systemreferenceno, 8) AS prefix8, COUNT(*) AS cnt FROM ${OLD}.[conv$vinpllvcithistory] WHERE systemreferenceno LIKE 'RQ%' GROUP BY LEFT(systemreferenceno, 8) ORDER BY cnt DESC OFFSET 0 ROWS FETCH NEXT 15 ROWS ONLY`);

  // 8. lvhisthsum: RQ sysref format breakdown
  await run(pool, 'lvhisthsum: RQ sysref format breakdown',
    `SELECT LEFT(systemreferenceno, 12) AS prefix12, COUNT(*) AS cnt FROM ${NEW}.[lv$lvhisthsum] WHERE systemreferenceno LIKE 'RQ%' GROUP BY LEFT(systemreferenceno, 12) ORDER BY cnt DESC OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY`);

  // 9. Find an RQ sysref that IS in cithistory (the long format like RQ17-120-013257)
  //    Does vinpllvhistory ALSO have that sysref?
  await run(pool, 'vinpllvhistory: RQ17-120-013257 (long format RQ sysref)',
    `SELECT accountno, affectcode, debitcredit, TRY_CAST(transactionamount AS decimal(20,4)) AS txamt FROM ${OLD}.[conv$vinpllvhistory] WHERE systemreferenceno = 'RQ17-120-013257'`);

  await run(pool, 'cithistory: RQ17-120-013257',
    `SELECT invaccountno, newinvaccountno FROM ${OLD}.[conv$vinpllvcithistory] WHERE systemreferenceno = 'RQ17-120-013257'`);

  await run(pool, 'lvhisthsum: RQ17-120-013257',
    `SELECT lvaccountno, lvcreditinterestamount, lvdebitinterestamount FROM ${NEW}.[lv$lvhisthsum] WHERE systemreferenceno = 'RQ17-120-013257'`);

  // 10. For RQ11-113-000001: is the accountno "847927" present as invaccountno in cithistory
  //     but under a DIFFERENT sysref?
  await run(pool, 'cithistory: find invaccountno=847927 (what sysref does it appear under?)',
    `SELECT TOP 5 systemreferenceno, invaccountno, newinvaccountno FROM ${OLD}.[conv$vinpllvcithistory] WHERE invaccountno = '847927'`);

  await pool.close();
  console.log('\nDone.');
})();
