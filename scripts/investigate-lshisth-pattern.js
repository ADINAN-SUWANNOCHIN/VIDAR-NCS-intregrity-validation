const sql = require('mssql');

const cfg = {
  server: '172.18.1.153', port: 1433,
  user: 'adinan.s', password: 'Adninp#555',
  options: { encrypt: false, trustServerCertificate: true },
  requestTimeout: 120000, connectionTimeout: 30000,
};

async function run() {
  const pool = await sql.connect(cfg);

  // ---- Q1: All distinct affectcodes in old table ----
  console.log('\n=== Q1: All distinct affectcodes in conv$vinpainvesthist ===');
  const q1 = await pool.request().query(`
    SELECT affectcode, debitcredit, COUNT(*) AS cnt,
           SUM(TRY_CAST(transactionamount AS DECIMAL(18,4))) AS total_amount
    FROM [ncs-conv-aging].dbo.[conv$vinpainvesthist]
    GROUP BY affectcode, debitcredit
    ORDER BY cnt DESC
  `);
  console.table(q1.recordset);

  // ---- Q2: Row count distribution old vs H-table ----
  console.log('\n=== Q2: old rows vs H-table rows per sysref (distribution) ===');
  const q2 = await pool.request().query(`
    SELECT old_rows, h_rows, COUNT(*) AS sysref_count
    FROM (
      SELECT o.systemreferencenumber,
             COUNT(o.id) AS old_rows,
             COUNT(h.id) AS h_rows
      FROM [ncs-conv-aging].dbo.[conv$vinpainvesthist] o
      LEFT JOIN [ncs-npl-aging].dbo.[ls$lshisthinvtransactionhistoryh] h
        ON h.systemreferenceno = o.systemreferencenumber COLLATE DATABASE_DEFAULT
      WHERE o.successlv2 = 1
      GROUP BY o.systemreferencenumber
    ) x
    GROUP BY old_rows, h_rows
    ORDER BY old_rows, h_rows
  `);
  console.table(q2.recordset);

  // ---- Q3: Does PP always appear with QQ in same sysref? ----
  console.log('\n=== Q3: Sysrefs with PP but no QQ (top 5) ===');
  const q3a = await pool.request().query(`
    SELECT TOP 5 systemreferencenumber FROM [ncs-conv-aging].dbo.[conv$vinpainvesthist]
    WHERE affectcode = 'PP' AND successlv2 = 1
      AND systemreferencenumber NOT IN (
        SELECT systemreferencenumber FROM [ncs-conv-aging].dbo.[conv$vinpainvesthist]
        WHERE affectcode = 'QQ'
      )
  `);
  console.log(`Sysrefs with PP but no QQ: ${q3a.recordset.length}`);
  if (q3a.recordset.length > 0) console.table(q3a.recordset);

  console.log('\n=== Q3b: Sysrefs with QQ but no PP (top 5) ===');
  const q3b = await pool.request().query(`
    SELECT TOP 5 systemreferencenumber FROM [ncs-conv-aging].dbo.[conv$vinpainvesthist]
    WHERE affectcode = 'QQ' AND successlv2 = 1
      AND systemreferencenumber NOT IN (
        SELECT systemreferencenumber FROM [ncs-conv-aging].dbo.[conv$vinpainvesthist]
        WHERE affectcode = 'PP'
      )
  `);
  console.log(`Sysrefs with QQ but no PP: ${q3b.recordset.length}`);
  if (q3b.recordset.length > 0) console.table(q3b.recordset);

  // ---- Q4: Column mapping verification at scale ----
  // Does SUM(old PP) = SUM(H lvcreditprincipleamount)?
  // Does SUM(old QQ) = SUM(H transactionamount)?
  // Does SUM(old I1/C) = SUM(H lvcreditinterestamount)?
  // Does SUM(old I1/D) = SUM(H lvdebitinterestamount)?
  console.log('\n=== Q4: SUM comparison — old affectcodes vs H-table columns ===');
  const q4old = await pool.request().query(`
    SELECT affectcode, debitcredit,
           SUM(TRY_CAST(transactionamount AS DECIMAL(18,4))) AS old_sum
    FROM [ncs-conv-aging].dbo.[conv$vinpainvesthist]
    WHERE successlv2 = 1
    GROUP BY affectcode, debitcredit
  `);
  const q4h = await pool.request().query(`
    SELECT
      SUM(lvcreditprincipleamount) AS h_pp_credit,
      SUM(lvdebitprincipleamount)  AS h_pp_debit,
      SUM(transactionamount)       AS h_qq,
      SUM(lvcreditinterestamount)  AS h_i1_credit,
      SUM(lvdebitinterestamount)   AS h_i1_debit,
      SUM(lvcreditgaincash)        AS h_gaincash_credit,
      SUM(lvdebitgaincash)         AS h_gaincash_debit,
      SUM(lvcreditgainsettlement)  AS h_gainsettlement_credit,
      SUM(lvdebitgainsettlement)   AS h_gainsettlement_debit
    FROM [ncs-npl-aging].dbo.[ls$lshisthinvtransactionhistoryh]
  `);
  console.log('Old table SUMs:');
  console.table(q4old.recordset);
  console.log('H-table column SUMs:');
  console.table(q4h.recordset);

  // ---- Q5: Are there sysrefs where old-H row count diff != 1 (i.e. not always PP+QQ merge)? ----
  console.log('\n=== Q5: Sysrefs where old-H row diff is NOT 1 (unexpected collapse) — top 10 ===');
  const q5 = await pool.request().query(`
    SELECT TOP 10 o.systemreferencenumber, old_rows, h_rows, old_rows - h_rows AS diff
    FROM (
      SELECT systemreferencenumber, COUNT(*) AS old_rows
      FROM [ncs-conv-aging].dbo.[conv$vinpainvesthist]
      WHERE successlv2 = 1
      GROUP BY systemreferencenumber
    ) o
    JOIN (
      SELECT systemreferenceno, COUNT(*) AS h_rows
      FROM [ncs-npl-aging].dbo.[ls$lshisthinvtransactionhistoryh]
      GROUP BY systemreferenceno
    ) h ON h.systemreferenceno = o.systemreferencenumber COLLATE DATABASE_DEFAULT
    WHERE old_rows - h_rows != 1
    ORDER BY ABS(old_rows - h_rows) DESC
  `);
  console.log(`Sysrefs with diff != 1: ${q5.recordset.length}`);
  if (q5.recordset.length > 0) console.table(q5.recordset);

  await pool.close();
}

run().catch(console.error);
