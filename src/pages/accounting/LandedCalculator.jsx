import { useEffect, useMemo, useState } from 'react';
import {
  Calculator, Plus, Trash2, Package, Ship, Info, AlertTriangle, TrendingUp,
  RotateCcw, Save, FolderOpen, Anchor,
} from 'lucide-react';
import BackLink from '../../components/BackLink.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import { useApp } from '../../context/AppContext.jsx';
import { formatMoney } from '../../lib/format.js';
import { effectiveDopRate } from '../../lib/exchangeRate.js';
import {
  resolveLandedCalculator, computeLanded, regimeDuty,
  INCOTERMS, COST_BUCKETS, ALLOCATION_METHODS, ORIGIN_REGIMES, FURNITURE_HS, DGA_DEFAULTS,
} from '../../core/accounting/index.js';

const DRAFT_KEY = 'rs.landedCalc.draft.v1';
const SCENARIOS_KEY = 'rs.landedCalc.scenarios.v1';

const uid = () => (globalThis.crypto?.randomUUID?.() || `id-${Math.random().toString(36).slice(2)}`);

/** A ready-to-edit furniture container (FOB from France) — instantly useful. */
function seedDraft() {
  return {
    incoterm: 'FOB',
    regime: 'epa',
    margin: 45,
    lines: [
      { id: uid(), name: 'Sofá Togo (3 plazas)', qty: 1, unitCost: 3200, cbm: 2.1, weightKg: 60, hsCode: '9401' },
      { id: uid(), name: 'Mesa Saturne', qty: 2, unitCost: 850, cbm: 0.6, weightKg: 22, hsCode: '9403' },
    ],
    costs: [
      { id: uid(), bucket: 'freight', amount: 2800, allocation: 'volume', itbis: 0 },
      { id: uid(), bucket: 'insurance', amount: 95, allocation: 'value', itbis: 0 },
      { id: uid(), bucket: 'broker', amount: 450, allocation: 'value', itbis: 69 },
      { id: uid(), bucket: 'port', amount: 380, allocation: 'volume', itbis: 58 },
      { id: uid(), bucket: 'inland', amount: 220, allocation: 'volume', itbis: 34 },
    ],
  };
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return seedDraft();
}

/** A small two-line money cell: USD on top, DOP below. */
function Money({ usd, rates, strong, accent }) {
  return (
    <div className="leading-tight">
      <div className={`tabular-nums ${strong ? 'font-semibold' : ''} ${accent || 'text-ink-900'}`}>{formatMoney(usd, 'USD')}</div>
      <div className="tabular-nums text-[11px] text-ink-400">{formatMoney(usd, 'DOP', rates)}</div>
    </div>
  );
}

/** The cost waterfall — floating bars from FOB up to the landed total. */
function Waterfall({ steps, landed, rates }) {
  const max = landed || 1;
  const COLOR = {
    goods: 'bg-brand-400', freight: 'bg-sky-400', insurance: 'bg-sky-300',
    duty: 'bg-amber-400', isc: 'bg-amber-300', serviceFee: 'bg-amber-200', local: 'bg-indigo-400',
  };
  const bars = [
    ...steps.map((s) => ({ ...s, color: COLOR[s.key] || 'bg-ink-300', base: s.cumulative - s.amount })),
    { key: 'landed', label: 'En destino', amount: landed, cumulative: landed, base: 0, color: 'bg-emerald-500', final: true },
  ];
  return (
    <div>
      <div className="flex items-end gap-1.5">
        {bars.map((b) => {
          const basePct = Math.max(0, (b.base / max) * 100);
          const hPct = Math.max(1.5, (b.amount / max) * 100);
          return (
            <div key={b.key} className="flex-1 min-w-0 flex flex-col items-center">
              <div className="relative w-full h-36">
                <div
                  className={`absolute inset-x-0 rounded-md ${b.color} ${b.final ? 'shadow-sm' : ''}`}
                  style={{ bottom: `${b.final ? 0 : basePct}%`, height: `${b.final ? 100 : hPct}%` }}
                  title={formatMoney(b.amount, 'USD')}
                />
              </div>
              <div className="mt-1.5 text-[9px] font-semibold uppercase tracking-wide text-ink-500 text-center leading-tight truncate w-full">{b.label}</div>
              <div className="text-[10px] tabular-nums text-ink-700">{formatMoney(b.amount, 'USD')}</div>
              <div className="text-[9px] tabular-nums text-ink-400">{formatMoney(b.amount, 'DOP', rates)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Calculadora de costo en destino — the interactive landed-cost simulator.
 * Drop in the goods + the shipment costs, pick the Incoterm and the origin
 * regime (UE/EPA 0% vs NMF 20%), and read the per-unit landed cost and the
 * price to hit a margin, recomputed live. It runs the same DGA cascade the
 * expediente posts (gravamen → ITBIS on CIF+gravamen → 0.4% servicio) but adds
 * the EPA duty lever, per-bucket allocation (volume for bulky furniture) and the
 * margin back-calc. Pure client-side — nothing is booked until you open an
 * expediente. Self-gates on accounting/admin.
 */
export default function LandedCalculator() {
  const { currentProfile, settings } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';

  const [draft, setDraft] = useState(loadDraft);
  const { incoterm, regime, margin, lines, costs } = draft;
  const fxRate = effectiveDopRate(settings);
  const rates = useMemo(() => ({ USD: 1, DOP: fxRate }), [fxRate]);

  // Persist the working draft (survives reloads).
  useEffect(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* ignore */ }
  }, [draft]);

  const patch = (p) => setDraft((d) => ({ ...d, ...p }));
  const patchLine = (id, p) => setDraft((d) => ({ ...d, lines: d.lines.map((l) => (l.id === id ? { ...l, ...p } : l)) }));
  const patchCost = (id, p) => setDraft((d) => ({ ...d, costs: d.costs.map((c) => (c.id === id ? { ...c, ...p } : c)) }));
  const addLine = () => setDraft((d) => ({ ...d, lines: [...d.lines, { id: uid(), name: '', qty: 1, unitCost: 0, cbm: 0, weightKg: 0, hsCode: '9403' }] }));
  const addCost = () => setDraft((d) => ({ ...d, costs: [...d.costs, { id: uid(), bucket: 'other', amount: 0, allocation: 'value', itbis: 0 }] }));
  const delLine = (id) => setDraft((d) => ({ ...d, lines: d.lines.filter((l) => l.id !== id) }));
  const delCost = (id) => setDraft((d) => ({ ...d, costs: d.costs.filter((c) => c.id !== id) }));

  const dutyRate = regimeDuty(regime);
  const input = useMemo(() => ({
    lines, costs, incoterm,
    itbisRate: DGA_DEFAULTS.itbisRate, dutyRate, serviceFeeRate: DGA_DEFAULTS.serviceFeeRate, targetMargin: Number(margin) || 0,
  }), [lines, costs, incoterm, dutyRate, margin]);

  const vm = useMemo(() => resolveLandedCalculator(input), [input]);
  // EPA vs NMF comparison band — run the engine at both duty rates.
  const epaLanded = useMemo(() => computeLanded({ ...input, dutyRate: regimeDuty('epa') }).totals.landed, [input]);
  const mfnLanded = useMemo(() => computeLanded({ ...input, dutyRate: regimeDuty('mfn') }).totals.landed, [input]);
  const epaSaving = Math.max(0, Math.round((mfnLanded - epaLanded) * 100) / 100);

  // Scenarios (save-as-template / what-if).
  const [scenarios, setScenarios] = useState(() => {
    try { return JSON.parse(localStorage.getItem(SCENARIOS_KEY) || '[]'); } catch { return []; }
  });
  const persistScenarios = (next) => { setScenarios(next); try { localStorage.setItem(SCENARIOS_KEY, JSON.stringify(next)); } catch { /* ignore */ } };
  const saveScenario = () => {
    const name = window.prompt('Nombre del escenario (p. ej. "Contenedor 40HC sofás · Francia")');
    if (!name) return;
    persistScenarios([{ id: uid(), name, savedAt: Date.now(), draft }, ...scenarios.filter((s) => s.name !== name)].slice(0, 24));
  };
  const loadScenario = (s) => { if (s?.draft) setDraft({ ...s.draft, lines: s.draft.lines.map((l) => ({ ...l })), costs: s.draft.costs.map((c) => ({ ...c })) }); };
  const delScenario = (id) => persistScenarios(scenarios.filter((s) => s.id !== id));

  if (!allowed) {
    return (
      <>
        <PageHeader title="Calculadora de costo en destino" subtitle=" " />
        <EmptyState icon={Calculator} title="Acceso restringido" description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }

  const t = vm.totals;
  const incotermDef = vm.incoterm;

  return (
    <>
      <BackLink to="/accounting/importaciones">Volver a importaciones</BackLink>
      <PageHeader
        title="Calculadora de costo en destino"
        subtitle="Aterriza tu costo CIF → gravamen → ITBIS → servicio → costo unitario y precio de venta, en vivo"
        actions={(
          <div className="flex items-center gap-2">
            <button type="button" onClick={saveScenario} className="btn-secondary"><Save size={15} /><span className="hidden sm:inline">Guardar</span></button>
            <button type="button" onClick={() => setDraft(seedDraft())} className="btn-ghost" title="Reiniciar"><RotateCcw size={15} /></button>
          </div>
        )}
      />

      {/* ── Control bar: Incoterm · régimen · margen · tasa ──────────────── */}
      <div className="card card-pad mb-4 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="label" htmlFor="incoterm"><Anchor size={11} className="inline -mt-0.5 mr-1" />Incoterm</label>
          <select id="incoterm" className="input" value={incoterm} onChange={(e) => patch({ incoterm: e.target.value })}>
            {INCOTERMS.map((i) => <option key={i.code} value={i.code}>{i.label}</option>)}
          </select>
          <p className="mt-1 text-[11px] text-ink-400 leading-snug">{incotermDef.hint}</p>
        </div>

        <div>
          <span className="label">Régimen de origen</span>
          <div className="grid grid-cols-2 gap-1.5 rounded-lg bg-ink-100 p-1">
            {ORIGIN_REGIMES.map((r) => (
              <button
                key={r.key} type="button" onClick={() => patch({ regime: r.key })}
                className={`rounded-md px-2 py-1.5 text-xs font-semibold transition-colors ${regime === r.key ? 'bg-surface text-ink-900 shadow-xs' : 'text-ink-500 hover:text-ink-800'}`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-ink-400 leading-snug">{(ORIGIN_REGIMES.find((r) => r.key === regime) || {}).note}</p>
        </div>

        <div>
          <label className="label" htmlFor="margin"><TrendingUp size={11} className="inline -mt-0.5 mr-1" />Margen objetivo</label>
          <div className="flex items-center gap-2">
            <input id="margin" type="range" min="0" max="80" step="1" value={margin} onChange={(e) => patch({ margin: Number(e.target.value) })} className="flex-1 accent-brand-500" />
            <div className="w-14">
              <input type="number" inputMode="decimal" value={margin} onChange={(e) => patch({ margin: Number(e.target.value) })} className="input text-right tabular-nums" />
            </div>
            <span className="text-xs text-ink-400">%</span>
          </div>
          <p className="mt-1 text-[11px] text-ink-400">Sobre el precio de venta. Precio = costo ÷ (1 − margen).</p>
        </div>

        <div>
          <span className="label">Tasa USD → DOP</span>
          <div className="rounded-md border border-ink-200 bg-surface px-3 py-2 min-h-9 flex items-center">
            <span className="tabular-nums text-sm text-ink-900">1 USD = RD$ {fxRate.toFixed(2)}</span>
          </div>
          <p className="mt-1 text-[11px] text-ink-400">Venta Banco Popular (settings). Los costos se ingresan en USD.</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        {/* ── Inputs (left) ─────────────────────────────────────────────── */}
        <div className="lg:col-span-3 space-y-4">
          {/* Mercancía */}
          <div className="card overflow-hidden">
            <div className="card-header"><h2><Package size={15} className="inline -mt-0.5 mr-1.5" />Mercancía (FOB en USD)</h2>
              <button type="button" onClick={addLine} className="card-header-action"><Plus size={13} /> Línea</button>
            </div>
            <div className="overflow-x-auto">
              <table className="table min-w-[640px]">
                <thead>
                  <tr>
                    <th>Descripción</th>
                    <th className="text-right w-16">Cant.</th>
                    <th className="text-right w-28">FOB unit.</th>
                    <th className="text-right w-20">m³ total</th>
                    <th className="text-right w-20">kg total</th>
                    <th className="w-20">HS</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id}>
                      <td><input className="input" placeholder="Artículo" value={l.name} onChange={(e) => patchLine(l.id, { name: e.target.value })} /></td>
                      <td><input className="input text-right tabular-nums" type="number" inputMode="decimal" min="0" value={l.qty} onChange={(e) => patchLine(l.id, { qty: Number(e.target.value) })} /></td>
                      <td><input className="input text-right tabular-nums" type="number" inputMode="decimal" min="0" value={l.unitCost} onChange={(e) => patchLine(l.id, { unitCost: Number(e.target.value) })} /></td>
                      <td><input className="input text-right tabular-nums" type="number" inputMode="decimal" min="0" value={l.cbm} onChange={(e) => patchLine(l.id, { cbm: Number(e.target.value) })} /></td>
                      <td><input className="input text-right tabular-nums" type="number" inputMode="decimal" min="0" value={l.weightKg} onChange={(e) => patchLine(l.id, { weightKg: Number(e.target.value) })} /></td>
                      <td>
                        <select className="input" value={l.hsCode || ''} onChange={(e) => patchLine(l.id, { hsCode: e.target.value })}>
                          {FURNITURE_HS.map((h) => <option key={h.code} value={h.code}>{h.code}</option>)}
                        </select>
                      </td>
                      <td><button type="button" onClick={() => delLine(l.id)} className="btn-icon-danger" aria-label="Eliminar"><Trash2 size={14} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Costos del embarque */}
          <div className="card overflow-hidden">
            <div className="card-header"><h2><Ship size={15} className="inline -mt-0.5 mr-1.5" />Costos del embarque (USD)</h2>
              <button type="button" onClick={addCost} className="card-header-action"><Plus size={13} /> Costo</button>
            </div>
            <div className="overflow-x-auto">
              <table className="table min-w-[640px]">
                <thead>
                  <tr>
                    <th>Concepto</th>
                    <th className="text-right w-28">Monto</th>
                    <th className="w-36">Reparto</th>
                    <th className="text-right w-24">ITBIS</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {costs.map((c) => {
                    const def = COST_BUCKETS.find((b) => b.key === c.bucket);
                    const ignored = (c.bucket === 'freight' && incotermDef.freightIncluded) || (c.bucket === 'insurance' && incotermDef.insuranceIncluded) || incotermDef.importCleared;
                    return (
                      <tr key={c.id} className={ignored ? 'opacity-45' : ''}>
                        <td>
                          <select className="input" value={c.bucket} onChange={(e) => patchCost(c.id, { bucket: e.target.value })}>
                            {COST_BUCKETS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
                          </select>
                          {ignored && <span className="block text-[10px] text-ink-400 mt-0.5">Ya incluido en el precio ({incotermDef.code})</span>}
                        </td>
                        <td><input className="input text-right tabular-nums" type="number" inputMode="decimal" min="0" value={c.amount} onChange={(e) => patchCost(c.id, { amount: Number(e.target.value) })} /></td>
                        <td>
                          <select className="input" value={c.allocation} onChange={(e) => patchCost(c.id, { allocation: e.target.value })}>
                            {ALLOCATION_METHODS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                          </select>
                        </td>
                        <td>
                          {def?.kind === 'local'
                            ? <input className="input text-right tabular-nums" type="number" inputMode="decimal" min="0" value={c.itbis || 0} onChange={(e) => patchCost(c.id, { itbis: Number(e.target.value) })} />
                            : <span className="block text-right text-[11px] text-ink-300">—</span>}
                        </td>
                        <td><button type="button" onClick={() => delCost(c.id)} className="btn-icon-danger" aria-label="Eliminar"><Trash2 size={14} /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="px-5 py-2.5 text-[11px] text-ink-400 border-t border-ink-100">
              Flete y seguro forman el CIF (base del gravamen); agenciamiento, puerto y transporte capitalizan después. El ITBIS de los costos locales es crédito recuperable.
            </p>
          </div>

          {/* Escenarios guardados */}
          {scenarios.length > 0 && (
            <div className="card overflow-hidden">
              <div className="card-header"><h2><FolderOpen size={15} className="inline -mt-0.5 mr-1.5" />Escenarios</h2></div>
              <div className="p-3 flex flex-wrap gap-2">
                {scenarios.map((s) => (
                  <span key={s.id} className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 bg-surface pl-2.5 pr-1 py-1 text-xs">
                    <button type="button" className="font-medium text-ink-700 hover:text-ink-900" onClick={() => loadScenario(s)}>{s.name}</button>
                    <button type="button" className="btn-icon-danger !min-h-0 !p-1" onClick={() => delScenario(s.id)} aria-label="Eliminar escenario"><Trash2 size={12} /></button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Results (right, sticky) ───────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-4 lg:sticky lg:top-4 self-start">
          {!vm.hasLines ? (
            <div className="card card-pad"><EmptyState icon={Calculator} title="Agrega una línea" description="Carga la mercancía para ver el costo en destino." /></div>
          ) : (
            <>
              {/* Hero */}
              <div className="card card-pad">
                <div className="eyebrow text-ink-400">Costo en destino</div>
                <div className="mt-0.5 text-3xl font-semibold tabular-nums text-ink-900">{formatMoney(t.landed, 'DOP', rates)}</div>
                <div className="text-sm tabular-nums text-ink-400">{formatMoney(t.landed, 'USD')}</div>

                <div className="mt-4 grid grid-cols-2 gap-2">
                  <div className="rounded-xl border border-ink-100 bg-surface px-3 py-2">
                    <div className="eyebrow-xs text-ink-400">Costo unit. prom.</div>
                    <Money usd={vm.landedPerUnitAvg} rates={rates} strong />
                  </div>
                  <div className="rounded-xl border border-ink-100 bg-surface px-3 py-2">
                    <div className="eyebrow-xs text-ink-400">Tasa efectiva aduana</div>
                    <div className="text-base font-semibold tabular-nums text-amber-700">{vm.effectiveCustomsRate}%</div>
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="badge">Impuestos aduana {formatMoney(t.taxesAtCustoms, 'DOP', rates)}</span>
                  <span className="badge bg-sky-100 text-sky-700">ITBIS recuperable {formatMoney(t.creditableItbis, 'DOP', rates)}</span>
                </div>
              </div>

              {/* EPA savings */}
              {epaSaving > 0 && (
                <div className={`card card-pad ${regime === 'epa' ? 'border-emerald-200 bg-emerald-50/40' : 'border-amber-200 bg-amber-50/40'}`}>
                  <div className="flex items-start gap-2">
                    <div className={regime === 'epa' ? 'text-emerald-600' : 'text-amber-600'}><TrendingUp size={18} /></div>
                    <div className="text-sm leading-snug">
                      {regime === 'epa'
                        ? <>Con origen UE (EUR.1) ahorras <strong className="tabular-nums">{formatMoney(epaSaving, 'DOP', rates)}</strong> frente al gravamen NMF (20%).</>
                        : <>Con una <strong>EUR.1</strong> de origen UE bajarías el costo en <strong className="tabular-nums">{formatMoney(epaSaving, 'DOP', rates)}</strong> (gravamen 0% bajo el EPA).</>}
                    </div>
                  </div>
                </div>
              )}

              {/* Waterfall */}
              <div className="card card-pad">
                <div className="eyebrow text-ink-400 mb-3">Composición del costo</div>
                <Waterfall steps={vm.waterfall} landed={t.landed} rates={rates} />
              </div>

              {/* Per-line landed + price */}
              <div className="card overflow-hidden">
                <div className="card-header"><h2>Por artículo</h2></div>
                <div className="overflow-x-auto">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Artículo</th>
                        <th className="text-right">Costo unit.</th>
                        <th className="text-right">Precio ({margin}%)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vm.lines.map((l) => (
                        <tr key={l.id}>
                          <td className="min-w-0"><div className="truncate">{l.name || '—'}</div><div className="text-[11px] text-ink-400 tabular-nums">×{l.qty} · gravamen {l.dutyRate}%</div></td>
                          <td className="text-right"><Money usd={l.landedUnit} rates={rates} /></td>
                          <td className="text-right"><Money usd={l.suggestedPrice} rates={rates} strong accent="text-emerald-700" /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Guardrails */}
              {vm.warnings.length > 0 && (
                <div className="card card-pad space-y-2">
                  <div className="eyebrow text-ink-400">Revisa</div>
                  {vm.warnings.map((w, i) => (
                    <div key={i} className="flex items-start gap-2 text-[12px] leading-snug">
                      {w.level === 'warn'
                        ? <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />
                        : <Info size={14} className="mt-0.5 shrink-0 text-sky-500" />}
                      <span className="text-ink-600">{w.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
