// Collections / cobranza ViewModel — rank the open customers for a dunning
// queue and surface who needs a reminder today. Pure: no React, no db.
import { round2 } from '../../lib/accounting/ledger.js';
import { planReminders, resolveDunningPolicy } from '../../lib/accounting/dunning.js';

const DAY = 86400000;

/**
 * The cobranza queue: one row per customer with an open balance, the reminders
 * due today (from planReminders), the last time we contacted them, and a
 * priority (balance × age) so the most-worth-chasing land on top.
 */
export function resolveCollectionsQueue({ receivables, reminders, policy, now } = {}) {
  const at = now || 0;
  const pol = resolveDunningPolicy(policy);
  const due = planReminders({ receivables, reminders, policy: pol, now: at });

  const dueByParty = new Map();
  for (const d of due) {
    if (!dueByParty.has(d.partyId)) dueByParty.set(d.partyId, []);
    dueByParty.get(d.partyId).push(d);
  }
  const lastByParty = new Map();
  for (const r of reminders || []) {
    const cur = lastByParty.get(r.customerId) || 0;
    if ((r.sentAt || 0) > cur) lastByParty.set(r.customerId, r.sentAt || 0);
  }

  const rows = (receivables?.rows || [])
    .filter((row) => row.balance > 0.001)
    .map((row) => {
      const openDocs = (row.docs || []).filter((d) => d.open > 0.001);
      const oldestDays = openDocs.reduce((mx, d) => {
        const dd = Math.floor((at - ((d.date || 0) + pol.netDays * DAY)) / DAY);
        return dd > mx ? dd : mx;
      }, 0);
      const dueList = dueByParty.get(row.partyId) || [];
      return {
        partyId: row.partyId,
        party: row.party || null,
        balance: round2(row.balance),
        buckets: row.buckets,
        oldestDays: Math.max(0, oldestDays),
        dueReminders: dueList,
        dueCount: dueList.length,
        lastSentAt: lastByParty.get(row.partyId) || null,
        priority: round2(row.balance) * (Math.max(0, oldestDays) + 1),
      };
    })
    .sort((a, b) => b.priority - a.priority);

  return {
    rows,
    count: rows.length,
    dueCount: rows.filter((r) => r.dueCount > 0).length,
    totalDue: round2(rows.reduce((s, r) => s + r.balance, 0)),
    policy: pol,
  };
}
