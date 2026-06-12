// ViewModel for the public storefront ("Tienda") — src/pages/PublicStore.jsx.
//
// MVVM: the storefront is ONE browsable grid with the shared list header
// (search / status tabs / family filter / sort). The page owns that interactive
// state and renders THIS projection — it derives nothing itself. `resolveStore`
// is pure: hand it the rows the public `store` Edge Function served plus the
// resolved UI state, and it returns the product cards, the facet chrome (tabs /
// filter options / sort options) and the result count.
//
// Products come from the line items of the quotes it's given — for the live
// storefront those are the quotes of the dealer's "house account" (Alcover
// quoting itself for store stock), pre-filtered server-side; the VM just
// projects whatever quotes it receives. The same article quoted across several
// of those quotes is deduped into one card, and its availability is read from
// the attached order's stage (received → Disponible, in transit/customs → En
// camino, everything earlier or no order → Bajo pedido / Pedido).
//
// Money is returned in USD (a point value or a min–max range); the page formats
// it to DOP through formatMoney + the rate the Edge Function supplies. The
// server bakes margin into the prices and never sends cost/margin, so the VM is
// a plain projection that can't leak markup.
//
// Pure: no React, no db, no I/O. Reuses the pricing primitives (never
// re-implements them), the order-stage model and the status-pill map so the
// figures and badges agree with the rest of the app.
import { isPricedLine } from '../../../lib/constants.js';
import {
  isCompoundLine, lineBasePrice, compoundSubtotal, compoundSubtotalRange,
  isRangeLine, lineHasRange,
} from '../../../lib/pricing.js';
import { currentOrderStage, orderStageIndex } from '../../../lib/orderStages.js';
import { orderStatusPill } from '../../../lib/statusPill.js';

/* ------------------------------- availability ------------------------------- */

// The three availability buckets the six order stages collapse into. `weight`
// orders them for the default sort — in-stock first, the most sellable.
const AVAILABILITY = {
  available: { key: 'available', label: 'Disponible', weight: 0 },
  incoming: { key: 'incoming', label: 'En camino', weight: 1 },
  on_order: { key: 'on_order', label: 'Pedido', weight: 2 },
};

// Stage key by its stepper index (0..5), the inverse of orderStageIndex, so a
// group's max stage index resolves back to a stage key for its pill + bucket.
const STAGE_BY_INDEX = ['draft', 'placed', 'confirmed', 'in_transit', 'in_customs', 'received'];

function bucketForStage(stage) {
  if (stage === 'received') return 'available';
  if (stage === 'in_transit' || stage === 'in_customs') return 'incoming';
  return 'on_order'; // draft / placed / confirmed
}

// Latest known logistics timestamp on an order — a coarse "moved on" hint used
// only as a sort tiebreak within an availability bucket.
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

// Per-article USD price for a card: a point value, or a min–max range for a
// material-less line/compound quoted across a grade span. Reuses the pricing
// primitives so it can't disagree with the quote totals.
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

// Group key that folds the same article quoted on different quotes into one
// card: the catalog reference when present, else a normalized family|name|subtype.
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

/* -------------------------------- products ---------------------------------- */

// Build the deduped product cards (pre-search) from the given quotes' priced
// lines, plus the distinct family list for the filter dropdown.
function buildProducts({ quotes, lines, orders, inventory }) {
  // Kardex cross-check: sku → on-hand. A card whose reference the books say is
  // SOLD OUT (tracked sku, qty ≤ 0) must not read "Disponible" — it demotes to
  // Bajo pedido. Untracked references are never touched.
  const qtyBySku = new Map();
  for (const i of inventory || []) {
    const sku = String(i.sku || '').trim().toUpperCase();
    if (sku) qtyBySku.set(sku, Number(i.qtyOnHand) || 0);
  }
  const orderById = new Map();
  for (const o of orders || []) orderById.set(o.id, o);

  // quoteId → its order (if any). Only lines belonging to the GIVEN quotes
  // count, so a stray line can never leak into the storefront.
  const orderByQuoteId = new Map();
  const quoteIds = new Set();
  for (const q of quotes || []) {
    quoteIds.add(q.id);
    if (q.orderId && orderById.has(q.orderId)) orderByQuoteId.set(q.id, orderById.get(q.orderId));
  }

  const groups = new Map();
  for (const line of lines || []) {
    if (!quoteIds.has(line.quoteId)) continue;
    if (!isPricedLine(line)) continue; // drops sections, parked optionals, unpicked alts

    const key = productKey(line);
    let g = groups.get(key);
    if (!g) { g = { key, lines: [], bestIdx: -1, rep: line, repIdx: -1, lastMovedAt: null }; groups.set(key, g); }
    g.lines.push(line);

    const order = orderByQuoteId.get(line.quoteId) || null;
    const stageIdx = order ? orderStageIndex(currentOrderStage(order)) : -1;
    // The representative line (photo / name / price) is the one whose order is
    // furthest along, so the card reads as "where this article is now".
    if (stageIdx > g.repIdx) { g.rep = line; g.repIdx = stageIdx; }
    if (stageIdx > g.bestIdx) g.bestIdx = stageIdx;
    if (order) {
      const at = orderLogisticsAt(order);
      if (at && (!g.lastMovedAt || at > g.lastMovedAt)) g.lastMovedAt = at;
    }
  }

  const families = new Set();
  const cards = [];
  for (const g of groups.values()) {
    const rep = g.rep;
    const hasOrder = g.bestIdx >= 0;
    let stageKey = hasOrder ? (STAGE_BY_INDEX[g.bestIdx] || 'draft') : null;
    let bucket = hasOrder ? bucketForStage(stageKey) : 'on_order';
    // An order-backed card borrows the precise stage pill (Recibido / En ruta /
    // …); an order-less one reads as made-to-order with a neutral pill.
    let pill = hasOrder ? orderStatusPill(stageKey) : { cls: 'status-pill-draft', label: 'Bajo pedido' };
    // The kardex outranks the order stage for "Disponible": a tracked sku at
    // qty ≤ 0 was sold — demote the card to Bajo pedido instead of showing a
    // piece that's no longer on the floor.
    if (bucket === 'available') {
      const sku = String(rep.reference || '').trim().toUpperCase();
      if (sku && qtyBySku.has(sku) && qtyBySku.get(sku) <= 0) {
        bucket = 'on_order';
        stageKey = null;
        pill = { cls: 'status-pill-draft', label: 'Bajo pedido' };
      }
    }

    let imageId = lineCoverImageId(rep);
    if (!imageId) {
      for (const l of g.lines) { const id = lineCoverImageId(l); if (id) { imageId = id; break; } }
    }

    // Fabric swatch chip for the card — the line's chosen swatch, falling back
    // to any sibling line in the group that carries one.
    let swatchImageId = rep.swatchImageId || null;
    if (!swatchImageId) {
      for (const l of g.lines) { if (l.swatchImageId) { swatchImageId = l.swatchImageId; break; } }
    }

    const family = (rep.family || '').trim();
    if (family) families.add(family);

    cards.push({
      kind: 'product',
      key: g.key,
      name: (rep.name || rep.family || rep.reference || 'Artículo').trim(),
      family,
      subtype: (rep.subtype || '').trim(),
      reference: (rep.reference || '').trim(),
      imageId,
      swatchImageId,
      price: articlePriceUsd(rep),
      availability: {
        bucket,
        stage: stageKey,
        label: pill.label,
        pillCls: pill.cls,
        weight: AVAILABILITY[bucket].weight,
      },
      lastMovedAt: g.lastMovedAt,
    });
  }

  return { cards, families: [...families].sort((a, b) => a.localeCompare(b)) };
}

// Apply the live search / tab / filter / sort over the product cards and return
// the page-ready chrome alongside the result list.
function applyProducts(cards, families, { q, tab, filters, sort }) {
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

/* -------------------------------- top level --------------------------------- */

/**
 * Project the storefront rows + the resolved UI state into exactly what the
 * Tienda page renders.
 *
 * @param {object}   p
 * @param {object[]} p.quotes   the quotes whose line items stock the store
 *                              (house-account quotes; need id + orderId)
 * @param {object[]} p.lines    those quotes' line items (margin baked server-side)
 * @param {object[]} p.orders   the attached orders (stage + stage timestamps),
 *                              for availability
 * @param {string}   p.q        search needle
 * @param {string}   p.tab      active availability tab ('all'|'available'|'incoming'|'on_order')
 * @param {object}   p.filters  active secondary filters ({ family })
 * @param {{key,dir}} p.sort    sort state
 * @returns {{
 *   items: object[],        // product cards, filtered + sorted
 *   resultCount: number,
 *   tabs: object[],         // availability dimension for ListSearchHeader
 *   filterDefs: object[],   // secondary filters for ListSearchHeader
 *   sortOptions: object[],  // sort menu for ListSearchHeader
 * }}
 */
export function resolveStore({
  quotes, lines, orders, inventory, q = '', tab = 'all', filters = {}, sort,
}) {
  const { cards, families } = buildProducts({ quotes, lines, orders, inventory });
  return applyProducts(cards, families, { q, tab, filters, sort });
}
