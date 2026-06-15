/**
 * Tests for src/core/crm/views/igInbox.js — the Instagram Direct inbox VM.
 *
 * Pins the thread grouping (by IGSID threadKey), the unread / awaiting-reply
 * signals, the 24h standard-messaging window the composer gates on, and the
 * display-name precedence (@handle → name → id).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveIgConversations, resolveIgThread, IG_WINDOW_MS } from '../src/core/crm/views/igInbox.js';

const NOW = Date.parse('2026-06-10T12:00:00Z');
const MIN = 60_000;

const msg = (o) => ({ direction: 'in', kind: 'text', body: 'hola', ...o });

test('groups by threadKey, newest-activity first; carries the handle', () => {
  const messages = [
    msg({ threadKey: 'A', body: 'a1 old', createdAt: NOW - 10 * MIN, username: 'ana' }),
    msg({ threadKey: 'A', body: 'a2 new', createdAt: NOW - 5 * MIN }),
    msg({ threadKey: 'B', body: 'b1', createdAt: NOW - 1 * MIN, username: 'beto' }),
  ];
  const list = resolveIgConversations(messages, { now: NOW });
  assert.deepEqual(list.map((c) => c.key), ['B', 'A']); // B's last activity is newer
  const a = list.find((c) => c.key === 'A');
  assert.equal(a.lastBody, 'a2 new'); // newest in-thread message
  assert.equal(a.unread, 2);          // both inbound A rows, none readAt
  assert.equal(a.username, 'ana');    // handle carried from inbound
});

test('unread = inbound messages without readAt; awaitingReply when last is inbound', () => {
  const messages = [
    msg({ threadKey: 'A', body: 'q1', createdAt: NOW - 9 * MIN }),
    msg({ threadKey: 'A', body: 'q2', createdAt: NOW - 8 * MIN }),
    msg({ threadKey: 'A', direction: 'out', body: 'r', status: 'sent', createdAt: NOW - 7 * MIN }),
    msg({ threadKey: 'A', body: 'q3', createdAt: NOW - 6 * MIN }),
  ];
  const [a] = resolveIgConversations(messages, { now: NOW });
  assert.equal(a.unread, 3);           // 3 inbound, none readAt
  assert.equal(a.awaitingReply, true); // last row is inbound
  assert.equal(a.lastBody, 'q3');
});

test('window opens for 24h after the last inbound, then closes', () => {
  const open = resolveIgConversations([msg({ threadKey: 'A', createdAt: NOW - 23 * 60 * MIN })], { now: NOW });
  assert.equal(open[0].windowOpen, true);
  const closed = resolveIgConversations([msg({ threadKey: 'A', createdAt: NOW - 25 * 60 * MIN })], { now: NOW });
  assert.equal(closed[0].windowOpen, false);
  // an outbound-only thread never opens the window
  const outOnly = resolveIgConversations([msg({ threadKey: 'A', direction: 'out', createdAt: NOW })], { now: NOW });
  assert.equal(outOnly[0].windowOpen, false);
});

test('display name: @handle wins, then name, then the raw id; media kinds get a label', () => {
  const named = resolveIgConversations([msg({ threadKey: 'A', username: 'ana', name: 'Ana P' })], { now: NOW });
  assert.equal(named[0].name, '@ana');
  const noHandle = resolveIgConversations([msg({ threadKey: 'B', name: 'Beto' })], { now: NOW });
  assert.equal(noHandle[0].name, 'Beto');
  const bare = resolveIgConversations([msg({ threadKey: 'C1789' })], { now: NOW });
  assert.equal(bare[0].name, 'C1789');
  const photo = resolveIgConversations([msg({ threadKey: 'D', kind: 'image', body: '' })], { now: NOW });
  assert.equal(photo[0].lastBody, '📷 Imagen');
});

test('needle filters by handle and name', () => {
  const messages = [
    msg({ threadKey: 'A', username: 'anitra', createdAt: NOW - MIN }),
    msg({ threadKey: 'B', name: 'Roberto', createdAt: NOW }),
  ];
  assert.deepEqual(resolveIgConversations(messages, { needle: 'anit', now: NOW }).map((c) => c.key), ['A']);
  assert.deepEqual(resolveIgConversations(messages, { needle: 'rober', now: NOW }).map((c) => c.key), ['B']);
});

test('resolveIgThread filters to one thread, oldest-first, with the window state', () => {
  const messages = [
    msg({ threadKey: 'A', body: 'a2', createdAt: NOW - 5 * MIN }),
    msg({ threadKey: 'A', body: 'a1', createdAt: NOW - 9 * MIN }),
    msg({ threadKey: 'B', body: 'b', createdAt: NOW }),
  ];
  const th = resolveIgThread(messages, { threadKey: 'A', now: NOW });
  assert.deepEqual(th.items.map((m) => m.body), ['a1', 'a2']); // oldest first
  assert.equal(th.threadKey, 'A');
  assert.equal(th.windowOpen, true);
  assert.equal(th.windowExpiresAt, (NOW - 5 * MIN) + IG_WINDOW_MS);
});
