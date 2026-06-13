/**
 * Instagram Studio ViewModel — pure projection of the meta-social `igStudio`
 * payload into exactly what the studio renders: audience demographics
 * (gender/age/country/city), a content-performance grid, a best-time-to-post
 * heatmap derived from post timestamps × engagement, account KPIs, stories and
 * mentions. The Graph API returns numbers as strings, ISO timestamps with a
 * `+0000` offset, and a nested total_value/breakdown shape for demographics —
 * all of that normalizing lives HERE, never in the View.
 */
import { agoLabel } from './board.js';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** IG timestamp ("2026-06-10T14:23:01+0000") or ms → JS ms, or null. */
function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// Dominican Republic is UTC-4 year-round (no DST) — shift then read UTC parts
// so a post's local weekday/hour is deterministic and test-stable.
const DO_OFFSET_MS = 4 * 3_600_000;
function doParts(ms) {
  const d = new Date(ms - DO_OFFSET_MS);
  return { day: d.getUTCDay(), hour: d.getUTCHours() };
}

/** Daily values of one metric from an insights `data` array. */
const metricValues = (insights, name) =>
  ((insights || []).find((m) => m.name === name)?.values || []).map((v) => num(v.value));

/** The total_value of a metric_type=total_value insights call. */
const totalValue = (insights, name) => {
  const m = (insights || []).find((x) => x.name === name);
  return m?.total_value ? num(m.total_value.value) : null;
};

/** Pull the breakdown results [{ dimension_values:[key], value }] out of a
 *  follower_demographics total_value payload. */
function demoResults(insightsData) {
  const tv = (insightsData || [])[0]?.total_value;
  const results = tv?.breakdowns?.[0]?.results || [];
  return results
    .map((r) => ({ key: String(r.dimension_values?.[0] ?? ''), value: num(r.value) }))
    .filter((r) => r.key);
}

const GENDER = { F: 'Mujeres', M: 'Hombres', U: 'Otro' };
const GENDER_COLOR = { F: '#c96a2a', M: '#3b3830', U: 'rgb(var(--ink-300))' };
const AGE_ORDER = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'];
// A small name map for the countries a DR furniture dealer actually sees;
// anything else just shows its ISO code (honest, not blank).
const COUNTRY_NAMES = {
  DO: 'Rep. Dominicana', US: 'Estados Unidos', ES: 'España', MX: 'México',
  CO: 'Colombia', VE: 'Venezuela', PR: 'Puerto Rico', HT: 'Haití', CA: 'Canadá',
  FR: 'Francia', IT: 'Italia', PA: 'Panamá', AR: 'Argentina', CL: 'Chile',
  PE: 'Perú', BR: 'Brasil', DE: 'Alemania', GB: 'Reino Unido', CH: 'Suiza',
};

/** Sort by value desc, attach a share %, keep the top N. */
function ranked(rows, topN) {
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  return [...rows]
    .sort((a, b) => b.value - a.value)
    .slice(0, topN)
    .map((r) => ({ ...r, pct: Math.round((r.value / total) * 100) }));
}

/** One media row → the grid item shape the View renders (post or mention). */
function mediaItem(m, now) {
  const at = toMs(m.timestamp);
  const isReel = String(m.media_product_type || '').toUpperCase() === 'REELS';
  const likes = num(m.like_count);
  const comments = num(m.comments_count);
  return {
    id: m.id || null,
    caption: (m.caption || '').trim(),
    excerpt: (m.caption || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    type: m.media_type || 'IMAGE',
    productType: m.media_product_type || '',
    isReel,
    isVideo: isReel || String(m.media_type || '').toUpperCase() === 'VIDEO',
    url: m.media_url || null,
    thumb: m.thumbnail_url || m.media_url || null,
    permalink: m.permalink || null,
    username: m.username || '',
    at,
    ago: agoLabel(at, now),
    likes,
    comments,
    engagement: likes + comments,
  };
}

/**
 * Best-time-to-post heatmap: bucket the account's own posts by DR-local
 * weekday × hour, weighted by engagement (likes + comments). Returns a dense
 * 7×24 matrix of normalized intensities plus the single peak cell — the View
 * just paints opacity from `norm`.
 */
function bestTimes(grid) {
  const cells = Array.from({ length: 7 }, (_, day) => Array.from({ length: 24 }, (_, hour) => ({ day, hour, count: 0, engagement: 0 })));
  for (const p of grid) {
    if (!p.at) continue;
    const { day, hour } = doParts(p.at);
    const cell = cells[day][hour];
    cell.count += 1;
    cell.engagement += p.engagement;
  }
  let peak = null;
  let max = 0;
  for (const row of cells) {
    for (const c of row) {
      if (c.engagement > max) { max = c.engagement; peak = c; }
    }
  }
  const flat = cells.flat().map((c) => ({ ...c, norm: max > 0 ? c.engagement / max : 0 }));
  const DAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  return {
    cells: flat,
    hasData: max > 0,
    peak: peak ? { day: peak.day, hour: peak.hour, label: `${DAY_LABELS[peak.day]} ${String(peak.hour).padStart(2, '0')}:00`, engagement: peak.engagement } : null,
    dayLabels: DAY_LABELS,
  };
}

export function resolveIgStudio(payload, { now = Date.now() } = {}) {
  const s = payload || {};
  const p = s.profile || {};

  const followers = num(p.followers_count);
  const reachSeries = metricValues(s.reach, 'reach');
  const reach28 = reachSeries.reduce((a, b) => a + b, 0);
  const engaged28 = totalValue(s.accountTotals, 'accounts_engaged');
  const interactions28 = totalValue(s.accountTotals, 'total_interactions');
  const reachTotal28 = totalValue(s.accountTotals, 'reach');
  const profileViews28 = totalValue(s.profileViews, 'profile_views');

  const d = s.demographics || {};
  const genderRows = demoResults(d.gender).map((r) => ({
    key: r.key, label: GENDER[r.key] || r.key, value: r.value, color: GENDER_COLOR[r.key] || GENDER_COLOR.U,
  }));
  const ageRows = demoResults(d.age)
    .sort((a, b) => AGE_ORDER.indexOf(a.key) - AGE_ORDER.indexOf(b.key))
    .map((r) => ({ label: r.key, value: r.value }));
  const ageTotal = ageRows.reduce((s2, r) => s2 + r.value, 0) || 1;
  const age = ageRows.map((r) => ({ ...r, pct: Math.round((r.value / ageTotal) * 100) }));
  const topCountries = ranked(demoResults(d.country).map((r) => ({ label: COUNTRY_NAMES[r.key] || r.key, value: r.value })), 6);
  const topCities = ranked(demoResults(d.city).map((r) => ({ label: r.key, value: r.value })), 6);
  const genderTotal = genderRows.reduce((s2, r) => s2 + r.value, 0);
  const audienceHasData = !!(genderRows.length || age.length || topCountries.length || topCities.length);

  const grid = (s.media || []).map((m) => mediaItem(m, now));
  const stories = (s.stories || []).map((m) => {
    const at = toMs(m.timestamp);
    return {
      id: m.id || null,
      type: m.media_type || 'IMAGE',
      isVideo: String(m.media_type || '').toUpperCase() === 'VIDEO',
      url: m.media_url || null,
      thumb: m.thumbnail_url || m.media_url || null,
      permalink: m.permalink || null,
      at,
      ago: agoLabel(at, now),
    };
  });
  const mentions = (s.mentions || []).map((m) => mediaItem(m, now));

  // Top posts by engagement — the leaderboard beside the chronological grid.
  const topPosts = [...grid].sort((a, b) => b.engagement - a.engagement).slice(0, 3);

  return {
    fetchedAt: s.fetchedAt || null,
    profile: {
      username: p.username || s.igUsername || '',
      name: p.name || '',
      biography: p.biography || '',
      followers,
      follows: num(p.follows_count),
      mediaCount: num(p.media_count),
      avatarUrl: p.profile_picture_url || null,
    },
    kpis: {
      reach28: reachTotal28 != null ? reachTotal28 : reach28,
      engaged28,
      interactions28,
      profileViews28,
      // Engagement rate: interactions over reach (the honest denominator —
      // null when reach is unknown rather than dividing by followers).
      engagementRatePct: (interactions28 != null && reachTotal28) ? (interactions28 / reachTotal28) * 100 : null,
    },
    reachSeries,
    audience: {
      gender: ranked(genderRows, 3).map((g) => ({ ...g, label: g.label, color: g.color })),
      genderTotal,
      age,
      topCountries,
      topCities,
      hasData: audienceHasData,
    },
    grid,
    topPosts,
    stories,
    mentions,
    bestTimes: bestTimes(grid),
    errors: s.errors || {},
  };
}

const INSIGHT_LABELS = {
  reach: 'Alcance',
  views: 'Reproducciones',
  total_interactions: 'Interacciones',
  saved: 'Guardados',
  shares: 'Compartidos',
};
const INSIGHT_ORDER = ['reach', 'views', 'total_interactions', 'saved', 'shares'];

/** Per-post insight map → an ordered, labeled list for the drill-down panel. */
export function resolveMediaInsights(metrics) {
  const m = metrics || {};
  return INSIGHT_ORDER
    .filter((k) => m[k] != null)
    .map((k) => ({ key: k, label: INSIGHT_LABELS[k] || k, value: num(m[k]) }));
}

/** A post's comment thread → moderation rows (newest first, hidden flagged). */
export function resolveMediaComments(comments, { now = Date.now() } = {}) {
  return (comments || [])
    .map((c) => ({
      id: c.id || null,
      text: (c.text || '').trim(),
      username: c.username || '',
      likes: num(c.like_count),
      hidden: !!c.hidden,
      at: toMs(c.timestamp),
      ago: agoLabel(toMs(c.timestamp), now),
      replyCount: ((c.replies?.data) || []).length,
    }))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}

/** Hashtag-search payload → a discovery grid (same item shape as the feed). */
export function resolveHashtagMedia(payload, { now = Date.now() } = {}) {
  const s = payload || {};
  return {
    name: s.hashtag?.name || '',
    media: (s.media || [])
      .map((m) => mediaItem(m, now))
      .sort((a, b) => b.engagement - a.engagement),
  };
}
