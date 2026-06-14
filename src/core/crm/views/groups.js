// ViewModels for WhatsApp GROUPS — the Grupos management panel and the group
// audience for Difusión campaigns.
//
// Pure projections over wa_groups + wa_group_participants + wa_messages — no
// React, no db. Group THREADS (the inbox conversation + composer) are resolved
// by views/inbox.js off wa_messages.groupId; this module owns the management
// surface (roster, last activity, invite link, archive state) and the campaign
// target list. A group is identified by a Meta group id; its thread key is
// groupKey(id) so it shares the inbox `key` namespace with 1:1 chats.

import { displayPhone, groupKey } from '../../../lib/phone.js';
import { WA_WINDOW_MS } from './inbox.js';

/** Admins first, then by display name — the order the roster renders in. */
function sortParticipants(parts) {
  return [...parts].sort((a, b) => {
    const ra = a.role === 'admin' ? 0 : 1;
    const rb = b.role === 'admin' ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return String(a.name || a.phone || '').localeCompare(String(b.name || b.phone || ''));
  });
}

/**
 * The Grupos panel list: every group with its live roster + last-activity
 * rollup, newest activity first.
 *
 *   resolveGroupsList(groups, participants, messages, { needle, now, includeArchived })
 *     → [{ id, key, subject, description, inviteLink, status, isAdmin, iconPath,
 *          participantCount, participants, lastAt, lastBody, lastDirection,
 *          lastSenderName, unread, windowOpen }]
 *
 * Archived groups are hidden unless `includeArchived`. `participantCount` counts
 * the LIVE roster (members without a leftAt), falling back to the stored count
 * before the roster has synced.
 */
export function resolveGroupsList(groups, participants, messages, { needle = '', now = Date.now(), includeArchived = false } = {}) {
  const partsByGroup = new Map();
  for (const p of participants || []) {
    if (!p.groupId) continue;
    if (!partsByGroup.has(p.groupId)) partsByGroup.set(p.groupId, []);
    partsByGroup.get(p.groupId).push(p);
  }

  const statsByGroup = new Map();
  for (const m of messages || []) {
    if (!m.groupId) continue;
    let s = statsByGroup.get(m.groupId);
    if (!s) { s = { lastAt: 0, lastBody: '', lastDirection: null, lastSenderName: null, lastInboundAt: 0, unread: 0 }; statsByGroup.set(m.groupId, s); }
    const at = m.createdAt || 0;
    if (at >= s.lastAt) {
      s.lastAt = at;
      s.lastBody = m.templateName && !m.body ? `Plantilla · ${m.templateName}` : (m.body || '');
      s.lastDirection = m.direction;
      s.lastSenderName = m.direction === 'in' ? (m.profileName || null) : null;
    }
    if (m.direction === 'in') {
      if (at > s.lastInboundAt) s.lastInboundAt = at;
      if (!m.readAt) s.unread += 1;
    }
  }

  const q = needle.trim().toLowerCase();
  const out = [];
  for (const g of groups || []) {
    if (!includeArchived && g.status === 'archived') continue;
    if (q && !String(g.subject || '').toLowerCase().includes(q)) continue;
    const active = (partsByGroup.get(g.id) || []).filter((p) => !p.leftAt);
    const s = statsByGroup.get(g.id) || {};
    out.push({
      id: g.id,
      key: groupKey(g.id),
      subject: g.subject || 'Grupo',
      description: g.description || '',
      inviteLink: g.inviteLink || '',
      status: g.status || 'active',
      isAdmin: !!g.isAdmin,
      iconPath: g.iconPath || null,
      participantCount: active.length || g.participantCount || 0,
      participants: sortParticipants(active).map((p) => ({
        id: p.id, phone: p.phone, name: p.name || displayPhone(p.phone), role: p.role || 'member', joinedAt: p.joinedAt || null,
      })),
      lastAt: s.lastAt || g.updatedAt || g.createdAt || 0,
      lastBody: s.lastBody || '',
      lastDirection: s.lastDirection || null,
      lastSenderName: s.lastSenderName || null,
      unread: s.unread || 0,
      windowOpen: !!s.lastInboundAt && now - s.lastInboundAt < WA_WINDOW_MS,
    });
  }
  out.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  return out;
}

/** The active roster of one group (admins first), for the thread/manage view. */
export function resolveGroupParticipants(participants, groupId) {
  const active = (participants || []).filter((p) => p.groupId === groupId && !p.leftAt);
  return sortParticipants(active).map((p) => ({
    id: p.id,
    phone: p.phone,
    name: p.name || displayPhone(p.phone),
    role: p.role || 'member',
    joinedAt: p.joinedAt || null,
  }));
}

/**
 * Selectable groups for a Difusión campaign — active groups only, searchable.
 *
 *   resolveGroupAudience(groups, { needle })
 *     → [{ id, key, subject, participantCount }]
 */
export function resolveGroupAudience(groups, { needle = '' } = {}) {
  const q = needle.trim().toLowerCase();
  return (groups || [])
    .filter((g) => g.status !== 'archived')
    .filter((g) => !q || String(g.subject || '').toLowerCase().includes(q))
    .map((g) => ({ id: g.id, key: groupKey(g.id), subject: g.subject || 'Grupo', participantCount: g.participantCount ?? null }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

/** A template variable's value for a GROUP recipient. Groups have no
 *  person/company, so every name-ish source resolves to the subject; 'fixed'
 *  is the shared text. Never empty (Meta rejects blank {{n}}). */
function groupVarValue(group, spec) {
  if (spec?.source === 'fixed') return String(spec.text || '').trim() || '—';
  return String(group?.subject || '').trim() || '—';
}

/**
 * Selected groups + per-variable specs → the wa-send broadcast recipients,
 * one message per group (recipient_type 'group' on the server). Deduped by
 * group id.
 *
 *   buildGroupBroadcastRecipients(groups, varSpecs)
 *     → [{ groupId, subject, params }]
 */
export function buildGroupBroadcastRecipients(groups, varSpecs = []) {
  const seen = new Set();
  const out = [];
  for (const g of groups || []) {
    if (!g?.id || seen.has(g.id)) continue;
    seen.add(g.id);
    out.push({
      groupId: g.id,
      subject: g.subject || 'Grupo',
      params: (varSpecs || []).map((spec) => groupVarValue(g, spec)),
    });
  }
  return out;
}
