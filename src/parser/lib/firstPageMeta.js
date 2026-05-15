// Extract designer / year / code / description / important / technical-notes
// from the FIRST page of a product's spread.
//
// Layout:
//   y < 40                       : designer (left) + year (right)
//   x > 480, 40 < y < 800        : running-header column with product name +
//                                  product CODE token (we skip the name)
//   "Important", "Description",
//   "Technical impossibilities" /
//   "List of cover materials suitable for this model"
//                                : section headers; body runs until next header.

import { REF_FULLMATCH, YEAR_RE } from './refs.js';
import { replacePlaceholders } from './nameFixes.js';

const DESIGNER_BLACKLIST = new Set([
  'Important',
  'Description',
  'Technical impossibilities',
  'List of cover materials suitable for this model',
  'CODE',
  'Annie Hi?ronimus',
]);

const CODE_RE = /^[A-Z0-9]{2,5}$/;
const SECTION_LABELS = [
  'Important',
  'Description',
  'Technical impossibilities',
  'List of cover materials suitable for this model',
];

export function extractFirstPageMeta(spans, { pageNumber = 0, productName = '' } = {}) {
  const meta = {};

  // 1) Designer + Year strip at the top.
  const topSpans = spans
    .filter((s) => s.y < 40)
    .slice()
    .sort((a, b) => a.x - b.x);
  if (topSpans.length) {
    const leftText = topSpans[0].text;
    const rightText = topSpans.length > 1 ? topSpans[topSpans.length - 1].text : '';
    if (
      leftText &&
      !DESIGNER_BLACKLIST.has(leftText) &&
      !/^\d+$/.test(leftText) &&
      leftText.length < 80
    ) {
      meta.designer = replacePlaceholders(leftText);
    }
    if (YEAR_RE.test(rightText)) meta.year = Number(rightText);
  }

  // 2) Product code: short alphanumeric token in the right-margin running
  // header, frequency-counted and tie-broken by "has a letter".
  const pageNoText = String(pageNumber);
  const codeSpans = spans.filter(
    (s) =>
      s.x > 480 &&
      s.y > 40 &&
      s.y < 800 &&
      CODE_RE.test(s.text) &&
      s.text !== 'CODE' &&
      s.text !== 'USD' &&
      s.text !== pageNoText &&
      s.text !== (productName || '').toUpperCase().trim(),
  );
  if (codeSpans.length) {
    const counter = new Map();
    for (const s of codeSpans) {
      counter.set(s.text, (counter.get(s.text) || 0) + 1);
    }
    const candidates = [...counter.entries()]
      .map(([text, n]) => ({ text, n, hasLetter: /[A-Z]/.test(text) }))
      // prefer most-frequent; tie-break: prefer with-letter.
      .sort((a, b) => b.n - a.n || Number(b.hasLetter) - Number(a.hasLetter));
    meta.code = candidates[0].text;
  }

  // 3) Section bodies. Find each header's y-position, collect text between
  // it and the next header, in spatial reading order.
  const sectionStarts = [];
  for (const s of spans) {
    if (SECTION_LABELS.includes(s.text)) sectionStarts.push({ y: s.y, label: s.text });
  }
  sectionStarts.sort((a, b) => a.y - b.y);

  const bodyLines = spans
    .filter((s) => s.x < 450 && s.y > 40)
    .map((s) => ({ y: s.y, x: s.x, text: s.text }))
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const sections = {};
  for (let i = 0; i < sectionStarts.length; i++) {
    const y0 = sectionStarts[i].y;
    const y1 = i + 1 < sectionStarts.length ? sectionStarts[i + 1].y : 800;
    const label = sectionStarts[i].label;
    const chunk = bodyLines.filter((t) => t.y > y0 && t.y < y1 && t.text !== label);
    sections[label] = chunk.map((t) => t.text).join(' ').trim();
  }

  if (sections.Important) meta.important = replacePlaceholders(sections.Important);
  if (sections.Description) meta.description = replacePlaceholders(sections.Description);

  const tech =
    sections['Technical impossibilities'] ||
    sections['List of cover materials suitable for this model'];
  if (tech) {
    meta.technical_notes = replacePlaceholders(tech);
    // Pull comma-separated material tokens out, dedupe, keep moderate length.
    const re = /[A-Z][A-Z0-9 ]+(?:\/FR)?(?:\([A-Z ]+\))?/g;
    const materials = new Set();
    let m;
    while ((m = re.exec(tech)) !== null) {
      const tok = m[0].trim();
      if (tok.length >= 2 && tok.length <= 30) materials.add(tok);
    }
    meta.compatible_materials = [...materials].sort();
  }

  return meta;
}
