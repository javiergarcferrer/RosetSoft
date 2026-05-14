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

export function downloadCsv(filename, rows) {
  // BOM so Excel picks UTF-8 correctly (accented characters, ñ, etc.).
  const body = '﻿' + buildCsv(rows);
  const blob = new Blob([body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
