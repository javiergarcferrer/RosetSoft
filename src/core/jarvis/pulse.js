/**
 * JARVIS business pulse — honest commercial telemetry.
 *
 * Pure projections of the REAL rows (quotes + their lines, orders, customers)
 * for the /jarvis surface: the pipeline funnel with the money each stage
 * holds, the receivable on accepted quotes, the weekly cadence series and a
 * feed of what actually happened. Every figure traces to a row — nothing is
 * decorative. Money rolls up through core/quote/totals (the single per-quote
 * sum), so JARVIS agrees to the cent with the dashboard and the lists.
 */
import { linesByQuoteId, quoteGrandTotal } from '../quote/totals.js';
import { quoteOutstanding } from '../../lib/quoteMilestones.js';
import { quoteDisplayName } from '../../lib/quoteNaming.js';
import { agoLabel } from './board.js';

const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** Live pipeline stages (declined/archived are out of the funnel). */
export const FUNNEL_STAGES = [
  { key: 'draft', label: 'Borradores' },
  { key: 'sent', label: 'Enviadas' },
  { key: 'accepted', label: 'Aceptadas' },
];

/** Monday 00:00 of the week containing `ts` (DR has no DST). */
function weekStart(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/**
 * The pulse: funnel (count + USD per live stage), won-this-month, the
 * outstanding receivable on accepted quotes, and `weeks` weekly buckets of
 * created/accepted cadence ending in the current week. USD base throughout —
 * the View formats (formatMoney is a sanctioned leaf call).
 */
export function resolveBusinessPulse({ quotes = [], lines = [], now = Date.now(), weeks = 12 } = {}) {
  const byQuote = linesByQuoteId(lines);
  const totalOf = new Map();
  for (const q of quotes) totalOf.set(q.id, quoteGrandTotal(q, byQuote.get(q.id) || []));
  const sumUsd = (qs) => qs.reduce((s, q) => s + (totalOf.get(q.id) || 0), 0);

  const funnel = FUNNEL_STAGES.map(({ key, label }) => {
    const qs = quotes.filter((q) => q.status === key);
    return { key, label, count: qs.length, totalUsd: sumUsd(qs) };
  });
  const maxUsd = Math.max(1, ...funnel.map((f) => f.totalUsd));
  for (const f of funnel) f.share = f.totalUsd / maxUsd;

  // Won this month — accepted since the 1st, wherever fulfillment stands now
  // (same rule as resolveDashboard's "won this month").
  const m0 = new Date(now);
  m0.setDate(1);
  m0.setHours(0, 0, 0, 0);
  const won = quotes.filter((q) => (q.acceptedAt || 0) >= m0.getTime());
  const wonMonth = { count: won.length, totalUsd: sumUsd(won) };

  // What accepted quotes still owe (deposit/balance milestones live on the quote).
  const accepted = quotes.filter((q) => q.status === 'accepted');
  const outstandingUsd = accepted.reduce(
    (s, q) => s + quoteOutstanding(q, totalOf.get(q.id) || 0),
    0,
  );

  // Weekly cadence, oldest → current week. Bucket starts step by exactly one
  // week from the current week's Monday, so every bucket is a true week.
  const w0 = weekStart(now);
  const series = Array.from({ length: weeks }, (_, i) => {
    const start = w0 - (weeks - 1 - i) * WEEK;
    const inWeek = (ts) => ts != null && ts >= start && ts < start + WEEK;
    return {
      start,
      created: quotes.filter((q) => inWeek(q.createdAt)).length,
      accepted: quotes.filter((q) => inWeek(q.acceptedAt)).length,
    };
  });

  // Honest week-over-week delta: the current (partial) week vs the previous
  // full one. `pct` is null when the previous week had nothing to compare to.
  const cur = series[series.length - 1] || { created: 0, accepted: 0 };
  const prev = series[series.length - 2] || { created: 0, accepted: 0 };
  const delta = (a, b) => ({ cur: a, prev: b, pct: b > 0 ? Math.round(((a - b) / b) * 100) : null });

  return {
    funnel,
    wonMonth,
    outstandingUsd,
    pipelineUsd: sumUsd(quotes.filter((q) => q.status === 'sent')),
    series,
    weekDelta: { created: delta(cur.created, prev.created), accepted: delta(cur.accepted, prev.accepted) },
  };
}

/**
 * GitHub-style activity heatmap: `weeks` columns × 7 rows (Mon→Sun) ending
 * today, each cell the count of REAL business events that day (quote
 * created/sent/accepted, order opened, customer registered) with a 0–4
 * intensity level scaled to the busiest day in range.
 */
export function resolveActivityHeatmap({ quotes = [], orders = [], customers = [], now = Date.now(), weeks = 12 } = {}) {
  const first = weekStart(now) - (weeks - 1) * WEEK;
  const byDay = new Map();
  const bump = (ts) => {
    if (ts == null || ts < first || ts > now) return;
    // Local-midnight day key, robust to any (theoretical) DST step.
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    byDay.set(d.getTime(), (byDay.get(d.getTime()) || 0) + 1);
  };
  for (const q of quotes) { bump(q.createdAt); bump(q.sentAt); bump(q.acceptedAt); }
  for (const o of orders) bump(o.createdAt);
  for (const c of customers) bump(c.createdAt);

  const max = Math.max(1, ...byDay.values());
  const cols = Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, dRow) => {
      const d = new Date(first);
      d.setDate(d.getDate() + w * 7 + dRow);
      const start = d.getTime();
      const count = byDay.get(start) || 0;
      return {
        start,
        count,
        future: start > now,
        level: count === 0 ? 0 : Math.max(1, Math.ceil((count / max) * 4)),
      };
    }));
  return { cols, max };
}

/**
 * Sparkline geometry for a weekly series: `values` → an SVG polyline `points`
 * string in a w×h viewbox (same VM-owns-geometry rule as radarPoints).
 * Pass a shared `max` when two series render on one chart, so their scales
 * are comparable — each scaling to its own peak would lie visually.
 */
export function sparkPoints(values = [], w = 100, h = 28, pad = 2, max = null) {
  if (!values.length) return '';
  max = Math.max(1, max ?? 0, ...values);
  const dx = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  return values
    .map((v, i) => `${(pad + i * dx).toFixed(1)},${(h - pad - ((v / max) * (h - pad * 2))).toFixed(1)}`)
    .join(' ');
}

/**
 * The honest ops feed — real business events, newest first: quotes moving
 * stage (created → sent → accepted, each its own event), orders opened,
 * customers registered. Each entry carries its timestamp + ago label.
 */
export function resolveOpsFeed({ quotes = [], orders = [], customers = [], now = Date.now(), limit = 12 } = {}) {
  const customersById = new Map((customers || []).map((c) => [c.id, c]));
  const events = [];

  for (const q of quotes) {
    const name = quoteDisplayName(q, customersById.get(q.customerId) || null);
    if (q.createdAt) events.push({ id: `q-new-${q.id}`, kind: 'quote', tone: 'muted', at: q.createdAt, text: `Cotización ${name} creada` });
    if (q.sentAt) events.push({ id: `q-sent-${q.id}`, kind: 'sent', tone: 'accent', at: q.sentAt, text: `Cotización ${name} enviada` });
    if (q.acceptedAt) events.push({ id: `q-acc-${q.id}`, kind: 'won', tone: 'success', at: q.acceptedAt, text: `Cotización ${name} aceptada` });
  }
  for (const o of orders) {
    if (o.createdAt) {
      events.push({
        id: `o-${o.id}`,
        kind: 'order',
        tone: 'muted',
        at: o.createdAt,
        text: `Pedido ${o.name || (o.number != null ? `#${o.number}` : o.id)} abierto`,
      });
    }
  }
  for (const c of customers) {
    if (c.createdAt) {
      events.push({ id: `c-${c.id}`, kind: 'cliente', tone: 'muted', at: c.createdAt, text: `Cliente ${c.company || c.name || ''} registrado` });
    }
  }

  return events
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, limit)
    .map((e) => ({ ...e, ago: agoLabel(e.at, now) }));
}
