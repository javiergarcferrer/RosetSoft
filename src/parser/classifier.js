/**
 * Classify a parsed page into a structural type.
 *
 * Types:
 *   - 'section'      A category divider page (very few items + 1 large banner)
 *   - 'fabric-list'  A "Cover Materials" fabric table page
 *   - 'leather-list' A leather table page
 *   - 'outdoor-list' An outdoor-fabrics table page
 *   - 'product'      A product description and/or pricing page
 *   - 'toc'          Table of contents / summary
 *   - 'cover'        Front matter, intro, legal text, generic info
 *   - 'unknown'
 */

import { groupRows } from './pageReader.js';

export function classifyPage({ items, width, height, pageNumber }) {
  if (!items.length) return { type: 'cover' };
  const rows = groupRows(items, 2);

  // Section divider: very few items overall, with exactly one large rotated banner
  // and no body content (no "Description", "Important", "Reference", etc.).
  const bigRotated = items.filter((it) => Math.abs(it.rotation) === 90 && it.fontSize >= 20);
  const hasBody = items.some((it) => it.rotation === 0 && /^(Important|Description|Reference|Yardage|Currency|Dimensions|Name)/i.test(it.str.trim()));
  if (items.length <= 8 && bigRotated.length === 1 && !hasBody) {
    return { type: 'section', sectionName: cleanSectionName(bigRotated[0].str) };
  }

  // Materials pages: look for header row with column labels
  const upperLines = rows
    .filter((r) => r.y < 80)
    .map((r) => r.items.map((i) => i.str.toUpperCase()).join(' '));
  const upperText = upperLines.join(' ');
  if (/NAME/.test(upperText) && /GRADE/.test(upperText) && /COMPOSITION/.test(upperText)) {
    if (/THICKNESS/.test(upperText) || /PRICE PER SM/.test(upperText)) {
      return { type: 'leather-list' };
    }
    if (/OUTDOOR/.test(upperText)) return { type: 'outdoor-list' };
    return { type: 'fabric-list' };
  }
  // TOC pages: lots of dotted lines with page numbers
  const dotsCount = items.filter((it) => /\.\s*\.\s*\.\s*\./.test(it.str)).length;
  if (dotsCount >= 5) return { type: 'toc' };

  // Cabinetry / dining table layout: column headers at top (Name|Dimensions|Colors|Reference|USD)
  const topRow = items.filter((it) => it.rotation === 0 && it.y < 50);
  const hasCabinetCols =
    topRow.some((it) => /^Reference$/i.test(it.str.trim()) && it.x > 400) &&
    topRow.some((it) => /^USD$/i.test(it.str.trim()) && it.x > 480) &&
    topRow.some((it) => /^Colors$/i.test(it.str.trim()) && it.x > 200);
  if (hasCabinetCols) return { type: 'cabinetry' };

  // Product pages: large rotated banner OR a "Reference"/"Yardage" row in left column
  const hasBanner = items.some((it) => Math.abs(it.rotation) === 90 && it.fontSize >= 18);
  const hasRefRow = rows.some((r) => r.items.some((it) => it.x < 130 && /^Reference$/i.test(it.str.trim())));
  const hasYardageRow = rows.some((r) => r.items.some((it) => it.x < 130 && /^Yardage$/i.test(it.str.trim())));

  if (hasBanner || (hasRefRow && hasYardageRow)) {
    return { type: 'product', hasBanner };
  }

  // Could not classify confidently
  return { type: 'unknown' };
}

function cleanSectionName(s) {
  return s.replace(/\s+/g, ' ').trim();
}
