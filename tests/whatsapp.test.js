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
  WA_WINDOW_MS, resolveConversations, resolveThread, resolveNewChatContacts,
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
