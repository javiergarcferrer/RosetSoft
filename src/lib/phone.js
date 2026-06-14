// Pure phone-number helpers for the WhatsApp integration (Model — no imports).
//
// WhatsApp addresses a chat by digits-only E.164 (no "+", no spaces). The
// Dominican market wrinkle: dealers type a bare 10-digit local number
// (area + line, e.g. "809 555 0100") and expect it to mean +1. Everything
// here normalizes through `waDigits`; thread/contact matching uses `phoneKey`
// (the last 10 digits) so "+18095550100", "18095550100" and "809-555-0100"
// all land in the SAME conversation.

/**
 * Digits-only number for the Cloud API / wa.me. A bare 10-digit local number
 * gets a leading "1" (+1, DR); anything that already carries a country code is
 * left as typed. Non-digits (spaces, dashes, "+") are stripped.
 */
export function waDigits(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  return d.length === 10 ? `1${d}` : d;
}

/**
 * Matching key for grouping messages into threads and linking a number to a
 * customer/professional: the LAST 10 digits. Country-code variants (806… vs
 * 1809…) collapse onto one key; numbers shorter than 10 digits key as-is.
 */
export function phoneKey(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}

/**
 * Thread key for a WhatsApp GROUP — the Meta group id behind a `g:` prefix.
 * Group threads live in the same inbox as 1:1 chats, so they share the `key`
 * namespace; the prefix keeps a group id from ever colliding with a phoneKey
 * (10 digits, no prefix) and lets `isGroupKey` tell the two apart.
 */
export function groupKey(groupId) {
  const id = String(groupId || '').trim();
  return id ? `g:${id}` : '';
}

/** True when a thread key names a group (vs a 1:1 phone thread). */
export function isGroupKey(key) {
  return typeof key === 'string' && key.startsWith('g:');
}

/** The Meta group id behind a group thread key (inverse of groupKey); '' for a
 *  non-group key. */
export function groupIdFromKey(key) {
  return isGroupKey(key) ? key.slice(2) : '';
}

/**
 * The contact (customer or professional) that already holds `phone`, matched by
 * phoneKey — the SINGLE source of truth for "is this WhatsApp number taken?".
 *
 * A WhatsApp number must identify exactly ONE contact: the inbox links a thread
 * to a contact by this same key (`indexByPhone` in core/crm), so two contacts
 * sharing a number make the conversation resolve to whichever happens to be
 * first — the "Carmen had Alcover's number" bug. Every contact-phone write goes
 * through this gate (the create/edit modals + inline edits) so the relation
 * stays watertight. `excludeId` skips the row being edited, so re-saving an
 * unchanged number isn't flagged against itself. Country-code variants collapse
 * via phoneKey, so "+1 809…" can't sneak past an existing "809…".
 *
 *   findPhoneOwner('8297608184', { customers, professionals, excludeId })
 *     → { kind: 'customer' | 'professional', row } | null
 */
export function findPhoneOwner(phone, { customers = [], professionals = [], excludeId = null } = {}) {
  const key = phoneKey(phone);
  if (!key) return null;
  const hit = (rows, kind) => {
    for (const r of rows || []) {
      if (excludeId && r.id === excludeId) continue;
      if (phoneKey(r.phone) === key) return { kind, row: r };
    }
    return null;
  };
  return hit(customers, 'customer') || hit(professionals, 'professional');
}

/** Spanish label naming a findPhoneOwner result, for the "already in use"
 *  message the modals/inline edits show. */
export function phoneOwnerLabel(owner) {
  if (!owner) return '';
  const { kind, row } = owner;
  const name = (row?.name || row?.company || displayPhone(row?.phone) || '').trim();
  const who = kind === 'professional' ? 'el profesional' : 'el cliente';
  return name ? `${who} ${name}` : who;
}

/**
 * Human display for a normalized digits number. NANP numbers (1 + 10 digits —
 * the DR lives here) render as "+1 809 555 0100"; anything else gets a bare
 * "+" prefix rather than a wrong grouping.
 */
export function displayPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 11 && d.startsWith('1')) {
    return `+1 ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
  }
  if (d.length === 10) return `+1 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  return `+${d}`;
}
