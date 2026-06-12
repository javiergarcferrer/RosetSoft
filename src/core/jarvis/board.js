/**
 * JARVIS board ViewModels — pure projections for the ops dashboard.
 *
 * `resolveIntegrationBoard` turns team settings + live probe results into the
 * card grid (one card per external integration, with a derived status), and
 * the small helpers below project the uplink thread, the activity feed and
 * the decorative radar from the same inputs. No React, no db — the page
 * fetches and passes rows in.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Card status → HUD chip label. `scanning` is probe-transient. */
export const STATUS_LABELS = {
  online: 'En línea',
  stale: 'Desfase',
  standby: 'En espera',
  offline: 'Sin config',
  fail: 'Fallo',
  scanning: 'Escaneando',
};

/** Spanish relative-time label ("hace 3 min", "hace 2 d"). */
export function agoLabel(ts, now = Date.now()) {
  if (!ts) return null;
  const d = Math.max(0, now - ts);
  if (d < 60_000) return 'hace segundos';
  if (d < HOUR) return `hace ${Math.round(d / 60_000)} min`;
  if (d < DAY) return `hace ${Math.round(d / HOUR)} h`;
  return `hace ${Math.round(d / DAY)} d`;
}

// A probe result ({ state:'scanning'|'ok'|'fail', ms?, note? }) overrides the
// settings-derived status; `soft` marks a probe that answered "not configured"
// (an offline, not a failure).
function applyProbe(card, probe) {
  if (!probe) return card;
  if (probe.state === 'scanning') return { ...card, status: 'scanning' };
  if (probe.state === 'ok') {
    return {
      ...card,
      status: probe.soft ? 'offline' : 'online',
      latencyMs: probe.ms ?? null,
      detail: probe.note || card.detail,
    };
  }
  return { ...card, status: 'fail', latencyMs: probe.ms ?? null, detail: probe.note || card.detail };
}

/**
 * The integration card grid. `settings` is the team settings row (freshness
 * stamps live there), `probes` is the page's live diagnostic state keyed by
 * card id. Returns cards ordered for display.
 */
export function resolveIntegrationBoard({ settings = {}, probes = {}, now = Date.now() } = {}) {
  const rate = settings.exchangeRate || {};
  const rateAt = rate.updatedAt || null;
  const sell = Number(rate.sell) || Number(rate.buy) || null;

  const cards = [
    {
      id: 'supabase',
      name: 'Supabase',
      desc: 'Base de datos · RLS · Storage',
      // The page read `settings` over this very connection, so reaching the
      // board at all proves the database is answering.
      status: 'online',
      at: null,
      detail: 'Postgres + Realtime',
    },
    {
      id: 'claude',
      name: 'Claude API',
      desc: 'Enlace IA · consola JARVIS',
      status: settings.claudeConnectedAt ? 'online' : 'offline',
      at: settings.claudeConnectedAt || null,
      detail: settings.claudeConnectedAt
        ? (settings.claudeModel || 'claude-opus-4-8')
        : 'Sin llave API',
    },
    {
      id: 'bpd',
      name: 'Banco Popular',
      desc: 'Tasa USD→DOP diaria',
      status: !rateAt ? 'offline' : now - rateAt > 36 * HOUR ? 'stale' : 'online',
      at: rateAt,
      detail: sell ? `1 USD ≈ RD$ ${sell.toFixed(2)}` : 'Sin tasa publicada',
    },
    {
      id: 'shopify',
      name: 'Shopify · Alcover',
      desc: 'Espejo de inventario',
      status: settings.shopifyConnectedAt ? 'online' : 'offline',
      at: settings.shopifyConnectedAt || null,
      detail: settings.shopifyDomain || 'Tienda alcover.do',
    },
    {
      id: 'shopifyLsg',
      name: 'Shopify · LSG',
      desc: 'Catálogo LifestyleGarden',
      status: settings.shopifyLsgConnectedAt ? 'online' : 'offline',
      at: settings.shopifyLsgConnectedAt || null,
      detail: 'Importación de catálogo',
    },
    {
      id: 'whatsapp',
      name: 'WhatsApp Cloud',
      desc: 'Mensajes · plantillas · difusión',
      status: settings.whatsappConnectedAt ? 'online' : 'offline',
      at: settings.whatsappConnectedAt || null,
      detail: 'Meta Graph API',
    },
    {
      id: 'ecf',
      name: 'DGII e-CF',
      desc: 'Facturación electrónica',
      status: settings.ecfCertUploadedAt ? 'online' : 'offline',
      at: settings.ecfCertUploadedAt || null,
      detail: settings.ecfCertUploadedAt
        ? `Certificado · entorno ${settings.ecfEnvironment || 'dev'}`
        : 'Sin certificado .p12',
    },
    {
      id: 'hlag',
      name: 'Hapag-Lloyd',
      desc: 'Track & Trace de contenedores',
      status: 'standby',
      at: null,
      detail: 'DCSA v2 · bajo demanda',
    },
    {
      id: 'lrCatalog',
      name: 'Ligne Roset',
      desc: 'Catálogo · telas · swatches',
      status: 'standby',
      at: null,
      detail: 'Importación manual',
    },
    {
      id: 'rnc',
      name: 'DGII RNC',
      desc: 'Registro de contribuyentes',
      status: 'standby',
      at: null,
      detail: 'Consulta bajo demanda',
    },
    {
      id: 'quoteShare',
      name: 'Enlace cliente',
      desc: 'Cotización pública interactiva',
      status: 'standby',
      at: null,
      detail: 'quote-share · por token',
    },
  ];

  return cards.map((c) => {
    const withProbe = applyProbe(c, probes[c.id]);
    return { ...withProbe, ago: agoLabel(withProbe.at, now), statusLabel: STATUS_LABELS[withProbe.status] };
  });
}

/**
 * Overall system integrity, 0–100. Standby (on-demand, nothing to be stale
 * about) counts as healthy; stale counts half; offline/fail count zero.
 */
export function systemIntegrity(cards) {
  if (!cards.length) return 0;
  const score = { online: 1, standby: 1, scanning: 1, stale: 0.5, offline: 0, fail: 0 };
  const total = cards.reduce((s, c) => s + (score[c.status] ?? 0), 0);
  return Math.round((total / cards.length) * 100);
}

/**
 * Decorative radar projection: each card becomes a blip on a 0–100 viewbox,
 * angle by position, radius by health (closer to center = healthier).
 */
export function radarPoints(cards) {
  const radius = { online: 18, scanning: 30, standby: 30, stale: 38, offline: 45, fail: 45 };
  return cards.map((c, i) => {
    const a = (i / Math.max(1, cards.length)) * Math.PI * 2 - Math.PI / 2;
    const r = radius[c.status] ?? 45;
    return { id: c.id, name: c.name, status: c.status, x: 50 + Math.cos(a) * r, y: 50 + Math.sin(a) * r };
  });
}

/** The uplink thread — conversation rows only, oldest first. */
export function resolveUplinkFeed(messages = [], { limit = 60 } = {}) {
  return [...messages]
    .filter((m) => m.kind === 'directive' || m.kind === 'reply' || m.kind === 'chat')
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .slice(-limit)
    .map((m) => ({
      id: m.id,
      role: m.role || 'user',
      content: m.content || '',
      status: m.status || 'pending',
      at: m.createdAt || null,
    }));
}

/**
 * The activity stream — "cambios en vigor": the commits baked into this very
 * deploy, interleaved with the agent's telemetry rows ('activity' | 'deploy'),
 * newest first.
 */
export function resolveActivityFeed({ commits = [], messages = [], limit = 14, now = Date.now() } = {}) {
  const fromGit = commits.map((c) => ({
    id: `c-${c.sha}`,
    type: 'commit',
    at: c.at || null,
    text: c.msg || c.sha,
    tag: c.sha,
  }));
  const fromAgent = messages
    .filter((m) => m.kind === 'activity' || m.kind === 'deploy')
    .map((m) => ({ id: m.id, type: m.kind, at: m.createdAt || null, text: m.content || '', tag: 'claude' }));
  return [...fromGit, ...fromAgent]
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, limit)
    .map((e) => ({ ...e, ago: agoLabel(e.at, now) }));
}
