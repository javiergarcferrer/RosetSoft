/**
 * DR labor entitlements & termination liquidation — Código de Trabajo (Ley 16-92).
 *
 * The recurring monthly nómina (TSS + ISR) lives in `payroll.ts`; this module is
 * the periodic / one-off side: the regalía pascual (salario de Navidad),
 * vacaciones, and the prestaciones laborales paid when a contract ends
 * (preaviso, cesantía, asistencia económica) plus the derechos adquiridos
 * roll-up — each tagged with its ISR/TSS treatment.
 *
 * Day schedules are flat counts straight from the code; pay = daily wage × days,
 * the daily wage being the monthly salary ÷ 23.83 (the MT convention, shared
 * with payroll.ts). Pure: no React, no Supabase.
 */
import { round2 } from './ledger.js';
import { DAILY_DIVISOR } from './payroll.js';

/** Daily wage from a monthly salary (÷ 23.83 by DR convention). */
export function dailyWage(monthlySalary: number, divisor = DAILY_DIVISOR): number {
  const d = divisor && divisor > 0 ? divisor : DAILY_DIVISOR;
  return round2((Number(monthlySalary) || 0) / d);
}

// ── Vacaciones (Arts. 177 / 180) ────────────────────────────────────────────

/** Vacation WORKING-days entitlement by completed years of service (Art. 177):
 *  14 days at 1–5 years, 18 days at 5+ years, none before the first year. */
export function vacationDays(years: number): number {
  const y = Number(years) || 0;
  if (y >= 5) return 18;
  if (y >= 1) return 14;
  return 0;
}

/** Proportional vacation days in the first year, by completed months of service
 *  (Art. 180): >5mo→6, then +1/month up to 12 days at 11mo; <5mo→none. */
export function vacationProportionalDays(months: number): number {
  const m = Math.floor(Number(months) || 0);
  if (m >= 12) return 14;
  if (m < 5) return 0;
  return m + 1; // 5→6, 6→7, … 11→12
}

/** Vacation pay = daily wage × days. Vacaciones are ordinary salary (ISR + TSS). */
export function vacationPay(monthlySalary: number, days: number, divisor = DAILY_DIVISOR): number {
  return round2(dailyWage(monthlySalary, divisor) * (Number(days) || 0));
}

// ── Regalía pascual / salario de Navidad (Arts. 219–222) ─────────────────────

export interface Regalia { legal: number; amount: number; isrExempt: number; isrTaxable: number; }

/**
 * Regalía pascual: 1/12 of the ordinary salary earned in the calendar year
 * (overtime and profit-sharing excluded from the base). ISR-exempt up to that
 * legal 1/12; any voluntary excess paid above it is taxable. Never in the TSS
 * salario cotizable. `paid` defaults to the legal amount.
 */
export function regaliaPascual(ordinaryEarnedYTD: number, paid?: number): Regalia {
  const legal = round2((Number(ordinaryEarnedYTD) || 0) / 12);
  const amount = paid != null ? round2(paid) : legal;
  const isrExempt = round2(Math.min(amount, legal));
  return { legal, amount, isrExempt, isrTaxable: round2(Math.max(0, amount - isrExempt)) };
}

// ── Prestaciones laborales: day schedules ────────────────────────────────────

/** Completed months of service between hire and termination. */
export function monthsOfService(startMs: number, endMs: number): number {
  if (!startMs || !endMs) return 0;
  const s = new Date(startMs);
  const e = new Date(endMs);
  let m = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
  if (e.getDate() < s.getDate()) m -= 1;
  return Math.max(0, m);
}

/** Preaviso (notice) days by tenure — flat counts (Art. 76). */
export function preavisoDays(months: number): number {
  const m = Number(months) || 0;
  if (m < 3) return 0;
  if (m < 6) return 7;
  if (m < 12) return 14;
  return 28;
}

/** Auxilio de cesantía days (Art. 80): 6 / 13 in the first year, then 21 days
 *  per year (1–5 yrs) or 23 per year (>5 yrs) applied to the whole tenure. */
export function cesantiaDays(months: number): number {
  const m = Number(months) || 0;
  if (m < 3) return 0;
  if (m < 6) return 6;
  if (m < 12) return 13;
  const years = m / 12;
  return round2((years > 5 ? 23 : 21) * years);
}

/** Asistencia económica days for no-fault terminations (Art. 82): 5 / 10 in the
 *  first year, then 15 days per year — NOT cesantía, a smaller separate scale. */
export function asistenciaEconomicaDays(months: number): number {
  const m = Number(months) || 0;
  if (m < 3) return 0;
  if (m < 6) return 5;
  if (m < 12) return 10;
  return round2(15 * (m / 12));
}

// ── Liquidación (full termination payout) ────────────────────────────────────

export type TerminationType =
  | 'desahucio'             // no-cause termination (bilateral — see initiatedBy)
  | 'despido_justificado'   // dismissal for just cause (Art. 88)
  | 'despido_injustificado' // dismissal without cause
  | 'dimision_justificada'  // resignation with employer at fault
  | 'dimision_injustificada'// resignation without cause
  | 'no_fault';             // illness / death / force majeure (Art. 82)

export interface LiquidacionInput {
  monthlySalary: number;
  startMs: number;
  endMs: number;
  terminationType: TerminationType;
  /** For desahucio: who gave it. Worker-desahucio owes NO cesantía. */
  initiatedBy?: 'employer' | 'worker';
  /** Ordinary salary earned Jan 1 → termination, for the proportional regalía.
   *  Defaults to salary × months elapsed in the termination's calendar year. */
  ordinaryEarnedYTD?: number;
  /** Unused vacation days to cash out (derecho adquirido). */
  pendingVacationDays?: number;
  divisor?: number;
}

export interface Liquidacion {
  months: number;
  daily: number;
  preavisoDays: number; cesantiaDays: number; asistenciaDays: number;
  preaviso: number; cesantia: number; asistencia: number;
  vacaciones: number; regalia: number;
  /** ISR/TSS-exempt portion (preaviso + cesantía + asistencia + exempt regalía). */
  exempt: number;
  /** ISR-taxable portion (vacaciones + any regalía excess). */
  taxable: number;
  total: number;
}

/** Does this termination obligate the employer to preaviso + cesantía? */
function owesPrestaciones(type: TerminationType, initiatedBy?: string): boolean {
  if (type === 'desahucio') return initiatedBy !== 'worker';
  return type === 'despido_injustificado' || type === 'dimision_justificada';
}

/**
 * Full liquidación: preaviso + cesantía (or asistencia económica for no-fault) +
 * the derechos adquiridos (proportional vacaciones + proportional regalía) that
 * are owed in EVERY case. Preaviso/cesantía/asistencia are ISR- and TSS-exempt;
 * vacaciones are taxable; regalía is exempt up to its 1/12 cap.
 */
export function liquidacion(input: LiquidacionInput): Liquidacion {
  const { monthlySalary, startMs, endMs, terminationType, initiatedBy } = input;
  const months = monthsOfService(startMs, endMs);
  const daily = dailyWage(monthlySalary, input.divisor);
  const owes = owesPrestaciones(terminationType, initiatedBy);

  const pDays = owes ? preavisoDays(months) : 0;
  const cDays = owes ? cesantiaDays(months) : 0;
  const aDays = terminationType === 'no_fault' ? asistenciaEconomicaDays(months) : 0;
  const preaviso = round2(daily * pDays);
  const cesantia = round2(daily * cDays);
  const asistencia = round2(daily * aDays);

  const vacaciones = round2(daily * (Number(input.pendingVacationDays) || 0));

  const monthsThisYear = new Date(endMs || Date.now()).getMonth() + 1; // Jan→end
  const ytd = input.ordinaryEarnedYTD != null
    ? input.ordinaryEarnedYTD
    : round2((Number(monthlySalary) || 0) * monthsThisYear);
  const reg = regaliaPascual(ytd);

  const exempt = round2(preaviso + cesantia + asistencia + reg.isrExempt);
  const taxable = round2(vacaciones + reg.isrTaxable);
  return {
    months, daily,
    preavisoDays: pDays, cesantiaDays: cDays, asistenciaDays: aDays,
    preaviso, cesantia, asistencia,
    vacaciones, regalia: reg.amount,
    exempt, taxable,
    total: round2(preaviso + cesantia + asistencia + vacaciones + reg.amount),
  };
}
