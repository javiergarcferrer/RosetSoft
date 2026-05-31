import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, AlertCircle, Check, CloudOff, Ship, MapPin } from 'lucide-react';
import ClientPreview from '../components/quote-builder/ClientPreview.jsx';
import ContainerTracking from '../components/ContainerTracking.jsx';
// Derivations + the one mutation reducer come from the quote Model.
import { computeTotals, lineForTotals, isPricedLine, applyAction } from '../core/quote/index.js';
import { normalizeContainerNo, resolveTrackableContainers } from '../core/tracking/index.js';
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
  const lines = useMemo(() => bundle?.lines || [], [bundle]);
  // The attached order's trackable containers (from the share bundle), so the
  // client can follow their shipment from the same link they used to configure
  // the quote. Validated here; each renders its own keyless tracking panel.
  const trackable = useMemo(
    () => resolveTrackableContainers(bundle?.containers),
    [bundle],
  );

  // The lines ARE the truth now (picks already mutated them), so the total is
  // just the priced lines — same isPricedLine gate the editor + PDF use.
  const totals = useMemo(
    () => computeTotals(lines.filter(isPricedLine).map(lineForTotals), quote || {}),
    [lines, quote],
  );

  // Apply a pick. The preview updates INSTANTLY by replaying the action locally
  // through the Model (applyAction mirrors the Edge Function), then we persist
  // in the background. The controls stay live the whole time — no waiting on the
  // save. We reconcile to the server's authoritative bundle only after the write
  // queue drains (an earlier response is stale vs. a later optimistic pick); a
  // failed write re-syncs to server truth.
  function applyPick(pick) {
    if (!bundleRef.current) return;
    const optimistic = applyAction(bundleRef.current, pick);
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
  // The FULL catalog picker — `sel` is { grade, fabric, swatchImageId }.
  const pickMaterialFree = (id, sel) => applyPick({ materialPick: { [id]: sel } });

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

  return (
    // Lives outside the app shell, so it can't lean on the Layout's <main>
    // scroll container — and html/body/#root are pinned to the viewport with
    // overflow:hidden (see index.css). Be our own scroll container, or the
    // quote is clipped at the fold with no way to scroll on mobile.
    <div className="h-full overflow-y-auto overscroll-contain bg-ink-50 py-6 px-3 sm:px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto max-w-4xl space-y-4">
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
          materials={bundle.materials || []}
          modelFabrics={bundle.modelFabrics || {}}
          onSelectMaterial={pickMaterial}
          onPickMaterial={pickMaterialFree}
          onToggleOptional={toggleOptional}
          onSelectAlternative={pickAlternative}
        />

        {/* Shipment tracking. With a trackable container we show the live
            Hapag-Lloyd panels; before one is attached we still show the block,
            promising the client real-time geolocation once the order ships. */}
        {trackable.length > 0 ? (
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
                <ContainerTracking containerNo={normalizeContainerNo(c.code)} shareToken={token} />
              </div>
            ))}
          </section>
        ) : (
          <section className="card p-4 sm:p-5 space-y-3">
            <h2 className="text-sm font-semibold text-ink-900 flex items-center gap-2">
              <Ship size={16} className="text-ink-500" /> Seguimiento de tu envío
            </h2>
            <div className="flex items-start gap-3 rounded-lg border border-ink-100 bg-ink-50/60 p-3.5">
              <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
                <MapPin size={16} />
              </span>
              <div className="space-y-1">
                <p className="text-xs font-medium text-ink-800">Geolocalización en tiempo real</p>
                <p className="text-[11px] leading-relaxed text-ink-600">
                  En cuanto tu pedido se embarque, podrás geolocalizarlo en tiempo
                  real desde este mismo enlace, gracias a nuestra conexión directa
                  con las actualizaciones de los buques de Hapag-Lloyd.
                </p>
              </div>
            </div>
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
