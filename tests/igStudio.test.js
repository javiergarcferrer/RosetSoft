/**
 * Tests for src/core/jarvis/igStudio.js — the Instagram Studio VM.
 *
 * Pins the data-shape normalizing the Graph API forces on us: demographics
 * arrive as a nested total_value/breakdown object, numbers come as strings,
 * timestamps carry a +0000 offset, and the best-time heatmap must bucket posts
 * in DR-local time (UTC-4, no DST) or the peak hour shifts a day.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveIgStudio, resolveMediaInsights, resolveMediaComments, resolveHashtagMedia,
} from '../src/core/jarvis/igStudio.js';

const NOW = Date.parse('2026-06-13T18:00:00Z');

// A follower_demographics total_value payload for one breakdown dimension.
const demo = (results) => [{ name: 'follower_demographics', total_value: { breakdowns: [{ results }] } }];

test('demographics: gender maps + ranks; age sorts by bracket; countries top-N with %', () => {
  const { audience } = resolveIgStudio({
    demographics: {
      gender: demo([
        { dimension_values: ['M'], value: 400 },
        { dimension_values: ['F'], value: 600 },
      ]),
      age: demo([
        { dimension_values: ['35-44'], value: 30 },
        { dimension_values: ['18-24'], value: 50 },
        { dimension_values: ['25-34'], value: 120 },
      ]),
      country: demo([
        { dimension_values: ['US'], value: 80 },
        { dimension_values: ['DO'], value: 320 },
        { dimension_values: ['ZZ'], value: 10 },
      ]),
    },
  }, { now: NOW });
  // Gender ranked by value desc, mapped to Spanish labels with colors.
  assert.deepEqual(audience.gender.map((g) => g.label), ['Mujeres', 'Hombres']);
  assert.equal(audience.gender[0].value, 600);
  // Age sorted into bracket order, each with a share %.
  assert.deepEqual(audience.age.map((a) => a.label), ['18-24', '25-34', '35-44']);
  assert.equal(audience.age.find((a) => a.label === '25-34').pct, 60); // 120/200
  // Country names mapped where known; unknown code passes through; % attached.
  assert.equal(audience.topCountries[0].label, 'Rep. Dominicana');
  assert.equal(audience.topCountries[0].pct, 78); // 320/410
  assert.equal(audience.topCountries.find((c) => c.label === 'ZZ').label, 'ZZ');
  assert.equal(audience.hasData, true);
});

test('no demographics → audience.hasData false, empty arrays (never crashes)', () => {
  const { audience } = resolveIgStudio({}, { now: NOW });
  assert.equal(audience.hasData, false);
  assert.deepEqual(audience.gender, []);
  assert.deepEqual(audience.topCities, []);
});

test('KPIs: views/engaged/interactions + profile taps; reach from the follow split', () => {
  const { kpis, reachSeries } = resolveIgStudio({
    accountTotals: [
      { name: 'views', total_value: { value: 9000 } },
      { name: 'accounts_engaged', total_value: { value: 800 } },
      { name: 'total_interactions', total_value: { value: 1500 } },
    ],
    profileTaps: [{ name: 'profile_links_taps', total_value: { value: 120 } }],
    reachByFollow: [{ name: 'reach', total_value: { breakdowns: [{ results: [
      { dimension_values: ['FOLLOWER'], value: 4000 },
      { dimension_values: ['NON_FOLLOWER'], value: 900 },
      { dimension_values: ['UNKNOWN'], value: 100 },
    ] }] } }],
    reach: [{ name: 'reach', values: [{ value: '100' }, { value: '200' }, { value: '50' }] }],
  }, { now: NOW });
  assert.equal(kpis.views28, 9000);
  assert.equal(kpis.engaged28, 800);
  assert.equal(kpis.interactions28, 1500);
  assert.equal(kpis.profileTaps28, 120);
  assert.equal(kpis.reach28, 5000); // 4000 + 900 + 100
  assert.equal(kpis.followerReach, 4000);
  assert.equal(kpis.nonFollowerReach, 1000); // non-follower + unknown
  assert.equal(kpis.followerReachPct, 80); // 4000 / 5000
  assert.ok(Math.abs(kpis.engagementRatePct - 30) < 1e-9); // 1500 / 5000
  assert.deepEqual(reachSeries, [100, 200, 50]);
});

test('reach falls back to the daily series sum when the follow split is absent', () => {
  const { kpis } = resolveIgStudio({ reach: [{ name: 'reach', values: [{ value: 100 }, { value: 200 }] }] }, { now: NOW });
  assert.equal(kpis.reach28, 300);
  assert.equal(kpis.hasReachSplit, false);
});

test('publish quota → used / total / remaining', () => {
  const { publishLimit } = resolveIgStudio({
    publishLimit: [{ quota_usage: 12, config: { quota_total: 50, quota_duration: 86400 } }],
  }, { now: NOW });
  assert.deepEqual(publishLimit, { used: 12, total: 50, remaining: 38 });
});

test('heatmap also folds into 7×6 four-hour buckets for mobile', () => {
  // DR-local Friday 22:00 → day 5, hour 22 → bucket 5 (20–24).
  const { bestTimes } = resolveIgStudio({ media: [{ id: 'x', like_count: '40', comments_count: '0', timestamp: '2026-06-13T02:00:00+0000' }] }, { now: NOW });
  assert.equal(bestTimes.buckets.length, 42); // 7 × 6
  assert.equal(bestTimes.bucketLabels.length, 6);
  const b = bestTimes.buckets.find((x) => x.day === 5 && x.bucket === 5);
  assert.equal(b.engagement, 40);
  assert.equal(b.norm, 1);
});

test('reel watch time (ms) surfaces as seconds with a unit', () => {
  const rows = resolveMediaInsights({ reach: 100, ig_reels_avg_watch_time: 8200 });
  const wt = rows.find((r) => r.key === 'ig_reels_avg_watch_time');
  assert.equal(wt.value, 8); // 8200 ms → 8 s
  assert.equal(wt.unit, 's');
});

test('content grid normalizes string counts, marks reels, builds top-3 by engagement', () => {
  const media = [
    { id: 'a', media_type: 'IMAGE', like_count: '10', comments_count: '2', timestamp: '2026-06-10T12:00:00+0000', caption: 'Sala' },
    { id: 'b', media_type: 'VIDEO', media_product_type: 'REELS', like_count: '100', comments_count: '20', timestamp: '2026-06-11T12:00:00+0000', thumbnail_url: 't.jpg', media_url: 'v.mp4' },
    { id: 'c', media_type: 'IMAGE', like_count: '5', comments_count: '0', timestamp: '2026-06-09T12:00:00+0000' },
  ];
  const { grid, topPosts } = resolveIgStudio({ media }, { now: NOW });
  assert.equal(grid.length, 3);
  const reel = grid.find((g) => g.id === 'b');
  assert.equal(reel.isReel, true);
  assert.equal(reel.engagement, 120);
  assert.equal(reel.thumb, 't.jpg'); // video → poster thumbnail
  assert.deepEqual(topPosts.map((p) => p.id), ['b', 'a', 'c']); // by engagement desc
});

test('best-time heatmap buckets in DR-local time (UTC-4), not UTC', () => {
  // 2026-06-13T02:00Z is a Saturday 02:00 UTC → DR-local Friday 22:00.
  const media = [
    { id: 'x', like_count: '10', comments_count: '0', timestamp: '2026-06-13T02:00:00+0000' },
    { id: 'y', like_count: '40', comments_count: '0', timestamp: '2026-06-13T02:00:00+0000' },
  ];
  const { bestTimes } = resolveIgStudio({ media }, { now: NOW });
  assert.equal(bestTimes.hasData, true);
  assert.equal(bestTimes.peak.day, 5); // Friday (UTC would say Saturday=6)
  assert.equal(bestTimes.peak.hour, 22);
  assert.equal(bestTimes.peak.label, 'Vie 22:00');
  // The peak cell carries norm 1; an empty cell carries norm 0.
  const peakCell = bestTimes.cells.find((c) => c.day === 5 && c.hour === 22);
  assert.equal(peakCell.norm, 1);
  assert.equal(peakCell.engagement, 50);
});

test('resolveMediaInsights orders + labels the present metrics only', () => {
  const rows = resolveMediaInsights({ reach: 900, saved: 12, total_interactions: 80, shares: 4 });
  assert.deepEqual(rows.map((r) => r.key), ['reach', 'total_interactions', 'saved', 'shares']);
  assert.equal(rows[0].label, 'Alcance');
  assert.equal(rows.find((r) => r.key === 'saved').value, 12);
});

test('resolveMediaComments flags hidden, counts replies, newest first', () => {
  const rows = resolveMediaComments([
    { id: '1', text: 'older', username: 'ana', timestamp: '2026-06-10T10:00:00+0000', hidden: true },
    { id: '2', text: 'newer', username: 'luis', timestamp: '2026-06-12T10:00:00+0000', replies: { data: [{ id: 'r1' }] } },
  ], { now: NOW });
  assert.equal(rows[0].id, '2');
  assert.equal(rows[0].replyCount, 1);
  assert.equal(rows[1].hidden, true);
});

test('resolveHashtagMedia sorts discovery results by engagement', () => {
  const { name, media } = resolveHashtagMedia({
    hashtag: { name: 'lignerosetdr' },
    media: [
      { id: 'a', like_count: '5', comments_count: '1' },
      { id: 'b', like_count: '50', comments_count: '5' },
    ],
  }, { now: NOW });
  assert.equal(name, 'lignerosetdr');
  assert.deepEqual(media.map((m) => m.id), ['b', 'a']);
});
