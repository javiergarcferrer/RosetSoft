/**
 * Tests for src/core/jarvis/messaging.js — the IG/FB DM inbox VMs.
 *
 * Pins the projection the Messaging surface renders: the conversation list
 * (participant pulled from `participants`, the 1-deep message preview, newest
 * first, unread + direction) and the thread (sorted oldest→newest, direction
 * resolved against the customer/self ids, ISO/unix timestamps normalized,
 * attachments flattened). The Graph API mixes ISO strings and unix seconds and
 * nests sender/participant — all of that lives in the VM, not the View.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDmConversations, resolveDmThread } from '../src/core/jarvis/messaging.js';

const NOW = Date.parse('2026-06-14T12:00:00Z');
const SELF = '17841400000000000'; // our IG business account id
const CUST = '6700000000000001';  // the customer's IGSID

test('resolveDmConversations: participant, preview, direction, unread, newest first', () => {
  const rows = [
    {
      id: 'tA', platform: 'instagram', unread_count: 0,
      updated_time: '2026-06-14T10:00:00Z',
      participants: { data: [{ id: SELF, username: 'alcover' }, { id: CUST, username: 'cliente1' }] },
      messages: { data: [{ id: 'm1', message: 'gracias!', from: { id: SELF }, created_time: '2026-06-14T10:00:00Z' }] },
    },
    {
      id: 'tB', platform: 'facebook', unread_count: 3,
      updated_time: '2026-06-14T11:30:00Z',
      participants: { data: [{ id: '999', name: 'Page' }, { id: '888', name: 'Juan Pérez' }] },
      messages: { data: [{ id: 'm2', message: '¿precio?', from: { id: '888' }, created_time: '2026-06-14T11:30:00Z' }] },
    },
  ];
  const out = resolveDmConversations(rows, { now: NOW, selfIds: [SELF, '999'] });
  assert.equal(out.length, 2);
  // Newest activity first → tB (11:30) before tA (10:00).
  assert.equal(out[0].id, 'tB');
  assert.equal(out[0].participantName, 'Juan Pérez');
  assert.equal(out[0].lastText, '¿precio?');
  assert.equal(out[0].lastDirection, 'in'); // from the customer
  assert.equal(out[0].unread, 3);
  assert.equal(out[0].platform, 'facebook');
  // tA: last message was from us.
  assert.equal(out[1].id, 'tA');
  assert.equal(out[1].participantName, 'cliente1');
  assert.equal(out[1].participantId, CUST);
  assert.equal(out[1].lastDirection, 'out');
  assert.equal(out[1].unread, 0);
});

test('resolveDmConversations: empty/missing fields degrade gracefully', () => {
  const out = resolveDmConversations([
    { id: 'tC', platform: 'instagram', participants: { data: [{ id: CUST }] } },
    { id: '' }, // no id → dropped
  ], { now: NOW, selfIds: [SELF] });
  assert.equal(out.length, 1);
  assert.equal(out[0].lastText, '(sin texto)');
  assert.equal(out[0].lastDirection, null);
  assert.equal(out[0].participantName, 'Sin nombre');
});

test('resolveDmThread: sorted oldest→newest, direction by participant, attachments flattened', () => {
  const messages = [
    // Meta returns newest first; the VM sorts ascending.
    {
      id: 'm3', message: 'perfecto', from: { id: SELF }, created_time: 1_781_431_200, // unix seconds = 2026-06-14T10:00:00Z
    },
    {
      id: 'm2', message: '', from: { id: CUST }, created_time: '2026-06-14T09:30:00Z',
      attachments: { data: [{ image_data: { url: 'https://cdn/img.jpg' }, mime_type: 'image/jpeg' }] },
    },
    { id: 'm1', message: 'hola', from: { id: CUST }, created_time: '2026-06-14T09:00:00Z' },
  ];
  const { items, count } = resolveDmThread(messages, { now: NOW, participantId: CUST });
  assert.equal(count, 3);
  assert.deepEqual(items.map((m) => m.id), ['m1', 'm2', 'm3']); // ascending by time
  assert.equal(items[0].direction, 'in');   // from customer
  assert.equal(items[2].direction, 'out');  // from us
  // Attachment flattened to mediaUrl + mediaType.
  assert.equal(items[1].mediaUrl, 'https://cdn/img.jpg');
  assert.equal(items[1].mediaType, 'image/jpeg');
  assert.ok(items.every((m) => typeof m.ago === 'string'));
});

test('resolveDmThread: selfIds fallback when no participantId given', () => {
  const messages = [
    { id: 'a', message: 'hi', from: { id: CUST }, created_time: '2026-06-14T09:00:00Z' },
    { id: 'b', message: 'reply', from: { id: SELF }, created_time: '2026-06-14T09:05:00Z' },
  ];
  const { items } = resolveDmThread(messages, { now: NOW, selfIds: [SELF] });
  assert.equal(items[0].direction, 'in');
  assert.equal(items[1].direction, 'out');
});
