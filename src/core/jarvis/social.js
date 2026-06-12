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

const DAY = 86_400_000;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

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
  const reachRows = ((s.igReach || []).find((m) => m.name === 'reach')?.values) || [];
  const reach7 = sumTail(reachRows, 'value', 7);
  const reach7Prev = sumTail(reachRows, 'value', 7, 7);

  const campaigns = (s.adCampaigns || [])
    .map((c) => {
      const spend = num(c.spend);
      const clicks = num(c.clicks);
      const impressions = num(c.impressions);
      return {
        name: c.campaign_name || '—',
        spend,
        clicks,
        ctrPct: impressions > 0 ? (clicks / impressions) * 100 : null,
        cpc: clicks > 0 ? spend / clicks : null,
      };
    })
    .sort((a, b) => b.spend - a.spend);

  const scheduled = (s.scheduled || [])
    .map((p) => ({ at: toMs(p.scheduled_publish_time), text: (p.message || '').slice(0, 120) || '(sin texto)' }))
    .filter((p) => p.at && p.at > now)
    .sort((a, b) => a.at - b.at)
    .map((p) => ({ ...p, inLabel: inLabel(p.at, now) }));

  const posts = (s.igMedia || [])
    .map((m) => ({
      text: (m.caption || '').slice(0, 90) || `(${m.media_type || 'post'})`,
      likes: num(m.like_count),
      comments: num(m.comments_count),
      at: toMs(m.timestamp),
      permalink: m.permalink || null,
    }))
    .map((m) => ({ ...m, ago: agoLabel(m.at, now) }));

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
    },
    spendSeries: adsDaily.map((r) => num(r.spend)),
    reachSeries: reachRows.map((r) => num(r.value)),
    campaigns,
    scheduled,
    posts,
    errors: s.errors || {},
    fetchedAt: s.fetchedAt || null,
  };
}
