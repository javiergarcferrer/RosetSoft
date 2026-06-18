import { userMessageFor } from '../lib/errorMessages.js';
import { useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, AlertCircle, Check, Download, PenLine, Eraser } from 'lucide-react';
import { fetchSharedContract, signSharedContract } from '../lib/contractShare.js';
import { resolvePaymentPlanView } from '../core/quote/index.js';
import { formatMoney } from '../lib/format.js';
import { safeDynamicImport } from '../lib/dynamicImport.js';

/**
 * Public, logged-OUT contract signing view (route #/contrato/:token).
 *
 * Fetches a whitelisted bundle from the `contract-share` Edge Function (the
 * company + client header, the financed total, the amortized payment schedule,
 * the contract body) and lets the client SIGN: a drawn signature + their name
 * are POSTed back, where the function archives the signature image and the
 * rendered signed PDF and stamps the plan signed. Renders OUTSIDE the auth shell
 * (forced light, like the quote link), depending on no AppContext.
 */
export default function PublicContractView() {
  const { token } = useParams();
  const [state, setState] = useState({ status: 'loading', bundle: null, error: null });
  const [signerName, setSignerName] = useState('');
  const [signerDoc, setSignerDoc] = useState('');
  const [submit, setSubmit] = useState('idle'); // idle | working | error
  const padRef = useRef(null);

  useEffect(() => {
    let active = true;
    setState({ status: 'loading', bundle: null, error: null });
    fetchSharedContract(token)
      .then((bundle) => { if (active) setState({ status: 'ready', bundle, error: null }); })
      .catch((e) => { if (active) setState({ status: 'error', bundle: null, error: userMessageFor(e) }); });
    return () => { active = false; };
  }, [token]);

  const bundle = state.bundle;
  const plan = useMemo(
    () => resolvePaymentPlanView(bundle?.plan || null, { rate: bundle?.rates?.DOP || 0 }),
    [bundle],
  );

  useEffect(() => {
    if (!bundle) return undefined;
    const prev = document.title;
    document.title = `Contrato — ${bundle.customer?.name || bundle.settings?.companyName || ''}`.trim();
    return () => { document.title = prev; };
  }, [bundle]);

  const isSigned = !!bundle?.plan?.signedAt;
  const rates = bundle?.rates || { USD: 1, DOP: 0 };
  const usd = (v) => formatMoney(v, 'USD');
  const dop = (v) => (rates.DOP ? formatMoney(v, 'DOP', { DOP: rates.DOP }) : '');

  async function handleSign() {
    if (submit === 'working' || !plan) return;
    const name = signerName.trim();
    const dataUrl = padRef.current?.getDataUrl();
    if (!name || !dataUrl) { setSubmit('error'); return; }
    setSubmit('working');
    try {
      // Render the signed PDF in the browser (embedding the drawn signature),
      // then archive it via the function. react-pdf is lazy-imported so the
      // heavy renderer only loads when the client actually signs.
      let signedPdfBase64 = '';
      try {
        const { generateContractPdf } = await safeDynamicImport(() => import('../pdf/contract/index.js'));
        const blob = await generateContractPdf({
          emisor: {
            name: bundle.settings?.companyName || '',
            rnc: bundle.settings?.companyRnc || '',
            address: bundle.settings?.companyAddress || '',
          },
          customer: bundle.customer
            ? { ...bundle.customer, doc: bundle.customer.rnc }
            : null,
          plan,
          contractBody: plan.contractBody,
          rates,
          signature: { name, doc: signerDoc.trim(), signedAt: Date.now(), src: dataUrl },
        });
        signedPdfBase64 = await blobToBase64(blob);
      } catch (e) {
        // The signature record stands on its own if PDF render fails — don't
        // block signing on the heavy renderer.
        console.warn('[PublicContractView] signed PDF render failed:', e);
      }
      const fresh = await signSharedContract(token, {
        signerName: name, signerDoc: signerDoc.trim(),
        signatureDataUrl: dataUrl, signedPdfBase64,
      });
      setState((s) => ({ ...s, bundle: fresh }));
      setSubmit('idle');
    } catch (e) {
      console.error('[PublicContractView] sign failed:', e);
      setSubmit('error');
    }
  }

  if (state.status === 'loading') {
    return (
      <div role="status" aria-live="polite" className="h-full flex flex-col items-center justify-center gap-3 bg-ink-50 text-ink-500">
        <Loader2 className="animate-spin text-brand-500" size={24} aria-hidden />
        <span className="text-sm">Cargando contrato…</span>
      </div>
    );
  }
  if (state.status === 'error' || !plan) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-ink-50 text-center px-6">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-ink-100 text-ink-400 mb-5 shadow-xs">
          <AlertCircle size={28} strokeWidth={1.5} aria-hidden />
        </div>
        <div className="font-display text-lg font-semibold text-ink-800">Enlace no disponible</div>
        <p className="text-sm text-ink-500 mt-2 max-w-sm leading-relaxed">
          Este contrato no es válido o fue desactivado. Pídele a tu asesor un
          enlace actualizado.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-ink-50 py-6 px-3 sm:px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] kb-scroll-pad">
      <div className="mx-auto max-w-3xl space-y-4">
        <section className="card p-5 sm:p-7 space-y-5">
          {/* Header */}
          <div className="flex items-start justify-between gap-4 border-b border-ink-100 pb-4">
            <div>
              <div className="font-display text-xl font-semibold text-ink-900">{bundle.settings?.companyName || 'Empresa'}</div>
              {bundle.settings?.companyRnc ? <div className="text-xs text-ink-500 mt-0.5">RNC {bundle.settings.companyRnc}</div> : null}
            </div>
            <div className="text-right">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-700">Contrato de venta a plazos</div>
              {bundle.plan?.number ? <div className="text-sm font-bold text-ink-800 mt-0.5">Nº {bundle.plan.number}</div> : null}
            </div>
          </div>

          {/* Client */}
          <div>
            <div className="text-[11px] uppercase tracking-wide text-ink-500">Cliente</div>
            <div className="text-base font-semibold text-ink-900 mt-0.5">{bundle.customer?.name || '—'}</div>
            {bundle.customer?.rnc ? <div className="text-xs text-ink-500">RNC/Cédula: {bundle.customer.rnc}</div> : null}
            {bundle.customer?.address ? <div className="text-xs text-ink-500">{bundle.customer.address}</div> : null}
          </div>

          {/* Terms */}
          {plan.contractBody ? (
            <p className="text-sm leading-relaxed text-ink-700 whitespace-pre-wrap">{plan.contractBody}</p>
          ) : null}

          {/* Financial summary */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Stat label="Total" value={usd(plan.totalUsd)} sub={dop(plan.totalUsd)} />
            {plan.scheduleMode === 'custom' ? (
              <>
                <Stat label="Pagos" value={`${plan.installmentCount} etapas`} />
                <Stat label="Primer pago" value={usd(plan.installments[0]?.amount || 0)} sub={dop(plan.installments[0]?.amount || 0)} />
              </>
            ) : (
              <>
                <Stat label={`Inicial (${plan.downPaymentPct}%)`} value={usd(plan.downPaymentUsd)} sub={dop(plan.downPaymentUsd)} />
                <Stat label="A financiar" value={usd(plan.financedUsd)} sub={dop(plan.financedUsd)} />
                <Stat label="Tasa mensual" value={`${plan.monthlyRatePct}%`} />
                <Stat label="Cuota mensual" value={usd(plan.monthlyUsd)} sub={`${plan.installmentCount} cuotas`} />
                <Stat label="Total a pagar" value={usd(plan.grandTotalToPayUsd)} sub={`Interés ${usd(plan.totalInterestUsd)}`} />
              </>
            )}
          </div>

          {/* Schedule */}
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-ink-500 border-b border-ink-100">
                  <th className="text-left py-2 px-2">#</th>
                  {plan.scheduleMode === 'custom' ? <th className="text-left py-2 px-2">Concepto</th> : null}
                  <th className="text-left py-2 px-2">Vencimiento</th>
                  {plan.scheduleMode === 'custom' ? null : <th className="text-right py-2 px-2">Capital</th>}
                  {plan.scheduleMode === 'custom' ? null : <th className="text-right py-2 px-2">Interés</th>}
                  <th className="text-right py-2 px-2">{plan.scheduleMode === 'custom' ? 'Pago' : 'Cuota'}</th>
                  <th className="text-right py-2 px-2">Balance</th>
                </tr>
              </thead>
              <tbody>
                {plan.installments.map((r) => (
                  <tr key={r.n} className="border-b border-ink-50">
                    <td className="py-2 px-2 text-ink-500">{r.n}</td>
                    {plan.scheduleMode === 'custom' ? <td className="py-2 px-2 text-ink-600">{r.label || `Etapa ${r.n}`}{r.pct ? ` · ${r.pct}%` : ''}</td> : null}
                    <td className="py-2 px-2 text-ink-700">{fmtDate(r.dueAt)}</td>
                    {plan.scheduleMode === 'custom' ? null : <td className="py-2 px-2 text-right text-ink-700">{usd(r.capital)}</td>}
                    {plan.scheduleMode === 'custom' ? null : <td className="py-2 px-2 text-right text-ink-700">{usd(r.interest)}</td>}
                    <td className="py-2 px-2 text-right font-medium text-ink-900">{usd(r.amount)}</td>
                    <td className="py-2 px-2 text-right text-ink-500">{usd(r.balanceAfter)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Sign / signed */}
        {isSigned ? (
          <section className="card p-5 sm:p-6 space-y-3 text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 mx-auto">
              <Check size={22} aria-hidden />
            </div>
            <div className="font-display text-lg font-semibold text-ink-900">Contrato firmado</div>
            <p className="text-sm text-ink-600">
              Firmado por {bundle.plan.signerName}{bundle.plan.signedAt ? ` el ${fmtDate(bundle.plan.signedAt)}` : ''}.
            </p>
            {bundle.plan.signedPdfUrl ? (
              <a href={bundle.plan.signedPdfUrl} target="_blank" rel="noopener noreferrer" className="btn-brand inline-flex">
                <Download size={14} aria-hidden /> Descargar contrato firmado
              </a>
            ) : null}
          </section>
        ) : (
          <section className="card p-5 sm:p-6 space-y-4">
            <h2 className="font-display text-sm font-semibold text-ink-900 flex items-center gap-2">
              <PenLine size={15} className="text-brand-500" aria-hidden /> Firmar contrato
            </h2>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-ink-500">Nombre completo</span>
                <input
                  type="text" value={signerName} onChange={(e) => setSignerName(e.target.value)}
                  className="input mt-1 w-full" placeholder="Tu nombre" autoComplete="name"
                />
              </label>
              <label className="block">
                <span className="text-xs text-ink-500">Cédula / RNC (opcional)</span>
                <input
                  type="text" value={signerDoc} onChange={(e) => setSignerDoc(e.target.value)}
                  className="input mt-1 w-full" placeholder="000-0000000-0"
                />
              </label>
            </div>
            <div>
              <span className="text-xs text-ink-500">Firma</span>
              <SignaturePad ref={padRef} />
            </div>
            {submit === 'error' && (
              <p role="alert" className="text-xs text-red-600">
                Escribe tu nombre y firma en el recuadro para continuar.
              </p>
            )}
            <button type="button" onClick={handleSign} disabled={submit === 'working'} className="btn-brand w-full justify-center">
              {submit === 'working'
                ? <><Loader2 size={14} className="animate-spin" aria-hidden /> Firmando…</>
                : <><Check size={14} aria-hidden /> Firmar y aceptar el contrato</>}
            </button>
            <p className="text-[11px] leading-relaxed text-ink-400 text-center">
              Al firmar aceptas el plan de pago y las condiciones descritas en este contrato.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-lg border border-ink-100 bg-surface px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wide text-ink-500">{label}</div>
      <div className="text-base font-bold text-ink-900 mt-0.5">{value}</div>
      {sub ? <div className="text-[11px] text-ink-400">{sub}</div> : null}
    </div>
  );
}

/**
 * Minimal canvas signature pad — pointer-drawn strokes, a clear button, and a
 * `getDataUrl()` imperative handle that returns the PNG (or null when blank). No
 * extra dependency; works with mouse + touch via Pointer Events.
 */
const SignaturePad = forwardRef(function SignaturePad(_props, ref) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const inkRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    // Size the backing store to the displayed size × DPR for a crisp line.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#171612';
    return undefined;
  }, []);

  function pos(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  function start(e) {
    e.preventDefault();
    drawingRef.current = true;
    const ctx = canvasRef.current.getContext('2d');
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    canvasRef.current.setPointerCapture?.(e.pointerId);
  }
  function move(e) {
    if (!drawingRef.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    inkRef.current = true;
  }
  function end() { drawingRef.current = false; }
  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    inkRef.current = false;
  }

  useImperativeHandle(ref, () => ({
    getDataUrl: () => (inkRef.current ? canvasRef.current.toDataURL('image/png') : null),
    clear,
  }));

  return (
    <div className="mt-1">
      <canvas
        ref={canvasRef}
        className="w-full h-40 rounded-lg border border-ink-200 bg-white touch-none cursor-crosshair"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
      />
      <button type="button" onClick={clear} className="mt-2 inline-flex items-center gap-1.5 text-xs text-ink-500 hover:text-ink-700">
        <Eraser size={13} aria-hidden /> Borrar
      </button>
    </div>
  );
});

function fmtDate(ms) {
  if (!ms) return '';
  const x = new Date(ms);
  return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
