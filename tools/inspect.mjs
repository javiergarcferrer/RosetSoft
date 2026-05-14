/**
 * Diagnostic tool: dump positioned text + transform info for a specific page of the PDF.
 *
 *   node tools/inspect.mjs <pdfPath> <pageNumber>
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [, , pdfPath, pageArg] = process.argv;
if (!pdfPath) {
  console.error('Usage: node tools/inspect.mjs <pdfPath> <pageNumber>');
  process.exit(1);
}
const targetPage = parseInt(pageArg || '1', 10);

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
// In Node.js, point the worker at the legacy worker module file
pdfjs.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;

const data = new Uint8Array(readFileSync(resolve(pdfPath)));
const pdf = await pdfjs.getDocument({ data, disableFontFace: true, isEvalSupported: false, useSystemFonts: false }).promise;

console.log(`PDF: ${pdfPath} | pages: ${pdf.numPages} | inspecting: ${targetPage}`);
console.log('='.repeat(120));

const page = await pdf.getPage(targetPage);
const viewport = page.getViewport({ scale: 1.0 });
console.log(`viewport: ${viewport.width.toFixed(1)} x ${viewport.height.toFixed(1)}`);

const tc = await page.getTextContent({ disableCombineTextItems: false, includeMarkedContent: false });
console.log(`items: ${tc.items.length}`);
console.log('-'.repeat(120));
console.log('y\t\tx\t\tfs\trot\tstr');
console.log('-'.repeat(120));

const rows = [];
for (const it of tc.items) {
  if (!it.str || it.str === ' ') continue;
  const [a, b, c, d, e, f] = it.transform;
  const x = e;
  const y = viewport.height - f;
  const fs = Math.hypot(a, b) || it.height || 0;
  // Detect rotation: for normal text a,d>0,b,c=0. For 90° CCW: a=0,b=+fs,c=-fs,d=0
  let rot = 0;
  if (Math.abs(a) < 0.1 && Math.abs(b) > 0.1) rot = b > 0 ? 90 : -90;
  else if (a < 0) rot = 180;
  rows.push({ x, y, fs, rot, str: it.str });
}

rows.sort((a, b) => a.y - b.y || a.x - b.x);
for (const r of rows) {
  const s = JSON.stringify(r.str);
  console.log(`${r.y.toFixed(1).padStart(6)}\t${r.x.toFixed(1).padStart(6)}\t${r.fs.toFixed(1).padStart(5)}\t${String(r.rot).padStart(4)}\t${s}`);
}
