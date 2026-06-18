import { useEffect, useMemo, useState } from 'react';
import { Loader2, Link2, Download, Check, FileSignature, Save } from 'lucide-react';
import { db, newId } from '../../db/database.js';
import { collectInstallment } from '../../db/paymentPlans.js';
import { buildPlanSchedule, resolvePaymentPlanView } from '../../core/quote/index.js';
import { resolveAccountingConfig } from '../../core/accounting/index.js';
import { effectiveDopRate } from '../../lib/exchangeRate.js';
import { contractLinkUrl, newShareToken } from '../../lib/contractShare.js';
import { quoteSlug } from '../../lib/quoteNaming.js';
import { formatMoney } from '../../lib/format.js';
import { safeDynamicImport } from '../../lib/dynamicImport.js';

const DOWN_PCT = 50; // The dealer's standing policy: always a 50% down payment.

/**
 * Per-quote payment plan + digital contract (the dealer side).
 *
 * The dealer finances the quote: a fixed 50% down payment + N equal monthly
 * cuotas at a monthly interest rate (the amortization Model is lib/paymentPlan).
 * The same row backs a public, signable contract link (#/contrato/<token>,
 * served by the `contract-share` Edge Function): the card mints/enables the
 * share token, shows the signed state, and downloads the contract PDF. The plan
 * persists to the `payment_plans` table keyed on this quote.
 */
export default function PaymentPlanCard({ quote, customer, settings, totalUsd }) {
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    monthlyRatePct: settings?.paymentPlanMonthlyRatePct ?? 2,
    installmentCount: 6,
    firstDueAt: defaultFirstDue(),
    contractBody: '',
  });
  const [save, setSave] = useState('idle'); // idle | saving | saved | error
  const [copy, setCopy] = useState('idle'); // idle | done
  const [pdf, setPdf] = useState('idle');   // idle | working | error
  const [collecting, setCollecting] = useState(0); // installment n being collected (0 = none)
  const [collectErr, setCollectErr] = useState('');

  const rate = effectiveDopRate(settings);
  const scope = quote?.profileId || 'team';
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);

  // Load the existing plan for this quote (if any) and seed the form from it.
  useEffect(() => {
    let active = true;
    if (!quote?.id) { setLoading(false); return undefined; }
    setLoading(true);
    db.paymentPlans.where('quoteId').equals(quote.id).toArray()
      .then((rows) => {
        if (!active) return;
        const row = rows[0] || null;
        setPlan(row);
        if (row) {
          setForm({
            monthlyRatePct: row.monthlyRatePct ?? 0,
            installmentCount: row.installmentCount ?? 6,
            firstDueAt: row.firstDueAt ?? defaultFirstDue(),
            contractBody: row.contractBody ?? '',
          });
        }
      })
      .catch(() => { /* a fresh quote simply has no plan yet */ })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [quote?.id]);

  // Live preview off the form + the quote's current grand total.
  const preview = useMemo(() => buildPlanSchedule({
    totalUsd: totalUsd || 0,
    downPaymentPct: DOWN_PCT,
    monthlyRatePct: Number(form.monthlyRatePct) || 0,
    installmentCount: Math.max(1, Number(form.installmentCount) || 1),
    firstDueAt: form.firstDueAt,
  }), [totalUsd, form.monthlyRatePct, form.installmentCount, form.firstDueAt]);

  // The saved plan, decorated (paid/overdue + DOP) for the signed banner / link.
  const planView = useMemo(() => resolvePaymentPlanView(plan, { rate }), [plan, rate]);

  const usd = (v) => formatMoney(v, 'USD');
  const dop = (v) => (rate ? formatMoney(v, 'DOP', { DOP: rate }) : '');

  function defaultBody() {
    return form.contractBody || (
      `El cliente acuerda adquirir los bienes detallados en la cotización Nº ${quote?.number ?? ''} `
      + `y pagar su valor total mediante un pago inicial del ${DOWN_PCT}% y ${preview.installmentCount} `
      + `cuotas mensuales con una tasa de interés del ${preview.monthlyRatePct}% mensual, conforme al `
      + `calendario de pagos detallado en este contrato. La entrega de los bienes se realizará según las `
      + `condiciones acordadas. El atraso en el pago de cualquier cuota podrá generar cargos por mora.`
    );
  }

  async function persist(patch = {}) {
    const schedule = buildPlanSchedule({
      totalUsd: totalUsd || 0,
      downPaymentPct: DOWN_PCT,
      monthlyRatePct: Number(form.monthlyRatePct) || 0,
      installmentCount: Math.max(1, Number(form.installmentCount) || 1),
      firstDueAt: form.firstDueAt,
    });
    // Preserve any per-row paid marks across a re-save (matched by index).
    const prior = Array.isArray(plan?.schedule) ? plan.schedule : [];
    const installments = schedule.installments.map((r, i) => ({
      ...r, paidAt: prior[i]?.paidAt ?? null,
    }));
    const now = Date.now();
    const row = {
      id: plan?.id || newId(),
      profileId: quote.profileId,
      quoteId: quote.id,
      customerId: quote.customerId || null,
      number: quote.number ?? null,
      totalUsd: schedule.totalUsd,
      downPaymentPct: DOWN_PCT,
      downPaymentUsd: schedule.downPaymentUsd,
      financedUsd: schedule.financedUsd,
      monthlyRatePct: schedule.monthlyRatePct,
      installmentCount: schedule.installmentCount,
      firstDueAt: form.firstDueAt,
      schedule: installments,
      status: plan?.status || 'draft',
      contractBody: form.contractBody || defaultBody(),
      shareToken: plan?.shareToken ?? null,
      shareEnabled: plan?.shareEnabled ?? false,
      signedAt: plan?.signedAt ?? null,
      signerName: plan?.signerName ?? null,
      signerDoc: plan?.signerDoc ?? null,
      signatureImageId: plan?.signatureImageId ?? null,
      signedPdfPath: plan?.signedPdfPath ?? null,
      createdAt: plan?.createdAt ?? now,
      updatedAt: now,
      ...patch,
    };
    await db.paymentPlans.put(row);
    setPlan(row);
    return row;
  }

  async function handleSave() {
    if (save === 'saving') return;
    setSave('saving');
    try {
      // Default the contract body on first save so the dealer has editable text.
      if (!form.contractBody) setForm((f) => ({ ...f, contractBody: defaultBody() }));
      await persist();
      setSave('saved');
      setTimeout(() => setSave('idle'), 1800);
    } catch (e) {
      console.error('[PaymentPlanCard] save failed:', e);
      setSave('error');
    }
  }

  // Mint + enable the share token (idempotent), then copy the contract link.
  async function handleCopyLink() {
    try {
      let row = plan;
      let token = row?.shareToken;
      if (!token || !row?.shareEnabled || !row) {
        token = token || newShareToken();
        row = await persist({ shareToken: token, shareEnabled: true });
      }
      const url = contractLinkUrl(token, quoteSlug(quote, customer));
      await navigator.clipboard.writeText(url);
      setCopy('done');
      setTimeout(() => setCopy('idle'), 1800);
    } catch (e) {
      console.error('[PaymentPlanCard] copy link failed:', e);
    }
  }

  // Download the contract PDF. If already signed, open the archived signed PDF;
  // otherwise render the current (unsigned) contract for review.
  async function handleDownloadPdf() {
    if (pdf === 'working') return;
    if (planView?.isSigned && planView.signedPdfPath) {
      window.open(signedPdfUrl(planView.signedPdfPath), '_blank', 'noopener');
      return;
    }
    setPdf('working');
    try {
      const view = resolvePaymentPlanView(plan || { ...form, ...preview, schedule: preview.installments, downPaymentPct: DOWN_PCT, totalUsd: preview.totalUsd, downPaymentUsd: preview.downPaymentUsd, financedUsd: preview.financedUsd, status: 'draft' }, { rate });
      const { generateContractPdf, downloadBlob } = await safeDynamicImport(() => import('../../pdf/contract/index.js'));
      const blob = await generateContractPdf({
        emisor: { name: settings?.companyName || '', rnc: settings?.companyRnc || '', address: settings?.companyAddress || '' },
        customer: customer ? { name: customer.name, company: customer.company, address: customer.address, doc: customer.rnc } : null,
        plan: view,
        contractBody: view?.contractBody || defaultBody(),
        rates: { USD: 1, DOP: rate },
        signature: view?.isSigned ? { name: view.signerName, doc: view.signerDoc, signedAt: view.signedAt, src: view.signatureImageId ? imageUrl(view.signatureImageId) : undefined } : null,
      });
      await downloadBlob(blob, `Contrato ${quote?.number ?? ''} ${customer?.name || ''}`.trim() + '.pdf');
      setPdf('idle');
    } catch (e) {
      console.error('[PaymentPlanCard] PDF failed:', e);
      setPdf('error');
    }
  }

  // Collect a cuota: post a real cobro to the ledger (allocated to the quote's
  // invoice, or an advance if not yet invoiced) and stamp the installment paid.
  // Shared with the Contabilidad collections board via db/paymentPlans.
  async function collectCuota(n) {
    if (!plan || collecting) return;
    setCollecting(n);
    setCollectErr('');
    try {
      const row = await collectInstallment({ plan, installmentN: n, config, scope, rate });
      setPlan(row);
    } catch (e) {
      console.error('[PaymentPlanCard] collect failed:', e);
      setCollectErr('No se pudo registrar el cobro.');
    } finally {
      setCollecting(0);
    }
  }

  if (loading) {
    return (
      <section className="card card-pad">
        <div className="flex items-center gap-2 text-ink-500 text-sm"><Loader2 size={15} className="animate-spin" /> Cargando plan de pago…</div>
      </section>
    );
  }

  const noTotal = !(totalUsd > 0);

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="flex items-center gap-2"><FileSignature size={15} className="text-brand-500" aria-hidden /> Plan de pago y contrato</h2>
        {planView?.isSigned ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700"><Check size={13} /> Firmado</span>
        ) : null}
      </div>

      <div className="p-5 space-y-5">
        {noTotal ? (
          <p className="text-sm text-ink-500">Agrega productos con precio a la cotización para crear un plan de pago.</p>
        ) : (
          <>
            {/* Parameters */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Field label="Inicial">
                <div className="input bg-ink-50 cursor-not-allowed">{DOWN_PCT}%</div>
              </Field>
              <Field label="Tasa mensual %">
                <input type="number" min="0" step="0.01" value={form.monthlyRatePct}
                  onChange={(e) => setForm((f) => ({ ...f, monthlyRatePct: e.target.value }))}
                  className="input w-full" />
              </Field>
              <Field label="Nº de cuotas">
                <input type="number" min="1" step="1" value={form.installmentCount}
                  onChange={(e) => setForm((f) => ({ ...f, installmentCount: e.target.value }))}
                  className="input w-full" />
              </Field>
              <Field label="Primera cuota">
                <input type="date" value={toDateInput(form.firstDueAt)}
                  onChange={(e) => setForm((f) => ({ ...f, firstDueAt: fromDateInput(e.target.value) }))}
                  className="input w-full" />
              </Field>
            </div>

            {/* Summary */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Inicial" value={usd(preview.downPaymentUsd)} sub={dop(preview.downPaymentUsd)} />
              <Stat label="A financiar" value={usd(preview.financedUsd)} sub={dop(preview.financedUsd)} />
              <Stat label="Cuota mensual" value={usd(preview.monthlyUsd)} sub={`${preview.installmentCount} cuotas`} />
              <Stat label="Total a pagar" value={usd(preview.grandTotalToPayUsd)} sub={`Interés ${usd(preview.totalInterestUsd)}`} />
            </div>

            {/* Contract body */}
            <Field label="Texto del contrato">
              <textarea
                rows={4}
                value={form.contractBody}
                placeholder={defaultBody()}
                onChange={(e) => setForm((f) => ({ ...f, contractBody: e.target.value }))}
                className="input w-full resize-y text-sm"
              />
            </Field>

            {/* Schedule */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-ink-500 border-b border-ink-100">
                    <th className="text-left py-1.5 px-2">#</th>
                    <th className="text-left py-1.5 px-2">Vence</th>
                    <th className="text-right py-1.5 px-2">Cuota</th>
                    <th className="text-right py-1.5 px-2">Interés</th>
                    <th className="text-right py-1.5 px-2">Balance</th>
                    {plan ? <th className="text-center py-1.5 px-2">Cobro</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {(planView?.installments || preview.installments).map((r) => (
                    <tr key={r.n} className={`border-b border-ink-50 ${r.isOverdue ? 'bg-red-50/50' : ''}`}>
                      <td className="py-1.5 px-2 text-ink-500">{r.n}</td>
                      <td className="py-1.5 px-2 text-ink-700">{fmtDate(r.dueAt)}</td>
                      <td className="py-1.5 px-2 text-right font-medium text-ink-900">{usd(r.amount)}</td>
                      <td className="py-1.5 px-2 text-right text-ink-500">{usd(r.interest)}</td>
                      <td className="py-1.5 px-2 text-right text-ink-500">{usd(r.balanceAfter)}</td>
                      {plan ? (
                        <td className="py-1.5 px-2 text-center whitespace-nowrap">
                          {r.isPaid ? (
                            <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><Check size={13} /> {fmtDate(r.paidAt)}</span>
                          ) : (
                            <button type="button" onClick={() => collectCuota(r.n)} disabled={collecting === r.n}
                              className="text-xs text-brand-700 hover:text-brand-900 inline-flex items-center gap-1">
                              {collecting === r.n ? <Loader2 size={12} className="animate-spin" /> : null}
                              Registrar cobro
                            </button>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {collectErr && <p role="alert" className="text-xs text-red-600">{collectErr}</p>}
            {plan && planView?.paidCount > 0 ? (
              <p className="text-[11px] text-ink-400">
                Cobrado {usd(planView.paidUsd)} · pendiente {usd(planView.outstandingUsd)}. Cada cobro se registra en Contabilidad (Cuentas por cobrar).
              </p>
            ) : null}

            {/* Signed banner */}
            {planView?.isSigned ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 text-sm text-emerald-800">
                Firmado por <strong>{planView.signerName}</strong>
                {planView.signedAt ? ` el ${fmtDate(planView.signedAt)}` : ''}
                {planView.signerDoc ? ` · ${planView.signerDoc}` : ''}.
              </div>
            ) : null}

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button type="button" onClick={handleSave} disabled={save === 'saving'} className="btn-brand">
                {save === 'saving' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {save === 'saved' ? 'Guardado' : 'Guardar plan'}
              </button>
              <button type="button" onClick={handleCopyLink} className="btn-ghost" disabled={!plan && save !== 'saved'}>
                {copy === 'done' ? <Check size={14} /> : <Link2 size={14} />}
                {copy === 'done' ? 'Enlace copiado' : 'Copiar enlace del contrato'}
              </button>
              <button type="button" onClick={handleDownloadPdf} disabled={pdf === 'working'} className="btn-ghost">
                {pdf === 'working' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                {planView?.isSigned ? 'Descargar firmado' : 'Descargar PDF'}
              </button>
              {save === 'error' && <span role="alert" className="text-xs text-red-600">No se pudo guardar.</span>}
              {pdf === 'error' && <span role="alert" className="text-xs text-red-600">No se pudo generar el PDF.</span>}
            </div>
            <p className="text-[11px] text-ink-400">
              Guarda el plan, copia el enlace y envíaselo al cliente. Él podrá ver el contrato y firmarlo desde su teléfono; la firma queda archivada aquí.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="text-xs text-ink-500">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-lg border border-ink-100 bg-surface px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-ink-500">{label}</div>
      <div className="text-sm font-bold text-ink-900 mt-0.5">{value}</div>
      {sub ? <div className="text-[11px] text-ink-400">{sub}</div> : null}
    </div>
  );
}

const VITE_ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const SUPABASE_URL = VITE_ENV.VITE_SUPABASE_URL || '';
function imageUrl(id) {
  return `${SUPABASE_URL}/storage/v1/object/public/images/${encodeURIComponent(id)}.png`;
}
function signedPdfUrl(path) {
  return `${SUPABASE_URL}/storage/v1/object/public/documents/${encodeURIComponent(path)}`;
}

function defaultFirstDue() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}
function toDateInput(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fromDateInput(str) {
  if (!str) return defaultFirstDue();
  const [y, m, day] = str.split('-').map(Number);
  return new Date(y, (m || 1) - 1, day || 1, 12, 0, 0, 0).getTime();
}
function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
