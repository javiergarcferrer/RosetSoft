// Pinned invariants for WhatsApp GROUP messaging:
//
//   • a group is a thread keyed by groupKey(id) (`g:<id>`), sharing the inbox
//     `key` namespace with 1:1 chats but never colliding with a phoneKey;
//   • a message with a groupId lands in its GROUP thread (not the sender's
//     phone thread), and a 1:1 thread never absorbs a group message that
//     happens to share a participant's phoneKey;
//   • group threads label WHO spoke (senderName / lastSenderName) — 1:1 don't;
//   • archived groups drop out of the active inbox / audience;
//   • the campaign group target builds one recipient per group, params never
//     empty (Meta rejects blank {{n}}), name-ish sources → the subject.

import test from 'node:test';
import assert from 'node:assert/strict';
import { groupKey, isGroupKey, groupIdFromKey, phoneKey } from '../src/lib/phone.js';
import {
  resolveConversations, resolveThread,
  resolveGroupsList, resolveGroupParticipants, resolveGroupAudience, buildGroupBroadcastRecipients,
} from '../src/core/crm/index.js';

const HOUR = 60 * 60 * 1000;
const GID = '123456789@g.us';

test('groupKey / isGroupKey / groupIdFromKey — round-trip, never collides with a phoneKey', () => {
  const k = groupKey(GID);
  assert.equal(k, `g:${GID}`);
  assert.equal(isGroupKey(k), true);
  assert.equal(groupIdFromKey(k), GID);
  // A phoneKey is plain digits — never a group key.
  assert.equal(isGroupKey(phoneKey('809 555 0100')), false);
  assert.equal(groupIdFromKey('8095550100'), '');
  assert.equal(groupKey(''), '');
});

function fixtures(now) {
  const customers = [{ id: 'c1', name: 'Eduardo García', phone: '809 555 0100' }];
  const professionals = [{ id: 'p1', name: 'Diseños Mota', phone: '829 555 0200' }];
  const groups = [
    { id: GID, subject: 'Proyecto Casa Cap Cana', status: 'active', participantCount: 3 },
    { id: 'old@g.us', subject: 'Obra terminada', status: 'archived', participantCount: 5 },
  ];
  const messages = [
    // A 1:1 thread with Eduardo.
    { id: 'm1', direction: 'in', phone: '18095550100', body: 'Hola', createdAt: now - 5 * HOUR, profileName: 'Eduardo' },
    // The group: Eduardo (same number as the 1:1 contact) speaks IN THE GROUP —
    // must NOT fold into his 1:1 thread.
    { id: 'g1', direction: 'in', groupId: GID, phone: '18095550100', body: 'Buenos días equipo', createdAt: now - 2 * HOUR, profileName: 'Eduardo' },
    { id: 'g2', direction: 'in', groupId: GID, phone: '18295550200', body: '¿Confirmamos medidas?', createdAt: now - 1 * HOUR, profileName: 'Arq. Mota' },
    { id: 'g3', direction: 'out', groupId: GID, phone: '', body: 'Sí, mañana 10am', status: 'delivered', createdAt: now - 30 * 60 * 1000 },
    // An archived group with a message — stays out of the active inbox.
    { id: 'a1', direction: 'in', groupId: 'old@g.us', phone: '18095559999', body: 'gracias', createdAt: now - 10 * HOUR },
  ];
  return { customers, professionals, groups, messages };
}

test('resolveConversations — group threads sit beside 1:1, keyed by group, archived hidden', () => {
  const now = Date.now();
  const { customers, professionals, groups, messages } = fixtures(now);
  const convos = resolveConversations(messages, customers, professionals, { now, groups });

  // The active group + Eduardo's 1:1 — the archived group is dropped.
  assert.equal(convos.length, 2);
  // Newest activity first → the group (last msg 30m ago) before Eduardo (5h ago).
  const group = convos[0];
  assert.equal(group.key, groupKey(GID));
  assert.equal(group.groupId, GID);
  assert.equal(group.contactKind, 'group');
  assert.equal(group.name, 'Proyecto Casa Cap Cana');   // from the groups mirror
  assert.equal(group.participantCount, 3);
  assert.equal(group.lastBody, 'Sí, mañana 10am');
  assert.equal(group.lastDirection, 'out');
  assert.equal(group.lastSenderName, null);              // last msg was ours
  assert.equal(group.unread, 2);                          // g1 + g2 inbound, unread

  const eduardo = convos[1];
  assert.equal(eduardo.contactKind, 'customer');
  assert.equal(eduardo.key, '8095550100');
  assert.equal(eduardo.unread, 1);                        // only m1 — the group msg g1 is NOT in his 1:1
  assert.equal(eduardo.lastBody, 'Hola');
});

test('resolveConversations — last group sender is surfaced for the inbox row', () => {
  const now = Date.now();
  const messages = [
    { id: 'g1', direction: 'in', groupId: GID, phone: '18095550100', body: 'hola', createdAt: now - 2 * HOUR, profileName: 'Eduardo' },
    { id: 'g2', direction: 'in', groupId: GID, phone: '18295550200', body: 'medidas?', createdAt: now - 1 * HOUR, profileName: 'Arq. Mota' },
  ];
  const groups = [{ id: GID, subject: 'Proyecto', status: 'active', participantCount: 2 }];
  const [group] = resolveConversations(messages, [], [], { now, groups });
  assert.equal(group.lastSenderName, 'Arq. Mota');
});

test('resolveThread — group key filters by groupId, excludes the 1:1, labels senders', () => {
  const now = Date.now();
  const { messages } = fixtures(now);
  const t = resolveThread(messages, { key: groupKey(GID), now });

  assert.equal(t.isGroup, true);
  assert.equal(t.groupId, GID);
  // Only the group's three messages, chronological — the 1:1 'm1' is excluded
  // even though Eduardo's number matches.
  assert.deepEqual(t.items.map((m) => m.id), ['g1', 'g2', 'g3']);
  // Inbound bubbles carry the sender; the outbound one does not.
  assert.equal(t.items[0].senderName, 'Eduardo');
  assert.equal(t.items[1].senderName, 'Arq. Mota');
  assert.equal(t.items[2].senderName ?? null, null);

  // The 1:1 thread for the same number excludes the group messages.
  const oneToOne = resolveThread(messages, { key: '8095550100', now });
  assert.equal(oneToOne.isGroup, false);
  assert.deepEqual(oneToOne.items.map((m) => m.id), ['m1']);
});

test('resolveThread — group inbound with no display name falls back to the phone', () => {
  const messages = [{ id: 'g1', direction: 'in', groupId: GID, phone: '18095550100', body: 'hola', createdAt: 1000 }];
  const t = resolveThread(messages, { key: groupKey(GID), now: 2000 });
  assert.equal(t.items[0].senderName, '+1 809 555 0100');
});

function groupData(now) {
  const groups = [
    { id: GID, subject: 'Proyecto Cap Cana', description: 'Sala + comedor', status: 'active', isAdmin: true, inviteLink: 'https://chat.whatsapp.com/abc', participantCount: 2, updatedAt: now - 9 * HOUR },
    { id: 'old@g.us', subject: 'Obra vieja', status: 'archived', participantCount: 4, updatedAt: now - 100 * HOUR },
  ];
  const participants = [
    { id: `${GID}:8095550100`, groupId: GID, phone: '18095550100', name: 'Eduardo', role: 'member', joinedAt: now - 50 * HOUR },
    { id: `${GID}:8295550200`, groupId: GID, phone: '18295550200', name: 'Arq. Mota', role: 'admin', joinedAt: now - 60 * HOUR },
    { id: `${GID}:8095559999`, groupId: GID, phone: '18095559999', name: 'Salió', role: 'member', joinedAt: now - 70 * HOUR, leftAt: now - 5 * HOUR },
  ];
  const messages = [
    { id: 'g1', direction: 'in', groupId: GID, phone: '18095550100', body: 'hola', createdAt: now - 2 * HOUR, profileName: 'Eduardo' },
    { id: 'g2', direction: 'out', groupId: GID, phone: '', body: 'listo', status: 'read', createdAt: now - 1 * HOUR },
  ];
  return { groups, participants, messages };
}

test('resolveGroupsList — roster (active, admins first), activity rollup, archived hidden', () => {
  const now = Date.now();
  const { groups, participants, messages } = groupData(now);
  const list = resolveGroupsList(groups, participants, messages, { now });

  assert.equal(list.length, 1);             // archived hidden by default
  const g = list[0];
  assert.equal(g.id, GID);
  assert.equal(g.key, groupKey(GID));
  assert.equal(g.subject, 'Proyecto Cap Cana');
  assert.equal(g.isAdmin, true);
  assert.equal(g.inviteLink, 'https://chat.whatsapp.com/abc');
  assert.equal(g.participantCount, 2);      // the member who left is dropped
  assert.deepEqual(g.participants.map((p) => p.name), ['Arq. Mota', 'Eduardo']); // admin first
  assert.equal(g.lastBody, 'listo');
  assert.equal(g.lastDirection, 'out');
  assert.equal(g.unread, 1);                 // g1 inbound, unread

  // includeArchived surfaces both.
  assert.equal(resolveGroupsList(groups, participants, messages, { now, includeArchived: true }).length, 2);
  // needle matches the subject.
  assert.equal(resolveGroupsList(groups, participants, messages, { now, needle: 'cap cana' }).length, 1);
  assert.equal(resolveGroupsList(groups, participants, messages, { now, needle: 'zzz' }).length, 0);
});

test('resolveGroupParticipants — active members only, admins first', () => {
  const now = Date.now();
  const { participants } = groupData(now);
  const roster = resolveGroupParticipants(participants, GID);
  assert.deepEqual(roster.map((p) => p.name), ['Arq. Mota', 'Eduardo']);
  assert.equal(roster[0].role, 'admin');
  // A member with no name falls back to the formatted phone.
  const anon = resolveGroupParticipants([{ id: 'x', groupId: GID, phone: '18095550100', role: 'member' }], GID);
  assert.equal(anon[0].name, '+1 809 555 0100');
});

test('resolveGroupAudience — active groups, searchable, sorted by subject', () => {
  const now = Date.now();
  const { groups } = groupData(now);
  const aud = resolveGroupAudience(groups, {});
  assert.deepEqual(aud.map((g) => g.subject), ['Proyecto Cap Cana']); // archived excluded
  assert.equal(aud[0].id, GID);
  assert.equal(resolveGroupAudience(groups, { needle: 'cap' }).length, 1);
  assert.equal(resolveGroupAudience(groups, { needle: 'obra' }).length, 0); // that one is archived
});

test('buildGroupBroadcastRecipients — one per group, params never empty, name→subject', () => {
  const groups = [
    { id: GID, subject: 'Proyecto Cap Cana' },
    { id: GID, subject: 'dup — should collapse' },   // dup id
    { id: 'g2@g.us', subject: 'Showroom' },
  ];
  const recipients = buildGroupBroadcastRecipients(groups, [
    { source: 'firstName' },   // groups have no person → the subject
    { source: 'fixed', text: '15%' },
  ]);
  assert.equal(recipients.length, 2);
  assert.deepEqual(recipients[0], { groupId: GID, subject: 'Proyecto Cap Cana', params: ['Proyecto Cap Cana', '15%'] });
  assert.deepEqual(recipients[1], { groupId: 'g2@g.us', subject: 'Showroom', params: ['Showroom', '15%'] });
  // A group with no subject still never sends a blank param.
  const blank = buildGroupBroadcastRecipients([{ id: 'g3@g.us' }], [{ source: 'name' }]);
  assert.deepEqual(blank[0].params, ['—']);
});
