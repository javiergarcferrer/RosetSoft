// Landed-cost calculator ViewModel — projects the engine result for the
// calculator screen and adds the guardrail warnings (the pitfalls world-class
// import tools nag about: insurance forgotten under FOB, freight spread by value
// instead of volume for bulky furniture, no EPA origin proof so duty is 20%…).
// Pure: no React, no db. The View calls resolveLandedCalculator in a useMemo.
import {
  computeLanded, incotermFor, bucketDef, regimeDuty,
} from '../../lib/accounting/landedCalc.js';

/**
 * Build the human-readable guardrails for a scenario. Each is `{ level, text }`
 * where level ∈ 'warn' | 'info' — the View renders them as a checklist so a
 * commonly-forgotten cost is never silently zero.
 */
function buildWarnings(input, result) {
  const out = [];
  const incoterm = incotermFor(input.incoterm);
  const costs = input.costs || [];
  const has = (bucket) => costs.some((c) => c.bucket === bucket && Number(c.amount) > 0);

  // Insurance the buyer's responsibility but not entered.
  if (!incoterm.insuranceIncluded && !has('insurance')) {
    out.push({ level: 'warn', text: `Bajo ${incoterm.code} el seguro corre por tu cuenta y está en cero — agrégalo o el costo en destino quedará subestimado.` });
  }
  // Freight the buyer's responsibility but not entered.
  if (!incoterm.freightIncluded && !has('freight') && !incoterm.importCleared) {
    out.push({ level: 'warn', text: `Bajo ${incoterm.code} el flete internacional no está incluido en el precio y está en cero.` });
  }
  // Bulky furniture: freight spread by value rather than volume.
  const freightByValue = costs.some((c) => c.bucket === 'freight' && Number(c.amount) > 0 && c.allocation === 'value');
  const haveVolume = (input.lines || []).some((l) => Number(l.cbm) > 0);
  if (freightByValue) {
    out.push({ level: 'info', text: 'El flete marítimo de muebles se reparte mejor por VOLUMEN (m³) que por valor — son voluminosos pero livianos.' });
  }
  if (!haveVolume && (input.lines || []).length > 1) {
    out.push({ level: 'info', text: 'Sin m³ por línea, el reparto por volumen cae a partes iguales. Carga el volumen del packing list para un costo unitario fiel.' });
  }
  // EPA opportunity / risk.
  const epaDuty = regimeDuty('epa');
  const usingMfn = (input.lines || []).some((l) => {
    const d = l.dutyRate != null ? Number(l.dutyRate) : Number(input.dutyRate);
    return d > epaDuty;
  });
  if (usingMfn && !incoterm.importCleared) {
    out.push({ level: 'warn', text: 'Estás aplicando gravamen NMF. Si la mercancía es de origen UE, con una EUR.1 / declaración de origen el gravamen baja a 0% bajo el EPA.' });
  }
  // Local costs entirely missing — broker + port are almost never zero on an FCL.
  const anyLocal = costs.some((c) => bucketDef(c.bucket).kind === 'local' && Number(c.amount) > 0);
  if (!anyLocal && result.units > 0) {
    out.push({ level: 'info', text: 'No hay costos locales (agenciamiento, puerto, transporte). En un contenedor real rara vez son cero.' });
  }
  return out;
}

/**
 * The calculator ViewModel: the full engine result plus the guardrail warnings
 * and a couple of convenience flags the screen needs.
 */
export function resolveLandedCalculator(input) {
  const result = computeLanded(input || { lines: [], costs: [] });
  return {
    ...result,
    warnings: buildWarnings(input || {}, result),
    hasLines: result.lines.length > 0,
  };
}
