/**
 * Tests for src/core/jarvis/social.js — the Meta social pulse VM.
 *
 * Pins the ad-money math the panel shows (the Graph API returns numbers as
 * STRINGS — spend sums, CPC/CTR with division guards, honest week-over-week
 * deltas that go null with no comparison base) and the timestamp normalizing
 * (Meta mixes ISO strings and unix seconds).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSocialPulse, inLabel } from '../src/core/jarvis/social.js';

const NOW = Date.parse('2026-06-10T12:00:00Z');
const DAY = 86_400_000;

// 14 daily ad rows, oldest first: prev week $10/day, current week $20/day.
const adsDaily = Array.from({ length: 14 }, (_, i) => ({
  date_start: new Date(NOW - (13 - i) * DAY).toISOString().slice(0, 10),
  spend: String(i < 7 ? 10 : 20),
  clicks: String(i < 7 ? 5 : 10),
  impressions: String(1000),
}));

test('ad spend sums string values; deltas compare 7d vs previous 7d', () => {
  const { kpis, spendSeries } = resolveSocialPulse({ adsDaily }, { now: NOW });
  assert.equal(kpis.spend7, 140);
  assert.equal(kpis.spend28, 210);
  assert.equal(kpis.spendDeltaPct, 100); // 140 vs 70
  assert.equal(kpis.clicks7, 70);
  assert.equal(kpis.cpc7, 2); // 140 / 70
  assert.ok(Math.abs(kpis.ctr7Pct - 1) < 1e-9); // 70 / 7000
  assert.equal(spendSeries.length, 14);
});

test('division guards: no clicks → null CPC; no impressions → null CTR; no prev → null delta', () => {
  const { kpis, campaigns } = resolveSocialPulse({
    adsDaily: [{ date_start: '2026-06-10', spend: '50', clicks: '0', impressions: '0' }],
    adCampaigns: [{ campaign_name: 'X', spend: '50', clicks: '0', impressions: '0' }],
  }, { now: NOW });
  assert.equal(kpis.cpc7, null);
  assert.equal(kpis.ctr7Pct, null);
  assert.equal(kpis.spendDeltaPct, null);
  assert.equal(campaigns[0].cpc, null);
  assert.equal(campaigns[0].ctrPct, null);
});

test('IG reach series reads the insights metric rows; campaigns sort by spend', () => {
  const igReach = [{
    name: 'reach',
    values: Array.from({ length: 14 }, (_, i) => ({ value: i < 7 ? 100 : 300 })),
  }];
  const adCampaigns = [
    { campaign_name: 'B', spend: '5', clicks: '1', impressions: '100' },
    { campaign_name: 'A', spend: '50', clicks: '10', impressions: '1000' },
  ];
  const { kpis, campaigns } = resolveSocialPulse({ igReach, adCampaigns }, { now: NOW });
  assert.equal(kpis.reach7, 2100);
  assert.equal(kpis.reachDeltaPct, 200); // 2100 vs 700
  assert.deepEqual(campaigns.map((c) => c.name), ['A', 'B']);
});

test('ad results pick ONE action type by priority and never mix', () => {
  const rows = [{
    date_start: '2026-06-10',
    spend: '60',
    clicks: '30',
    impressions: '1000',
    actions: [
      { action_type: 'link_click', value: '30' },
      { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '12' },
    ],
  }];
  const { kpis, campaigns } = resolveSocialPulse({
    adsDaily: rows,
    adCampaigns: [{ campaign_name: 'C', spend: '60', clicks: '30', impressions: '1000', actions: rows[0].actions }],
  }, { now: NOW });
  // conversations outrank link clicks
  assert.equal(kpis.resultsLabel, 'conversaciones');
  assert.equal(kpis.results7, 12);
  assert.equal(kpis.costPerResult7, 5); // 60 / 12
  assert.equal(campaigns[0].results, 12);
});

test('no actions at all → null results label and no cost per result', () => {
  const { kpis } = resolveSocialPulse({
    adsDaily: [{ date_start: '2026-06-10', spend: '50', clicks: '0', impressions: '100' }],
  }, { now: NOW });
  assert.equal(kpis.resultsLabel, null);
  assert.equal(kpis.results7, 0);
  assert.equal(kpis.costPerResult7, null);
});

test('IG audience and Page insights series sum the right metric rows', () => {
  const igAudience = [
    { name: 'follower_count', values: [{ value: 2 }, { value: 3 }] },
    { name: 'profile_views', values: [{ value: 10 }, { value: 5 }] },
  ];
  const pageInsights = [
    { name: 'page_post_engagements', values: Array.from({ length: 14 }, (_, i) => ({ value: i < 7 ? 1 : 4 })) },
  ];
  const { kpis, followerSeries } = resolveSocialPulse({ igAudience, pageInsights }, { now: NOW });
  assert.equal(kpis.newFollowers7, 5);
  assert.equal(kpis.profileViews7, 15);
  assert.deepEqual(followerSeries, [2, 3]);
  assert.equal(kpis.pageEngagement7, 28);
  assert.equal(kpis.pageEngagementDeltaPct, 300); // 28 vs 7
});

test('scheduled posts: ISO and unix-second timestamps both parse; past drops; soonest first', () => {
  const { scheduled } = resolveSocialPulse({
    scheduled: [
      { message: 'far', scheduled_publish_time: new Date(NOW + 3 * DAY).toISOString() },
      { message: 'soon', scheduled_publish_time: String(Math.floor((NOW + 2 * 3_600_000) / 1000)) },
      { message: 'past', scheduled_publish_time: new Date(NOW - DAY).toISOString() },
    ],
  }, { now: NOW });
  assert.deepEqual(scheduled.map((p) => p.text), ['soon', 'far']);
  assert.equal(scheduled[0].inLabel, 'en 2 h');
  assert.equal(scheduled[1].inLabel, 'en 3 d');
});

test('inLabel covers minutes/hours/days and clamps the past to "ahora"', () => {
  assert.equal(inLabel(NOW + 30 * 60_000, NOW), 'en 30 min');
  assert.equal(inLabel(NOW - 1, NOW), 'ahora');
  assert.equal(inLabel(null, NOW), null);
});
