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

import { lookupPort } from './portCoordinates.js';
import { haversineKm } from './voyageGeometry.js';

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
  location: string | null;   // human display name (or UN/LOCODE fallback)
  unloc: string | null;      // raw UN/LOCODE, for map geocoding
  lat: number | null;        // event coordinate, when the carrier supplies one
  lon: number | null;
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

function locUnloc(loc: any): string | null {
  if (!loc) return null;
  return loc.UNLocationCode || null;
}

/** Pull a {lat, lon} off a DCSA location object when the carrier includes one. */
function locCoords(loc: any): { lat: number; lon: number } | null {
  if (!loc) return null;
  const lat = Number(loc.latitude);
  const lon = Number(loc.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  return null;
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
    unloc: null,
    lat: null,
    lon: null,
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
    m.unloc = locUnloc(tc?.location) || tc?.UNLocationCode || null;
    const c = locCoords(tc?.location);
    if (c) { m.lat = c.lat; m.lon = c.lon; }
    m.vessel = tc?.vessel?.vesselName || null;
    m.voyage = tc?.exportVoyageNumber || tc?.importVoyageNumber || null;
  } else if (type === 'EQUIPMENT') {
    m.code = ev?.equipmentEventTypeCode || null;
    m.label = (m.code && EQUIPMENT_LABELS[m.code]) || m.code || 'Equipo';
    m.location = locName(ev?.eventLocation) || locName(ev?.transportCall?.location) || null;
    m.unloc = locUnloc(ev?.eventLocation) || locUnloc(ev?.transportCall?.location) || null;
    const c = locCoords(ev?.eventLocation) || locCoords(ev?.transportCall?.location);
    if (c) { m.lat = c.lat; m.lon = c.lon; }
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

/* ------------------------- map route shaping ------------------------ */

export interface RouteStop {
  lat: number;
  lon: number;
  name: string;                  // port name (event-supplied, else table, else code)
  unloc: string | null;
  at: number | null;            // most recent event time at this stop, ms
  events: TrackingMilestone[];  // every event that happened here, in order
  isLast: boolean;              // the last-known ACTual position
  isEta: boolean;               // the estimated/planned arrival (destination)
}

export interface TrackingRoute {
  stops: RouteStop[];   // chronological, consecutive same-port events merged
  lastIndex: number;    // index of the last-known position in stops, or -1
  etaIndex: number;     // index of the ETA stop in stops, or -1
}

/** Coordinate for a milestone: the carrier's own lat/lon if present, else the
 *  UN/LOCODE table. Returns null when neither resolves (not mappable). */
function milestoneCoords(m: TrackingMilestone): { lat: number; lon: number; name: string | null } | null {
  if (m.lat != null && m.lon != null && Number.isFinite(m.lat) && Number.isFinite(m.lon)) {
    return { lat: m.lat, lon: m.lon, name: m.location };
  }
  const port = lookupPort(m.unloc);
  if (port) return { lat: port.lat, lon: port.lon, name: port.name };
  return null;
}

/**
 * Turn a TrackingSummary into an ordered list of map stops. Milestones that
 * don't geocode are skipped (they remain in the textual timeline); CONSECUTIVE
 * events at the same place collapse into one stop (LOAD→DEPA at the load port,
 * ARRI→DISC at destination), so the map shows the voyage's port hops rather
 * than one pin per raw event. The stop carrying `summary.last` / `summary.eta`
 * is flagged so the UI can style the current position and the destination.
 */
export function buildTrackingRoute(summary: TrackingSummary | null | undefined): TrackingRoute {
  const empty: TrackingRoute = { stops: [], lastIndex: -1, etaIndex: -1 };
  if (!summary || !Array.isArray(summary.milestones) || summary.milestones.length === 0) {
    return empty;
  }

  // Internal `key` groups consecutive events at one place; stripped before return.
  type WorkingStop = RouteStop & { key: string; nameFromEvent: boolean };
  const stops: WorkingStop[] = [];

  for (const m of summary.milestones) {
    const coords = milestoneCoords(m);
    if (!coords) continue;
    const key = (m.unloc && m.unloc.toUpperCase()) || `${coords.lat.toFixed(3)},${coords.lon.toFixed(3)}`;
    // A "real" name is an event place name that isn't just the bare UN/LOCODE.
    // When the event carries only the code, the port table's nicer name wins.
    const realName = m.location && m.location !== m.unloc ? m.location : null;
    const prev = stops[stops.length - 1];
    if (prev && prev.key === key) {
      prev.events.push(m);
      if (m.at != null && (prev.at == null || m.at > prev.at)) prev.at = m.at;
      if (!prev.nameFromEvent && realName) { prev.name = realName; prev.nameFromEvent = true; }
      continue;
    }
    stops.push({
      key,
      lat: coords.lat,
      lon: coords.lon,
      name: realName || coords.name || m.location || m.unloc || '—',
      nameFromEvent: !!realName,
      unloc: m.unloc,
      at: m.at,
      events: [m],
      isLast: false,
      isEta: false,
    });
  }

  let lastIndex = -1;
  let etaIndex = -1;
  stops.forEach((s, i) => {
    if (summary.last && s.events.includes(summary.last)) { s.isLast = true; lastIndex = i; }
    if (summary.eta && s.events.includes(summary.eta)) { s.isEta = true; etaIndex = i; }
  });

  const cleaned: RouteStop[] = stops.map(({ key, nameFromEvent, ...rest }) => rest);
  return { stops: cleaned, lastIndex, etaIndex };
}

/* --------------------------- voyage summary ------------------------- */

/** High-level facts for the map's voyage HUD: endpoints, the vessel/voyage,
 *  key timestamps, and great-circle progress. All derived — no I/O. */
export interface VoyageSummary {
  origin: RouteStop | null;
  destination: RouteStop | null; // the ETA stop, else the last known stop
  current: RouteStop | null;     // the last-known ACTual position
  vessel: string | null;
  voyage: string | null;
  carrier: string | null;        // guessed from the container's owner prefix
  departedAt: number | null;     // most recent activity at the origin, ms
  updatedAt: number | null;      // last ACTual event time, ms
  etaAt: number | null;          // estimated arrival, ms
  totalKm: number;               // great-circle length origin → destination
  sailedKm: number;              // origin → current
  remainingKm: number;
  progressPct: number;           // 0..100
  arrived: boolean;
}

/** Sum the great-circle distance over stops[from..to] (inclusive indices). */
function legSumKm(stops: RouteStop[], from: number, to: number): number {
  let sum = 0;
  for (let i = from + 1; i <= to; i++) {
    sum += haversineKm([stops[i - 1].lat, stops[i - 1].lon], [stops[i].lat, stops[i].lon]);
  }
  return sum;
}

export function summarizeVoyage(
  route: TrackingRoute | null | undefined,
  summary: TrackingSummary | null | undefined,
  containerNo?: string | null,
): VoyageSummary {
  const stops = route?.stops || [];
  const base: VoyageSummary = {
    origin: null, destination: null, current: null,
    vessel: null, voyage: null, carrier: detectCarrier(containerNo),
    departedAt: null, updatedAt: summary?.last?.at ?? null, etaAt: summary?.eta?.at ?? null,
    totalKm: 0, sailedKm: 0, remainingKm: 0, progressPct: 0, arrived: false,
  };
  if (stops.length === 0 || !route) return base;

  const lastIndex = route.lastIndex;
  const destIndex = route.etaIndex >= 0 ? route.etaIndex : stops.length - 1;

  base.origin = stops[0];
  base.destination = stops[destIndex] || null;
  base.current = lastIndex >= 0 ? stops[lastIndex] : null;
  base.departedAt = base.origin?.at ?? null;

  // Vessel + voyage: the most recent event that names each.
  const ms = summary?.milestones || [];
  for (let i = ms.length - 1; i >= 0; i--) {
    if (!base.vessel && ms[i].vessel) base.vessel = ms[i].vessel;
    if (!base.voyage && ms[i].voyage) base.voyage = ms[i].voyage;
    if (base.vessel && base.voyage) break;
  }

  base.totalKm = legSumKm(stops, 0, destIndex);
  const sailedTo = lastIndex >= 0 ? Math.min(lastIndex, destIndex) : 0;
  base.sailedKm = legSumKm(stops, 0, sailedTo);
  base.remainingKm = Math.max(0, base.totalKm - base.sailedKm);
  base.arrived = lastIndex >= 0 && lastIndex >= destIndex;
  base.progressPct = base.arrived
    ? 100
    : base.totalKm > 0 ? Math.min(100, (base.sailedKm / base.totalKm) * 100) : 0;

  return base;
}
