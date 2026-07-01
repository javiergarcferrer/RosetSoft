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
import { resolveSocialPulse, resolveAdsSalesWeeks, inLabel } from '../src/core/jarvis/social.js';

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

test('ad KPIs sum by DATE, not row position — paused ads report 0, not stale spend', () => {
  // The Marketing API omits no-delivery days. All delivery ended 14+ days ago:
  // the last 7 ROWS are weeks old, but "this week" spent nothing.
  const stale = Array.from({ length: 10 }, (_, i) => ({
    date_start: new Date(NOW - (23 - i) * DAY).toISOString().slice(0, 10), // 23..14 days ago
    spend: '100', clicks: '10', impressions: '1000',
  }));
  const { kpis } = resolveSocialPulse({ adsDaily: stale }, { now: NOW });
  assert.equal(kpis.spend7, 0);
  assert.equal(kpis.clicks7, 0);
  assert.equal(kpis.spend7Prev ?? 0, 0); // 8-14 days ago window: only the 14d row could touch it
  // …while the 28-day total still sees the historical spend.
  assert.equal(kpis.spend28, 1000);
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

test('IG audience: follower_count is a daily series; profile actions a total_value', () => {
  // follower_count stays the time_series shape; profile_views was removed in
  // v22, so profile actions come from profile_links_taps' total_value (one #).
  const igAudience = [
    { name: 'follower_count', values: [{ value: 2 }, { value: 3 }] },
  ];
  const igProfileActions = [
    { name: 'profile_links_taps', total_value: { value: 42 } },
  ];
  const { kpis, followerSeries } = resolveSocialPulse({ igAudience, igProfileActions }, { now: NOW });
  assert.equal(kpis.newFollowers7, 5);
  assert.equal(kpis.profileActions7, 42);
  assert.deepEqual(followerSeries, [2, 3]);
});

test('ads↔sales weeks bucket spend by LOCAL day next to quote counts', () => {
  // NOW is Wednesday 2026-06-10 local; current week starts Monday 06-08.
  const adsDaily = [
    { date_start: '2026-06-08', spend: '10' }, // Monday this week — if parsed
    // as UTC it would land Sunday 8 PM local and fall into the PREVIOUS week
    { date_start: '2026-06-09', spend: '15' },
    { date_start: '2026-06-01', spend: '40' }, // previous week
  ];
  const quotes = [
    { id: 'q1', createdAt: new Date(2026, 5, 9).getTime() },
    { id: 'q2', createdAt: new Date(2026, 5, 2).getTime(), acceptedAt: new Date(2026, 5, 3).getTime() },
  ];
  const wk = resolveAdsSalesWeeks({ adsDaily, quotes, now: NOW, weeks: 4 });
  assert.equal(wk.length, 4);
  const cur = wk[3];
  const prev = wk[2];
  assert.equal(cur.spend, 25); // 06-08 stays in THIS week (local parse)
  assert.equal(cur.created, 1);
  assert.equal(prev.spend, 40);
  assert.equal(prev.created, 1);
  assert.equal(prev.accepted, 1);
  assert.ok(cur.label.length > 0);
});

test('recent IG comments flatten across posts, newest first, capped at 8', () => {
  const igMedia = [
    {
      caption: 'Post A',
      media_type: 'IMAGE',
      comments: { data: [
        { text: 'older', username: 'ana', timestamp: new Date(NOW - 2 * DAY).toISOString() },
        { text: 'newest', username: 'luis', timestamp: new Date(NOW - 1000).toISOString() },
      ] },
    },
    { caption: 'Post B', comments: { data: Array.from({ length: 10 }, (_, i) => ({ text: `c${i}`, username: 'x', timestamp: new Date(NOW - (i + 3) * DAY).toISOString() })) } },
  ];
  const { recentComments } = resolveSocialPulse({ igMedia }, { now: NOW });
  assert.equal(recentComments.length, 8);
  assert.equal(recentComments[0].text, 'newest');
  assert.equal(recentComments[0].username, 'luis');
  assert.equal(recentComments[0].postText, 'Post A');
  assert.ok(recentComments[0].ago);
});

test('post + comment image: a VIDEO shows its thumbnail, a photo its media_url', () => {
  const igMedia = [
    {
      caption: 'Photo post', media_type: 'IMAGE',
      media_url: 'https://cdn/photo.jpg', thumbnail_url: 'https://cdn/photo-thumb.jpg',
      like_count: '5', comments_count: '1', timestamp: new Date(NOW - 1000).toISOString(),
      comments: { data: [{ id: 'k1', text: 'nice', username: 'ana', timestamp: new Date(NOW - 500).toISOString() }] },
    },
    {
      caption: 'Reel', media_type: 'VIDEO',
      media_url: 'https://cdn/reel.mp4', thumbnail_url: 'https://cdn/reel-thumb.jpg',
      timestamp: new Date(NOW - 2000).toISOString(),
    },
  ];
  const { posts, recentComments } = resolveSocialPulse({ igMedia }, { now: NOW });
  // photo serves straight from media_url; reel shows its thumbnail, never the mp4
  assert.equal(posts[0].mediaUrl, 'https://cdn/photo.jpg');
  assert.equal(posts[1].mediaUrl, 'https://cdn/reel-thumb.jpg');
  assert.equal(posts[0].caption, 'Photo post');
  // a comment carries the parent post's image so the View can pop it up
  assert.equal(recentComments[0].mediaUrl, 'https://cdn/photo.jpg');
  assert.equal(recentComments[0].postCaption, 'Photo post');
  // the post carries its nested comment thread for the full-view popup
  assert.equal(posts[0].commentList.length, 1);
  assert.equal(posts[0].commentList[0].username, 'ana');
  assert.equal(posts[0].commentList[0].id, 'k1');
  assert.ok(posts[0].commentList[0].ago);
  assert.deepEqual(posts[1].commentList, []);
});

test('campaigns map the campaigns-edge shape (id + status + nested insights)', () => {
  const adCampaigns = [
    {
      id: 'c2', name: 'Paused', effective_status: 'PAUSED',
      insights: { data: [{ spend: '10', clicks: '5', impressions: '100' }] },
    },
    {
      id: 'c1', name: 'Active', status: 'ACTIVE',
      insights: { data: [{ spend: '90', clicks: '30', impressions: '1000' }] },
    },
    // campaign created but never delivered — no insights at all
    { id: 'c3', name: 'New', status: 'PAUSED' },
  ];
  const { campaigns } = resolveSocialPulse({ adCampaigns }, { now: NOW });
  assert.deepEqual(campaigns.map((c) => c.name), ['Active', 'Paused', 'New']);
  assert.equal(campaigns[0].id, 'c1');
  assert.equal(campaigns[0].active, true);
  assert.equal(campaigns[1].active, false);
  assert.equal(campaigns[0].spend, 90);
  assert.equal(campaigns[2].spend, 0);
});

test('campaigns carry their own account currency (multi-account boards never misformat)', () => {
  // The snapshot concatenates campaigns from every ad account — Instagram
  // boosts often bill through a DIFFERENT account than the in-app wizard's, in
  // its own currency. Each row must keep that currency so the View never tags a
  // DOP boost's spend as the primary account's USD.
  const adCampaigns = [
    { id: 'c1', name: 'USD boost', status: 'ACTIVE', currency: 'USD', insights: { data: [{ spend: '10' }] } },
    { id: 'c2', name: 'DOP boost', status: 'PAUSED', currency: 'DOP', insights: { data: [{ spend: '500' }] } },
    { id: 'c3', name: 'Untagged', status: 'PAUSED' }, // no currency → null (View falls back to adCurrency)
  ];
  const { campaigns } = resolveSocialPulse({ adCampaigns }, { now: NOW });
  const byName = Object.fromEntries(campaigns.map((c) => [c.name, c.currency]));
  assert.equal(byName['USD boost'], 'USD');
  assert.equal(byName['DOP boost'], 'DOP');
  assert.equal(byName['Untagged'], null);
});

test('recent IG comments carry the id a reply needs', () => {
  const { recentComments } = resolveSocialPulse({
    igMedia: [{ caption: 'P', comments: { data: [{ id: 'c1', text: 'hola', username: 'ana', timestamp: new Date(NOW - 1000).toISOString() }] } }],
  }, { now: NOW });
  assert.equal(recentComments[0].id, 'c1'); // reply needs the id
});

test('inLabel covers minutes/hours/days and clamps the past to "ahora"', () => {
  assert.equal(inLabel(NOW + 30 * 60_000, NOW), 'en 30 min');
  assert.equal(inLabel(NOW - 1, NOW), 'ahora');
  assert.equal(inLabel(null, NOW), null);
});
