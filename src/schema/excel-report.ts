import * as ExcelJS from 'exceljs';
import { ColumnMatch, MatchStatus, MatcherResult } from './column-matcher';

// ----------------------------------------------------------------
// Color palette (V50-inspired)
// ----------------------------------------------------------------

const COLORS = {
  headerBlue:   { argb: 'FF4472C4' },
  headerOrange: { argb: 'FFF4B084' },
  headerPurple: { argb: 'FF7030A0' },
  headerGray:   { argb: 'FF595959' },
  white:        { argb: 'FFFFFFFF' },

  verifiedFill:       { argb: 'FFC6EFCE' },
  verifiedFont:       { argb: 'FF006100' },
  probableFill:       { argb: 'FFDDEBF7' },
  probableFont:       { argb: 'FF1F4E79' },
  manualFill:         { argb: 'FFFFEB9C' },
  manualFont:         { argb: 'FF9C5700' },
  noMatchFill:        { argb: 'FFFFC7CE' },
  noMatchFont:        { argb: 'FF9C0006' },
  noisyFill:          { argb: 'FFD9D9D9' },
  noisyFont:          { argb: 'FF000000' },
  sameNameDiffFill:   { argb: 'FFFFCCFF' },   // light purple — same name, different data
  sameNameDiffFont:   { argb: 'FF7B2C9B' },
  regeneratedIdFill:  { argb: 'FFFFE0CC' },   // light orange — ID regenerated
  regeneratedIdFont:  { argb: 'FF7F3F00' },
};

function statusFill(status: MatchStatus): { fill: ExcelJS.FillPattern; fontColor: { argb: string } } {
  switch (status) {
    case 'VERIFIED':
      return { fill: { type: 'pattern', pattern: 'solid', fgColor: COLORS.verifiedFill }, fontColor: COLORS.verifiedFont };
    case 'PROBABLE':
      return { fill: { type: 'pattern', pattern: 'solid', fgColor: COLORS.probableFill }, fontColor: COLORS.probableFont };
    case 'MANUAL_CHECK':
      return { fill: { type: 'pattern', pattern: 'solid', fgColor: COLORS.manualFill }, fontColor: COLORS.manualFont };
    case 'NO_MATCH':
      return { fill: { type: 'pattern', pattern: 'solid', fgColor: COLORS.noMatchFill }, fontColor: COLORS.noMatchFont };
    case 'SAME_NAME_DIFF_DATA':
      return { fill: { type: 'pattern', pattern: 'solid', fgColor: COLORS.sameNameDiffFill }, fontColor: COLORS.sameNameDiffFont };
    case 'REGENERATED_ID':
      return { fill: { type: 'pattern', pattern: 'solid', fgColor: COLORS.regeneratedIdFill }, fontColor: COLORS.regeneratedIdFont };
    default: // NULL_COLUMN / ZERO_COLUMN / BOOLEAN_COLUMN
      return { fill: { type: 'pattern', pattern: 'solid', fgColor: COLORS.noisyFill }, fontColor: COLORS.noisyFont };
  }
}

function applyHeaderStyle(row: ExcelJS.Row, bgColor: { argb: string }) {
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: bgColor };
    cell.font = { bold: true, color: COLORS.white };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FF000000' } },
    };
  });
  row.height = 20;
}

function applyDataRowStyle(row: ExcelJS.Row, status: MatchStatus) {
  const { fill, fontColor } = statusFill(status);
  row.eachCell((cell) => {
    cell.fill = fill;
    cell.font = { color: fontColor };
    cell.alignment = { vertical: 'middle', wrapText: false };
  });
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// ----------------------------------------------------------------
// Split candidate detection
// ----------------------------------------------------------------

interface SplitCandidate {
  oldCol: string;
  newCols: string[];
  namePct: string[];
}

function detectSplitCandidates(
  matches: ColumnMatch[],
  unmatchedNew: string[],
): SplitCandidate[] {
  const candidates: SplitCandidate[] = [];

  for (const m of matches) {
    if (m.status !== 'NO_MATCH') continue;
    if (m.oldCol.inferredType !== 'numeric') continue;

    const oldName = m.oldCol.name.toLowerCase();
    const prefix = oldName.substring(0, Math.max(3, Math.floor(oldName.length * 0.5)));

    const related = unmatchedNew.filter((nc) => {
      const nn = nc.toLowerCase();
      return nn.startsWith(prefix) || oldName.startsWith(nc.toLowerCase().substring(0, Math.max(3, Math.floor(nc.length * 0.5))));
    });

    if (related.length >= 2) {
      candidates.push({
        oldCol: m.oldCol.name,
        newCols: related,
        namePct: related.map((nc) => pct(stringSim(m.oldCol.name, nc))),
      });
    }
  }

  return candidates;
}

function stringSim(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return 1;
  const maxLen = Math.max(la.length, lb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(la, lb) / maxLen;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// ----------------------------------------------------------------
// Main export
// ----------------------------------------------------------------

export interface ExcelReportInput {
  oldTable: string;
  newTable: string;
  tableType: string;
  sampleSize: number;
  result: MatcherResult;
  yamlContent: string;
}

export async function writeExcelReport(input: ExcelReportInput): Promise<Buffer> {
  const { oldTable, newTable, tableType, sampleSize, result, yamlContent } = input;
  const { matches, anchorOld, anchorNew, anchorOverlapPct, unmatchedNew } = result;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'DV Schema Analyzer';
  wb.created = new Date();

  // ----------------------------------------------------------------
  // Sheet 1: Mapping Result
  // ----------------------------------------------------------------

  const s1 = wb.addWorksheet('Mapping Result');
  s1.columns = [
    { header: 'Old Column',    key: 'oldCol',    width: 28 },
    { header: 'Old Type',      key: 'oldType',   width: 14 },
    { header: 'Old Sample',    key: 'oldSample', width: 30 },
    { header: 'New Column',    key: 'newCol',    width: 28 },
    { header: 'New Type',      key: 'newType',   width: 14 },
    { header: 'New Sample',    key: 'newSample', width: 30 },
    { header: 'Status',        key: 'status',    width: 16 },
    { header: 'Confidence%',   key: 'conf',      width: 13 },
    { header: 'Name Match%',   key: 'nameSim',   width: 13 },
    { header: 'Value Match%',  key: 'valSim',    width: 13 },
    { header: 'Transform Hint',key: 'hint',      width: 20 },
  ];
  applyHeaderStyle(s1.getRow(1), COLORS.headerBlue);

  for (const m of matches) {
    const row = s1.addRow({
      oldCol:    m.oldCol.name,
      oldType:   m.oldCol.inferredType,
      oldSample: m.oldCol.sampleValues.join(', '),
      newCol:    m.newCol?.name ?? '',
      newType:   m.newCol?.inferredType ?? '',
      newSample: m.newCol?.sampleValues.join(', ') ?? '',
      status:    m.status,
      conf:      pct(m.confidence),
      nameSim:   pct(m.nameSim),
      valSim:    pct(m.valueSim),
      hint:      m.transformHint,
    });
    applyDataRowStyle(row, m.status);
  }

  // ----------------------------------------------------------------
  // Sheet 2: Unmatched Old Columns
  // ----------------------------------------------------------------

  const s2 = wb.addWorksheet('Unmatched Old Columns');
  s2.columns = [
    { header: 'Name',    key: 'name',    width: 28 },
    { header: 'Type',    key: 'type',    width: 14 },
    { header: 'Sample',  key: 'sample',  width: 35 },
    { header: 'Reason',  key: 'reason',  width: 40 },
  ];
  applyHeaderStyle(s2.getRow(1), COLORS.headerOrange);

  for (const m of matches.filter((x) => x.status === 'NO_MATCH')) {
    s2.addRow({
      name:   m.oldCol.name,
      type:   m.oldCol.inferredType,
      sample: m.oldCol.sampleValues.join(', '),
      reason: `Confidence ${pct(m.confidence)} — best candidate: "${m.newCol?.name ?? 'none'}"`,
    });
  }

  // ----------------------------------------------------------------
  // Sheet 3: Split Candidates
  // ----------------------------------------------------------------

  const s3 = wb.addWorksheet('Split Candidates');
  s3.columns = [
    { header: 'Old Column',       key: 'oldCol',  width: 28 },
    { header: 'Candidate New 1',  key: 'new1',    width: 28 },
    { header: 'Candidate New 2',  key: 'new2',    width: 28 },
    { header: 'Name Match 1%',    key: 'pct1',    width: 14 },
    { header: 'Name Match 2%',    key: 'pct2',    width: 14 },
  ];
  applyHeaderStyle(s3.getRow(1), COLORS.headerPurple);

  const splitCandidates = detectSplitCandidates(matches, unmatchedNew);
  for (const sc of splitCandidates) {
    s3.addRow({
      oldCol: sc.oldCol,
      new1:   sc.newCols[0] ?? '',
      new2:   sc.newCols[1] ?? '',
      pct1:   sc.namePct[0] ?? '',
      pct2:   sc.namePct[1] ?? '',
    });
  }

  // ----------------------------------------------------------------
  // Sheet 4: Summary
  // ----------------------------------------------------------------

  const s4 = wb.addWorksheet('Summary');
  s4.getColumn(1).width = 26;
  s4.getColumn(2).width = 45;

  const verified       = matches.filter((m) => m.status === 'VERIFIED').length;
  const probable       = matches.filter((m) => m.status === 'PROBABLE').length;
  const manual         = matches.filter((m) => m.status === 'MANUAL_CHECK').length;
  const noMatch        = matches.filter((m) => m.status === 'NO_MATCH').length;
  const sameNameDiff   = matches.filter((m) => m.status === 'SAME_NAME_DIFF_DATA').length;
  const regeneratedId  = matches.filter((m) => m.status === 'REGENERATED_ID').length;
  const noisy          = matches.filter((m) => ['NULL_COLUMN','ZERO_COLUMN','BOOLEAN_COLUMN'].includes(m.status)).length;

  const anchorLabel = anchorOld && anchorNew
    ? `${anchorOld} → ${anchorNew}${anchorOverlapPct !== null ? ` (${anchorOverlapPct}% value overlap)` : ''}`
    : '(not detected)';

  const summaryRows: [string, string | number][] = [
    ['Old table',              oldTable],
    ['New table',              newTable],
    ['Table type',             tableType],
    ['Sample size',            sampleSize],
    ['Generated at',           new Date().toISOString()],
    ['', ''],
    ['Total old cols',         matches.length],
    ['VERIFIED',               verified],
    ['PROBABLE',               probable],
    ['MANUAL_CHECK',           manual],
    ['NO_MATCH',               noMatch],
    ['SAME_NAME_DIFF_DATA',    sameNameDiff],
    ['REGENERATED_ID',         regeneratedId],
    ['Noisy (skip)',            noisy],
    ['', ''],
    ['Anchor key detected',    anchorLabel],
  ];

  for (const [label, value] of summaryRows) {
    const row = s4.addRow([label, value]);
    if (label) {
      row.getCell(1).font = { bold: true };
    }
  }

  // ----------------------------------------------------------------
  // Sheet 5: Draft YAML
  // ----------------------------------------------------------------

  const s5 = wb.addWorksheet('Draft YAML');
  s5.getColumn(1).width = 90;
  applyHeaderStyle(s5.getRow(1), COLORS.headerGray);
  s5.getRow(1).getCell(1).value = 'Draft common.yaml — copy this content to rules/tables/{tableName}/common.yaml';

  for (const line of yamlContent.split('\n')) {
    const row = s5.addRow([line]);
    row.getCell(1).font = { name: 'Courier New', size: 10 };
    row.getCell(1).alignment = { vertical: 'middle' };
  }

  // ----------------------------------------------------------------
  // Return as buffer (no disk write)
  // ----------------------------------------------------------------

  const raw = await wb.xlsx.writeBuffer();
  return Buffer.from(raw);
}
