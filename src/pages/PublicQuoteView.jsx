import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, AlertCircle, Check } from 'lucide-react';
import ClientPreview from '../components/quote-builder/ClientPreview.jsx';
import { computeTotals, lineForTotals, lineTotal } from '../lib/pricing.js';
import { isPricedLine } from '../lib/constants.js';
import { applyClientSelections } from '../lib/clientSelections.js';
import { formatMoney } from '../lib/format.js';
import { fetchSharedQuote, saveClientSelections } from '../lib/quoteShare.js';

/**
 * Public, logged-OUT interactive quote view (route #/q/:token).
 *
 * Fetches a whitelisted, margin-free bundle from the `quote-share` Edge
 * Function, lets the recipient pick among alternatives + toggle optionals,
 * recomputes the total live, and persists their picks back (plan A — stored
 * separately on the quote so the dealer sees what the client wants without
 * the client mutating the dealer's own lines).
 *
 * Renders OUTSIDE the app's auth shell, so it depends on no AppContext /
 * session — only the bundle it fetches and <ImageView>'s public-bucket reads.
 *
 * The recipient's picks (alternatives, optionals, AND material grades) are
 * folded into the line set by applyClientSelections (lib) so the transform is
 * shared + unit-tested; this component owns only the fetch, the panel UI, and
 * the debounced persistence.
 */

export default function PublicQuoteView() {
  const { token } = useParams();
  const [state, setState] = useState({ status: 'loading', bundle: null, error: null });
  const [selections, setSelections] = useState({ alternatives: {}, optionals: {}, materials: {} });
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved
  const initialised = useRef(false);

  // Load the bundle once per token.
  useEffect(() => {
    let active = true;
    setState({ status: 'loading', bundle: null, error: null });
    initialised.current = false;
    fetchSharedQuote(token)
      .then((bundle) => {
        if (!active) return;
        const saved = bundle?.quote?.clientSelections || {};
        setSelections({
          alternatives: saved.alternatives || {},
          optionals: saved.optionals || {},
          materials: saved.materials || {},
        });
        setState({ status: 'ready', bundle, error: null });
      })
      .catch((e) => {
        if (!active) return;
        setState({ status: 'error', bundle: null, error: e?.message || 'error' });
      });
    return () => { active = false; };
  }, [token]);

  // Persist picks (debounced) after the first render that follows load.
  useEffect(() => {
    if (state.status !== 'ready') return undefined;
    if (!initialised.current) { initialised.current = true; return undefined; }
    setSaveState('saving');
    const id = setTimeout(() => {
      saveClientSelections(token, selections)
        .then(() => setSaveState('saved'))
        .catch(() => setSaveState('idle'));
    }, 600);
    return () => clearTimeout(id);
  }, [selections, state.status, token]);

  const bundle = state.bundle;
  const quote = bundle?.quote || null;
  const currency = quote?.currencyCode || 'USD';
  const rates = quote?.rates || { USD: 1 };
  const fmt = (v) => formatMoney(v, currency, rates);

  // Effective lines + totals recompute whenever selections change.
  const effectiveLines = useMemo(
    () => (bundle ? applyClientSelections(bundle.lines || [], selections) : []),
    [bundle, selections],
  );
  // Effective line by id — so the options panel prices each alternative with
  // the recipient's material picks already applied.
  const effectiveById = useMemo(
    () => new Map(effectiveLines.map((l) => [l.id, l])),
    [effectiveLines],
  );
  // Only PRICED lines feed the total — the same isPricedLine gate the editor
  // uses. Without it the total would sum every alternative + every excluded
  // optional, so picking an option wouldn't actually move the number.
  const totals = useMemo(
    () => computeTotals(effectiveLines.filter(isPricedLine).map(lineForTotals), quote || {}),
    [effectiveLines, quote],
  );

  // Group the choosable bits for the options panel. `hasMaterials` flags that
  // at least one line/component can be re-quoted in another material (those
  // pickers live in-line in the preview below, not in this panel).
  const { altGroups, optionals, hasMaterials } = useMemo(() => {
    const lines = bundle?.lines || [];
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
  }, [bundle]);

  function selectedAltId(group, members) {
    if (selections.alternatives[group] != null) return selections.alternatives[group];
    const dealerPick = members.find((m) => m.isSelectedAlternative);
    return (dealerPick || members[0])?.id;
  }
  function pickAlternative(group, lineId) {
    setSelections((s) => ({ ...s, alternatives: { ...s.alternatives, [group]: lineId } }));
  }
  function toggleOptional(lineId, on) {
    setSelections((s) => ({ ...s, optionals: { ...s.optionals, [lineId]: on } }));
  }
  // Re-quote a line (or compound component) in a different material grade. The
  // total recomputes via applyClientSelections shifting that line's unit price
  // by the option's price delta.
  function pickMaterial(id, grade) {
    setSelections((s) => ({ ...s, materials: { ...s.materials, [id]: grade } }));
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
          <section className="card p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3 mb-3">
              <h2 className="text-sm font-semibold text-ink-900">Personaliza tu cotización</h2>
              <SaveBadge state={saveState} />
            </div>

            {altGroups.map(([group, members]) => {
              const sel = selectedAltId(group, members);
              // Price each option as the DIFFERENCE vs. the one currently
              // chosen: the selected option shows its absolute total (it's
              // what's in the quote), the others show +/− what switching costs.
              const selMember = effectiveById.get(sel) || members.find((m) => m.id === sel) || members[0];
              const selTotal = lineTotal(selMember);
              return (
                <div key={group} className="mb-4 last:mb-0">
                  <div className="eyebrow-xs tracking-widest text-ink-500 mb-1.5">Elige una opción</div>
                  <div className="space-y-1.5">
                    {members.map((m) => {
                      const isSel = sel === m.id;
                      const mTotal = lineTotal(effectiveById.get(m.id) || m);
                      const diff = mTotal - selTotal;
                      return (
                        <label
                          key={m.id}
                          className={`flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                            isSel ? 'border-brand-400 bg-brand-50' : 'border-ink-200 hover:bg-ink-50'
                          }`}
                        >
                          <input
                            type="radio"
                            name={`alt-${group}`}
                            checked={isSel}
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
                                <span className="block text-sm font-semibold tabular-nums text-ink-900">{fmt(mTotal)}</span>
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
                  {optionals.map((o) => {
                    const on = !!selections.optionals[o.id];
                    return (
                      <label
                        key={o.id}
                        className={`flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                          on ? 'border-emerald-400 bg-emerald-50' : 'border-ink-200 hover:bg-ink-50'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => toggleOptional(o.id, e.target.checked)}
                          className="accent-emerald-600"
                        />
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-medium text-ink-900 truncate">{o.name || '—'}</span>
                          {o.subtype && <span className="block text-[11px] text-ink-500 truncate">{o.subtype}</span>}
                        </span>
                        <span className="text-sm tabular-nums text-ink-700 whitespace-nowrap">
                          {on ? '' : '+ '}{fmt(lineTotal(effectiveById.get(o.id) || o))}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {hasMaterials && (
              <div className="mt-3 text-[11px] text-ink-500 border-t border-ink-100 pt-3">
                ¿Quieres otra tela o piel? Cámbiala en cada artículo más abajo —
                verás la diferencia de precio y el total se actualiza al instante.
              </div>
            )}
          </section>
        )}

        <ClientPreview
          quote={quote}
          settings={bundle.settings || {}}
          lines={effectiveLines}
          quoteGroups={[]}
          totals={totals}
          customer={bundle.customer || null}
          professional={bundle.professional || null}
          seller={bundle.seller || null}
          families={undefined}
          materialSelections={selections.materials}
          onSelectMaterial={pickMaterial}
        />
      </div>
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
  return null;
}
