import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, AlertCircle, Check, CloudOff } from 'lucide-react';
import ClientPreview from '../components/quote-builder/ClientPreview.jsx';
import { computeTotals, lineForTotals, lineTotal } from '../lib/pricing.js';
import { isPricedLine } from '../lib/constants.js';
import { formatMoney } from '../lib/format.js';
import { fetchSharedQuote, applyClientPick } from '../lib/quoteShare.js';

/**
 * Public, logged-OUT interactive quote view (route #/q/:token).
 *
 * Fetches a whitelisted, margin-free bundle from the `quote-share` Edge
 * Function and lets the recipient configure it — pick alternatives, add
 * optionals, choose a fabric. Per the owner's call, every pick EDITS THE REAL
 * QUOTE (one version, no separate copy): a pick POSTs to the function, which
 * mutates quote_lines in place and returns the fresh bundle, which we swap in.
 * So the dealer and the client always see the exact same quote.
 *
 * Renders OUTSIDE the app's auth shell, so it depends on no AppContext /
 * session — only the bundle it fetches and <ImageView>'s public-bucket reads.
 */
export default function PublicQuoteView() {
  const { token } = useParams();
  const [state, setState] = useState({ status: 'loading', bundle: null, error: null });
  const [save, setSave] = useState('idle'); // idle | saving | saved | error
  // Guards against an out-of-order response clobbering a newer pick.
  const seqRef = useRef(0);

  useEffect(() => {
    let active = true;
    setState({ status: 'loading', bundle: null, error: null });
    fetchSharedQuote(token)
      .then((bundle) => { if (active) setState({ status: 'ready', bundle, error: null }); })
      .catch((e) => { if (active) setState({ status: 'error', bundle: null, error: e?.message || 'error' }); });
    return () => { active = false; };
  }, [token]);

  const bundle = state.bundle;
  const quote = bundle?.quote || null;
  const currency = quote?.currencyCode || 'USD';
  const rates = quote?.rates || { USD: 1 };
  const fmt = (v) => formatMoney(v, currency, rates);
  const lines = useMemo(() => bundle?.lines || [], [bundle]);

  // The lines ARE the truth now (picks already mutated them), so the total is
  // just the priced lines — same isPricedLine gate the editor + PDF use.
  const totals = useMemo(
    () => computeTotals(lines.filter(isPricedLine).map(lineForTotals), quote || {}),
    [lines, quote],
  );

  const busy = save === 'saving';

  // Apply ONE pick to the real quote and swap in the returned bundle. Picks are
  // serialized (ignored while one is in flight) so two rapid clicks can't race
  // a read-modify-write on the shared quote.
  function applyPick(pick) {
    if (busy) return;
    const seq = ++seqRef.current;
    setSave('saving');
    applyClientPick(token, pick)
      .then((updated) => {
        if (seqRef.current !== seq) return;
        setState((s) => ({ ...s, bundle: updated }));
        setSave('saved');
      })
      .catch(() => { if (seqRef.current === seq) setSave('error'); });
  }

  const pickAlternative = (group, lineId) => applyPick({ alternatives: { [group]: lineId } });
  const toggleOptional = (lineId, on) => applyPick({ optionals: { [lineId]: on } });
  const pickMaterial = (id, grade) => applyPick({ materials: { [id]: grade } });

  // Choosable bits for the options panel. `hasMaterials` flags that at least
  // one line/component can be re-quoted in another material (those pickers live
  // in-line in the preview below).
  const { altGroups, optionals, hasMaterials } = useMemo(() => {
    const groups = new Map();
    const opts = [];
    let mats = false;
    for (const l of lines) {
      if (l.materialOptions?.options?.length) mats = true;
      if (Array.isArray(l.components)) {
        for (const c of l.components) if (c?.materialOptions?.options?.length) mats = true;
      }
      if (l.alternativeGroup) {
        if (!groups.has(l.alternativeGroup)) groups.set(l.alternativeGroup, []);
        groups.get(l.alternativeGroup).push(l);
      } else if (l.isOptional) {
        opts.push(l);
      }
    }
    return { altGroups: [...groups.entries()], optionals: opts, hasMaterials: mats };
  }, [lines]);

  function selectedAltMember(members) {
    return members.find((m) => m.isSelectedAlternative) || members[0] || null;
  }

  if (state.status === 'loading') {
    return (
      <div className="h-full flex items-center justify-center bg-ink-50 text-ink-500">
        <Loader2 className="animate-spin mr-2" size={18} /> Cargando cotización…
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-ink-50 text-center px-6">
        <AlertCircle className="text-ink-400 mb-3" size={32} />
        <div className="text-lg font-semibold text-ink-800">Enlace no disponible</div>
        <p className="text-sm text-ink-500 mt-1 max-w-sm">
          Este enlace de cotización no es válido o fue desactivado. Pídele a tu
          asesor un enlace actualizado.
        </p>
      </div>
    );
  }

  const hasChoices = altGroups.length > 0 || optionals.length > 0 || hasMaterials;

  return (
    // Lives outside the app shell, so it can't lean on the Layout's <main>
    // scroll container — and html/body/#root are pinned to the viewport with
    // overflow:hidden (see index.css). Be our own scroll container, or the
    // quote is clipped at the fold with no way to scroll on mobile.
    <div className="h-full overflow-y-auto overscroll-contain bg-ink-50 py-6 px-3 sm:px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto max-w-4xl space-y-4">
        {hasChoices && (
          <section className={`card p-4 sm:p-5 transition-opacity ${busy ? 'opacity-60' : ''}`}>
            <div className="flex items-center justify-between gap-3 mb-3">
              <h2 className="text-sm font-semibold text-ink-900">Personaliza tu cotización</h2>
              <SaveBadge state={save} />
            </div>

            {altGroups.map(([group, members]) => {
              // Price each option as the DIFFERENCE vs. the one currently in the
              // quote: the selected option shows its absolute total, the others
              // show +/− what switching costs.
              const selMember = selectedAltMember(members);
              const selId = selMember?.id;
              const selTotal = selMember ? lineTotal(selMember) : 0;
              return (
                <div key={group} className="mb-4 last:mb-0">
                  <div className="eyebrow-xs tracking-widest text-ink-500 mb-1.5">Elige una opción</div>
                  <div className="space-y-1.5">
                    {members.map((m) => {
                      const isSel = selId === m.id;
                      const diff = lineTotal(m) - selTotal;
                      return (
                        <label
                          key={m.id}
                          className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${busy ? 'cursor-default' : 'cursor-pointer'} ${
                            isSel ? 'border-brand-400 bg-brand-50' : 'border-ink-200 hover:bg-ink-50'
                          }`}
                        >
                          <input
                            type="radio"
                            name={`alt-${group}`}
                            checked={isSel}
                            disabled={busy}
                            onChange={() => pickAlternative(group, m.id)}
                            className="accent-brand-600"
                          />
                          <span className="flex-1 min-w-0">
                            <span className="block text-sm font-medium text-ink-900 truncate">{m.name || '—'}</span>
                            {m.subtype && <span className="block text-[11px] text-ink-500 truncate">{m.subtype}</span>}
                          </span>
                          <span className="text-right whitespace-nowrap">
                            {isSel ? (
                              <>
                                <span className="block text-sm font-semibold tabular-nums text-ink-900">{fmt(lineTotal(m))}</span>
                                <span className="block text-[10px] text-ink-400">en tu total</span>
                              </>
                            ) : (
                              <span className={`block text-sm font-semibold tabular-nums ${diff < 0 ? 'text-emerald-700' : 'text-ink-700'}`}>
                                {diff === 0 ? 'Mismo precio' : `${diff < 0 ? '−' : '+'}${fmt(Math.abs(diff))}`}
                              </span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {optionals.length > 0 && (
              <div className="mt-1">
                <div className="eyebrow-xs tracking-widest text-ink-500 mb-1.5">Complementos opcionales</div>
                <div className="space-y-1.5">
                  {optionals.map((o) => (
                    <label
                      key={o.id}
                      className={`flex items-center gap-3 rounded-lg border border-ink-200 px-3 py-2 transition-colors ${busy ? 'cursor-default' : 'cursor-pointer hover:bg-ink-50'}`}
                    >
                      <input
                        type="checkbox"
                        checked={false}
                        disabled={busy}
                        onChange={(e) => toggleOptional(o.id, e.target.checked)}
                        className="accent-emerald-600"
                      />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium text-ink-900 truncate">{o.name || '—'}</span>
                        {o.subtype && <span className="block text-[11px] text-ink-500 truncate">{o.subtype}</span>}
                      </span>
                      <span className="text-sm tabular-nums text-ink-700 whitespace-nowrap">+ {fmt(lineTotal(o))}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {hasMaterials && (
              <div className="mt-3 text-[11px] text-ink-500 border-t border-ink-100 pt-3">
                ¿Quieres otra tela o piel? Elígela en cada artículo más abajo —
                verás la diferencia de precio y el total se actualiza al instante.
              </div>
            )}
          </section>
        )}

        <ClientPreview
          quote={quote}
          settings={bundle.settings || {}}
          lines={lines}
          quoteGroups={[]}
          totals={totals}
          customer={bundle.customer || null}
          professional={bundle.professional || null}
          seller={bundle.seller || null}
          families={undefined}
          onSelectMaterial={pickMaterial}
        />
      </div>

      {/* Save status — fixed so it's visible no matter where on the long quote
          the recipient just made a change (the options panel can be scrolled
          far above the in-line fabric pickers). */}
      <SaveToast state={save} />
    </div>
  );
}

function SaveBadge({ state }) {
  if (state === 'saving') {
    return <span className="text-[11px] text-ink-400 inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> Guardando…</span>;
  }
  if (state === 'saved') {
    return <span className="text-[11px] text-emerald-600 inline-flex items-center gap-1"><Check size={12} /> Guardado</span>;
  }
  if (state === 'error') {
    return <span className="text-[11px] text-red-600 inline-flex items-center gap-1"><CloudOff size={12} /> No se pudo guardar</span>;
  }
  return null;
}

function SaveToast({ state }) {
  if (state === 'idle') return null;
  const cfg = {
    saving: { cls: 'bg-ink-900 text-white', icon: <Loader2 size={13} className="animate-spin" />, label: 'Guardando cambios…' },
    saved: { cls: 'bg-emerald-600 text-white', icon: <Check size={14} />, label: 'Guardado' },
    error: { cls: 'bg-red-600 text-white', icon: <CloudOff size={14} />, label: 'No se pudo guardar — revisa tu conexión' },
  }[state];
  if (!cfg) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 flex justify-center px-4">
      <div className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium shadow-lg ${cfg.cls}`}>
        {cfg.icon}{cfg.label}
      </div>
    </div>
  );
}
