/**
 * Landed-cost CALCULATOR Model — the interactive "land my costs fast" engine.
 *
 * Where `expediente.ts` posts the accounting liquidation, this is the simulator
 * the dealer plays with BEFORE (or instead of) booking: drop in the goods, the
 * freight, pick the Incoterm + origin regime, and read the per-unit landed cost
 * and the price to hit a margin — recomputed live on every keystroke.
 *
 * It encodes the same DGA cascade the posting Model uses, plus the three pieces
 * that matter for getting the number RIGHT and FAST:
 *
 *   1. HS-/origin-driven duty.  Furniture (HS 9401/9403/9404) is the 20% MFN
 *      top band — BUT EU-origin goods (French Ligne Roset) clear at 0% under the
 *      CARIFORUM–EU EPA when a valid EUR.1 / origin proof travels with them. So
 *      `dutyRate` is per-line, not a flat constant.
 *   2. The 0.4%-of-CIF customs service fee (tasa por servicios aduaneros) the
 *      posting Model doesn't yet line-item.
 *   3. Per-bucket cost allocation.  Ocean freight on bulky-but-light furniture
 *      should spread by VOLUME (m³), not value — the single biggest accuracy
 *      lever. Each cost bucket carries its own allocation basis.
 *
 * The DGA stack (per CIF line, all percentages, currency-agnostic):
 *   CIF       = goods + (intl freight + insurance, when not already in the price)
 *   gravamen  = CIF × dutyRate          (0% EPA · 20% MFN furniture)
 *   ISC       = CIF × iscRate           (0 for furniture)
 *   ITBIS     = (CIF + gravamen + ISC) × itbisRate   ← RECOVERABLE input credit
 *   servicio  = CIF × serviceFeeRate    (0.4%)
 *   landed    = CIF + gravamen + ISC + servicio + local costs   (excludes ITBIS)
 *
 * ITBIS is recoverable, so — like the posting Model — it never enters the landed
 * cost; it's surfaced separately. Pure: no React, no Supabase, no currency (the
 * View multiplies by the USD→DOP rate for display).
 */
import { round2 } from './ledger.js';

/** 4-dp round for a unit cost (matches the kardex IN precision). */
function round4(n: number): number {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

// ───────────────────────────────────────────────────────────── Incoterms 2020
/**
 * What the SELLER's price already covers — drives which cost buckets the buyer
 * must still add, and how the customs value (CIF) is composed.
 *   freightIncluded   → goods price already carries main carriage (CFR…DDP)
 *   insuranceIncluded → …and insurance (CIF, CIP, DAP, DPU, DDP)
 *   importCleared     → seller paid the import duty + taxes too (DDP only)
 */
export interface Incoterm {
  code: string;
  label: string;
  freightIncluded: boolean;
  insuranceIncluded: boolean;
  importCleared: boolean;
  /** One-line plain-language note for the UI. */
  hint: string;
}

export const INCOTERMS: ReadonlyArray<Incoterm> = [
  { code: 'EXW', label: 'EXW — En fábrica', freightIncluded: false, insuranceIncluded: false, importCleared: false, hint: 'Tú asumes todo: salida, flete, seguro, despacho y aranceles.' },
  { code: 'FCA', label: 'FCA — Franco transportista', freightIncluded: false, insuranceIncluded: false, importCleared: false, hint: 'El vendedor despacha la exportación; tú pones flete y seguro.' },
  { code: 'FAS', label: 'FAS — Franco al costado', freightIncluded: false, insuranceIncluded: false, importCleared: false, hint: 'Mercancía al costado del buque; flete y seguro a tu cargo.' },
  { code: 'FOB', label: 'FOB — Franco a bordo', freightIncluded: false, insuranceIncluded: false, importCleared: false, hint: 'El precio llega a bordo; sumas flete + seguro al CIF.' },
  { code: 'CFR', label: 'CFR — Costo y flete', freightIncluded: true, insuranceIncluded: false, importCleared: false, hint: 'El flete ya viene en el precio; agrega el seguro.' },
  { code: 'CIF', label: 'CIF — Costo, seguro y flete', freightIncluded: true, insuranceIncluded: true, importCleared: false, hint: 'Flete y seguro ya incluidos: el precio ES el valor CIF.' },
  { code: 'CPT', label: 'CPT — Transporte pagado', freightIncluded: true, insuranceIncluded: false, importCleared: false, hint: 'Flete incluido hasta destino; el seguro corre por tu cuenta.' },
  { code: 'CIP', label: 'CIP — Transporte y seguro pagados', freightIncluded: true, insuranceIncluded: true, importCleared: false, hint: 'Flete y seguro incluidos; faltan despacho y aranceles.' },
  { code: 'DAP', label: 'DAP — Entregada en lugar', freightIncluded: true, insuranceIncluded: true, importCleared: false, hint: 'Llega al destino; tú haces el despacho y pagas aranceles.' },
  { code: 'DPU', label: 'DPU — Entregada y descargada', freightIncluded: true, insuranceIncluded: true, importCleared: false, hint: 'Como DAP, ya descargada; aranceles a tu cargo.' },
  { code: 'DDP', label: 'DDP — Entregada con aranceles', freightIncluded: true, insuranceIncluded: true, importCleared: true, hint: 'Todo incluido: el vendedor pagó hasta los aranceles.' },
];

export function incotermFor(code: string | null | undefined): Incoterm {
  return INCOTERMS.find((i) => i.code === code) || INCOTERMS[3]; // default FOB
}

// ─────────────────────────────────────────────────────── Cost buckets + basis
/**
 * `intl` buckets (freight, insurance) compose the customs value (CIF) — they're
 * added BEFORE duty. `local` buckets (broker, port, inland, other) are incurred
 * at/after clearance in the DR: they capitalize into landed cost but never into
 * the dutiable base.
 */
export type CostBucketKind = 'intl' | 'local';
export interface CostBucketDef {
  key: string;
  label: string;
  kind: CostBucketKind;
  /** Sensible default allocation basis for this bucket. */
  defaultAllocation: AllocationMethod;
}

export const COST_BUCKETS: ReadonlyArray<CostBucketDef> = [
  { key: 'freight', label: 'Flete internacional', kind: 'intl', defaultAllocation: 'volume' },
  { key: 'insurance', label: 'Seguro', kind: 'intl', defaultAllocation: 'value' },
  { key: 'broker', label: 'Agenciamiento aduanal', kind: 'local', defaultAllocation: 'value' },
  { key: 'port', label: 'Puerto / manejo (Caucedo)', kind: 'local', defaultAllocation: 'volume' },
  { key: 'inland', label: 'Transporte terrestre', kind: 'local', defaultAllocation: 'volume' },
  { key: 'other', label: 'Otros (almacenaje, bancarios…)', kind: 'local', defaultAllocation: 'value' },
];

export function bucketDef(key: string): CostBucketDef {
  return COST_BUCKETS.find((b) => b.key === key) || COST_BUCKETS[COST_BUCKETS.length - 1];
}

// ───────────────────────────────────────────────────── Allocation of one cost
/**
 * How a shared cost is split across the product lines. The math is identical for
 * every method — only the per-line METRIC changes:
 *   value  → goods value (unitCost × qty)     (good for duty/insurance)
 *   volume → m³ of the line                    (best for ocean freight)
 *   weight → kg of the line                    (air / dense freight)
 *   qty    → number of pieces
 *   equal  → split evenly
 */
export type AllocationMethod = 'value' | 'volume' | 'weight' | 'qty' | 'equal';

export const ALLOCATION_METHODS: ReadonlyArray<{ key: AllocationMethod; label: string; short: string }> = [
  { key: 'volume', label: 'Por volumen (m³)', short: 'm³' },
  { key: 'value', label: 'Por valor', short: 'valor' },
  { key: 'weight', label: 'Por peso (kg)', short: 'kg' },
  { key: 'qty', label: 'Por cantidad', short: 'cant.' },
  { key: 'equal', label: 'Partes iguales', short: 'iguales' },
];

export interface CalcLine {
  id: string;
  name?: string;
  qty: number;
  /** Goods price per unit in the entry currency (FOB, or CIF when the Incoterm
   *  already bundles freight/insurance). */
  unitCost: number;
  /** Total m³ for the line (not per-unit) — the volume allocation metric. */
  cbm?: number;
  /** Total kg for the line — the weight allocation metric. */
  weightKg?: number;
  hsCode?: string;
  /** Per-line duty % override; falls back to the input's `dutyRate`. */
  dutyRate?: number;
  /** ISC % (0 for furniture). */
  iscRate?: number;
}

export interface CalcCost {
  id: string;
  label?: string;
  /** One of COST_BUCKETS' keys. */
  bucket: string;
  amount: number;
  allocation: AllocationMethod;
  /** Recoverable ITBIS portion of `amount` (local costs with an NCF). */
  itbis?: number;
}

export interface CalcInput {
  lines: CalcLine[];
  costs: CalcCost[];
  incoterm: string;
  /** ITBIS general rate (18). */
  itbisRate: number;
  /** Default duty % when a line carries none (20 MFN furniture · 0 EPA). */
  dutyRate: number;
  /** Customs service fee % of CIF (0.4). */
  serviceFeeRate: number;
  /** Target gross margin % for the suggested sell price. */
  targetMargin: number;
}

const clampPos = (n: unknown): number => Math.max(0, Number(n) || 0);

function metricFor(method: AllocationMethod): (l: CalcLine) => number {
  switch (method) {
    case 'volume': return (l) => clampPos(l.cbm);
    case 'weight': return (l) => clampPos(l.weightKg);
    case 'qty': return (l) => clampPos(l.qty);
    case 'equal': return () => 1;
    case 'value':
    default: return (l) => clampPos(l.unitCost) * clampPos(l.qty);
  }
}

/**
 * Split `total` across `lines` by `method`. Rounding drift lands on the last
 * line so Σ shares === total exactly. Falls back to an even split when the
 * chosen metric is all-zero (e.g. "by volume" but no m³ entered yet).
 */
export function allocate(lines: readonly CalcLine[], total: number, method: AllocationMethod): number[] {
  const t = round2(clampPos(total));
  const n = lines.length;
  if (n === 0 || t === 0) return lines.map(() => 0);
  const metric = metricFor(method);
  const metrics = lines.map(metric);
  const sumM = metrics.reduce((a, b) => a + b, 0);
  let assigned = 0;
  return lines.map((_, i) => {
    let share = sumM > 0 ? round2((t * metrics[i]) / sumM) : round2(t / n);
    if (i === n - 1) share = round2(t - assigned); // drift → last
    assigned = round2(assigned + share);
    return share;
  });
}

// ──────────────────────────────────────────────────────── Margin back-calc
/** Sell price that yields `marginPct` gross margin over `landed` (margin on the
 *  SALE price): price = landed / (1 − margin). Clamped; ≥100% margin → 0. */
export function priceForMargin(landed: number, marginPct: number): number {
  const m = Math.min(99.999, Math.max(0, Number(marginPct) || 0)) / 100;
  if (m <= 0) return round2(landed);
  return round2(clampPos(landed) / (1 - m));
}

/** Gross margin % implied by selling `landed` at `price`. */
export function marginForPrice(landed: number, price: number): number {
  const p = clampPos(price);
  if (p <= 0) return 0;
  return round2(((p - clampPos(landed)) / p) * 100);
}

// ──────────────────────────────────────────────────────────── The engine
export interface CalcResultLine {
  id: string;
  name: string;
  qty: number;
  goods: number;
  /** Allocated international freight + insurance folded into this line. */
  intlAdd: number;
  cif: number;
  dutyRate: number;
  duty: number;
  isc: number;
  /** Recoverable — NOT in `landedTotal`. */
  itbis: number;
  serviceFee: number;
  /** Allocated local costs, net of their recoverable ITBIS. */
  localCosts: number;
  landedTotal: number;
  landedUnit: number;
  suggestedPrice: number;
}

export interface CalcWaterfallStep {
  key: string;
  label: string;
  amount: number;
  cumulative: number;
}

export interface CalcResult {
  incoterm: Incoterm;
  lines: CalcResultLine[];
  totals: {
    goods: number;
    freight: number;
    insurance: number;
    cif: number;
    duty: number;
    isc: number;
    itbis: number;
    serviceFee: number;
    localCostsNet: number;
    localCostsItbis: number;
    landed: number;
    /** All recoverable input ITBIS = import ITBIS + local-cost ITBIS. */
    creditableItbis: number;
    /** Cash paid to DGA at clearance: gravamen + ISC + ITBIS + servicio. */
    taxesAtCustoms: number;
    /** Taxes that actually hit cost (ITBIS excluded — it's recovered). */
    capitalizedTaxes: number;
  };
  /** Steps that sum exactly to `landed` (ITBIS shown separately, recoverable). */
  waterfall: CalcWaterfallStep[];
  /** taxesAtCustoms ÷ CIF — the headline effective rate (≈18.4% EPA / 41.6% MFN). */
  effectiveCustomsRate: number;
  units: number;
  landedPerUnitAvg: number;
}

/**
 * Resolve a whole shipment into per-line landed costs + the roll-up, the cost
 * waterfall and the effective rate. Pure — the single source the calculator
 * screen (and any PDF/export) reads from.
 */
export function computeLanded(input: CalcInput): CalcResult {
  const incoterm = incotermFor(input.incoterm);
  const itbisRate = clampPos(input.itbisRate);
  const serviceFeeRate = clampPos(input.serviceFeeRate);
  const defaultDuty = clampPos(input.dutyRate);
  const lines = (input.lines || []).filter((l) => clampPos(l.qty) > 0);
  const costs = input.costs || [];

  // 1) Split each cost across the lines by its own basis, bucketed by kind.
  //    `intl` (freight/insurance) only when the Incoterm hasn't already bundled
  //    it into the price; `local` always. DDP zeroes the customs taxes entirely.
  const intlAdd = lines.map(() => 0);
  const localNet = lines.map(() => 0);
  let freightTotal = 0;
  let insuranceTotal = 0;
  let localItbisTotal = 0;

  for (const c of costs) {
    const def = bucketDef(c.bucket);
    const gross = round2(clampPos(c.amount));
    if (gross <= 0) continue;
    if (def.kind === 'intl') {
      if (c.bucket === 'freight' && incoterm.freightIncluded) continue;
      if (c.bucket === 'insurance' && incoterm.insuranceIncluded) continue;
      const shares = allocate(lines, gross, c.allocation);
      shares.forEach((s, i) => { intlAdd[i] = round2(intlAdd[i] + s); });
      if (c.bucket === 'freight') freightTotal = round2(freightTotal + gross);
      else insuranceTotal = round2(insuranceTotal + gross);
    } else {
      // Net of recoverable ITBIS — only the net capitalizes into landed cost.
      const itbis = Math.min(round2(clampPos(c.itbis)), gross);
      const net = round2(gross - itbis);
      localItbisTotal = round2(localItbisTotal + itbis);
      const shares = allocate(lines, net, c.allocation);
      shares.forEach((s, i) => { localNet[i] = round2(localNet[i] + s); });
    }
  }

  // 2) Per-line DGA cascade.
  const ddp = incoterm.importCleared;
  const resLines: CalcResultLine[] = lines.map((l, i) => {
    const qty = clampPos(l.qty);
    const goods = round2(clampPos(l.unitCost) * qty);
    const cif = round2(goods + intlAdd[i]);
    const dutyRate = ddp ? 0 : (l.dutyRate != null ? clampPos(l.dutyRate) : defaultDuty);
    const iscRate = ddp ? 0 : clampPos(l.iscRate);
    const duty = round2((cif * dutyRate) / 100);
    const isc = round2((cif * iscRate) / 100);
    const itbis = ddp ? 0 : round2(((cif + duty + isc) * itbisRate) / 100);
    const serviceFee = ddp ? 0 : round2((cif * serviceFeeRate) / 100);
    const landedTotal = round2(cif + duty + isc + serviceFee + localNet[i]);
    const landedUnit = qty > 0 ? round4(landedTotal / qty) : 0;
    return {
      id: l.id,
      name: l.name || '',
      qty,
      goods,
      intlAdd: round2(intlAdd[i]),
      cif,
      dutyRate,
      duty,
      isc,
      itbis,
      serviceFee,
      localCosts: round2(localNet[i]),
      landedTotal,
      landedUnit,
      suggestedPrice: round4(priceForMargin(landedUnit, input.targetMargin)),
    };
  });

  const sum = (f: (l: CalcResultLine) => number) => round2(resLines.reduce((s, l) => s + f(l), 0));
  const goods = sum((l) => l.goods);
  const cif = sum((l) => l.cif);
  const duty = sum((l) => l.duty);
  const isc = sum((l) => l.isc);
  const itbis = sum((l) => l.itbis);
  const serviceFee = sum((l) => l.serviceFee);
  const localCostsNet = sum((l) => l.localCosts);
  const landed = sum((l) => l.landedTotal);
  const taxesAtCustoms = round2(duty + isc + itbis + serviceFee);
  const capitalizedTaxes = round2(duty + isc + serviceFee);
  const units = sum((l) => l.qty);

  // 3) Waterfall — every non-zero step, summing exactly to `landed`. ITBIS is
  //    intentionally absent (recoverable; shown as its own chip).
  const steps: Array<{ key: string; label: string; amount: number }> = [
    { key: 'goods', label: 'Mercancía (FOB)', amount: goods },
    { key: 'freight', label: 'Flete', amount: freightTotal },
    { key: 'insurance', label: 'Seguro', amount: insuranceTotal },
    { key: 'duty', label: 'Gravamen', amount: duty },
    { key: 'isc', label: 'ISC', amount: isc },
    { key: 'serviceFee', label: 'Servicio aduanal 0.4%', amount: serviceFee },
    { key: 'local', label: 'Costos locales', amount: localCostsNet },
  ];
  let cumulative = 0;
  const waterfall: CalcWaterfallStep[] = [];
  for (const s of steps) {
    if (s.amount === 0 && s.key !== 'goods') continue;
    cumulative = round2(cumulative + s.amount);
    waterfall.push({ ...s, cumulative });
  }

  return {
    incoterm,
    lines: resLines,
    totals: {
      goods,
      freight: freightTotal,
      insurance: insuranceTotal,
      cif,
      duty,
      isc,
      itbis,
      serviceFee,
      localCostsNet,
      localCostsItbis: localItbisTotal,
      landed,
      creditableItbis: round2(itbis + localItbisTotal),
      taxesAtCustoms,
      capitalizedTaxes,
    },
    waterfall,
    effectiveCustomsRate: cif > 0 ? round4((taxesAtCustoms / cif) * 100) : 0,
    units,
    landedPerUnitAvg: units > 0 ? round4(landed / units) : 0,
  };
}

// ──────────────────────────────────────────────────── DGA + furniture presets
/**
 * DR import defaults for the calculator. Duty is regime-dependent: furniture
 * (HS Ch. 94) is the 20% MFN top band, but EU-origin furniture under the
 * CARIFORUM–EU EPA clears at 0% with a valid EUR.1 / origin declaration.
 */
export const DGA_DEFAULTS = {
  itbisRate: 18,
  serviceFeeRate: 0.4,
  furnitureMfnDuty: 20,
  epaDuty: 0,
  iscFurniture: 0,
};

/** Origin/tariff regime → the duty rate it implies for furniture. */
export const ORIGIN_REGIMES: ReadonlyArray<{ key: string; label: string; duty: number; note: string }> = [
  { key: 'epa', label: 'UE · EPA (EUR.1)', duty: DGA_DEFAULTS.epaDuty, note: 'Origen UE con prueba EUR.1 / declaración de origen → 0% de gravamen.' },
  { key: 'mfn', label: 'NMF (sin preferencia)', duty: DGA_DEFAULTS.furnitureMfnDuty, note: 'Sin prueba de origen: gravamen de nación más favorecida (20% en muebles).' },
];

export function regimeDuty(key: string): number {
  return (ORIGIN_REGIMES.find((r) => r.key === key) || ORIGIN_REGIMES[1]).duty;
}

/** Furniture HS headings (Ch. 94) with the MFN duty band, for the quick picker. */
export const FURNITURE_HS: ReadonlyArray<{ code: string; label: string; mfnDuty: number }> = [
  { code: '9401', label: 'Asientos (sofás, sillas)', mfnDuty: 20 },
  { code: '9403', label: 'Los demás muebles (mesas, almacenaje)', mfnDuty: 20 },
  { code: '9404', label: 'Colchones / artículos de cama', mfnDuty: 20 },
];
