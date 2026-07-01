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

  // Mobile view: 24 hourly cells don't fit a phone, so fold into six 4-hour
  // blocks (7×6) — the data-viz guidance is to reduce density, not scroll.
  const BUCKET_LABELS = ['0–4', '4–8', '8–12', '12–16', '16–20', '20–24'];
  const buckets = Array.from({ length: 7 }, (_, day) => Array.from({ length: 6 }, (_, b) => {
    const engagement = cells[day].slice(b * 4, b * 4 + 4).reduce((s, c) => s + c.engagement, 0);
    const count = cells[day].slice(b * 4, b * 4 + 4).reduce((s, c) => s + c.count, 0);
    return { day, bucket: b, engagement, count };
  }));
  const bucketMax = Math.max(0, ...buckets.flat().map((b) => b.engagement));
  const bucketsFlat = buckets.flat().map((b) => ({ ...b, norm: bucketMax > 0 ? b.engagement / bucketMax : 0 }));

  return {
    cells: flat,
    buckets: bucketsFlat,
    bucketLabels: BUCKET_LABELS,
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
  const reachSeriesSum = reachSeries.reduce((a, b) => a + b, 0);
  const engaged28 = totalValue(s.accountTotals, 'accounts_engaged');
  const interactions28 = totalValue(s.accountTotals, 'total_interactions');
  const views28 = totalValue(s.accountTotals, 'views');
  const profileTaps28 = totalValue(s.profileTaps, 'profile_links_taps');

  // Reach split: follower vs non-follower (the discovery signal). Sum = truest
  // 28d reach; fall back to the daily series if the breakdown didn't answer.
  const reachByKey = Object.fromEntries(demoResults(s.reachByFollow).map((r) => [r.key, r.value]));
  const followerReach = num(reachByKey.FOLLOWER);
  const nonFollowerReach = num(reachByKey.NON_FOLLOWER) + num(reachByKey.UNKNOWN);
  const hasReachSplit = Object.keys(reachByKey).length > 0;
  const reachTotal28 = hasReachSplit ? followerReach + nonFollowerReach : reachSeriesSum;

  // Publishing quota — IG containers per rolling 24h (Meta currently 50).
  const limitRow = (s.publishLimit || [])[0];
  const publishLimit = limitRow ? {
    used: num(limitRow.quota_usage),
    total: limitRow.config?.quota_total != null ? num(limitRow.config.quota_total) : null,
    remaining: limitRow.config?.quota_total != null ? Math.max(0, num(limitRow.config.quota_total) - num(limitRow.quota_usage)) : null,
  } : null;

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
  // Mentions are OTHER accounts' posts that tagged us — we don't own them, so
  // per-post insights and comment moderation are off-limits (the Graph API
  // 404s them). Flag them so the drill-down skips those owner-only calls.
  const mentions = (s.mentions || []).map((m) => ({ ...mediaItem(m, now), isMention: true }));

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
      reach28: reachTotal28,
      views28,
      engaged28,
      interactions28,
      profileTaps28,
      // Engagement rate: interactions over reach (the honest denominator —
      // null when reach is unknown rather than dividing by followers).
      engagementRatePct: (interactions28 != null && reachTotal28) ? (interactions28 / reachTotal28) * 100 : null,
      followerReach,
      nonFollowerReach,
      // Only meaningful when the follower/non-follower breakdown answered —
      // otherwise followerReach is a coerced 0 and the pct would read as a lie.
      followerReachPct: hasReachSplit && reachTotal28 > 0 ? Math.round((followerReach / reachTotal28) * 100) : null,
      hasReachSplit,
    },
    publishLimit,
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

/**
 * Engagement-rate benchmark bands (by followers), from Sprout Social's 2024-25
 * bands: <0.43% needs work · 0.43-1% average · 1-3% strong · 3%+ exceptional.
 * Home-decor/furniture is a low-engagement vertical (Rival IQ: below the 0.36%
 * all-industry median), so the note calibrates expectations — a 0.4% ER is
 * healthy for this business, not a failure.
 */
function engagementBand(pct) {
  if (pct == null) return { band: 'unknown', label: 'Sin datos', note: '' };
  if (pct >= 3) return { band: 'exceptional', label: 'Excepcional', note: 'Muy por encima del promedio del sector.' };
  if (pct >= 1) return { band: 'strong', label: 'Fuerte', note: 'Por encima del promedio de Instagram.' };
  if (pct >= 0.43) return { band: 'average', label: 'Promedio', note: 'En el rango típico; el mueble/hogar suele rondar aquí.' };
  return { band: 'low', label: 'Bajo', note: 'Normal en mueble/hogar (sector de baja interacción); prioriza guardados y compartidos.' };
}

/**
 * Derived audience business KPIs — turns the raw Studio numbers into the
 * "understanding" layer: how good is engagement (by reach AND by followers, the
 * two denominators the industry disagrees on — we report both), how far content
 * travels beyond the existing audience (discovery), which format earns its keep,
 * and how concentrated the audience is in the home market. Pure over the ALREADY
 * resolved `resolveIgStudio` output — no extra API calls. Formulas are the
 * documented ones (Hootsuite/Sprout/Rival IQ); every ratio guards its divisor
 * and returns null (never NaN/Infinity) when the denominator is unknown.
 */
export function resolveAudienceKpis(studio) {
  const s = studio || {};
  const k = s.kpis || {};
  const followers = num(s.profile?.followers);
  const reach = num(k.reach28);
  const interactions = k.interactions28 != null ? num(k.interactions28) : null;
  const pct = (n, d) => (d > 0 && n != null ? (n / d) * 100 : null);

  const erByFollowers = pct(interactions, followers);
  const erByReach = pct(interactions, reach);
  const reachRate = pct(reach, followers);
  // `nonFollowerReach` arrives as a NUMBER even when the follower-split call
  // errored (resolveIgStudio coerces with num()), so the honest "is the split
  // known" signal is hasReachSplit — otherwise a failed Meta breakdown would
  // render as a hard "0% discovery". Same for views28: null means unknown.
  const discoveryPct = reach > 0 && k.hasReachSplit ? (num(k.nonFollowerReach) / reach) * 100 : null;
  const viewsPerReach = reach > 0 && k.views28 != null ? num(k.views28) / reach : null;

  // Content-format performance: Reels vs feed posts, by average engagement per
  // post — each format wins on a different axis, so never collapse to one ER.
  const grid = s.grid || [];
  const byType = (isReel) => {
    const rows = grid.filter((g) => !!g.isReel === isReel);
    const eng = rows.reduce((a, g) => a + num(g.engagement), 0);
    return { posts: rows.length, totalEngagement: eng, avgEngagement: rows.length ? Math.round(eng / rows.length) : 0 };
  };
  const reels = byType(true);
  const posts = byType(false);
  const totalEng = reels.totalEngagement + posts.totalEngagement;
  const contentPerformance = [
    { type: 'Reels', ...reels, sharePct: totalEng ? Math.round((reels.totalEngagement / totalEng) * 100) : 0 },
    { type: 'Publicaciones', ...posts, sharePct: totalEng ? Math.round((posts.totalEngagement / totalEng) * 100) : 0 },
  ];
  const bestFormat = reels.avgEngagement === posts.avgEngagement ? null
    : (reels.avgEngagement > posts.avgEngagement ? 'Reels' : 'Publicaciones');

  // Audience concentration — among the top markets we can see (demographics only
  // returns the top performers), how dominant is #1, the top 3, and the home
  // market (Rep. Dominicana). Tells a single-location dealer if the audience is
  // local and actionable, or diffuse.
  const countries = s.audience?.topCountries || [];
  const countryTotal = countries.reduce((a, c) => a + num(c.value), 0);
  const top3 = countries.slice(0, 3).reduce((a, c) => a + num(c.value), 0);
  const home = countries.find((c) => c.label === 'Rep. Dominicana');
  const ages = s.audience?.age || [];
  const dominantAge = ages.reduce((best, a) => (best && best.value >= a.value ? best : a), null);

  return {
    engagementRateByFollowersPct: erByFollowers,
    engagementRateByReachPct: erByReach,
    reachRatePct: reachRate,
    discoveryPct,               // % of reach that came from non-followers
    viewsPerReach,              // repeat-exposure ratio (>1 = re-watched)
    engagementBenchmark: engagementBand(erByFollowers),
    contentPerformance,
    bestFormat,
    audienceConcentration: {
      topCountry: countries[0] ? { label: countries[0].label, pct: countryTotal ? Math.round((num(countries[0].value) / countryTotal) * 100) : null } : null,
      top3CountryPct: countryTotal ? Math.round((top3 / countryTotal) * 100) : null,
      homeMarketPct: countryTotal && home ? Math.round((num(home.value) / countryTotal) * 100) : null,
      dominantAge: dominantAge ? { label: dominantAge.label, pct: dominantAge.pct ?? null } : null,
    },
    hasData: reach > 0 || followers > 0 || grid.length > 0,
  };
}

const INSIGHT_LABELS = {
  reach: 'Alcance',
  views: 'Visualizaciones',
  total_interactions: 'Interacciones',
  replies: 'Respuestas',
  saved: 'Guardados',
  shares: 'Compartidos',
  profile_visits: 'Visitas al perfil',
  follows: 'Seguidores ganados',
  ig_reels_avg_watch_time: 'Tiempo medio visto',
};
const INSIGHT_ORDER = ['reach', 'views', 'total_interactions', 'replies', 'saved', 'shares', 'profile_visits', 'follows', 'ig_reels_avg_watch_time'];
const MS_METRICS = new Set(['ig_reels_avg_watch_time']); // values arrive in milliseconds

/** Per-post insight map → an ordered, labeled list for the drill-down panel.
 *  Watch-time arrives in ms — surface it as seconds so the panel reads cleanly. */
export function resolveMediaInsights(metrics) {
  const m = metrics || {};
  return INSIGHT_ORDER
    .filter((k) => m[k] != null)
    .map((k) => (MS_METRICS.has(k)
      ? { key: k, label: INSIGHT_LABELS[k] || k, value: Math.round(num(m[k]) / 1000), unit: 's' }
      : { key: k, label: INSIGHT_LABELS[k] || k, value: num(m[k]) }));
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
