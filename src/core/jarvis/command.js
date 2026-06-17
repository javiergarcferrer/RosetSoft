/**
 * JARVIS command-deck ViewModels — the cross-domain aggregation that turns the
 * ops dashboard into a command center of EVERYTHING.
 *
 * These are pure assemblers: the View fetches each domain's rows and runs that
 * domain's own resolver (resolveAccountingDashboard, resolveConversations,
 * resolveIgConversations, resolveScheduleAgenda, resolveFilingDeadline…), then
 * hands the OUTPUTS here. So nothing is recomputed and the CRM↔Accounting
 * barrier stays intact — JARVIS sits above both cores and only reads their
 * projections (no React, no db, no formatting; money stays raw + a currency tag
 * so the View formats it with formatDop/formatMoney).
 */
import { agoLabel } from './board.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Severity → sort weight (danger floats to the front of the strip). */
const SEVERITY = { danger: 0, warn: 1, info: 2 };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "en 3 d" / "hoy" / "en 5 h" — a short countdown for a future instant. */
function inLabel(ms) {
  if (ms == null) return '';
  if (ms <= 0) return 'ahora';
  if (ms < HOUR) return `en ${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < DAY) return `en ${Math.round(ms / HOUR)} h`;
  return `en ${Math.round(ms / DAY)} d`;
}

/**
 * The cross-domain obligations strip — every time-sensitive thing the dealer
 * must not miss, ranked by urgency (danger → warn → info; within a tier the
 * soonest deadline / biggest money first). Each input is another resolver's
 * OUTPUT, so this only selects + ranks + labels; it never re-derives a figure.
 *
 *   deadlines  — [{ code, label, to, daysLeft, period }] (resolveFilingDeadline
 *                over the active fiscal plugin's periodic reports)
 *   itbis      — d.itbis ({ aPagar, aFavor }) from resolveAccountingDashboard
 *   ecfAlerts  — d.ecfSeqAlerts ([{ type, label, kind, remaining?, expiresAt? }])
 *   ecfPending — d.ecfPending (count of e-CF not yet transmitted)
 *   arOverdue  — d.overdue (+90-day receivable, DOP)
 *   shipments  — resolveShipments output ({ alerts, inCustoms })
 *   followUps  — resolveFollowUps output ({ count, atRiskUsd })
 *   comms      — resolveCommsBrief output (WhatsApp/IG/posts)
 *
 * Returns `{ items, count, urgent }` — `urgent` is the danger-tier count, for a
 * header badge. Money is left raw (`amount` + `currency`); the View formats it.
 */
export function resolveObligations({
  deadlines = [], itbis = null, ecfAlerts = [], ecfPending = 0,
  arOverdue = 0, shipments = null, followUps = null, comms = null,
  now = Date.now(),
} = {}) {
  const items = [];
  const push = (it) => items.push(it);

  // ── DGII periodic filings (606/607/IT-1) — always shown so the next filing
  //    is never a surprise; the tier hardens as the deadline nears. The IT-1
  //    carries the ITBIS that's actually due.
  for (const f of deadlines) {
    if (f == null || f.daysLeft == null) continue;
    const tone = f.daysLeft <= 3 ? 'danger' : f.daysLeft <= 7 ? 'warn' : 'info';
    const isItbis = f.kind === 'liquidation';
    const due = itbis && itbis.aPagar > 0 ? itbis.aPagar : 0;
    push({
      id: `filing-${f.code}`,
      kind: 'filing',
      tone,
      to: f.to || '/accounting/impuestos',
      label: f.label || `DGII ${f.code}`,
      detail: f.daysLeft <= 0 ? 'vence hoy' : `vence en ${plural(f.daysLeft, 'día', 'días')}`,
      amount: isItbis && due > 0 ? due : null,
      currency: isItbis && due > 0 ? 'DOP' : null,
      sortKey: f.daysLeft,
    });
  }

  // ── e-CF sequence health — running out HALTS invoicing, so 'none'/'low' is
  //    a hard stop. (Reuses resolveEcfSequenceAlerts' classification.)
  for (const a of ecfAlerts) {
    let detail = '';
    let tone = 'warn';
    if (a.kind === 'none') { detail = 'sin secuencia utilizable'; tone = 'danger'; }
    else if (a.kind === 'low') { detail = plural(a.remaining ?? 0, 'e-NCF restante', 'e-NCF restantes'); tone = (a.remaining ?? 0) <= 5 ? 'danger' : 'warn'; }
    else if (a.kind === 'expiring') { detail = `secuencia vence ${inLabel((a.expiresAt ?? now) - now)}`; tone = 'warn'; }
    push({
      id: `ecf-${a.type}`, kind: 'ecf', tone, to: '/accounting/ecf',
      label: `e-CF ${a.label || a.type}`, detail, amount: null, currency: null, sortKey: 0,
    });
  }
  if (ecfPending > 0) {
    push({
      id: 'ecf-pending', kind: 'ecfPending', tone: 'warn', to: '/accounting/facturacion',
      label: 'e-CF', detail: `${plural(ecfPending, 'comprobante', 'comprobantes')} por transmitir`,
      amount: null, currency: null, sortKey: 1,
    });
  }

  // ── Receivable past 90 days — the money most at risk of never landing.
  if (arOverdue > 0) {
    push({
      id: 'ar-overdue', kind: 'ar', tone: 'danger', to: '/accounting/cuentas',
      label: 'CxC vencida +90', detail: '', amount: arOverdue, currency: 'DOP', sortKey: -arOverdue,
    });
  }

  // ── Containers stuck in customs past the dwell threshold (storage fees).
  if (shipments && shipments.alerts > 0) {
    push({
      id: 'customs', kind: 'customs', tone: 'warn', to: '/orders',
      label: 'Aduana', detail: `${plural(shipments.alerts, 'contenedor', 'contenedores')} +7 d`,
      amount: null, currency: null, sortKey: 2,
    });
  }

  // ── Stalled sent quotes — pipeline money going quiet (USD).
  if (followUps && followUps.count > 0) {
    push({
      id: 'followups', kind: 'followups', tone: 'info', to: '/quotes?status=sent',
      label: 'Seguimientos', detail: `${plural(followUps.count, 'en silencio', 'en silencio')}`,
      amount: followUps.atRiskUsd > 0 ? followUps.atRiskUsd : null,
      currency: followUps.atRiskUsd > 0 ? 'USD' : null, sortKey: 3,
    });
  }

  // ── Inbound conversations + posts waiting on a human.
  if (comms) {
    if (comms.waUnread > 0) {
      const waited = comms.waOldestWaitingAt ? now - comms.waOldestWaitingAt : 0;
      push({
        id: 'wa', kind: 'wa', tone: waited > DAY ? 'warn' : 'info', to: '/chats',
        label: 'WhatsApp', detail: `${plural(comms.waUnread, 'sin leer', 'sin leer')}`,
        amount: null, currency: null, sortKey: 4,
      });
    }
    if (comms.igUnread > 0) {
      push({
        id: 'ig', kind: 'ig', tone: 'info', to: '/marketing',
        label: 'Instagram', detail: `${plural(comms.igUnread, 'sin leer', 'sin leer')}`,
        amount: null, currency: null, sortKey: 5,
      });
    }
    if (comms.postsOverdue > 0) {
      push({
        id: 'posts', kind: 'posts', tone: 'warn', to: '/marketing',
        label: 'Publicaciones', detail: `${plural(comms.postsOverdue, 'atrasada', 'atrasadas')}`,
        amount: null, currency: null, sortKey: 2,
      });
    } else if (comms.nextPostAt != null) {
      push({
        id: 'posts-next', kind: 'posts', tone: 'info', to: '/marketing',
        label: 'Próxima publicación', detail: inLabel(comms.nextPostAt - now),
        amount: null, currency: null, sortKey: 6,
      });
    }
  }

  items.sort((a, b) => (SEVERITY[a.tone] - SEVERITY[b.tone]) || (a.sortKey - b.sortKey));
  return {
    items,
    count: items.length,
    urgent: items.filter((i) => i.tone === 'danger').length,
  };
}

/**
 * Inbox brief — the conversational + scheduling load waiting on a human, across
 * WhatsApp, Instagram Direct and the post scheduler. Each argument is the
 * matching resolver's OUTPUT (resolveConversations / resolveIgConversations /
 * resolveScheduleAgenda), so this only reduces them to glance figures + a single
 * merged "oldest waiting first" list the Bandejas panel renders.
 */
export function resolveCommsBrief({
  conversations = [], igConversations = [], agenda = null, now = Date.now(), limit = 6,
} = {}) {
  const waiting = [];

  let waUnread = 0;
  let waOldestWaitingAt = null;
  for (const c of conversations) {
    waUnread += c.unread || 0;
    if (c.awaitingReply) {
      const at = c.lastInboundAt || c.lastAt || 0;
      if (at && (waOldestWaitingAt == null || at < waOldestWaitingAt)) waOldestWaitingAt = at;
      waiting.push({
        id: `wa-${c.key}`, channel: 'wa', name: c.name || c.phone || 'WhatsApp',
        at, unread: c.unread || 0, to: `/chats?chat=${encodeURIComponent(c.key)}`,
      });
    }
  }

  let igUnread = 0;
  let igOldestWaitingAt = null;
  for (const c of igConversations) {
    igUnread += c.unread || 0;
    if (c.awaitingReply) {
      const at = c.lastInboundAt || c.lastAt || 0;
      if (at && (igOldestWaitingAt == null || at < igOldestWaitingAt)) igOldestWaitingAt = at;
      waiting.push({
        id: `ig-${c.threadKey}`, channel: 'ig',
        name: c.username ? `@${c.username}` : (c.name || 'Instagram'),
        at, unread: c.unread || 0, to: '/marketing',
      });
    }
  }

  // Oldest first — the conversation that has waited longest needs answering most.
  waiting.sort((a, b) => (a.at || Infinity) - (b.at || Infinity));

  const upcoming = (agenda && agenda.upcoming) || [];
  const postsOverdue = upcoming.filter((p) => p.at && p.at < now).length;
  const nextFuture = upcoming.find((p) => p.at && p.at > now);

  return {
    waUnread,
    waWaitingCount: waiting.filter((w) => w.channel === 'wa').length,
    waOldestWaitingAt,
    igUnread,
    igWaitingCount: waiting.filter((w) => w.channel === 'ig').length,
    igOldestWaitingAt,
    postsUpcoming: upcoming.length,
    postsOverdue,
    nextPostAt: nextFuture ? nextFuture.at : null,
    waiting: waiting.slice(0, limit).map((w) => ({ ...w, ago: agoLabel(w.at, now) })),
  };
}
