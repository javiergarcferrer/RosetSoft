// ViewModels for Difusión — WhatsApp template campaigns (the marketing /
// "ads" side of the Business Platform: outbound MARKETING templates to a
// chosen audience; inbound Click-to-WhatsApp ad traffic lands in the inbox
// with a referral payload, resolved in views/inbox.js).
//
// Pure projections over customers + professionals + wa_campaigns +
// wa_messages — no React, no db, no supabase. The Difusión page fetches,
// calls these in useMemo, renders.

import { phoneKey, displayPhone } from '../../../lib/phone.js';

/** What a body variable ({{n}}) is filled with, per recipient:
 *  'firstName' | 'name' | 'company' | 'fixed' (same text for everyone). */
export const VAR_SOURCES = [
  { value: 'firstName', label: 'Nombre (primera palabra)' },
  { value: 'name', label: 'Nombre completo' },
  { value: 'company', label: 'Empresa' },
  { value: 'fixed', label: 'Texto fijo' },
];

/**
 * The selectable audience for a campaign: every contact with a phone, deduped
 * by phoneKey (two contact cards sharing a number collapse into one recipient
 * — WhatsApp delivers to the PHONE, so one send per phone is the invariant).
 *
 *   resolveBroadcastAudience(customers, professionals, { kind, needle })
 *     → [{ key, phone, name, company, contactKind, customerId, professionalId }]
 *
 * `kind`: 'professionals' | 'customers' | 'all'.
 */
export function resolveBroadcastAudience(customers, professionals, { kind = 'professionals', needle = '' } = {}) {
  const rows = [];
  if (kind === 'professionals' || kind === 'all') {
    for (const p of professionals || []) rows.push({ row: p, contactKind: 'professional' });
  }
  if (kind === 'customers' || kind === 'all') {
    for (const c of customers || []) rows.push({ row: c, contactKind: 'customer' });
  }

  const q = needle.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');
  const seen = new Set();
  const out = [];
  for (const { row, contactKind } of rows) {
    const key = phoneKey(row.phone);
    if (!key || seen.has(key)) continue;
    const name = row.name || row.company || displayPhone(row.phone);
    if (q) {
      const hit = name.toLowerCase().includes(q)
        || (row.company || '').toLowerCase().includes(q)
        || (qDigits && String(row.phone || '').replace(/\D/g, '').includes(qDigits));
      if (!hit) continue;
    }
    seen.add(key);
    out.push({
      key,
      phone: row.phone,
      name,
      company: row.company || '',
      contactKind,
      customerId: contactKind === 'customer' ? row.id : null,
      professionalId: contactKind === 'professional' ? row.id : null,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** A contact's value for one variable spec ({ source, text? }). Falls back to
 *  the full name so an empty company never sends a blank into the template
 *  (Meta rejects empty parameters). */
function varValue(contact, spec) {
  const name = (contact.name || '').trim();
  switch (spec?.source) {
    case 'fixed': return String(spec.text || '').trim() || '—';
    case 'company': return (contact.company || '').trim() || name || '—';
    case 'name': return name || '—';
    case 'firstName':
    default:
      return name.split(/\s+/)[0] || '—';
  }
}

/**
 * Selected contacts + per-variable specs → the wa-send broadcast recipients.
 * Deduped by phoneKey (the one-send-per-phone invariant, kept even if the
 * caller passes duplicates).
 *
 *   buildBroadcastRecipients(contacts, varSpecs)
 *     → [{ to, params, customerId, professionalId }]
 */
export function buildBroadcastRecipients(contacts, varSpecs = []) {
  const seen = new Set();
  const out = [];
  for (const c of contacts || []) {
    const key = phoneKey(c.phone);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      to: String(c.phone || '').replace(/\D/g, ''),
      params: (varSpecs || []).map((spec) => varValue(c, spec)),
      customerId: c.customerId || null,
      professionalId: c.professionalId || null,
    });
  }
  return out;
}

/** Fill a template body's {{1}}, {{2}}… with params for a preview. */
export function fillTemplateBody(bodyText, params = []) {
  return String(bodyText || '').replace(/\{\{(\d+)\}\}/g, (_, n) => {
    const v = params[Number(n) - 1];
    return v == null || v === '' ? `{{${n}}}` : String(v);
  });
}

// Delivery-state precedence: a message's CURRENT state is the furthest stage
// it reached (the webhook overwrites status in place).
const OUT_STAGE = { accepted: 1, sent: 2, delivered: 3, read: 4 };

/**
 * Campaign history with the LIVE delivery rollup — counts come from the
 * campaign-tagged wa_messages rows, which the webhook keeps updating after the
 * send (delivered/read trickle in for hours), not from the frozen counters on
 * the campaign row. Newest first.
 *
 *   resolveCampaignsList({ campaigns, messages })
 *     → [{ campaign, recipients, sent, delivered, read, failed }]
 */
export function resolveCampaignsList({ campaigns, messages }) {
  const byCampaign = new Map();
  for (const m of messages || []) {
    if (!m.campaignId) continue;
    if (!byCampaign.has(m.campaignId)) byCampaign.set(m.campaignId, []);
    byCampaign.get(m.campaignId).push(m);
  }
  const out = (campaigns || []).map((campaign) => {
    const rows = byCampaign.get(campaign.id) || [];
    let sent = 0;
    let delivered = 0;
    let read = 0;
    let failed = 0;
    let billable = 0; // messages Meta charged for (per-message pricing webhook)
    for (const m of rows) {
      if (m.pricingBillable === true) billable += 1;
      if (m.status === 'failed') { failed += 1; continue; }
      const stage = OUT_STAGE[m.status] || 0;
      if (stage >= 1) sent += 1;
      if (stage >= 3) delivered += 1;
      if (stage >= 4) read += 1;
    }
    // Before the messages land (or for legacy rows) fall back to the counters
    // frozen on the campaign at send time.
    if (!rows.length) {
      sent = campaign.sentCount || 0;
      failed = campaign.failedCount || 0;
    }
    return {
      campaign,
      recipients: campaign.recipientCount ?? rows.length,
      sent,
      delivered,
      read,
      failed,
      billable,
    };
  });
  out.sort((a, b) => (b.campaign.createdAt || 0) - (a.campaign.createdAt || 0));
  return out;
}
