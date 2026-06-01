// ViewModel for the Tienda (showroom / ecommerce browse) page — src/pages/Store.jsx.
//
// MVVM: the Store page is ONE browsable surface with a two-way segment
// (Mercancía / Materiales) plus the shared list header (search / tab / filter /
// sort). It owns that interactive state in React and renders THIS projection —
// it derives nothing itself. `resolveStore` is pure: hand it the raw rows plus
// the resolved UI state and it returns the card list for the active segment, the
// facet chrome (segment counts, status/category tabs, filter options, sort
// options) and the per-card lookups the view reads straight through.
//
// Two product sources, deliberately the two entities that actually carry BOTH an
// image and a price in this app (the imported price-list `products` table has
// neither — it's bare SKUs):
//
//   • Mercancía — the priced line items of quotes ATTACHED TO AN ORDER (an
//     "Alcover order uploaded to the module"): a real product photo, a USD price,
//     and — through the order's containers — a live shipment to track. Deduped by
//     article so the same sofa quoted across several orders shows once, with its
//     quantity, order count and best availability aggregated. Availability folds
//     the six order stages into three sellable buckets (Disponible / En camino /
//     Pedido) so "incoming merchandise" is a first-class filter.
//
//   • Materiales — the fabric / leather / outdoor catalog: a swatch, a per-yard
//     (or per-m²) price, grade and wear rating. The "available material search".
//
// Money is returned in USD (a point value or a min–max range); the view formats
// it to DOP through formatMoney + the live rate, exactly like every other
// surface — the VM stays a plain-data projection independent of the exchange
// rate. Live container ETAs come from the hl-track edge function via the
// useContainerTracking hook in the view; here we only attach each card's
// trackable containers so the view can render <ShipmentTracking> for it.
//
// Pure: no React, no db, no I/O. Reuses the pricing primitives (never
// re-implements them), the order-stage model and resolveTrackableContainers so
// the figures and the shipment list can't drift from the rest of the app.
import { isPricedLine } from '../../../lib/constants.js';
import {
  isCompoundLine, lineBasePrice, compoundSubtotal, compoundSubtotalRange,
  isRangeLine, lineHasRange,
} from '../../../lib/pricing.js';
import { currentOrderStage, orderStageIndex } from '../../../lib/orderStages.js';
import { orderStatusPill } from '../../../lib/statusPill.js';
// Import the pure predicate straight from its module, NOT the core/tracking
// barrel — the barrel also re-exports the useContainerTracking hook, which would
// drag React + db into this otherwise-pure, node-testable ViewModel.
import { resolveTrackableContainers } from '../../tracking/containers.js';

/* --------------------------------- segments --------------------------------- */

export const STORE_VIEW_MERCHANDISE = 'merchandise';
export const STORE_VIEW_MATERIALS = 'materials';

/* ------------------------------- availability ------------------------------- */

// The three availability buckets the merchandise tabs collapse the six order
// stages into. `weight` orders them for the default sort — in-stock first, since
// it's the most sellable. Higher order-stage index maps monotonically to a
// better-or-equal bucket (received → available, customs/transit → incoming,
// everything earlier → on_order), so a product's BEST stage gives its bucket.
const AVAILABILITY = {
  available: { key: 'available', label: 'Disponible', weight: 0 },
  incoming: { key: 'incoming', label: 'En camino', weight: 1 },
  on_order: { key: 'on_order', label: 'Pedido', weight: 2 },
};

function bucketForStage(stage) {
  if (stage === 'received') return 'available';
  if (stage === 'in_transit' || stage === 'in_customs') return 'incoming';
  return 'on_order'; // draft / placed / confirmed
}

// Latest known logistics timestamp on an order — used as a coarse "incoming
// since / arrived on" hint for sorting + the card caption. The precise live ETA
// comes from container tracking in the view, not from here.
function orderLogisticsAt(order) {
  return Math.max(
    0,
    order.receivedAt || 0,
    order.inCustomsAt || 0,
    order.inTransitAt || 0,
    order.confirmedAt || 0,
    order.placedAt || 0,
  ) || null;
}

/* ----------------------------------- price ---------------------------------- */

// Per-article USD price for a merchandise card: a point value, or a min–max
// range for a material-less line/compound quoted across a grade span. Reuses the
// pricing primitives so it can never disagree with the quote totals.
function articlePriceUsd(line) {
  if (isCompoundLine(line)) {
    if (lineHasRange(line)) {
      const r = compoundSubtotalRange(line);
      return r.min === r.max ? { value: r.min } : { min: r.min, max: r.max };
    }
    return { value: compoundSubtotal(line) };
  }
  if (isRangeLine(line)) {
    const min = Number(line.priceMin) || 0;
    const max = Number(line.priceMax) || 0;
    return min === max ? { value: min } : { min, max };
  }
  return { value: lineBasePrice(line) };
}

// The single number a price (point or range) sorts / compares by.
function priceSortValue(price) {
  if (!price) return 0;
  return price.value != null ? price.value : (price.min != null ? price.min : 0);
}

/* -------------------------------- identity ---------------------------------- */

// Group key that folds the same article quoted on different orders into one card:
// the catalog reference when present, else a normalized family|name|subtype.
function productKey(line) {
  const ref = (line.reference || '').trim().toUpperCase();
  if (ref) return `ref:${ref}`;
  const fam = (line.family || '').trim().toLowerCase();
  const name = (line.name || '').trim().toLowerCase();
  const sub = (line.subtype || '').trim().toLowerCase();
  return `n:${fam}|${name}|${sub}`;
}

function lineCoverImageId(line) {
  if (line.imageId) return line.imageId;
  const extra = Array.isArray(line.extraImageIds) ? line.extraImageIds : [];
  return extra.find(Boolean) || null;
}

function norm(s) {
  return (s == null ? '' : String(s)).toLowerCase();
}

/* ------------------------------- merchandise -------------------------------- */

// Build the deduped merchandise cards (pre-search) from the order-attached quote
// lines, plus the distinct family list for the filter dropdown.
function buildMerchandise({ quotes, lines, orders, containers }) {
  const orderById = new Map();
  for (const o of orders || []) orderById.set(o.id, o);

  // quoteId → its order (only quotes attached to a live, non-cancelled order
  // count as "uploaded merchandise"; a declined/archived quote never does).
  const orderByQuoteId = new Map();
  for (const q of quotes || []) {
    if (!q.orderId) continue;
    if (q.status === 'declined' || q.status === 'archived') continue;
    const order = orderById.get(q.orderId);
    if (!order || currentOrderStage(order) === 'cancelled') continue;
    orderByQuoteId.set(q.id, order);
  }

  // orderId → its trackable (valid ISO 6346) containers, computed once.
  const trackableByOrderId = new Map();
  for (const c of resolveTrackableContainers(containers || [])) {
    if (!c.orderId) continue;
    if (!trackableByOrderId.has(c.orderId)) trackableByOrderId.set(c.orderId, []);
    trackableByOrderId.get(c.orderId).push(c);
  }

  const groups = new Map();
  for (const line of lines || []) {
    if (!isPricedLine(line)) continue; // drops sections, parked optionals, unpicked alts
    const order = orderByQuoteId.get(line.quoteId);
    if (!order) continue;

    const key = productKey(line);
    let g = groups.get(key);
    if (!g) {
      g = { key, lines: [], orderIds: new Set(), qty: 0, bestIdx: -2, rep: line, repIdx: -2 };
      groups.set(key, g);
    }
    g.lines.push(line);
    g.orderIds.add(order.id);
    g.qty += isCompoundLine(line) ? 1 : (Number(line.qty) || 0);

    const stageIdx = orderStageIndex(currentOrderStage(order));
    // The representative line (drives photo / name / price) is the one from the
    // most-advanced order, so the card reads as "where this article is now".
    if (stageIdx > g.repIdx) { g.rep = line; g.repIdx = stageIdx; }
    if (stageIdx > g.bestIdx) g.bestIdx = stageIdx;
  }

  const families = new Set();
  const cards = [];
  for (const g of groups.values()) {
    const rep = g.rep;
    // The card's status = the most-advanced order across the whole group
    // (bestIdx), mapped back to a stage key for its bucket + pill.
    const stageKey = STAGE_BY_INDEX[g.bestIdx] || 'draft';
    const bucket = bucketForStage(stageKey);
    const pill = orderStatusPill(stageKey);

    // Cover photo: prefer the representative line, else any line in the group.
    let imageId = lineCoverImageId(rep);
    if (!imageId) {
      for (const l of g.lines) { const id = lineCoverImageId(l); if (id) { imageId = id; break; } }
    }

    // Union the trackable containers across every order this article sits on,
    // and note its most recent logistics movement (a sort tiebreak — the precise
    // live ETA comes from container tracking in the view, not from here).
    const trackable = [];
    let lastMovedAt = null;
    for (const oid of g.orderIds) {
      for (const c of trackableByOrderId.get(oid) || []) trackable.push(c);
      const at = orderLogisticsAt(orderById.get(oid) || {});
      if (at && (!lastMovedAt || at > lastMovedAt)) lastMovedAt = at;
    }

    const family = (rep.family || '').trim();
    if (family) families.add(family);

    cards.push({
      kind: 'merchandise',
      key: g.key,
      name: (rep.name || rep.family || rep.reference || 'Artículo').trim(),
      family,
      subtype: (rep.subtype || '').trim(),
      reference: (rep.reference || '').trim(),
      imageId,
      price: articlePriceUsd(rep),
      qty: g.qty,
      orderCount: g.orderIds.size,
      availability: {
        bucket,
        stage: stageKey,
        label: pill.label,
        pillCls: pill.cls,
        weight: AVAILABILITY[bucket].weight,
      },
      lastMovedAt,
      trackable,
      orderIds: [...g.orderIds],
    });
  }

  return { cards, families: [...families].sort((a, b) => a.localeCompare(b)) };
}

// Stage key by its stepper index (0..5) — the inverse of orderStageIndex, so a
// group's max stage index resolves back to a stage key for its pill + bucket.
const STAGE_BY_INDEX = ['draft', 'placed', 'confirmed', 'in_transit', 'in_customs', 'received'];

// Apply the live search / tab / filter / sort over the merchandise cards and
// return the page-ready chrome alongside the result list.
function applyMerchandise(cards, families, { q, tab, filters, sort }) {
  const counts = { all: cards.length, available: 0, incoming: 0, on_order: 0 };
  for (const c of cards) counts[c.availability.bucket] += 1;
  const tabs = [
    { key: 'all', label: 'Todo', count: counts.all },
    { key: 'available', label: 'Disponible', count: counts.available },
    { key: 'incoming', label: 'En camino', count: counts.incoming },
    { key: 'on_order', label: 'Pedido', count: counts.on_order },
  ];
  const filterDefs = [{
    key: 'family',
    label: 'Familia',
    type: 'select',
    placeholder: 'Todas',
    options: families.map((f) => ({ value: f, label: f })),
  }];
  const sortOptions = [
    { key: 'availability', label: 'Disponibilidad' },
    { key: 'price', label: 'Precio' },
    { key: 'name', label: 'Nombre' },
    { key: 'qty', label: 'Cantidad' },
  ];

  const needle = norm(q).trim();
  const family = filters?.family || null;
  const matched = cards.filter((c) => {
    if (tab && tab !== 'all' && c.availability.bucket !== tab) return false;
    if (family && c.family !== family) return false;
    if (!needle) return true;
    return (
      norm(c.name).includes(needle) ||
      norm(c.family).includes(needle) ||
      norm(c.subtype).includes(needle) ||
      norm(c.reference).includes(needle)
    );
  });

  const mul = sort?.dir === 'asc' ? 1 : -1;
  const key = sort?.key || 'availability';
  const items = [...matched].sort((a, b) => {
    if (key === 'price') return (priceSortValue(a.price) - priceSortValue(b.price)) * mul;
    if (key === 'name') return a.name.localeCompare(b.name) * mul;
    if (key === 'qty') return (a.qty - b.qty) * mul;
    // availability: bucket weight, then most-recently-moved, then name.
    if (a.availability.weight !== b.availability.weight) {
      return (a.availability.weight - b.availability.weight) * mul;
    }
    if ((a.lastMovedAt || 0) !== (b.lastMovedAt || 0)) {
      return ((b.lastMovedAt || 0) - (a.lastMovedAt || 0)) * mul;
    }
    return a.name.localeCompare(b.name);
  });

  return { items, tabs, filterDefs, sortOptions, resultCount: items.length };
}

/* -------------------------------- materials --------------------------------- */

const MATERIAL_CATEGORY_LABEL = { fabric: 'Telas', leather: 'Pieles', outdoor: 'Exterior' };

function materialHeroImageId(material) {
  const colors = Array.isArray(material.colors) ? material.colors : [];
  const withImage = colors.find((c) => c && c.imageId);
  return withImage ? withImage.imageId : null;
}

// Build the material cards (pre-search). "Available" excludes discontinued
// materials by default — the dealer is searching what they can actually offer.
function buildMaterials({ materials }) {
  const grades = new Set();
  const cards = [];
  for (const m of materials || []) {
    if (m.discontinuedAt) continue;
    const colors = Array.isArray(m.colors) ? m.colors : [];
    const grade = (m.grade || '').trim();
    if (grade) grades.add(grade);
    cards.push({
      kind: 'material',
      id: m.id,
      name: (m.name || '').trim() || 'Material',
      category: m.category,
      categoryLabel: MATERIAL_CATEGORY_LABEL[m.category] || m.category || '',
      grade,
      wearRating: (m.wearRating || '').trim(),
      composition: (m.composition || '').trim(),
      colorCount: colors.length,
      // Pre-lowercased "name code name code …" blob so a search like "4479" or
      // "antracita" lands the material that offers that color.
      colorText: colors.map((c) => `${c?.name || ''} ${c?.code || ''}`).join(' ').toLowerCase(),
      imageId: materialHeroImageId(m),
      heroColorCode: colors[0]?.code || null,
      price: m.price != null ? { value: Number(m.price) || 0, unit: m.priceUnit || null } : null,
    });
  }
  return {
    cards,
    grades: [...grades].sort((a, b) => a.localeCompare(b)),
  };
}

function applyMaterials(cards, grades, { q, tab, filters, sort }) {
  const counts = { all: cards.length, fabric: 0, leather: 0, outdoor: 0 };
  for (const c of cards) if (counts[c.category] != null) counts[c.category] += 1;
  const tabs = [
    { key: 'all', label: 'Todos', count: counts.all },
    { key: 'fabric', label: 'Telas', count: counts.fabric },
    { key: 'leather', label: 'Pieles', count: counts.leather },
    { key: 'outdoor', label: 'Exterior', count: counts.outdoor },
  ];
  const filterDefs = [{
    key: 'grade',
    label: 'Grado',
    type: 'select',
    placeholder: 'Todos',
    options: grades.map((g) => ({ value: g, label: g })),
  }];
  const sortOptions = [
    { key: 'name', label: 'Nombre' },
    { key: 'price', label: 'Precio' },
    { key: 'grade', label: 'Grado' },
    { key: 'colors', label: 'Colores' },
  ];

  const needle = norm(q).trim();
  const grade = filters?.grade || null;
  const matched = cards.filter((c) => {
    if (tab && tab !== 'all' && c.category !== tab) return false;
    if (grade && c.grade !== grade) return false;
    if (!needle) return true;
    // Match by material name / grade / composition, OR by any color it offers
    // (name or LR code) — "available material search" reaches the swatch level.
    return (
      norm(c.name).includes(needle) ||
      norm(c.grade).includes(needle) ||
      norm(c.composition).includes(needle) ||
      c.colorText.includes(needle)
    );
  });

  const mul = sort?.dir === 'asc' ? 1 : -1;
  const key = sort?.key || 'name';
  const items = [...matched].sort((a, b) => {
    if (key === 'price') return ((a.price?.value ?? 0) - (b.price?.value ?? 0)) * mul;
    if (key === 'grade') return (a.grade || '').localeCompare(b.grade || '') * mul;
    if (key === 'colors') return (a.colorCount - b.colorCount) * mul;
    return a.name.localeCompare(b.name) * mul;
  });

  return { items, tabs, filterDefs, sortOptions, resultCount: items.length };
}

/* -------------------------------- top level --------------------------------- */

/**
 * Project the store rows + the resolved UI state into exactly what the Tienda
 * page renders for the active segment.
 *
 * @param {object}   p
 * @param {object[]} p.quotes       team quotes (need id, orderId, status)
 * @param {object[]} p.lines        every quote line (sourced via quoteId)
 * @param {object[]} p.orders       team orders (stage + stage timestamps)
 * @param {object[]} p.containers   team containers (code → ISO 6346 tracking)
 * @param {object[]} p.materials    team materials (catalog)
 * @param {'merchandise'|'materials'} p.view   active segment
 * @param {string}   p.q            search needle
 * @param {string}   p.tab          active primary tab (availability or category)
 * @param {object}   p.filters      active secondary filters ({ family } | { grade })
 * @param {{key,dir}} p.sort        sort state
 * @returns {{
 *   view: string,
 *   items: object[],          // cards for the active segment, filtered + sorted
 *   resultCount: number,
 *   tabs: object[],           // primary dimension for ListSearchHeader
 *   filterDefs: object[],     // secondary filters for ListSearchHeader
 *   sortOptions: object[],    // sort menu for ListSearchHeader
 *   segments: object[],       // [{key,label,count}] for the Mercancía/Materiales toggle
 * }}
 */
export function resolveStore({
  quotes, lines, orders, containers, materials,
  view = STORE_VIEW_MERCHANDISE, q = '', tab = 'all', filters = {}, sort,
}) {
  const merch = buildMerchandise({ quotes, lines, orders, containers });
  const mats = buildMaterials({ materials });

  const segments = [
    { key: STORE_VIEW_MERCHANDISE, label: 'Mercancía', count: merch.cards.length },
    { key: STORE_VIEW_MATERIALS, label: 'Materiales', count: mats.cards.length },
  ];

  const active = view === STORE_VIEW_MATERIALS
    ? applyMaterials(mats.cards, mats.grades, { q, tab, filters, sort })
    : applyMerchandise(merch.cards, merch.families, { q, tab, filters, sort });

  return { view, segments, ...active };
}
