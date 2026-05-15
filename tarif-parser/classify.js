// Pure page classifier. Stateless function from positioned text items to a
// page kind. The kinds form a small set; the state machine in index.js
// interprets them.
//
// kind ∈ { blank, section, product, cabinetry, fabric-list, leather-list,
//          outdoor-list, noise }
//
// The classifier reads the document's own visual grammar — no catalog of
// known product, section, designer, or fiber names. Every test is on
// structural facts the PDF itself prints: rotated banners, the literal
// labels "Reference", "USD", "Currency", "Description", "Important",
// "Roset Name", "GRADE" / "PRICE", or grade letters A..Z laid out in the
// left margin.

import { groupRows } from './pdf.js';

export function classifyPage(pageInfo) {
  const { items } = pageInfo;
  if (!items.length) return { kind: 'blank', hints: { reason: 'empty' } };

  const visible = items.filter((it) => it.str && it.str.trim().length > 0);

  // Blank back-pages carry only page furniture (page number, date footer,
  // model-code tag) and no real banner.
  const hasAnyBanner = visible.some((it) => isBannerLike(it, 22));
  if (visible.length <= 4 && !hasAnyBanner) {
    return { kind: 'blank', hints: { reason: 'furniture-only' } };
  }

  const rows = groupRows(items, 2);
  const topText = rows
    .filter((r) => r.y < 110)
    .map((r) => r.items.map((it) => it.str.toUpperCase()).join(' '))
    .join(' ');

  const rotatedBanners = visible.filter((it) => isRotatedBanner(it));
  const allBanners = visible.filter((it) => isBannerLike(it, 22));

  // Header row — used by Cabinetry and Per-fabric detection.
  const topRow = visible.filter((it) => it.rotation === 0 && it.y < 50);
  const refHeaders = topRow.filter((it) => /^Reference(\s+[A-Z])?$/i.test(it.str.trim()) && it.x > 80);
  const priceHeaders = topRow.filter((it) => /^(USD|Currency)$/i.test(it.str.trim()));

  // ── A. Per-fabric color page ───────────────────────────────────────
  // The literal "Roset Name" header identifies this layout regardless of
  // how many columns the page splits into (single or 2-up).
  if (/\bROSET\s*NAME\b/.test(topText) && rotatedBanners.length >= 1) {
    return {
      kind: pickMaterialKindFromBanner(rotatedBanners[0].str),
      hints: { perFabric: true, banner: rotatedBanners[0].str.trim() },
    };
  }

  // ── B. Legacy multi-fabric table ───────────────────────────────────
  if (/\bGRADE\b/.test(topText) && /\bPRICE\b/.test(topText)) {
    return {
      kind: pickLegacyMaterialKind(rotatedBanners, topText),
      hints: { legacyTable: true },
    };
  }

  // ── C. Cabinetry table ─────────────────────────────────────────────
  // Header row contains at least one "Reference [X]" and one "USD" or
  // "Currency". Covers four flavours we've observed:
  //   - ALLUNGAMI  (single Reference column at x≈494)
  //   - BOOK&LOOK  (4 Reference columns at x>200)
  //   - LINENS / Samples & sales tools (Reference at x≈120, Currency column)
  if (refHeaders.length >= 1 && priceHeaders.length >= 1) {
    return { kind: 'cabinetry', hints: { refCols: refHeaders.length } };
  }

  // ── D. Upholstered product table ───────────────────────────────────
  // A "Reference" label in the LEFT margin (x<130) AND at least one
  // grade-letter label (single uppercase A..Z) also at x<130 confirms the
  // grid layout. Banner may be absent on continuation pages.
  const hasLeftRefLabel = rows.some((r) =>
    r.items.some((it) => it.x < 130 && /^Reference$/i.test(it.str.trim()))
  );
  const hasGradeLabel = rows.some((r) =>
    r.items.some(
      (it) => it.x < 130 && /^[A-Z]$/.test(it.str.trim()) && it.fontSize <= 9
    )
  );
  if (hasLeftRefLabel && hasGradeLabel) {
    return {
      kind: 'product',
      hints: { continuation: rotatedBanners.length === 0 },
    };
  }

  // ── E. Product front-card / description page ──────────────────────
  // A banner (rotated or horizontal) AND a left-margin "Description" or
  // "Important" section header. Has no variant table but contributes
  // designer / year / description / important to the product accumulator
  // and sets currentProductKey so the next page's table belongs to it.
  const hasDescriptionLabel = rows.some((r) =>
    r.items.some(
      (it) =>
        it.x < 80 &&
        it.fontSize >= 9 &&
        /^(?:Description|Important|Concept)$/i.test(it.str.trim())
    )
  );
  if (allBanners.length >= 1 && hasDescriptionLabel) {
    const banner = allBanners[0];
    return { kind: 'product', hints: { frontCard: true, banner: banner.str.trim() } };
  }

  // ── F. Section divider ─────────────────────────────────────────────
  // A page whose only structural content is a single big banner. Used for
  // category dividers ("FABRICS", "SEATS & CHAIRS") and intro pages.
  if (rotatedBanners.length === 1) {
    return {
      kind: 'section',
      hints: { sectionName: cleanSectionName(rotatedBanners[0].str) },
    };
  }

  // Substantial text content but no recognized table — informational page.
  // Examples: per-product "List of cover materials suitable for this model"
  // (HÉMICYCLE / MOA), care-instruction intros, configuration diagrams.
  // Doesn't update product/material data and isn't counted against the 5%
  // unrecognised-pages gate.
  const bodyItems = visible.filter((it) => it.fontSize >= 8 && it.fontSize <= 14 && it.rotation === 0);
  if (bodyItems.length >= 10) {
    return { kind: 'info', hints: {} };
  }

  return { kind: 'noise', hints: { reason: 'no-rule' } };
}

// A banner is rotated 90°, ≥ minFs, contains at least one A-Z letter (rejects
// stray "½" / "¼" / "Χ" rendered as rotated dimension marks), and is at least
// 2 characters (allows real names like "TV").
function isRotatedBanner(it, minFs = 22) {
  if (Math.abs(it.rotation) !== 90) return false;
  return isBannerLike(it, minFs);
}

function isBannerLike(it, minFs = 22) {
  if (it.fontSize < minFs) return false;
  const s = it.str.trim();
  if (s.length < 2) return false;
  if (!/[A-Z]/.test(s)) return false;
  if (s.toUpperCase() === 'CODE') return false;
  return true;
}

function cleanSectionName(s) {
  return s.replace(/\s+/g, ' ').trim().toUpperCase();
}

function pickMaterialKindFromBanner(bannerStr) {
  const s = bannerStr.toUpperCase();
  if (/LEATHER/.test(s)) return 'leather-list';
  if (/OUTDOOR/.test(s)) return 'outdoor-list';
  return 'fabric-list';
}

function pickLegacyMaterialKind(banners, upperTopText) {
  if (/THICKNESS|PRICE\s*PER\s*SM/.test(upperTopText)) return 'leather-list';
  if (/OUTDOOR/.test(upperTopText)) return 'outdoor-list';
  for (const b of banners) {
    const s = b.str.toUpperCase();
    if (/LEATHER/.test(s)) return 'leather-list';
    if (/OUTDOOR/.test(s)) return 'outdoor-list';
    if (/FABRIC/.test(s)) return 'fabric-list';
  }
  return 'fabric-list';
}
