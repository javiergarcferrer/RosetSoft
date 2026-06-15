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

/** `ads:{op:'board'}` → account header + campaigns (spend-ranked). */
export function resolveAdsBoard(raw) {
  const currency = raw?.currency || raw?.account?.currency || null;
  return {
    account: parseAccount(raw?.account, currency),
    currency,
    campaigns: (raw?.campaigns || [])
      .map((c) => parseCampaign(c, currency))
      .sort((a, b) => (b.insights?.spend || 0) - (a.insights?.spend || 0)),
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
