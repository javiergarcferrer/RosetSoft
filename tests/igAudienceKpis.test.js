/**
 * Tests for resolveAudienceKpis (src/core/jarvis/igStudio.js) — the derived
 * business-intelligence layer over the resolved Studio object. Pins the KPI
 * formulas (engagement rate by reach/followers, reach rate, discovery,
 * content-format split, audience concentration) and the divide-by-zero guards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAudienceKpis } from '../src/core/jarvis/igStudio.js';

function studio(over = {}) {
  return {
    profile: { followers: 10000 },
    kpis: {
      reach28: 5000,
      views28: 8000,
      interactions28: 300,
      followerReach: 3000,
      nonFollowerReach: 2000,
      hasReachSplit: true,
      ...(over.kpis || {}),
    },
    audience: {
      topCountries: [
        { label: 'Rep. Dominicana', value: 700 },
        { label: 'Estados Unidos', value: 200 },
        { label: 'España', value: 60 },
        { label: 'México', value: 40 },
      ],
      age: [
        { label: '25-34', value: 500, pct: 50 },
        { label: '35-44', value: 300, pct: 30 },
        { label: '18-24', value: 200, pct: 20 },
      ],
      ...(over.audience || {}),
    },
    grid: over.grid || [
      { isReel: true, engagement: 100 },
      { isReel: true, engagement: 200 },
      { isReel: false, engagement: 20 },
      { isReel: false, engagement: 40 },
    ],
  };
}

test('engagement rate by reach and by followers use the right denominators', () => {
  const k = resolveAudienceKpis(studio());
  // 300 / 5000 × 100 = 6% by reach
  assert.equal(Math.round(k.engagementRateByReachPct * 100) / 100, 6);
  // 300 / 10000 × 100 = 3% by followers
  assert.equal(Math.round(k.engagementRateByFollowersPct * 100) / 100, 3);
});

test('reach rate = reach / followers', () => {
  const k = resolveAudienceKpis(studio());
  assert.equal(k.reachRatePct, 50); // 5000 / 10000
});

test('discovery = non-follower reach share of total reach', () => {
  const k = resolveAudienceKpis(studio());
  assert.equal(k.discoveryPct, 40); // 2000 / 5000
});

test('viewsPerReach captures repeat exposure', () => {
  const k = resolveAudienceKpis(studio());
  assert.equal(k.viewsPerReach, 1.6); // 8000 / 5000
});

test('engagement benchmark bands the by-followers rate', () => {
  assert.equal(resolveAudienceKpis(studio({ kpis: { interactions28: 300 } })).engagementBenchmark.band, 'exceptional'); // 3%
  assert.equal(resolveAudienceKpis(studio({ kpis: { interactions28: 150 } })).engagementBenchmark.band, 'strong');      // 1.5%
  assert.equal(resolveAudienceKpis(studio({ kpis: { interactions28: 50 } })).engagementBenchmark.band, 'average');      // 0.5%
  assert.equal(resolveAudienceKpis(studio({ kpis: { interactions28: 20 } })).engagementBenchmark.band, 'low');          // 0.2%
});

test('content performance splits Reels vs feed posts by avg engagement', () => {
  const k = resolveAudienceKpis(studio());
  const reels = k.contentPerformance.find((c) => c.type === 'Reels');
  const posts = k.contentPerformance.find((c) => c.type === 'Publicaciones');
  assert.equal(reels.posts, 2);
  assert.equal(reels.avgEngagement, 150); // (100+200)/2
  assert.equal(posts.avgEngagement, 30);  // (20+40)/2
  assert.equal(k.bestFormat, 'Reels');
});

test('audience concentration: top country, top-3 share, home market, dominant age', () => {
  const k = resolveAudienceKpis(studio());
  // total across the 4 shown = 1000; DO = 700
  assert.equal(k.audienceConcentration.topCountry.label, 'Rep. Dominicana');
  assert.equal(k.audienceConcentration.topCountry.pct, 70);
  assert.equal(k.audienceConcentration.homeMarketPct, 70);
  assert.equal(k.audienceConcentration.top3CountryPct, 96); // (700+200+60)/1000
  assert.equal(k.audienceConcentration.dominantAge.label, '25-34');
});

test('missing follower-split → discovery is null, NOT "0%" (no lying from missing data)', () => {
  // resolveIgStudio coerces nonFollowerReach to a NUMBER (0) even when the
  // breakdown call errored; hasReachSplit is the honest signal. With reach
  // present but the split unknown, discovery must be null.
  const k = resolveAudienceKpis(studio({
    kpis: { reach28: 5000, nonFollowerReach: 0, followerReach: 0, hasReachSplit: false },
  }));
  assert.equal(k.discoveryPct, null);
});

test('discovery renders when the split IS known', () => {
  const k = resolveAudienceKpis(studio({
    kpis: { reach28: 5000, nonFollowerReach: 2000, followerReach: 3000, hasReachSplit: true },
  }));
  assert.equal(k.discoveryPct, 40);
});

test('missing views28 → viewsPerReach is null, NOT 0', () => {
  const k = resolveAudienceKpis(studio({ kpis: { reach28: 5000, views28: null } }));
  assert.equal(k.viewsPerReach, null);
});

test('all ratios guard divide-by-zero (return null, never NaN/Infinity)', () => {
  const k = resolveAudienceKpis({ profile: { followers: 0 }, kpis: { reach28: 0, views28: 0, interactions28: null }, audience: {}, grid: [] });
  assert.equal(k.engagementRateByFollowersPct, null);
  assert.equal(k.engagementRateByReachPct, null);
  assert.equal(k.reachRatePct, null);
  assert.equal(k.discoveryPct, null);
  assert.equal(k.viewsPerReach, null);
  assert.equal(k.engagementBenchmark.band, 'unknown');
  assert.equal(k.hasData, false);
});

test('empty/undefined input does not throw', () => {
  assert.doesNotThrow(() => resolveAudienceKpis(undefined));
  assert.doesNotThrow(() => resolveAudienceKpis({}));
});
