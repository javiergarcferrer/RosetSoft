// Pinned invariants for the WhatsApp/CRM integration:
//
//   • phone normalization (lib/phone) — DR-local numbers get +1, threads and
//     contact links key on the LAST 10 digits so country-code variants of the
//     same number collapse into ONE conversation. wa-webhook re-implements
//     phoneKey across the Deno↔Vite wall; this file pins the client side of
//     that contract.
//   • the inbox ViewModels (core/crm) — thread grouping, contact linking by
//     id-then-phone, unread counting, and Meta's 24h customer-service window
//     (free text only delivers for 24h after the LAST inbound message).

import test from 'node:test';
import assert from 'node:assert/strict';
import { waDigits, phoneKey, displayPhone } from '../src/lib/phone.js';
import {
  WA_WINDOW_MS, resolveConversations, resolveThread, resolveNewChatContacts, fillQuickReply,
} from '../src/core/crm/index.js';

const HOUR = 60 * 60 * 1000;

test('waDigits — DR-local 10 digits get +1; explicit country codes pass through', () => {
  assert.equal(waDigits('809 555 0100'), '18095550100');
  assert.equal(waDigits('(829) 555-0100'), '18295550100');
  assert.equal(waDigits('+1 809-555-0100'), '18095550100');
  assert.equal(waDigits('+34 600 11 22 33'), '34600112233'); // 11 digits, kept as typed
  assert.equal(waDigits(''), '');
  assert.equal(waDigits(null), '');
});

test('phoneKey — country-code variants of one number share a key', () => {
  const local = phoneKey('809-555-0100');
  assert.equal(local, '8095550100');
  assert.equal(phoneKey('18095550100'), local);
  assert.equal(phoneKey('+1 (809) 555-0100'), local);
  assert.notEqual(phoneKey('8295550100'), local);
});

test('displayPhone — NANP grouping, bare + for the rest', () => {
  assert.equal(displayPhone('18095550100'), '+1 809 555 0100');
  assert.equal(displayPhone('8095550100'), '+1 809 555 0100');
  assert.equal(displayPhone('34600112233'), '+34600112233');
});

function fixtures(now) {
  const customers = [{ id: 'c1', name: 'Eduardo García', phone: '809 555 0100' }];
  const professionals = [{ id: 'p1', name: 'Diseños Mota', phone: '829 555 0200' }];
  const messages = [
    // One conversation, two phone spellings of the same number.
    { id: 'm1', direction: 'in', phone: '18095550100', body: 'Hola', createdAt: now - 2 * HOUR, profileName: 'Eduardo' },
    { id: 'm2', direction: 'out', phone: '8095550100', body: 'Su cotización', status: 'delivered', createdAt: now - 1 * HOUR },
    // A professional's thread, inbound unread, outside the window.
    { id: 'm3', direction: 'in', phone: '18295550200', body: '¿Comisión?', createdAt: now - 30 * HOUR },
    // An unknown number — no contact match.
    { id: 'm4', direction: 'in', phone: '15615550300', body: 'Info', createdAt: now - 3 * HOUR, profileName: 'Ana', readAt: now },
  ];
  return { customers, professionals, messages };
}

test('resolveConversations — groups by phoneKey, links contacts, counts unread, orders by activity', () => {
  const now = Date.now();
  const { customers, professionals, messages } = fixtures(now);
  const convos = resolveConversations(messages, customers, professionals, { now });

  assert.equal(convos.length, 3);
  // Newest activity first.
  assert.deepEqual(convos.map((c) => c.name), ['Eduardo García', 'Ana', 'Diseños Mota']);

  const eduardo = convos[0];
  assert.equal(eduardo.key, '8095550100');         // both spellings collapsed
  assert.equal(eduardo.contactKind, 'customer');
  assert.equal(eduardo.customerId, 'c1');
  assert.equal(eduardo.unread, 1);                 // m1 has no readAt
  assert.equal(eduardo.lastBody, 'Su cotización'); // the newest message wins
  assert.equal(eduardo.lastDirection, 'out');
  assert.equal(eduardo.windowOpen, true);          // inbound 2h ago

  const mota = convos[2];
  assert.equal(mota.contactKind, 'professional');
  assert.equal(mota.professionalId, 'p1');
  assert.equal(mota.windowOpen, false);            // inbound 30h ago

  const ana = convos[1];
  assert.equal(ana.contactKind, null);             // unknown number falls back
  assert.equal(ana.name, 'Ana');                   // …to the WhatsApp profile name
  assert.equal(ana.unread, 0);                     // read

  // Needle filters by name and by digits.
  assert.equal(resolveConversations(messages, customers, professionals, { now, needle: 'eduardo' }).length, 1);
  assert.equal(resolveConversations(messages, customers, professionals, { now, needle: '0300' })[0].name, 'Ana');
});

test('resolveThread — chronological items + the 24h window off the LAST inbound', () => {
  const now = Date.now();
  const { messages } = fixtures(now);
  const t = resolveThread(messages, { key: '8095550100', now });
  assert.deepEqual(t.items.map((m) => m.id), ['m1', 'm2']);
  assert.equal(t.windowOpen, true);
  assert.equal(t.windowExpiresAt, (now - 2 * HOUR) + WA_WINDOW_MS);

  // Outbound traffic does NOT extend the window — only the client's messages do.
  const stale = resolveThread([
    { id: 'a', direction: 'in', phone: '8095550100', createdAt: now - 25 * HOUR },
    { id: 'b', direction: 'out', phone: '8095550100', createdAt: now - 1 * HOUR },
  ], { key: '8095550100', now });
  assert.equal(stale.windowOpen, false);
  assert.equal(stale.windowExpiresAt, null);

  // No inbound ever → closed (template required to initiate).
  const fresh = resolveThread([], { key: '8095550100', now });
  assert.equal(fresh.windowOpen, false);
  assert.equal(fresh.lastInboundAt, null);
});

test('fillQuickReply — named placeholders, unknown tokens left intact', () => {
  assert.equal(
    fillQuickReply('Hola {{nombre}}, gracias por escribir a {{negocio}}.', { nombre: 'Eduardo', negocio: 'ALCOVER' }),
    'Hola Eduardo, gracias por escribir a ALCOVER.',
  );
  // Case-insensitive key, tolerant of inner spacing.
  assert.equal(fillQuickReply('Hola {{ Nombre }}', { nombre: 'Ana' }), 'Hola Ana');
  // Unknown placeholder is preserved (a typo stays visible).
  assert.equal(fillQuickReply('Hola {{cliente}}', { nombre: 'Ana' }), 'Hola {{cliente}}');
  // Known key with no value collapses to ''.
  assert.equal(fillQuickReply('Hola {{nombre}}!', {}), 'Hola !');
  assert.equal(fillQuickReply('', { nombre: 'Ana' }), '');
});

test('resolveNewChatContacts — phone-bearing contacts not already in a thread', () => {
  const now = Date.now();
  const { customers, professionals, messages } = fixtures(now);
  const convos = resolveConversations(messages, customers, professionals, { now });
  const fresh = resolveNewChatContacts(
    [...customers, { id: 'c2', name: 'Nuevo Cliente', phone: '809 555 0400' }, { id: 'c3', name: 'Sin Teléfono' }],
    professionals,
    convos,
  );
  // c1 and p1 already have threads; c3 has no phone — only c2 remains.
  assert.deepEqual(fresh.map((c) => c.name), ['Nuevo Cliente']);
  assert.equal(fresh[0].customerId, 'c2');
  assert.equal(fresh[0].key, '8095550400');
});

/* ----------------------------- Difusión (campaigns) -----------------------------
 * Pinned invariants for the broadcast pipeline (core/crm/views/campaigns):
 *   • ONE send per phone — WhatsApp delivers to the number; duplicate contact
 *     cards (or a contact present as both customer and professional) must
 *     collapse to a single recipient.
 *   • template parameters are never empty — Meta rejects empty {{n}} values,
 *     so every variable source falls back (company → name → '—').
 *   • the campaign rollup reads the LIVE webhook statuses with stage
 *     precedence (read ⊂ delivered ⊂ sent), failures separate.
 */
import {
  resolveBroadcastAudience, buildBroadcastRecipients, fillTemplateBody, resolveCampaignsList,
} from '../src/core/crm/index.js';

test('resolveBroadcastAudience — dedupes by phone across lists, skips phone-less', () => {
  const customers = [
    { id: 'c1', name: 'Ana Pérez', phone: '809-555-0100' },
    { id: 'c2', name: 'Sin Teléfono' },
  ];
  const professionals = [
    { id: 'p1', name: 'Ana P. (estudio)', phone: '+1 809 555 0100' }, // same number as c1
    { id: 'p2', name: 'Berta Gómez', phone: '829-555-0200' },
  ];
  const all = resolveBroadcastAudience(customers, professionals, { kind: 'all' });
  assert.equal(all.length, 2); // Ana collapsed, Sin Teléfono dropped
  const keys = all.map((c) => c.key).sort();
  assert.deepEqual(keys, ['8095550100', '8295550200']);

  const pros = resolveBroadcastAudience(customers, professionals, { kind: 'professionals' });
  assert.deepEqual(pros.map((c) => c.professionalId).sort(), ['p1', 'p2']);
});

test('buildBroadcastRecipients — one send per phone, params never empty', () => {
  const contacts = [
    { phone: '809-555-0100', name: 'Ana Pérez García', company: '', customerId: 'c1', professionalId: null },
    { phone: '+1 (809) 555-0100', name: 'Ana dup', company: '', customerId: 'c9', professionalId: null }, // dup phone
    { phone: '829-555-0200', name: 'Berta Gómez', company: 'Estudio BG', customerId: null, professionalId: 'p2' },
  ];
  const recipients = buildBroadcastRecipients(contacts, [
    { source: 'firstName' },
    { source: 'company' },
    { source: 'fixed', text: '10%' },
  ]);
  assert.equal(recipients.length, 2);
  // Ana: first name; empty company falls back to her name (never an empty param).
  assert.deepEqual(recipients[0].params, ['Ana', 'Ana Pérez García', '10%']);
  assert.deepEqual(recipients[1].params, ['Berta', 'Estudio BG', '10%']);
  assert.equal(recipients[0].to, '8095550100');
  assert.equal(recipients[1].customerId, null);
  assert.equal(recipients[1].professionalId, 'p2');
});

test('fillTemplateBody — fills {{n}}, leaves missing params visible', () => {
  assert.equal(fillTemplateBody('Hola {{1}}, oferta {{2}}', ['Ana', '10%']), 'Hola Ana, oferta 10%');
  assert.equal(fillTemplateBody('Hola {{1}}, oferta {{2}}', ['Ana']), 'Hola Ana, oferta {{2}}');
  assert.equal(fillTemplateBody('', []), '');
});

test('resolveCampaignsList — live rollup with stage precedence; frozen fallback', () => {
  const campaigns = [
    { id: 'k1', name: 'Promo', recipientCount: 4, sentCount: 4, failedCount: 0, createdAt: 2000 },
    { id: 'k0', name: 'Vieja sin mensajes', recipientCount: 3, sentCount: 2, failedCount: 1, createdAt: 1000 },
  ];
  const messages = [
    { campaignId: 'k1', status: 'read' },      // counts as sent+delivered+read
    { campaignId: 'k1', status: 'delivered' }, // sent+delivered
    { campaignId: 'k1', status: 'accepted' },  // sent only
    { campaignId: 'k1', status: 'failed' },    // failed only
    { campaignId: 'other', status: 'read' },   // another campaign — ignored
    { status: 'read' },                        // not campaign-tagged — ignored
  ];
  const rows = resolveCampaignsList({ campaigns, messages });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].campaign.id, 'k1'); // newest first
  assert.deepEqual(
    { sent: rows[0].sent, delivered: rows[0].delivered, read: rows[0].read, failed: rows[0].failed },
    { sent: 3, delivered: 2, read: 1, failed: 1 },
  );
  // No campaign-tagged messages yet → the counters frozen at send time.
  assert.deepEqual({ sent: rows[1].sent, failed: rows[1].failed }, { sent: 2, failed: 1 });
});

/* --------------------- thread affordances (reactions, replies) ---------------------
 * Pinned: a reaction row decorates its TARGET bubble (matched by wamid) and
 * never renders as its own row; removing the reaction (empty emoji) clears it;
 * a reaction to a message we never logged stays visible as a row. A reply
 * (Meta `context`) resolves into the quoted snippet.
 */
test('resolveThread — reactions fold onto their target; removal clears; replies quote', () => {
  const phone = '18095550100';
  const messages = [
    { id: 'a', phone, direction: 'out', waId: 'wamid.A', body: 'Su cotización está lista', createdAt: 1000 },
    { id: 'b', phone, direction: 'in', waId: 'wamid.B', kind: 'reaction', body: '👍',
      payload: { reaction: { message_id: 'wamid.A', emoji: '👍' } }, createdAt: 2000 },
    { id: 'c', phone, direction: 'in', waId: 'wamid.C', kind: 'text', body: 'Gracias, ¿incluye envío?',
      payload: { context: { id: 'wamid.A' } }, createdAt: 3000 },
    // Reaction to a message outside our log → stays as its own row.
    { id: 'd', phone, direction: 'in', waId: 'wamid.D', kind: 'reaction', body: '❤️',
      payload: { reaction: { message_id: 'wamid.UNKNOWN', emoji: '❤️' } }, createdAt: 4000 },
  ];
  const t = resolveThread(messages, { key: '8095550100', now: 5000 });
  assert.deepEqual(t.items.map((m) => m.id), ['a', 'c', 'd']); // 'b' folded into 'a'
  assert.deepEqual(t.items[0].reactions, ['👍']);
  assert.equal(t.items[1].quoted.direction, 'out');
  assert.equal(t.items[1].quoted.body, 'Su cotización está lista');

  // The user removes the reaction → the decoration clears.
  const removed = [...messages,
    { id: 'e', phone, direction: 'in', waId: 'wamid.E', kind: 'reaction', body: '',
      payload: { reaction: { message_id: 'wamid.A', emoji: '' } }, createdAt: 4500 },
  ];
  const t2 = resolveThread(removed, { key: '8095550100', now: 5000 });
  assert.equal(t2.items.find((m) => m.id === 'a').reactions ?? null, null);
});
