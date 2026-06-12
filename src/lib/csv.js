// Minimal CSV utilities. RFC 4180 quoting: double-quote fields containing
// commas, quotes, or newlines; double up internal quotes. Excel/Sheets-friendly.

export function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function csvRow(cells) {
  return cells.map(csvEscape).join(',');
}

export function buildCsv(rows) {
  return rows.map(csvRow).join('\r\n');
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv(filename, rows) {
  // BOM so Excel picks UTF-8 correctly (accented characters, ñ, etc.).
  const body = '﻿' + buildCsv(rows);
  downloadBlob(filename, new Blob([body], { type: 'text/csv;charset=utf-8;' }));
}

/** Download a prebuilt plain-text body (e.g. a DGII 606/607 TXT). No BOM —
 *  the Oficina Virtual wants the bare pipe-delimited file. */
export function downloadText(filename, text) {
  downloadBlob(filename, new Blob([text], { type: 'text/plain;charset=utf-8;' }));
}
