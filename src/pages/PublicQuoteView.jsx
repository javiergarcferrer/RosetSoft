import { userMessageFor } from '../lib/errorMessages.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, AlertCircle, Check, CloudOff, Ship, MapPin, Download, Link2 } from 'lucide-react';
import ClientPreview from '../components/quote-builder/ClientPreview.jsx';
import ContainerTracking from '../components/ContainerTracking.jsx';
// Derivations + the one mutation reducer come from the quote Model.
import { computeTotals, lineForTotals, isPricedLine, applyAction } from '../core/quote/index.js';
import { normalizeContainerNo, resolveTrackableContainers } from '../core/tracking/index.js';
import { fetchSharedQuote, applyClientPick } from '../lib/quoteShare.js';
import { quoteDisplayName } from '../lib/quoteNaming.js';
import { safeDynamicImport } from '../lib/dynamicImport.js';

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
  const [pdf, setPdf] = useState('idle'); // idle | working | error — PDF download
  const [copied, setCopied] = useState(false); // "Copiar enlace" feedback
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
      .catch((e) => { if (active) setState({ status: 'error', bundle: null, error: userMessageFor(e) }); });
    return () => { active = false; };
  }, [token]);

  const bundle = state.bundle;
  const quote = bundle?.quote || null;
  const lines = useMemo(() => bundle?.lines || [], [bundle]);

  // Title the tab with the SAME "client - Cotizacion N" label as the PDF and
  // the link slug, so a bookmarked / re-shared tab reads identically. Restored
  // on unmount so the dealer app's title isn't left overwritten.
  useEffect(() => {
    if (!quote) return undefined;
    const prev = document.title;
    document.title = quoteDisplayName(quote, bundle?.customer || null);
    return () => { document.title = prev; };
  }, [quote, bundle]);
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
  // Apply-to-all: ONE action that dresses many components in the same fabric.
  // `selsById` is already a materialPick map ({ id: sel }), so the reducer +
  // Edge Function reprice each piece at its own model's price in a single write.
  const pickMaterialFreeMany = (selsById) => applyPick({ materialPick: selsById });

  // Copy THIS page's URL so the dealer (or the client) can paste it anywhere —
  // WhatsApp, email, a text — and share the live quote freely. Prefers the async
  // Clipboard API; falls back to a hidden-textarea execCommand for older or
  // non-secure contexts so the button never silently does nothing.
  async function copyLink() {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* give up silently */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  // Download the quote as a branded PDF. The link is anonymous, so the renderer
  // resolves images through public bucket URLs (publicImages). react-pdf is
  // lazy-imported via safeDynamicImport — the heavy renderer loads only on
  // demand, and a stale-deploy chunk reference recovers with a one-time reload.
  async function downloadPdf() {
    if (pdf === 'working' || !quote) return;
    setPdf('working');
    try {
      const { generateQuotePdf, downloadBlob, quoteFileName } = await safeDynamicImport(
        () => import('../pdf/react/index.js'),
      );
      const blob = await generateQuotePdf({
        quote,
        settings: bundle.settings || {},
        lines,
        totals,
        customer: bundle.customer || null,
        professional: bundle.professional || null,
        seller: bundle.seller || null,
        quoteGroups: [],
        publicImages: true,
      });
      await downloadBlob(blob, `${quoteFileName(quote, bundle.customer || null)}.pdf`);
      setPdf('idle');
    } catch (e) {
      console.error('[PublicQuoteView] PDF download failed:', e);
      setPdf('error');
    }
  }

  if (state.status === 'loading') {
    return (
      <div role="status" aria-live="polite" className="h-full flex flex-col items-center justify-center gap-3 bg-ink-50 text-ink-500">
        <Loader2 className="animate-spin text-brand-500" size={24} aria-hidden />
        <span className="text-sm">Cargando cotización…</span>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-ink-50 text-center px-6">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-ink-100 text-ink-400 mb-5 shadow-xs">
          <AlertCircle size={28} strokeWidth={1.5} aria-hidden />
        </div>
        <div className="font-display text-lg font-semibold text-ink-800">Enlace no disponible</div>
        <p className="text-sm text-ink-500 mt-2 max-w-sm leading-relaxed">
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
    <div className="h-full overflow-y-auto overscroll-contain bg-ink-50 py-6 px-3 sm:px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] kb-scroll-pad">
      <div className="mx-auto max-w-4xl space-y-4">
        {/* Page-level action bar — right-aligned, lives above the content card */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {pdf === 'error' && (
            <p role="alert" className="text-xs text-red-600 min-w-0">No se pudo generar el PDF. Inténtalo de nuevo.</p>
          )}
          {/* Copy this quote's share link to send it freely (WhatsApp, email,
              anywhere) — the dealer can grab the link straight from the header. */}
          <button
            type="button"
            onClick={copyLink}
            className="btn-secondary flex-shrink-0"
            aria-label="Copiar el enlace de la cotización"
          >
            {copied ? <Check size={14} aria-hidden /> : <Link2 size={14} aria-hidden />}
            {copied ? 'Enlace copiado' : 'Copiar enlace'}
          </button>
          <button
            type="button"
            onClick={downloadPdf}
            disabled={pdf === 'working'}
            className="btn-brand flex-shrink-0"
            aria-label="Descargar cotización en PDF"
          >
            {pdf === 'working'
              ? <Loader2 size={14} className="animate-spin" aria-hidden />
              : <Download size={14} aria-hidden />}
            {pdf === 'working' ? 'Generando PDF…' : 'Descargar PDF'}
          </button>
        </div>
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
          onPickMaterialMany={pickMaterialFreeMany}
          onToggleOptional={toggleOptional}
          onSelectAlternative={pickAlternative}
        />

        {/* Shipment tracking. With a trackable container we show the live
            Hapag-Lloyd panels; before one is attached we still show the block,
            promising the client real-time geolocation once the order ships. */}
        {trackable.length > 0 ? (
          <section className="card p-4 sm:p-5 space-y-3">
            <h2 className="font-display text-sm font-semibold text-ink-900 flex items-center gap-2">
              <Ship size={15} className="text-brand-500" aria-hidden /> Seguimiento de tu envío
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
            <h2 className="font-display text-sm font-semibold text-ink-900 flex items-center gap-2">
              <Ship size={15} className="text-brand-500" aria-hidden /> Seguimiento de tu envío
            </h2>
            <div className="flex items-start gap-3 rounded-lg border border-brand-100 bg-brand-50/40 p-3.5">
              <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-600 shadow-xs">
                <MapPin size={15} aria-hidden />
              </span>
              <div className="space-y-1">
                <p className="text-xs font-semibold text-ink-800">Geolocalización en tiempo real</p>
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
    saving: { cls: 'bg-ink-900 text-white', icon: <Loader2 size={13} className="animate-spin" aria-hidden />, label: 'Guardando cambios…' },
    saved:  { cls: 'bg-emerald-600 text-white', icon: <Check size={14} aria-hidden />, label: 'Guardado' },
    error:  { cls: 'bg-red-600 text-white', icon: <CloudOff size={14} aria-hidden />, label: 'No se pudo guardar — revisa tu conexión' },
  }[state];
  if (!cfg) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-50 flex justify-center px-4 kb-hide-when-open">
      <div role="status" aria-live="polite" className={`inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-xs font-medium shadow-pop animate-in fade-in slide-in-from-bottom-2 duration-200 motion-reduce:animate-none ${cfg.cls}`}>
        {cfg.icon}{cfg.label}
      </div>
    </div>
  );
}
