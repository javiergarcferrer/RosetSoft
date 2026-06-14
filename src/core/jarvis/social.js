/**
 * JARVIS social pulse — Meta (Facebook Page + Instagram + Ads) ViewModel.
 *
 * Pure projection of the meta-social Edge Function's `snapshot` payload into
 * what the panel renders: follower counts, IG reach (7d vs previous 7d, an
 * HONEST delta — null when there's nothing to compare), ad spend/results with
 * guarded CPC/CTR math, the per-campaign rollup, the publishing schedule and
 * recent posts. The Graph API returns numbers as strings and mixes ISO/unix
 * timestamps; all of that normalizing lives here, not in the View.
 */
import { agoLabel } from './board.js';
import { weekStart } from './pulse.js';

const DAY = 86_400_000;
const WEEK = 7 * DAY;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The image to SHOW for an IG media item: a VIDEO's `media_url` is the raw
 * .mp4, so its `thumbnail_url` is the picture; a photo / carousel serves the
 * image straight from `media_url`. These are short-lived signed CDN URLs —
 * fine for a live, polled dashboard where each fetch refreshes them.
 */
function mediaImage(m) {
  if (!m) return null;
  return m.media_type === 'VIDEO'
    ? (m.thumbnail_url || m.media_url || null)
    : (m.media_url || m.thumbnail_url || null);
}

/** ISO string or unix seconds → JS ms (null when unparseable). */
function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 10_000_000_000 ? v : v * 1000;
  const n = Number(v);
  if (Number.isFinite(n)) return n > 10_000_000_000 ? n : n * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Spanish future label ("en 3 h", "en 2 d") — agoLabel's forward twin. */
export function inLabel(ts, now = Date.now()) {
  if (!ts) return null;
  const d = ts - now;
  if (d <= 0) return 'ahora';
  if (d < 3_600_000) return `en ${Math.max(1, Math.round(d / 60_000))} min`;
  if (d < DAY) return `en ${Math.round(d / 3_600_000)} h`;
  return `en ${Math.round(d / DAY)} d`;
}

// Sum a slice of daily rows. `days` rows from the end; `skip` rows skipped
// from the end first (so {days:7, skip:7} = the previous week).
function sumTail(rows, field, days, skip = 0) {
  const end = rows.length - skip;
  return rows.slice(Math.max(0, end - days), Math.max(0, end))
    .reduce((s, r) => s + num(r[field]), 0);
}

const deltaPct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null);

/** One action type's count from an ads row's `actions` array. */
const actionCount = (row, type) =>
  num(((row?.actions || []).find((a) => a.action_type === type) || {}).value);

// What an ad "result" means here, in priority order: a furniture dealer's
// Meta ads overwhelmingly optimize for WhatsApp/Messenger conversations;
// leads and link clicks are the honest fallbacks. The FIRST type with any
// activity in range wins and is labeled as such — never mixed.
const RESULT_TYPES = [
  ['onsite_conversion.messaging_conversation_started_7d', 'conversaciones'],
  ['lead', 'leads'],
  ['link_click', 'clics al enlace'],
];

/** Daily values of one metric from an insights payload (data array). */
const metricRows = (insights, name) =>
  ((insights || []).find((m) => m.name === name)?.values) || [];

// A `metric_type=total_value` insight collapses its window to one figure under
// `total_value.value` (no per-day `values` array) — the modern IG shape.
const totalValue = (insights, name) =>
  num((insights || []).find((m) => m.name === name)?.total_value?.value);

/**
 * Marketing API `date_start` ("YYYY-MM-DD") as a LOCAL-midnight timestamp.
 * `Date.parse` would read it as UTC midnight — in Santo Domingo (UTC-4)
 * that lands on 8 PM of the PREVIOUS day and shifts week buckets.
 */
function localDayMs(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/**
 * The ads ↔ sales bridge: the last `weeks` Monday-aligned weeks with what
 * was SPENT on Meta ads (account currency) next to what the pipeline DID
 * (quotes created / accepted, same week rule as the business pulse). No
 * shared y-axis trickery — plain numbers side by side; the reader judges
 * the correlation.
 */
export function resolveAdsSalesWeeks({ adsDaily = [], quotes = [], now = Date.now(), weeks = 4 } = {}) {
  const w0 = weekStart(now);
  return Array.from({ length: weeks }, (_, i) => {
    const start = w0 - (weeks - 1 - i) * WEEK;
    const inWeek = (ts) => ts != null && ts >= start && ts < start + WEEK;
    const spend = adsDaily.reduce(
      (acc, r) => acc + (inWeek(localDayMs(r.date_start)) ? num(r.spend) : 0),
      0,
    );
    return {
      start,
      label: new Date(start).toLocaleDateString('es-DO', { day: 'numeric', month: 'short' }),
      spend,
      created: quotes.filter((q) => inWeek(q.createdAt)).length,
      accepted: quotes.filter((q) => inWeek(q.acceptedAt)).length,
    };
  });
}

/**
 * The social pulse. `snapshot` is the meta-social function's payload (may be
 * partial — sections that errored arrive null and surface in `errors`).
 */
export function resolveSocialPulse(snapshot, { now = Date.now() } = {}) {
  const s = snapshot || {};

  // Daily ad rows, oldest first (the API already orders by date_start; sort
  // defensively — sums below index from the end).
  const adsDaily = [...(s.adsDaily || [])].sort(
    (a, b) => String(a.date_start || '').localeCompare(String(b.date_start || '')),
  );
  const spend7 = sumTail(adsDaily, 'spend', 7);
  const spend7Prev = sumTail(adsDaily, 'spend', 7, 7);
  const spend28 = sumTail(adsDaily, 'spend', 28);
  const clicks7 = sumTail(adsDaily, 'clicks', 7);
  const impressions7 = sumTail(adsDaily, 'impressions', 7);

  // IG daily reach values (insights metric rows → the `reach` series).
  const reachRows = metricRows(s.igReach, 'reach');
  const reach7 = sumTail(reachRows, 'value', 7);
  const reach7Prev = sumTail(reachRows, 'value', 7, 7);

  // IG audience: net new followers per day (time series) + profile actions
  // (profile_links_taps, a 7d total_value — `profile_views` was removed in v22).
  const followerRows = metricRows(s.igAudience, 'follower_count');
  const newFollowers7 = sumTail(followerRows, 'value', 7);
  const profileActions7 = totalValue(s.igProfileActions, 'profile_links_taps');

  // Facebook Page daily engagement + unique reach (when Meta still answers
  // this metric family — absent otherwise).
  const pageEngRows = metricRows(s.pageInsights, 'page_post_engagements');
  const pageEngagement7 = sumTail(pageEngRows, 'value', 7);
  const pageEngagement7Prev = sumTail(pageEngRows, 'value', 7, 7);

  // Ad RESULTS: the first result type with activity in range (see above).
  const resultType = RESULT_TYPES.find(([t]) => adsDaily.some((r) => actionCount(r, t) > 0)) || null;
  const sumResults = (days, skip = 0) => {
    if (!resultType) return 0;
    const end = adsDaily.length - skip;
    return adsDaily.slice(Math.max(0, end - days), Math.max(0, end))
      .reduce((acc, r) => acc + actionCount(r, resultType[0]), 0);
  };
  const results7 = sumResults(7);

  // Campaigns: the new shape is the campaigns edge (id + status + nested
  // insights); rows from the old level=campaign insights call (flat, with
  // campaign_name) still map so a stale function deploy can't blank the list.
  const campaigns = (s.adCampaigns || [])
    .map((c) => {
      const ins = c.insights?.data?.[0] || c;
      const spend = num(ins.spend);
      const clicks = num(ins.clicks);
      const impressions = num(ins.impressions);
      const results = resultType ? actionCount(ins, resultType[0]) : null;
      const status = c.effective_status || c.status || null;
      return {
        id: c.id || null,
        name: c.name || c.campaign_name || '—',
        status,
        active: status === 'ACTIVE',
        spend,
        clicks,
        results,
        ctrPct: impressions > 0 ? (clicks / impressions) * 100 : null,
        cpc: clicks > 0 ? spend / clicks : null,
      };
    })
    .sort((a, b) => b.spend - a.spend);

  const scheduled = (s.scheduled || [])
    .map((p) => ({
      at: toMs(p.scheduled_publish_time),
      text: (p.message || '').slice(0, 120) || '(sin texto)',
      mediaUrl: p.full_picture || null,
      permalink: p.permalink_url || null,
    }))
    .filter((p) => p.at && p.at > now)
    .sort((a, b) => a.at - b.at)
    .map((p) => ({ ...p, inLabel: inLabel(p.at, now) }));

  const posts = (s.igMedia || [])
    .map((m) => ({
      text: (m.caption || '').slice(0, 90) || `(${m.media_type || 'post'})`,
      caption: m.caption || '',
      likes: num(m.like_count),
      comments: num(m.comments_count),
      at: toMs(m.timestamp),
      mediaUrl: mediaImage(m),
      permalink: m.permalink || null,
      // The nested comments (newest first) for the full-post peek's thread.
      commentList: ((m.comments?.data) || [])
        .map((c) => ({
          id: c.id || null,
          username: c.username || '',
          text: (c.text || '').slice(0, 200),
          at: toMs(c.timestamp),
        }))
        .sort((a, b) => (b.at || 0) - (a.at || 0))
        .map((c) => ({ ...c, ago: agoLabel(c.at, now) })),
    }))
    .map((m) => ({ ...m, ago: agoLabel(m.at, now) }));

  // Recent comments flattened across the recent posts, newest first — the
  // triage feed (what people are saying that may deserve a reply). Each
  // carries the parent post's image + caption so the View can pop up the
  // post being spoken of for context.
  const recentComments = (s.igMedia || [])
    .flatMap((m) => ((m.comments?.data) || []).map((c) => ({
      id: c.id || null,
      text: (c.text || '').slice(0, 100),
      username: c.username || '',
      at: toMs(c.timestamp),
      postText: (m.caption || '').slice(0, 40) || `(${m.media_type || 'post'})`,
      postCaption: m.caption || '',
      mediaUrl: mediaImage(m),
      permalink: m.permalink || null,
    })))
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, 8)
    .map((c) => ({ ...c, ago: agoLabel(c.at, now) }));

  return {
    pageName: s.page?.name || s.pageName || '',
    igUsername: s.ig?.username || s.igUsername || '',
    hasIg: !!s.hasIg,
    hasAds: !!s.hasAds,
    adCurrency: s.adAccount?.currency || null,
    kpis: {
      igFollowers: num(s.ig?.followers_count) || null,
      fbFollowers: num(s.page?.followers_count) || num(s.page?.fan_count) || null,
      reach7,
      reachDeltaPct: deltaPct(reach7, reach7Prev),
      spend7,
      spendDeltaPct: deltaPct(spend7, spend7Prev),
      spend28,
      clicks7,
      cpc7: clicks7 > 0 ? spend7 / clicks7 : null,
      ctr7Pct: impressions7 > 0 ? (clicks7 / impressions7) * 100 : null,
      results7,
      resultsLabel: resultType ? resultType[1] : null,
      costPerResult7: results7 > 0 ? spend7 / results7 : null,
      profileActions7,
      newFollowers7,
      pageEngagement7,
      pageEngagementDeltaPct: deltaPct(pageEngagement7, pageEngagement7Prev),
    },
    spendSeries: adsDaily.map((r) => num(r.spend)),
    reachSeries: reachRows.map((r) => num(r.value)),
    followerSeries: followerRows.map((r) => num(r.value)),
    campaigns,
    scheduled,
    posts,
    recentComments,
    // Meta product catalogs across the business portfolios the token sees.
    catalogs: (s.businesses || []).flatMap((b) => ((b.owned_product_catalogs?.data) || []).map((c) => ({
      name: c.name || '—',
      products: num(c.product_count),
      vertical: c.vertical || '',
      business: b.name || '',
    }))),
    errors: s.errors || {},
    fetchedAt: s.fetchedAt || null,
  };
}
