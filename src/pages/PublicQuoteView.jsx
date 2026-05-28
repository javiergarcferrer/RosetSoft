import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, AlertCircle, Check } from 'lucide-react';
import ClientPreview from '../components/quote-builder/ClientPreview.jsx';
import { computeTotals, lineForTotals, lineTotal } from '../lib/pricing.js';
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
 */

// Fold the recipient's picks into the line set the preview + totals consume:
// the chosen alternative becomes the selected member; an included optional is
// un-flagged so it both counts in the total and renders as a normal line.
function applySelections(lines, sel) {
  const alts = sel.alternatives || {};
  const opts = sel.optionals || {};
  return lines.map((l) => {
    if (l.alternativeGroup && alts[l.alternativeGroup] != null) {
      return { ...l, isSelectedAlternative: alts[l.alternativeGroup] === l.id };
    }
    if (l.isOptional) return opts[l.id] ? { ...l, isOptional: false } : l;
    return l;
  });
}

export default function PublicQuoteView() {
  const { token } = useParams();
  const [state, setState] = useState({ status: 'loading', bundle: null, error: null });
  const [selections, setSelections] = useState({ alternatives: {}, optionals: {} });
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
    () => (bundle ? applySelections(bundle.lines || [], selections) : []),
    [bundle, selections],
  );
  const totals = useMemo(
    () => computeTotals(effectiveLines.map(lineForTotals), quote || {}),
    [effectiveLines, quote],
  );

  // Group the choosable bits for the options panel.
  const { altGroups, optionals } = useMemo(() => {
    const lines = bundle?.lines || [];
    const groups = new Map();
    const opts = [];
    for (const l of lines) {
      if (l.alternativeGroup) {
        if (!groups.has(l.alternativeGroup)) groups.set(l.alternativeGroup, []);
        groups.get(l.alternativeGroup).push(l);
      } else if (l.isOptional) {
        opts.push(l);
      }
    }
    return { altGroups: [...groups.entries()], optionals: opts };
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

  if (state.status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink-50 text-ink-500">
        <Loader2 className="animate-spin mr-2" size={18} /> Cargando cotización…
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-ink-50 text-center px-6">
        <AlertCircle className="text-ink-400 mb-3" size={32} />
        <div className="text-lg font-semibold text-ink-800">Enlace no disponible</div>
        <p className="text-sm text-ink-500 mt-1 max-w-sm">
          Este enlace de cotización no es válido o fue desactivado. Pídele a tu
          asesor un enlace actualizado.
        </p>
      </div>
    );
  }

  const hasChoices = altGroups.length > 0 || optionals.length > 0;

  return (
    <div className="min-h-screen bg-ink-50 py-6 px-3 sm:px-6">
      <div className="mx-auto max-w-4xl space-y-4">
        {hasChoices && (
          <section className="card p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3 mb-3">
              <h2 className="text-sm font-semibold text-ink-900">Personaliza tu cotización</h2>
              <SaveBadge state={saveState} />
            </div>

            {altGroups.map(([group, members]) => {
              const sel = selectedAltId(group, members);
              return (
                <div key={group} className="mb-4 last:mb-0">
                  <div className="eyebrow-xs tracking-widest text-ink-500 mb-1.5">Elige una opción</div>
                  <div className="space-y-1.5">
                    {members.map((m) => (
                      <label
                        key={m.id}
                        className={`flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                          sel === m.id ? 'border-brand-400 bg-brand-50' : 'border-ink-200 hover:bg-ink-50'
                        }`}
                      >
                        <input
                          type="radio"
                          name={`alt-${group}`}
                          checked={sel === m.id}
                          onChange={() => pickAlternative(group, m.id)}
                          className="accent-brand-600"
                        />
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-medium text-ink-900 truncate">{m.name || '—'}</span>
                          {m.subtype && <span className="block text-[11px] text-ink-500 truncate">{m.subtype}</span>}
                        </span>
                        <span className="text-sm tabular-nums text-ink-700 whitespace-nowrap">{fmt(lineTotal(m))}</span>
                      </label>
                    ))}
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
                          {on ? '' : '+ '}{fmt(lineTotal(o))}
                        </span>
                      </label>
                    );
                  })}
                </div>
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
