/**
 * Container-number (ISO 6346) helpers + Hapag-Lloyd Track & Trace event
 * shaping. Pure logic — no network, no Supabase — so it unit-tests under
 * node and runs in the browser unchanged. The actual API call lives in the
 * `hl-track` Edge Function (it holds the keys); this module validates the
 * number the dealer types and turns the DCSA event list that comes back
 * into a timeline the UI can render.
 *
 * Track & Trace queries by `equipmentReference`, which IS the ISO 6346
 * container number — so a correct number is the whole input to the lookup.
 */

/* ----------------------------- ISO 6346 ----------------------------- */

// Per ISO 6346: letters map to values 10..38, skipping every multiple of
// 11 (11, 22, 33). Digits map to their face value.
const LETTER_VALUES: Record<string, number> = {
  A: 10, B: 12, C: 13, D: 14, E: 15, F: 16, G: 17, H: 18, I: 19,
  J: 20, K: 21, L: 23, M: 24, N: 25, O: 26, P: 27, Q: 28, R: 29,
  S: 30, T: 31, U: 32, V: 34, W: 35, X: 36, Y: 37, Z: 38,
};

// 4 letters (3 owner + 1 category) + 6 serial digits + 1 check digit.
const CONTAINER_RE = /^[A-Z]{4}\d{6}\d$/;

/** Uppercase and strip everything that isn't a letter or digit. */
export function normalizeContainerNo(raw: string | null | undefined): string {
  return (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * ISO 6346 check digit for the 10-char prefix (4 letters + 6 digits): each
 * character's value is weighted by 2^position, summed, then taken mod 11 —
 * a remainder of 10 maps to 0. Returns null if the prefix isn't well-formed.
 */
export function iso6346CheckDigit(prefix: string): number | null {
  const p = normalizeContainerNo(prefix);
  if (!/^[A-Z]{4}\d{6}$/.test(p)) return null;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = p[i];
    const value = i < 4 ? LETTER_VALUES[ch] : Number(ch);
    sum += value * 2 ** i;
  }
  const rem = sum % 11;
  return rem === 10 ? 0 : rem;
}

export type ContainerNoStatus = 'empty' | 'invalid' | 'valid';

export interface ContainerNoValidation {
  status: ContainerNoStatus;
  value: string;
  /** Set when status === 'invalid'. */
  reason?: 'format' | 'checkDigit';
  /** The check digit the algorithm expected, when reason === 'checkDigit'. */
  expectedCheckDigit?: number;
}

/** Validate a container number's shape AND its ISO 6346 check digit. */
export function validateContainerNo(raw: string | null | undefined): ContainerNoValidation {
  const value = normalizeContainerNo(raw);
  if (!value) return { status: 'empty', value };
  if (!CONTAINER_RE.test(value)) return { status: 'invalid', value, reason: 'format' };
  const expected = iso6346CheckDigit(value.slice(0, 10));
  if (expected == null || expected !== Number(value[10])) {
    return {
      status: 'invalid',
      value,
      reason: 'checkDigit',
      expectedCheckDigit: expected == null ? undefined : expected,
    };
  }
  return { status: 'valid', value };
}

export function isValidContainerNo(raw: string | null | undefined): boolean {
  return validateContainerNo(raw).status === 'valid';
}

/* --------------------------- carrier hint --------------------------- */

// Owner-prefix → operator. A display hint only (BIC owner codes are stable
// but a container can be leased/SOC and carried by another line), so we
// never gate tracking on it. Covers the majors a Ligne Roset shipment to
// the Caribbean might ride on; Hapag-Lloyd first since that's the API.
const CARRIER_BY_PREFIX: Record<string, string> = {
  HLCU: 'Hapag-Lloyd', HLXU: 'Hapag-Lloyd', HLBU: 'Hapag-Lloyd', HPLU: 'Hapag-Lloyd', UACU: 'Hapag-Lloyd',
  MAEU: 'Maersk', MRKU: 'Maersk', MSKU: 'Maersk', MSWU: 'Maersk', MRSU: 'Maersk', SUDU: 'Maersk', SEAU: 'Maersk',
  MSCU: 'MSC', MEDU: 'MSC',
  CMAU: 'CMA CGM', CGMU: 'CMA CGM', APLU: 'CMA CGM', APZU: 'CMA CGM',
  COSU: 'COSCO', CSNU: 'COSCO', CBHU: 'COSCO', CCLU: 'COSCO',
  EGHU: 'Evergreen', EGSU: 'Evergreen', EISU: 'Evergreen', EMCU: 'Evergreen',
  ONEU: 'ONE', NYKU: 'ONE', MOLU: 'ONE', MOAU: 'ONE', KKLU: 'ONE', KKFU: 'ONE',
  YMLU: 'Yang Ming', YMMU: 'Yang Ming',
  HMMU: 'HMM', HDMU: 'HMM',
  ZIMU: 'ZIM', ZCSU: 'ZIM',
  OOLU: 'OOCL', OOCU: 'OOCL',
};

/** Best-effort carrier name from the 4-letter owner prefix, or null. */
export function detectCarrier(raw: string | null | undefined): string | null {
  const value = normalizeContainerNo(raw);
  if (value.length < 4) return null;
  return CARRIER_BY_PREFIX[value.slice(0, 4)] || null;
}

/* --------------------- DCSA Track & Trace events -------------------- */

export type EventClassifier = 'ACT' | 'EST' | 'PLN';

export interface TrackingMilestone {
  type: string;              // SHIPMENT | TRANSPORT | EQUIPMENT
  classifier: string;        // ACT (actual) | EST (estimated) | PLN (planned)
  code: string | null;       // DEPA / ARRI / LOAD / GTIN / …
  label: string;             // human label (es)
  at: number | null;         // event time, ms
  location: string | null;
  mode: string | null;       // VESSEL | RAIL | TRUCK | BARGE
  vessel: string | null;
  voyage: string | null;
  empty: string | null;      // EMPTY | LADEN (equipment events)
}

export interface TrackingSummary {
  milestones: TrackingMilestone[]; // ascending by time
  last: TrackingMilestone | null;  // most recent ACTual event
  eta: TrackingMilestone | null;   // estimated/planned final arrival
  count: number;
}

const TRANSPORT_LABELS: Record<string, string> = { ARRI: 'Llegada', DEPA: 'Salida' };
const EQUIPMENT_LABELS: Record<string, string> = {
  LOAD: 'Cargado', DISC: 'Descargado', GTIN: 'Entrada a terminal',
  GTOT: 'Salida de terminal', STUF: 'Llenado', STRP: 'Vaciado',
};
const SHIPMENT_LABELS: Record<string, string> = { ISSU: 'Documento emitido', CONF: 'Confirmado' };

export const MODE_LABELS: Record<string, string> = {
  VESSEL: 'Barco', RAIL: 'Tren', TRUCK: 'Camión', BARGE: 'Barcaza',
};
export const CLASSIFIER_LABELS: Record<string, string> = {
  ACT: 'Real', EST: 'Estimado', PLN: 'Planificado',
};

function locName(loc: any): string | null {
  if (!loc) return null;
  return loc.locationName || loc.UNLocationCode || null;
}

function toMs(iso: any): number | null {
  if (!iso) return null;
  const t = Date.parse(String(iso));
  return Number.isNaN(t) ? null : t;
}

/** Flatten one raw DCSA event into a display milestone. */
export function normalizeEvent(ev: any): TrackingMilestone {
  const type = ev?.eventType || '';
  const m: TrackingMilestone = {
    type,
    classifier: ev?.eventClassifierCode || '',
    code: null,
    label: '',
    at: toMs(ev?.eventDateTime),
    location: null,
    mode: null,
    vessel: null,
    voyage: null,
    empty: null,
  };
  if (type === 'TRANSPORT') {
    const tc = ev?.transportCall || {};
    m.code = ev?.transportEventTypeCode || null;
    m.label = (m.code && TRANSPORT_LABELS[m.code]) || m.code || 'Transporte';
    m.mode = tc?.modeOfTransport || null;
    m.location = locName(tc?.location) || tc?.UNLocationCode || null;
    m.vessel = tc?.vessel?.vesselName || null;
    m.voyage = tc?.exportVoyageNumber || tc?.importVoyageNumber || null;
  } else if (type === 'EQUIPMENT') {
    m.code = ev?.equipmentEventTypeCode || null;
    m.label = (m.code && EQUIPMENT_LABELS[m.code]) || m.code || 'Equipo';
    m.location = locName(ev?.eventLocation) || locName(ev?.transportCall?.location) || null;
    m.mode = ev?.transportCall?.modeOfTransport || null;
    m.empty = ev?.emptyIndicatorCode || null;
  } else if (type === 'SHIPMENT') {
    m.code = ev?.shipmentEventTypeCode || null;
    m.label = (m.code && SHIPMENT_LABELS[m.code]) || m.code || 'Documento';
  } else {
    m.label = type || 'Evento';
  }
  return m;
}

/**
 * Turn the raw event array into a sorted timeline plus two derived facts:
 * `last` (the most recent ACTual event = last known status/location) and
 * `eta` (the latest estimated/planned ARRIval = final destination ETA).
 */
export function summarizeTracking(events: any[] | null | undefined): TrackingSummary {
  const list = Array.isArray(events) ? events : [];
  const milestones = list
    .map(normalizeEvent)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

  let last: TrackingMilestone | null = null;
  let lastAt = -Infinity;
  let eta: TrackingMilestone | null = null;
  let etaAt = -Infinity;
  for (const m of milestones) {
    if (m.at == null) continue;
    if (m.classifier === 'ACT' && m.at >= lastAt) {
      last = m;
      lastAt = m.at;
    }
    if (m.code === 'ARRI' && (m.classifier === 'EST' || m.classifier === 'PLN') && m.at >= etaAt) {
      eta = m;
      etaAt = m.at;
    }
  }

  return { milestones, last, eta, count: milestones.length };
}
