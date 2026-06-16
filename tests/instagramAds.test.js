/**
 * Tests for src/lib/instagramAds.js — the Ads Manager Model.
 *
 * Pins the invariants the in-app manager must never get wrong, because they
 * move real money and Meta's API is asymmetric about units:
 *   - BUDGETS / account balances are MINOR units (cents) → shown as major;
 *     INSIGHT spend/cpc/cpm are already MAJOR units → shown as-is. A regression
 *     either way is a 100× error on what the dealer is spending.
 *   - zero-decimal currencies (JPY…) divide by 1, not 100;
 *   - CTR/CPC/CPM derive only when the denominator is > 0 (never NaN/∞);
 *   - the result figure is the FIRST present action type, by dealer priority,
 *     never summed across kinds;
 *   - effective_status maps to the right tone so "rejected"/"in review" show.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  minorToMajor,
  majorToMinor,
  currencyMinorUnits,
  parseInsights,
  parseCampaign,
  parseAdSet,
  parseAccount,
  statusInfo,
  isActiveStatus,
  summarizeTargeting,
  buildTargeting,
  objectiveLabel,
} from '../src/lib/instagramAds.js';

test('minor↔major: USD/DOP use cents, zero-decimal currencies do not', () => {
  assert.equal(currencyMinorUnits('USD'), 100);
  assert.equal(currencyMinorUnits('DOP'), 100);
  assert.equal(currencyMinorUnits('JPY'), 1);
  // 2500 cents = $25.00; round-trips back to the cents string.
  assert.equal(minorToMajor(2500, 'USD'), 25);
  assert.equal(majorToMinor(25, 'USD'), '2500');
  assert.equal(majorToMinor(12.34, 'DOP'), '1234');
  // Yen: the integer already IS the major amount.
  assert.equal(minorToMajor(2500, 'JPY'), 2500);
  assert.equal(majorToMinor(2500, 'JPY'), '2500');
  // null budget stays null (not 0) so "no budget set" reads honestly.
  assert.equal(minorToMajor(null, 'USD'), null);
  assert.equal(minorToMajor('', 'USD'), null);
});

test('parseInsights: spend stays MAJOR; CTR/CPC/CPM derive guarded', () => {
  const ins = parseInsights({ data: [{
    spend: '40.00', impressions: '1000', clicks: '50', reach: '800',
    actions: [{ action_type: 'link_click', value: '50' }],
  }] });
  assert.equal(ins.spend, 40);             // major, NOT 4000
  assert.equal(ins.ctr, 5);                // 50/1000 * 100
  assert.equal(ins.cpc, 0.8);              // 40/50
  assert.equal(ins.cpm, 40);               // 40/1000 * 1000
  assert.equal(ins.results, 50);
  assert.equal(ins.resultLabel, 'clics');
  assert.equal(ins.costPerResult, 0.8);
});

test('parseInsights: zero denominators never produce NaN/Infinity', () => {
  const ins = parseInsights({ data: [{ spend: '10', impressions: '0', clicks: '0', reach: '0' }] });
  assert.equal(ins.ctr, null);
  assert.equal(ins.cpc, null);
  assert.equal(ins.cpm, null);
  assert.equal(ins.results, null);
  assert.equal(ins.costPerResult, null);
  assert.equal(ins.hasData, true);         // spend alone still counts as data
  assert.equal(parseInsights(null).hasData, false);
});

test('parseInsights: result is the FIRST priority action present, not a sum', () => {
  // conversations outrank leads outrank clicks — only the winner is counted.
  const ins = parseInsights({ data: [{
    spend: '30',
    actions: [
      { action_type: 'link_click', value: '99' },
      { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '3' },
    ],
  }] });
  assert.equal(ins.results, 3);
  assert.equal(ins.resultLabel, 'conversaciones');
  assert.equal(ins.costPerResult, 10);     // 30 / 3, not 30/102
});

test('parseCampaign: daily/lifetime budgets convert cents→major; insights nest', () => {
  const c = parseCampaign({
    id: '120', name: 'Verano', status: 'ACTIVE', effective_status: 'ACTIVE',
    objective: 'OUTCOME_ENGAGEMENT', daily_budget: '1500', budget_remaining: '900',
    insights: { data: [{ spend: '6.00', clicks: '12', impressions: '2000' }] },
  }, 'USD');
  assert.equal(c.dailyBudget, 15);         // 1500 cents
  assert.equal(c.lifetimeBudget, null);
  assert.equal(c.budgetRemaining, 9);
  assert.equal(c.insights.spend, 6);
  assert.equal(c.insights.cpc, 0.5);
  assert.equal(c.objective, 'OUTCOME_ENGAGEMENT');
  // The node carries its own account currency — the board aggregates ads from
  // several accounts, which may bill in different currencies.
  assert.equal(c.currency, 'USD');
});

test('parseAdSet: lifetime budget + targeting summary', () => {
  const a = parseAdSet({
    id: '6', name: 'DR 25-44', campaign_id: '120', status: 'PAUSED', effective_status: 'PAUSED',
    lifetime_budget: '5000', optimization_goal: 'REACH', billing_event: 'IMPRESSIONS',
    targeting: {
      geo_locations: { countries: ['DO'] }, age_min: 25, age_max: 44, genders: [2],
      flexible_spec: [{ interests: [{ id: '1', name: 'Diseño de interiores' }] }],
    },
    insights: { data: [{ spend: '12' }] },
  }, 'USD');
  assert.equal(a.lifetimeBudget, 50);
  assert.equal(a.dailyBudget, null);
  assert.match(a.targetingSummary, /DO/);
  assert.match(a.targetingSummary, /25–44/);
  assert.match(a.targetingSummary, /Mujeres/);
  assert.match(a.targetingSummary, /interés|intereses/);
});

test('parseAccount: amount_spent/balance/spend_cap convert; status flags', () => {
  const acc = parseAccount({ id: 'act_1', name: 'Tienda', currency: 'DOP', amount_spent: '125000', balance: '0', spend_cap: '0', account_status: 1 }, null);
  assert.equal(acc.amountSpent, 1250);     // 125000 cents = 1,250.00
  assert.equal(acc.balance, 0);
  assert.equal(acc.spendCap, null);        // 0 cap means "no cap" → null
  assert.equal(acc.currency, 'DOP');
  assert.equal(acc.disabled, false);
  assert.equal(parseAccount(null), null);
});

test('statusInfo: effective_status drives label + tone (issues surface)', () => {
  assert.equal(statusInfo('ACTIVE').tone, 'emerald');
  assert.equal(statusInfo('PAUSED').tone, 'ink');
  assert.equal(statusInfo('DISAPPROVED').tone, 'red');
  assert.equal(statusInfo('PENDING_REVIEW').tone, 'amber');
  assert.equal(statusInfo('WITH_ISSUES').tone, 'amber');
  assert.equal(isActiveStatus('ACTIVE'), true);
  assert.equal(isActiveStatus('PAUSED'), false);
});

test('buildTargeting ↔ summarizeTargeting roundtrip', () => {
  const t = buildTargeting({ countries: ['DO'], ageMin: 30, ageMax: 50, genders: [2], interests: [{ id: '9', name: 'Hogar' }] });
  assert.deepEqual(t.geo_locations.countries, ['DO']);
  assert.equal(t.age_min, 30);
  assert.equal(t.age_max, 50);
  assert.deepEqual(t.genders, [2]);
  assert.deepEqual(t.publisher_platforms, ['instagram']);
  const s = summarizeTargeting(t);
  assert.match(s, /30–50/);
  assert.match(s, /Mujeres/);
  // "Todos" (no gender) omits the gender chip rather than printing both.
  const all = buildTargeting({ genders: [] });
  assert.equal(all.genders, undefined);
});

test('objectiveLabel maps both wizard and externally-created objectives', () => {
  assert.equal(objectiveLabel('OUTCOME_ENGAGEMENT'), 'Interacción');
  assert.equal(objectiveLabel('OUTCOME_LEADS'), 'Clientes potenciales');
  assert.equal(objectiveLabel('OUTCOME_SALES'), 'Ventas');
});
