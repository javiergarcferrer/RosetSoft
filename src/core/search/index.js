// Global search — the pure matching ViewModel behind the ⌘K palette.
//
// `resolveGlobalSearch` is a pure projection: raw rows in (already scoped to
// the profile by the View's fetch), grouped + ranked result groups out. No
// React, no db, no other core/* barrels — only leaf Model helpers from lib.
// The View (components/GlobalSearch.jsx) owns fetching, debounce, keyboard
// state, and the leaf label maps (status pills, money formatting).

import { currentQuoteStage } from '../../lib/quoteStages.js';
import { BRAND_LIFESTYLEGARDEN } from '../../lib/constants.js';

/** Max rows shown per group; the remainder surfaces as a quiet "N más…". */
export const SEARCH_GROUP_CAP = 5;

/** Case- and diacritic-insensitive normalization ("Pérez" → "perez"). */
function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Score a candidate's searchable fields against the normalized query.
 *   2 — some field STARTS WITH the full query (best),
 *   1 — every whitespace token of the query is INCLUDED in some field,
 *   0 — no match.
 * startsWith beats includes; the token-AND fallback lets "perez juan" still
 * find "Juan Pérez" without requiring adjacency or order.
 */
function scoreFields(fields, nq, tokens) {
  const normed = [];
  for (const f of fields) {
    if (f == null || f === '') continue;
    const v = norm(f);
    if (v.startsWith(nq)) return 2;
    normed.push(v);
  }
  if (!normed.length) return 0;
  const allTokensHit = tokens.every((t) => normed.some((v) => v.includes(t)));
  return allTokensHit ? 1 : 0;
}

/**
 * Rank `rows` against the query: keep matches, sort score-desc then by the
 * caller's tiebreak, cap at SEARCH_GROUP_CAP, report the overflow count.
 * `fieldsOf(row)` lists the searchable strings; `toItem(row)` shapes the
 * result row; `tiebreak(a.row, b.row)` orders equal scores.
 */
function rankGroup(rows, nq, tokens, { fieldsOf, toItem, tiebreak }) {
  const matched = [];
  for (const row of rows || []) {
    const score = scoreFields(fieldsOf(row), nq, tokens);
    if (score > 0) matched.push({ row, score });
  }
  matched.sort((a, b) => (b.score - a.score) || tiebreak(a.row, b.row));
  return {
    items: matched.slice(0, SEARCH_GROUP_CAP).map(({ row }) => toItem(row)),
    more: Math.max(0, matched.length - SEARCH_GROUP_CAP),
  };
}

const byUpdatedDesc = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
const byNameAsc = (key) => (a, b) => norm(a[key]).localeCompare(norm(b[key]));

/**
 * The global-search projection.
 *
 * Input (all optional but `query`):
 *   query          — the raw search string (the View debounces it).
 *   quotes         — quote rows (number, status, customerId, updatedAt, …).
 *   customers      — customer rows; also the join source for quote rows.
 *   professionals  — professional rows.
 *   orders         — order rows (number, name, status).
 *   products       — catalog rows the View fetched server-side (searchProducts).
 *   pages          — [{ to, label, icon?, group? }] nav shortcuts, already
 *                    role-gated by the View (navForRole).
 *   actions        — [{ key, label, keywords?, to?, run?, icon?, hint? }]
 *                    commands (create shortcuts, theme toggle), role-gated by
 *                    the View. `to` navigates; `run` is a host side effect.
 *
 * Output:
 *   {
 *     query: <trimmed query>,
 *     isEmptyQuery: <true when the query is blank → pages-only mode>,
 *     groups: [{ key, label, items, more }],   // non-empty groups only
 *     flat:   [items in render order],          // for ↑/↓ keyboard traversal
 *   }
 *
 * Item shape (per `type`):
 *   { key, type, to, primary, secondary }
 *   + quote:    { stage }      — quote stage key; the View labels it.
 *   + order:    { status }     — order status key; the View labels it.
 *   + product:  { priceUsd }   — the View formats the money.
 *   + page:     { icon }       — passed through from the nav definition.
 *   + action:   { icon, run }  — command; `run` is the host side-effect key.
 */
export function resolveGlobalSearch({
  query = '',
  quotes = [],
  customers = [],
  professionals = [],
  orders = [],
  containers = [],
  suppliers = [],
  products = [],
  pages = [],
  actions = [],
} = {}) {
  const trimmed = String(query || '').trim();
  const nq = norm(trimmed);
  const tokens = nq.split(/\s+/).filter(Boolean);

  const pageItem = (p) => ({
    key: `page:${p.to}`,
    type: 'page',
    to: p.to,
    primary: p.label,
    secondary: p.group || '',
    icon: p.icon || null,
  });

  // A command (e.g. "Nueva cotización", theme toggle). `to` navigates; `run`
  // is a host-handled side effect (the View's `go` dispatches on it). Already
  // role-gated by the View, same as `pages`.
  const actionItem = (a) => ({
    key: `action:${a.key}`,
    type: 'action',
    to: a.to || null,
    run: a.run || null,
    primary: a.label,
    secondary: a.hint || 'Acción',
    icon: a.icon || null,
  });

  // Blank query → the palette's "home": what you can DO (commands) then where
  // you can GO (nav shortcuts).
  if (!nq) {
    const groups = [];
    const actionItems = (actions || []).map(actionItem);
    if (actionItems.length) groups.push({ key: 'commands', label: 'Acciones', items: actionItems, more: 0 });
    const pageItems = (pages || []).map(pageItem);
    if (pageItems.length) groups.push({ key: 'pages', label: 'Páginas', items: pageItems, more: 0 });
    return { query: trimmed, isEmptyQuery: true, groups, flat: groups.flatMap((g) => g.items) };
  }

  const customerById = new Map((customers || []).map((c) => [c.id, c]));

  const quoteGroup = rankGroup(quotes, nq, tokens, {
    fieldsOf: (q) => {
      const client = q.customerId ? customerById.get(q.customerId) : null;
      return [
        q.number != null ? `#${q.number}` : null,
        q.number != null ? String(q.number) : null,
        client?.name,
      ];
    },
    toItem: (q) => {
      const client = q.customerId ? customerById.get(q.customerId) : null;
      return {
        key: `quote:${q.id}`,
        type: 'quote',
        to: `/quotes/${q.id}`,
        primary: `Cotización #${q.number ?? '—'}`,
        secondary: client?.name || 'Sin cliente',
        stage: currentQuoteStage(q),
      };
    },
    tiebreak: byUpdatedDesc,
  });

  const personGroup = (rows, type, basePath) =>
    rankGroup(rows, nq, tokens, {
      fieldsOf: (p) => [p.name, p.company, p.phone, p.email],
      toItem: (p) => ({
        key: `${type}:${p.id}`,
        type,
        to: `${basePath}/${p.id}`,
        primary: p.name || '—',
        secondary: [p.company, p.phone, p.email].filter(Boolean).join(' · '),
      }),
      tiebreak: byNameAsc('name'),
    });

  const customerGroup = personGroup(customers, 'customer', '/customers');
  const professionalGroup = personGroup(professionals, 'professional', '/professionals');

  const orderGroup = rankGroup(orders, nq, tokens, {
    fieldsOf: (o) => [
      o.number != null ? `#${o.number}` : null,
      o.number != null ? String(o.number) : null,
      o.name,
    ],
    toItem: (o) => ({
      key: `order:${o.id}`,
      type: 'order',
      to: `/orders/${o.id}`,
      primary: `Pedido #${o.number ?? String(o.id).slice(-4)}`,
      secondary: o.name || '',
      status: o.status,
    }),
    tiebreak: byUpdatedDesc,
  });

  // A container number ("MSCU1234567") answers "which order is this on?" —
  // only rows attached to an order are navigable.
  const containerGroup = rankGroup((containers || []).filter((c) => c.orderId), nq, tokens, {
    fieldsOf: (c) => [
      c.code,
      c.number != null ? `#${c.number}` : null,
      c.number != null ? String(c.number) : null,
    ],
    toItem: (c) => ({
      key: `container:${c.id}`,
      type: 'container',
      to: `/orders/${c.orderId}`,
      primary: c.code || `Contenedor #${c.number ?? '—'}`,
      secondary: c.code ? `Contenedor #${c.number ?? '—'}` : 'Contenedor',
    }),
    tiebreak: byUpdatedDesc,
  });

  // Suppliers — the View passes rows only for accounting/admin roles.
  const supplierGroup = rankGroup(suppliers, nq, tokens, {
    fieldsOf: (s) => [s.name, s.rnc],
    toItem: (s) => ({
      key: `supplier:${s.id}`,
      type: 'supplier',
      to: '/accounting/suppliers',
      primary: s.name || '—',
      secondary: s.rnc || '',
    }),
    tiebreak: byNameAsc('name'),
  });

  const productGroup = rankGroup(products, nq, tokens, {
    fieldsOf: (p) => [p.reference, p.name, p.family],
    toItem: (p) => ({
      key: `product:${p.id}`,
      type: 'product',
      // Deep-link to where the row lives: LSG stock under Inventario, every
      // other brand under its Catálogos page (rows imported before the brand
      // column default to Ligne Roset).
      to: p.brand === BRAND_LIFESTYLEGARDEN ? '/inventario/lifestylegarden' : '/admin/catalog/roset',
      primary: p.name || p.reference || '—',
      secondary: [p.reference, p.family].filter(Boolean).join(' · '),
      priceUsd: p.priceUsd ?? null,
    }),
    tiebreak: byNameAsc('name'),
  });

  const pagesGroup = rankGroup(pages, nq, tokens, {
    fieldsOf: (p) => [p.label],
    toItem: pageItem,
    tiebreak: byNameAsc('label'),
  });

  // Commands rank on their label + keyword synonyms, so "nueva", "crear" or
  // "tema" surface the right action. Empty unless the query hits one, so a
  // name search is never cluttered by it — hence safe to list first.
  const commandsGroup = rankGroup(actions, nq, tokens, {
    fieldsOf: (a) => [a.label, ...(a.keywords || [])],
    toItem: actionItem,
    tiebreak: byNameAsc('label'),
  });

  const groups = [
    { key: 'commands', label: 'Acciones', ...commandsGroup },
    { key: 'quotes', label: 'Cotizaciones', ...quoteGroup },
    { key: 'customers', label: 'Clientes', ...customerGroup },
    { key: 'professionals', label: 'Profesionales', ...professionalGroup },
    { key: 'orders', label: 'Pedidos', ...orderGroup },
    { key: 'containers', label: 'Contenedores', ...containerGroup },
    { key: 'suppliers', label: 'Proveedores', ...supplierGroup },
    { key: 'products', label: 'Productos (catálogo)', ...productGroup },
    { key: 'pages', label: 'Páginas', ...pagesGroup },
  ].filter((g) => g.items.length > 0);

  return {
    query: trimmed,
    isEmptyQuery: false,
    groups,
    flat: groups.flatMap((g) => g.items),
  };
}
