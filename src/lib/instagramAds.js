/**
 * Instagram / Meta Ads — the pure Model behind the in-app Ads Manager.
 *
 * The `meta-social` Edge Function fetches the Marketing API (Graph) and passes
 * its rows through untouched; THIS module projects them into display-ready
 * nodes and centralizes the two things a View must never get wrong:
 *
 *  • MONEY. Meta mixes units on purpose: budgets and account balances
 *    (daily_budget, lifetime_budget, budget_remaining, amount_spent, balance,
 *    spend_cap) come back as integer MINOR units (cents for USD/DOP), while
 *    insight figures (spend, cpc, cpm) come back as MAJOR-unit decimal
 *    strings. Reading a budget as dollars (or a spend as cents) is a 100×
 *    money bug, so the conversion lives here once and is pinned by a test.
 *  • STATUS. `effective_status` carries the truth the dealer needs to see
 *    (in review / rejected / out of budget), distinct from the configured
 *    `status`; the label + tone mapping is here so screen and controls agree.
 *
 * No React, Supabase or network here — the Edge Function does the I/O; this is
 * a referentially-transparent projection (Model layer, imported via core/jarvis).
 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ── Money ────────────────────────────────────────────────────────────────
// Currencies Meta bills with NO minor unit (the integer already IS the major
// amount). Everything else uses 1/100. USD and DOP — the dealer's world — are
// /100; the set keeps the math correct if the ad account is ever another one.
const ZERO_DECIMAL = new Set([
  'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'TWD', 'UGX', 'CRC', 'PYG', 'COP',
]);
export const currencyMinorUnits = (currency) =>
  (ZERO_DECIMAL.has(String(currency || '').toUpperCase()) ? 1 : 100);

/** Meta minor-unit integer (e.g. cents) → major units (e.g. dollars). */
export const minorToMajor = (minor, currency) =>
  minor == null || minor === '' ? null : num(minor) / currencyMinorUnits(currency);

/** Major units → the minor-unit integer STRING the Marketing API expects. */
export const majorToMinor = (major, currency) =>
  String(Math.round(num(major) * currencyMinorUnits(currency)));

/** Account-currency money for the UI ("RD$1,250.00" style via Intl). */
export function formatAdMoney(major, currency, { maximumFractionDigits = 2, minimumFractionDigits } = {}) {
  if (major == null || !Number.isFinite(Number(major))) return '—';
  try {
    return num(major).toLocaleString('en-US', {
      style: currency ? 'currency' : 'decimal',
      currency: currency || undefined,
      maximumFractionDigits,
      minimumFractionDigits: minimumFractionDigits ?? Math.min(2, maximumFractionDigits),
    });
  } catch {
    // Unknown ISO code → plain number with the code appended.
    return `${num(major).toLocaleString('en-US', { maximumFractionDigits })}${currency ? ` ${currency}` : ''}`;
  }
}

// ── Status (effective_status → human label + tone) ─────────────────────────
// tone keys map to the app's tonal pills (emerald/amber/red/ink).
const STATUS = {
  ACTIVE: { label: 'Activo', tone: 'emerald' },
  PAUSED: { label: 'Pausado', tone: 'ink' },
  CAMPAIGN_PAUSED: { label: 'Campaña pausada', tone: 'ink' },
  ADSET_PAUSED: { label: 'Conjunto pausado', tone: 'ink' },
  IN_PROCESS: { label: 'Procesando', tone: 'amber' },
  PENDING_REVIEW: { label: 'En revisión', tone: 'amber' },
  PENDING_BILLING_INFO: { label: 'Falta método de pago', tone: 'amber' },
  WITH_ISSUES: { label: 'Con problemas', tone: 'amber' },
  DISAPPROVED: { label: 'Rechazado', tone: 'red' },
  PREAPPROVED: { label: 'Pre-aprobado', tone: 'emerald' },
  ARCHIVED: { label: 'Archivado', tone: 'ink' },
  DELETED: { label: 'Eliminado', tone: 'red' },
  COMPLETED: { label: 'Finalizado', tone: 'ink' },
  CAMPAIGN_DELETED: { label: 'Campaña eliminada', tone: 'red' },
  ADSET_DELETED: { label: 'Conjunto eliminado', tone: 'red' },
};
export const statusInfo = (s) =>
  STATUS[String(s || '').toUpperCase()] || { label: s || '—', tone: 'ink' };

/** The toggle truth: is this node currently switched ON (its own status)? */
export const isActiveStatus = (s) => String(s || '').toUpperCase() === 'ACTIVE';
/** Whether effective_status says Meta is actively delivering (vs paused/issue). */
export const isDelivering = (s) => String(s || '').toUpperCase() === 'ACTIVE';

// ── Results (what an ad "achieved") ────────────────────────────────────────
// A furniture dealer's Meta ads overwhelmingly optimize for WhatsApp/Messenger
// conversations; leads then link-clicks are the honest fallbacks. The first
// action type present wins and is labeled — never summed across kinds.
const RESULT_TYPES = [
  ['onsite_conversion.messaging_conversation_started_7d', 'conversaciones'],
  ['onsite_conversion.lead_grouped', 'leads'],
  ['lead', 'leads'],
  ['link_click', 'clics'],
  ['post_engagement', 'interacciones'],
  ['reach', 'alcance'],
];
const actionVal = (actions, type) =>
  num((actions || []).find((a) => a.action_type === type)?.value);

/**
 * One insights row (the Graph nests it under `insights.data[0]`) → the metric
 * tiles the manager shows. CTR/CPC/CPM are taken from the API when present and
 * derived (guarded against /0) otherwise, so a node with a partial row still
 * reads sensibly. `spend`/`cpc`/`cpm` are MAJOR units already (Graph insight
 * convention) — no minor-unit conversion here, unlike budgets.
 */
export function parseInsights(raw) {
  const r = raw?.data?.[0] || raw?.[0] || raw || {};
  const spend = num(r.spend);
  const impressions = num(r.impressions);
  const clicks = num(r.clicks);
  const reach = num(r.reach);
  const actions = r.actions || [];
  const found = RESULT_TYPES.find(([t]) => actionVal(actions, t) > 0) || null;
  const results = found ? actionVal(actions, found[0]) : null;
  return {
    hasData: !!(spend || impressions || clicks || reach || results),
    spend,
    impressions,
    clicks,
    reach,
    frequency: r.frequency != null ? num(r.frequency) : (reach > 0 ? impressions / reach : null),
    ctr: r.ctr != null ? num(r.ctr) : (impressions > 0 ? (clicks / impressions) * 100 : null),
    cpc: r.cpc != null ? num(r.cpc) : (clicks > 0 ? spend / clicks : null),
    cpm: r.cpm != null ? num(r.cpm) : (impressions > 0 ? (spend / impressions) * 1000 : null),
    results,
    resultLabel: found ? found[1] : null,
    costPerResult: found && results > 0 ? spend / results : null,
  };
}

// ── Targeting (summarize for display + normalize for the API) ───────────────
const GENDER_LABEL = { 1: 'Hombres', 2: 'Mujeres' };

/** A one-line human summary of an ad set's targeting (geo · age · gender). */
export function summarizeTargeting(t) {
  if (!t) return null;
  const geo = t.geo_locations || {};
  const places = [
    ...(geo.countries || []),
    ...((geo.regions || []).map((r) => r.name || r.key)),
    ...((geo.cities || []).map((c) => c.name || c.key)),
  ].filter(Boolean);
  const parts = [];
  if (places.length) parts.push(places.slice(0, 3).join(', ') + (places.length > 3 ? '…' : ''));
  const lo = t.age_min, hi = t.age_max;
  if (lo || hi) parts.push(`${lo || 13}–${hi || 65}`);
  const g = (t.genders || []);
  if (g.length === 1) parts.push(GENDER_LABEL[g[0]] || '');
  const interests = (t.flexible_spec || []).flatMap((s) => (s.interests || []).map((i) => i.name)).filter(Boolean);
  if (interests.length) parts.push(`${interests.length} interés${interests.length > 1 ? 'es' : ''}`);
  return parts.filter(Boolean).join(' · ') || null;
}

/**
 * Build the Marketing API `targeting` object from the wizard's simple form.
 * Countries default to the Dominican Republic (the dealer's market). Genders
 * empty → all. Interests come from targetingSearch as `{ id, name }`.
 */
export function buildTargeting({ countries = ['DO'], ageMin = 18, ageMax = 65, genders = [], interests = [] } = {}) {
  const t = {
    geo_locations: { countries: countries.length ? countries : ['DO'] },
    age_min: Math.max(13, Math.min(65, num(ageMin) || 18)),
    age_max: Math.max(13, Math.min(65, num(ageMax) || 65)),
  };
  if (genders.length === 1) t.genders = genders;
  if (interests.length) {
    t.flexible_spec = [{ interests: interests.map((i) => ({ id: i.id, name: i.name })) }];
  }
  // Instagram-stream placement (this is an IG-first dealer).
  t.publisher_platforms = ['instagram'];
  t.instagram_positions = ['stream', 'explore', 'reels'];
  return t;
}

// ── Node parsers (campaign / ad set / ad) ──────────────────────────────────
const isoOrNull = (v) => (v ? String(v) : null);

export function parseCampaign(c, currency) {
  return {
    level: 'campaign',
    id: c.id || null,
    name: c.name || '—',
    status: c.status || null,
    effectiveStatus: c.effective_status || c.status || null,
    objective: c.objective || null,
    dailyBudget: minorToMajor(c.daily_budget, currency),
    lifetimeBudget: minorToMajor(c.lifetime_budget, currency),
    budgetRemaining: minorToMajor(c.budget_remaining, currency),
    startTime: isoOrNull(c.start_time),
    stopTime: isoOrNull(c.stop_time),
    insights: parseInsights(c.insights),
  };
}

export function parseAdSet(a, currency) {
  return {
    level: 'adset',
    id: a.id || null,
    name: a.name || '—',
    campaignId: a.campaign_id || null,
    status: a.status || null,
    effectiveStatus: a.effective_status || a.status || null,
    dailyBudget: minorToMajor(a.daily_budget, currency),
    lifetimeBudget: minorToMajor(a.lifetime_budget, currency),
    budgetRemaining: minorToMajor(a.budget_remaining, currency),
    optimizationGoal: a.optimization_goal || null,
    billingEvent: a.billing_event || null,
    bidStrategy: a.bid_strategy || null,
    startTime: isoOrNull(a.start_time),
    endTime: isoOrNull(a.end_time),
    targeting: a.targeting || null,
    targetingSummary: summarizeTargeting(a.targeting),
    insights: parseInsights(a.insights),
  };
}

export function parseAd(a, currency) {
  const cr = a.creative || {};
  return {
    level: 'ad',
    id: a.id || null,
    name: a.name || '—',
    adsetId: a.adset_id || null,
    status: a.status || null,
    effectiveStatus: a.effective_status || a.status || null,
    creativeId: cr.id || null,
    thumb: cr.thumbnail_url || cr.image_url || null,
    storyId: cr.effective_object_story_id || null,
    insights: parseInsights(a.insights),
  };
}

/** The account header strip (financials are MINOR units → major). */
export function parseAccount(acc, currency) {
  if (!acc) return null;
  const cur = acc.currency || currency || null;
  return {
    id: acc.id || null,
    name: acc.name || null,
    currency: cur,
    amountSpent: minorToMajor(acc.amount_spent, cur),
    balance: minorToMajor(acc.balance, cur),
    spendCap: acc.spend_cap && num(acc.spend_cap) > 0 ? minorToMajor(acc.spend_cap, cur) : null,
    status: num(acc.account_status),
    disabled: num(acc.account_status) !== 1 && num(acc.account_status) !== 0,
  };
}

// ── Create-wizard option tables ────────────────────────────────────────────
// Only the objectives whose creative is "promote an existing IG post" and whose
// optimization/billing combo we can set correctly without a pixel or
// destination. The manager still CONTROLS leads/sales campaigns made elsewhere
// in full; it just doesn't fabricate those combos here.
export const OBJECTIVES = [
  { id: 'OUTCOME_ENGAGEMENT', label: 'Interacción', hint: 'Más likes, comentarios y guardados', optimizationGoal: 'POST_ENGAGEMENT', billingEvent: 'IMPRESSIONS' },
  { id: 'OUTCOME_AWARENESS', label: 'Reconocimiento', hint: 'Llega al mayor número de personas', optimizationGoal: 'REACH', billingEvent: 'IMPRESSIONS' },
  { id: 'OUTCOME_TRAFFIC', label: 'Tráfico', hint: 'Lleva visitas a un enlace', optimizationGoal: 'LINK_CLICKS', billingEvent: 'IMPRESSIONS' },
];
export const objectiveInfo = (id) => OBJECTIVES.find((o) => o.id === id) || OBJECTIVES[0];

export const AGE_BOUNDS = Array.from({ length: 65 - 13 + 1 }, (_, i) => 13 + i);
export const GENDER_OPTIONS = [
  { id: 0, label: 'Todos', genders: [] },
  { id: 1, label: 'Hombres', genders: [1] },
  { id: 2, label: 'Mujeres', genders: [2] },
];

// Common Latin-American/relevant markets pre-listed for the geo picker (the
// dealer sells in DR; nearby diaspora markets occasionally run too).
export const COUNTRY_OPTIONS = [
  { code: 'DO', label: 'República Dominicana' },
  { code: 'US', label: 'Estados Unidos' },
  { code: 'PR', label: 'Puerto Rico' },
  { code: 'ES', label: 'España' },
  { code: 'MX', label: 'México' },
  { code: 'CO', label: 'Colombia' },
];

/** A friendly objective label for an existing campaign's raw objective code. */
export function objectiveLabel(code) {
  const known = OBJECTIVES.find((o) => o.id === code);
  if (known) return known.label;
  const MAP = {
    OUTCOME_LEADS: 'Clientes potenciales',
    OUTCOME_SALES: 'Ventas',
    OUTCOME_APP_PROMOTION: 'Promoción de app',
    LINK_CLICKS: 'Tráfico',
    POST_ENGAGEMENT: 'Interacción',
    REACH: 'Reconocimiento',
    BRAND_AWARENESS: 'Reconocimiento',
    MESSAGES: 'Mensajes',
    CONVERSIONS: 'Conversiones',
    LEAD_GENERATION: 'Clientes potenciales',
  };
  return MAP[String(code || '').toUpperCase()] || code || '—';
}
