import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, AlertCircle, Check, CloudOff, Ship } from 'lucide-react';
import ClientPreview from '../components/quote-builder/ClientPreview.jsx';
import ContainerTracking from '../components/ContainerTracking.jsx';
import { computeTotals, lineForTotals, lineTotal } from '../lib/pricing.js';
import { isPricedLine } from '../lib/constants.js';
import { isValidContainerNo, normalizeContainerNo } from '../lib/containerTracking.js';
import { formatMoney } from '../lib/format.js';
import { fetchSharedQuote, applyClientPick } from '../lib/quoteShare.js';
import { applyClientPick as applyPickLocally } from '../lib/clientPick.js';

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
  // The bundle we're currently showing (kept in a ref too, so the optimistic
  // chain can build each pick on the latest local state without waiting for a
  // re-render).
  const bundleRef = useRef(null);
  // Writes are serialized through this promise chain so the server applies
  // picks in the order they were made; `pending` counts in-flight writes so we
  // only reconcile to the server bundle once the queue drains.
  const chainRef = useRef(Promise.resolve());
  const pendingRef = useRef(0);

  // Show a bundle now — both in the ref (for the next optimistic pick) and on
  // screen.
  function commit(b) {
    bundleRef.current = b;
    setState((s) => ({ ...s, bundle: b }));
  }

  useEffect(() => {
    let active = true;
    setState({ status: 'loading', bundle: null, error: null });
    setSave('idle');
    pendingRef.current = 0;
    chainRef.current = Promise.resolve();
    fetchSharedQuote(token)
      .then((bundle) => { if (active) { bundleRef.current = bundle; setState({ status: 'ready', bundle, error: null }); } })
      .catch((e) => { if (active) setState({ status: 'error', bundle: null, error: e?.message || 'error' }); });
    return () => { active = false; };
  }, [token]);

  const bundle = state.bundle;
  const quote = bundle?.quote || null;
  const currency = quote?.currencyCode || 'USD';
  const rates = quote?.rates || { USD: 1 };
  const fmt = (v) => formatMoney(v, currency, rates);
  const lines = useMemo(() => bundle?.lines || [], [bundle]);
  // The attached order's trackable containers (from the share bundle), so the
  // client can follow their shipment from the same link they used to configure
  // the quote. Validated here; each renders its own keyless tracking panel.
  const trackable = useMemo(
    () => (bundle?.containers || []).filter((c) => isValidContainerNo(c.code)),
    [bundle],
  );

  // The lines ARE the truth now (picks already mutated them), so the total is
  // just the priced lines — same isPricedLine gate the editor + PDF use.
  const totals = useMemo(
    () => computeTotals(lines.filter(isPricedLine).map(lineForTotals), quote || {}),
    [lines, quote],
  );

  // Apply a pick. The preview updates INSTANTLY by replaying the pick locally
  // (applyPickLocally mirrors the Edge Function), then we persist in the
  // background. The controls stay live the whole time — no waiting on the save.
  // We reconcile to the server's authoritative bundle only after the write
  // queue drains (an earlier response is stale vs. a later optimistic pick); a
  // failed write re-syncs to server truth.
  function applyPick(pick) {
    if (!bundleRef.current) return;
    const optimistic = applyPickLocally(bundleRef.current, pick);
    if (optimistic !== bundleRef.current) commit(optimistic);
    setSave('saving');
    pendingRef.current += 1;
    chainRef.current = chainRef.current
      .then(() => applyClientPick(token, pick))
      .then((server) => {
        pendingRef.current = Math.max(0, pendingRef.current - 1);
        if (pendingRef.current === 0) { commit(server); setSave('saved'); }
      })
      .catch(async () => {
        pendingRef.current = 0;
        setSave('error');
        // Re-sync to the server's truth so the preview can't drift after a
        // failed write.
        try { const fresh = await fetchSharedQuote(token); commit(fresh); } catch { /* keep what we have */ }
      });
  }

  const pickAlternative = (group, lineId) => applyPick({ alternatives: { [group]: lineId } });
  const toggleOptional = (lineId, on) => applyPick({ optionals: { [lineId]: on } });
  const pickMaterial = (id, grade) => applyPick({ materials: { [id]: grade } });

  // Choosable bits for the options panel: alternatives (pick-one menus) and a
  // flag that some line/component can be re-quoted in another material.
  // Optionals are NOT here — each dealer-offered optional carries its own
  // Agregar / Quitar action ON its product card in the preview below, where it
  // belongs, instead of a checklist divorced at the top of the page.
  const { altGroups, hasMaterials } = useMemo(() => {
    const groups = new Map();
    let mats = false;
    for (const l of lines) {
      if (l.materialOptions?.options?.length) mats = true;
      if (Array.isArray(l.components)) {
        for (const c of l.components) if (c?.materialOptions?.options?.length) mats = true;
      }
      if (l.alternativeGroup) {
        if (!groups.has(l.alternativeGroup)) groups.set(l.alternativeGroup, []);
        groups.get(l.alternativeGroup).push(l);
      }
    }
    return { altGroups: [...groups.entries()], hasMaterials: mats };
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

  const hasChoices = altGroups.length > 0 || hasMaterials;

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
                          className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors cursor-pointer ${
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
          onToggleOptional={toggleOptional}
        />

        {/* Shipment tracking — appears once the quote's order has a container
            with a real number. Same link, now also follows the delivery. */}
        {trackable.length > 0 && (
          <section className="card p-4 sm:p-5 space-y-3">
            <h2 className="text-sm font-semibold text-ink-900 flex items-center gap-2">
              <Ship size={16} className="text-ink-500" /> Seguimiento de tu envío
            </h2>
            {trackable.map((c) => (
              <div key={c.code} className="space-y-1.5">
                {trackable.length > 1 && (
                  <div className="text-[11px] font-medium text-ink-600">
                    Contenedor #{c.number ?? '—'}
                    <span className="font-mono text-ink-400"> · {normalizeContainerNo(c.code)}</span>
                  </div>
                )}
                <ContainerTracking containerNo={normalizeContainerNo(c.code)} />
              </div>
            ))}
          </section>
        )}
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
