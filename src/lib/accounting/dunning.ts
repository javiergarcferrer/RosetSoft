/**
 * Collections / dunning Model — given the receivables aging, decide which open
 * invoice needs a reminder TODAY, following a configurable escalating cadence.
 * Pure: no React, no Supabase.
 *
 * Cadence (the QuickBooks-praised mechanic, validated by research): up to N
 * steps, each on a day-offset relative to the invoice due date (negative =
 * before, positive = after, clamped to ±90 days), each with its own template.
 * STATUS-GATED: a doc with no open balance never reminds, and a step already
 * sent for a doc is never repeated — so paid/collected invoices drop out and
 * customers aren't double-nudged. Sending stays human-in-the-loop (the View
 * drafts the WhatsApp/e-mail; a person reviews and sends).
 */
import type { DunningPolicy, DunningStep } from '../../types/domain.ts';
import { round2 } from './ledger.js';

const DAY = 86400000;

export const DEFAULT_DUNNING_POLICY: Required<DunningPolicy> = {
  enabled: false,
  channel: 'whatsapp',
  netDays: 0,
  steps: [
    { offsetDays: 0, template: 'Hola {cliente}, le recordamos la factura {ncf} por {monto}, vence hoy. ¡Gracias!' },
    { offsetDays: 7, template: 'Hola {cliente}, la factura {ncf} por {monto} tiene {dias} días de vencida. Agradecemos su pago.' },
    { offsetDays: 15, template: 'Hola {cliente}, la factura {ncf} por {monto} lleva {dias} días vencida. Por favor regularice el pago.' },
  ],
};

/** Merge saved overrides over the defaults; clamp + sort the cadence steps. */
export function resolveDunningPolicy(saved?: DunningPolicy | null): Required<DunningPolicy> {
  const s = saved || {};
  const steps: DunningStep[] = Array.isArray(s.steps) && s.steps.length
    ? s.steps
      .map((st) => ({ offsetDays: Math.max(-90, Math.min(90, Math.trunc(Number(st.offsetDays) || 0))), template: st.template || '' }))
      .sort((a, b) => a.offsetDays - b.offsetDays)
    : DEFAULT_DUNNING_POLICY.steps;
  return {
    enabled: s.enabled ?? DEFAULT_DUNNING_POLICY.enabled,
    channel: s.channel || DEFAULT_DUNNING_POLICY.channel,
    netDays: Number.isFinite(s.netDays as number) ? Number(s.netDays) : DEFAULT_DUNNING_POLICY.netDays,
    steps,
  };
}

function money(n: number): string {
  return `RD$ ${round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Fill a template's {cliente} {ncf} {monto} {dias} placeholders. */
export function fillTemplate(tpl: string | undefined, vars: { cliente?: string; ncf?: string; monto: number; dias: number }): string {
  return String(tpl || '')
    .replace(/\{cliente\}/g, vars.cliente || 'cliente')
    .replace(/\{ncf\}/g, vars.ncf || '')
    .replace(/\{monto\}/g, money(vars.monto))
    .replace(/\{dias\}/g, String(vars.dias));
}

/**
 * The reminder step due for a doc today — the most-escalated step whose offset
 * has been reached and not yet sent — or null. Status-gated on the open balance.
 */
export function dueStepFor(
  doc: { open: number; dueAt: number },
  policy: Required<DunningPolicy>,
  now: number,
  sentOffsets: number[] = [],
): DunningStep | null {
  if (!(doc.open > 0.001)) return null;
  const daysSinceDue = Math.floor((now - doc.dueAt) / DAY);
  const sent = new Set(sentOffsets);
  let pick: DunningStep | null = null;
  for (const st of policy.steps) {
    // A step is "reached" once daysSinceDue ≥ its offset. NOTE (pre-due
    // reminders, AMBIGUOUS — behavior intentionally unchanged): a negative offset
    // (e.g. −3 = "remind 3 days BEFORE due") becomes reachable as soon as
    // daysSinceDue ≥ −3, i.e. from 3 days before due onward — so it stays
    // "pending" through the whole overdue period until sent, and the
    // most-escalated reachable+unsent step wins (for negatives that's the one
    // CLOSEST to due, since −3 > −7). This matches the current product behavior;
    // if the desired semantics are "fire a pre-due step only in its window",
    // that's a separate decision for the owner. See report.
    if (st.offsetDays <= daysSinceDue && !sent.has(st.offsetDays)) {
      if (!pick || st.offsetDays > pick.offsetDays) pick = st;
    }
  }
  return pick;
}

export interface PlannedReminder {
  partyId: string;
  party: { name?: string; phone?: string } | null;
  docId: string;
  ncf: string;
  open: number;
  daysLate: number;
  stepOffset: number;
  channel: string;
  message: string;
}

/**
 * Which (party, doc) need a nudge today — deduped against reminders already
 * sent (by docId + step offset). `receivables` is a resolveReceivables result.
 */
export function planReminders({
  receivables, reminders, policy, now,
}: {
  receivables?: { rows?: Array<{ partyId: string; party?: any; docs?: Array<{ docId: string; date?: number; label?: string; open: number }> }> };
  reminders?: Array<{ docId: string; stepOffset: number }>;
  policy?: DunningPolicy | Required<DunningPolicy> | null;
  now: number;
}): PlannedReminder[] {
  const pol = (policy && (policy as Required<DunningPolicy>).steps) ? policy as Required<DunningPolicy> : resolveDunningPolicy(policy as DunningPolicy);
  const sentByDoc = new Map<string, number[]>();
  for (const r of reminders || []) {
    if (!sentByDoc.has(r.docId)) sentByDoc.set(r.docId, []);
    sentByDoc.get(r.docId)!.push(Number(r.stepOffset));
  }
  const out: PlannedReminder[] = [];
  for (const row of receivables?.rows || []) {
    for (const d of row.docs || []) {
      if (!(d.open > 0.001)) continue;
      const dueAt = (d.date || 0) + pol.netDays * DAY;
      const step = dueStepFor({ open: d.open, dueAt }, pol, now, sentByDoc.get(d.docId) || []);
      if (!step) continue;
      const dias = Math.max(0, Math.floor((now - dueAt) / DAY));
      out.push({
        partyId: row.partyId,
        party: row.party || null,
        docId: d.docId,
        ncf: d.label || '',
        open: round2(d.open),
        daysLate: dias,
        stepOffset: step.offsetDays,
        channel: pol.channel,
        message: fillTemplate(step.template, { cliente: row.party?.name, ncf: d.label, monto: d.open, dias }),
      });
    }
  }
  return out;
}
