/**
 * Instagram Ads Manager ViewModels — project the meta-social `ads` op payloads
 * into the rows + metric tiles the AdsManager renders. Pure: every money,
 * status and metric rule lives in lib/instagramAds; this only shapes the
 * board / children / insights responses and labels the insight tiles. (Model
 * layer — imported by the View via the core/jarvis barrel.)
 */
import {
  parseAccount,
  parseCampaign,
  parseAdSet,
  parseAd,
  parseInsights,
  formatAdMoney,
} from '../../lib/instagramAds.js';

const bySpend = (a, b) => (b.insights?.spend || 0) - (a.insights?.spend || 0);

/**
 * `ads:{op:'board'}` → the ad accounts the Business can see, each with its
 * campaigns (spend-ranked), so EVERY ad shows — Instagram boosts and Business
 * Suite promotions included, even when they bill through a different account.
 * Money is routed PER ACCOUNT currency (accounts may differ). `account` /
 * `currency` expose the primary one for the create wizard; `campaigns` is the
 * flat, spend-ranked roll-up across all accounts for the at-a-glance count.
 */
export function resolveAdsBoard(raw) {
  // New multi-account shape; falls back to the legacy single-account payload so
  // a brief deploy skew (old edge ↔ new client) still renders.
  const rawAccounts = raw?.accounts
    || (raw?.account ? [{ ...raw.account, campaigns: raw.campaigns || [] }] : []);
  const primaryId = raw?.primaryAccountId || rawAccounts[0]?.id || null;

  const accounts = rawAccounts.map((acc) => {
    const currency = acc?.currency || null;
    return {
      ...parseAccount(acc, currency),
      unreadable: !!acc?.unreadable,
      campaigns: (acc?.campaigns || []).map((c) => parseCampaign(c, currency)).sort(bySpend),
    };
  });
  // Primary leads; otherwise keep the edge order (already primary-first), but a
  // legacy payload gets a stable spend-then-name nudge so the busiest shows up.
  accounts.sort((a, b) => (a.id === primaryId ? -1 : b.id === primaryId ? 1 : 0));

  const primary = accounts.find((a) => a.id === primaryId) || accounts[0] || null;
  return {
    accounts,
    account: primary,
    currency: primary?.currency || null,
    campaigns: accounts.flatMap((a) => a.campaigns).sort(bySpend),
  };
}

/** `ads:{op:'children'}` → the level's parsed rows (spend-ranked). */
export function resolveAdChildren(raw, currency) {
  const level = raw?.level;
  return {
    level,
    rows: (raw?.rows || [])
      .map((r) => (level === 'adset' ? parseAdSet(r, currency) : parseAd(r, currency)))
      .sort((a, b) => (b.insights?.spend || 0) - (a.insights?.spend || 0)),
  };
}

/** A parsed insights object → labeled tiles for the insights drawer. */
export function adInsightTiles(ins, currency) {
  if (!ins) return [];
  const m = (v) => (v == null ? '—' : formatAdMoney(v, currency));
  const n = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
  const pct = (v) => (v == null ? '—' : `${Number(v).toFixed(2)}%`);
  const resultLabel = ins.resultLabel
    ? ins.resultLabel.charAt(0).toUpperCase() + ins.resultLabel.slice(1)
    : 'Resultados';
  return [
    { key: 'spend', label: 'Gasto', value: m(ins.spend) },
    { key: 'reach', label: 'Alcance', value: n(ins.reach) },
    { key: 'impressions', label: 'Impresiones', value: n(ins.impressions) },
    { key: 'results', label: resultLabel, value: n(ins.results) },
    { key: 'cpr', label: 'Costo/resultado', value: m(ins.costPerResult) },
    { key: 'ctr', label: 'CTR', value: pct(ins.ctr) },
    { key: 'cpc', label: 'CPC', value: m(ins.cpc) },
    { key: 'cpm', label: 'CPM', value: m(ins.cpm) },
    { key: 'freq', label: 'Frecuencia', value: ins.frequency == null ? '—' : Number(ins.frequency).toFixed(2) },
  ];
}

export { parseInsights };
