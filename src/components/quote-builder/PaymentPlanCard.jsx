import { useEffect, useMemo, useState } from 'react';
import { Loader2, Link2, Download, Check, FileSignature, Save, Plus, Trash2, ChevronDown, Undo2, FileText, AlertTriangle } from 'lucide-react';
import { db, newId } from '../../db/database.js';
import { collectInstallment, uncollectInstallment } from '../../db/paymentPlans.js';
import { buildPlanSchedule, buildCustomSchedule, SPLIT_PRESETS, resolvePaymentPlanView } from '../../core/quote/index.js';
import { resolveAccountingConfig } from '../../core/accounting/index.js';
import { effectiveDopRate } from '../../lib/exchangeRate.js';
import { contractLinkUrl, newShareToken } from '../../lib/contractShare.js';
import { quoteSlug } from '../../lib/quoteNaming.js';
import { formatMoney } from '../../lib/format.js';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { useConfirm } from '../ConfirmProvider.jsx';

const DOWN_PCT = 50; // Default down payment for the financed (amortized) mode.

// A fresh custom plan starts as a 50/20/20/10 staged schedule, one month apart.
function defaultSplits() {
  return [50, 20, 20, 10].map((pct, i) => ({ pct, dueAt: addMonthsMs(defaultFirstDue(), i), label: '' }));
}

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
export default function PaymentPlanCard({ quote, customer, settings, totalUsd, standalone = false }) {
  // On its own ModeBar tab the card owns the whole surface, so it opens expanded
  // and drops the collapse toggle; inline it stays collapsed until tapped.
  const [open, setOpen] = useState(standalone);
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    mode: 'amortized', // 'amortized' | 'custom'
    monthlyRatePct: settings?.paymentPlanMonthlyRatePct ?? 2,
    installmentCount: 6,
    firstDueAt: defaultFirstDue(),
    splits: defaultSplits(),
    contractBody: '',
  });
  const [save, setSave] = useState('idle'); // idle | saving | saved | error
  const [copy, setCopy] = useState('idle'); // idle | done
  const [pdf, setPdf] = useState('idle');   // idle | working | error
  const [collecting, setCollecting] = useState(0); // installment n being collected (0 = none)
  const [uncollecting, setUncollecting] = useState(0); // installment n being undone (0 = none)
  const [collectErr, setCollectErr] = useState('');
  const [deleting, setDeleting] = useState(false);
  const confirm = useConfirm();

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
          const isCustom = row.scheduleMode === 'custom';
          setForm({
            mode: isCustom ? 'custom' : 'amortized',
            monthlyRatePct: row.monthlyRatePct ?? 0,
            installmentCount: row.installmentCount ?? 6,
            firstDueAt: row.firstDueAt ?? defaultFirstDue(),
            // Rebuild the stage editor from the saved schedule (pct/dueAt/label).
            splits: isCustom && Array.isArray(row.schedule) && row.schedule.length
              ? row.schedule.map((r) => ({ pct: r.pct ?? 0, dueAt: r.dueAt ?? defaultFirstDue(), label: r.label ?? '' }))
              : defaultSplits(),
            contractBody: row.contractBody ?? '',
          });
        }
      })
      .catch(() => { /* a fresh quote simply has no plan yet */ })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [quote?.id]);

  // Live preview off the form + the quote's current grand total.
  const preview = useMemo(() => buildScheduleFor(form, totalUsd), [form, totalUsd]);
  const splitTotalPct = useMemo(
    () => (form.splits || []).reduce((s, r) => s + (Number(r.pct) || 0), 0),
    [form.splits],
  );
  const splitsValid = Math.abs(splitTotalPct - 100) < 0.01;

  // The saved plan, decorated (paid/overdue + DOP) for the signed banner / link.
  const planView = useMemo(() => resolvePaymentPlanView(plan, { rate }), [plan, rate]);

  // Has the form diverged from the saved plan? Drives the "unsaved changes" hint
  // (the schedule table reflects the SAVED plan until you save, so the paid-mark
  // mapping for collections never breaks).
  const dirty = useMemo(() => {
    if (!plan) return false;
    if (form.mode !== (plan.scheduleMode === 'custom' ? 'custom' : 'amortized')) return true;
    if ((form.contractBody || '') !== (plan.contractBody || '')) return true;
    if (form.mode === 'amortized') {
      return Number(form.monthlyRatePct) !== Number(plan.monthlyRatePct)
        || Number(form.installmentCount) !== Number(plan.installmentCount)
        || form.firstDueAt !== plan.firstDueAt;
    }
    const saved = Array.isArray(plan.schedule) ? plan.schedule : [];
    if ((form.splits || []).length !== saved.length) return true;
    return form.splits.some((s, i) => Number(s.pct) !== Number(saved[i]?.pct)
      || s.dueAt !== saved[i]?.dueAt || (s.label || '') !== (saved[i]?.label || ''));
  }, [plan, form]);

  const usd = (v) => formatMoney(v, 'USD');
  const dop = (v) => (rate ? formatMoney(v, 'DOP', { DOP: rate }) : '');

  function defaultBody(srcForm = form) {
    if (srcForm.contractBody) return srcForm.contractBody;
    const head = `El cliente acuerda adquirir los bienes detallados en la cotización Nº ${quote?.number ?? ''} `;
    const tail = `conforme al calendario de pagos detallado en este contrato. La entrega de los bienes se `
      + `realizará según las condiciones acordadas. El atraso en el pago de cualquier cuota podrá generar `
      + `cargos por mora.`;
    if (srcForm.mode === 'custom') {
      const pcts = (srcForm.splits || []).map((s) => `${Number(s.pct) || 0}%`).join(' / ');
      return `${head}y pagar su valor total en ${preview.installmentCount} pagos por etapas (${pcts}), ${tail}`;
    }
    return `${head}y pagar su valor total mediante un pago inicial del ${DOWN_PCT}% y ${preview.installmentCount} `
      + `cuotas mensuales con una tasa de interés del ${preview.monthlyRatePct}% mensual, ${tail}`;
  }

  // `srcForm` lets a caller (handleSave) pass the just-computed form so the
  // write never reads a stale `form` from a setForm queued in the same tick.
  async function persist(patch = {}, srcForm = form) {
    const schedule = buildScheduleFor(srcForm, totalUsd);
    // Preserve any per-row paid marks (+ the linked cobro id) across a re-save,
    // matched by index so editing the plan doesn't drop collected cuotas.
    const prior = Array.isArray(plan?.schedule) ? plan.schedule : [];
    const installments = schedule.installments.map((r, i) => ({
      ...r, paidAt: prior[i]?.paidAt ?? null, paymentId: prior[i]?.paymentId ?? null,
    }));
    const now = Date.now();
    const row = {
      id: plan?.id || newId(),
      profileId: quote.profileId,
      quoteId: quote.id,
      customerId: quote.customerId || null,
      number: quote.number ?? null,
      scheduleMode: srcForm.mode,
      totalUsd: schedule.totalUsd,
      downPaymentPct: schedule.downPaymentPct,
      downPaymentUsd: schedule.downPaymentUsd,
      financedUsd: schedule.financedUsd,
      monthlyRatePct: schedule.monthlyRatePct,
      installmentCount: schedule.installmentCount,
      firstDueAt: srcForm.firstDueAt,
      schedule: installments,
      status: plan?.status || 'draft',
      contractBody: srcForm.contractBody || defaultBody(srcForm),
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
    if (form.mode === 'custom' && !splitsValid) { setSave('error'); return; }
    setSave('saving');
    try {
      // Default the contract body on first save so the dealer has editable text.
      // Build the body-filled form up front and persist THAT — reading `form`
      // back after a queued setForm would be stale (same-tick render batch).
      const body = form.contractBody || defaultBody();
      const next = body === form.contractBody ? form : { ...form, contractBody: body };
      if (next !== form) setForm(next);
      await persist({}, next);
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
      // The unsigned preview-plan must carry the same identity fields persist()
      // writes (customerId / number / contractBody) — otherwise the rendered
      // PDF drops the client/quote number and the contract text.
      const previewPlan = {
        ...preview,
        customerId: quote?.customerId || null,
        number: quote?.number ?? null,
        scheduleMode: form.mode,
        schedule: preview.installments,
        contractBody: form.contractBody || defaultBody(),
        status: 'draft',
      };
      const view = resolvePaymentPlanView(plan || previewPlan, { rate });
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

  // Undo a cuota collected by accident: reverses the cobro (deletes its asiento
  // + payment row) and clears the paid mark. See db/paymentPlans.
  async function uncollectCuota(n) {
    if (!plan || uncollecting) return;
    const ok = await confirm({
      title: 'Deshacer cobro',
      message: '¿Deshacer este cobro? Se eliminarán el pago y su asiento contable.',
      confirmLabel: 'Deshacer',
      tone: 'danger',
    });
    if (!ok) return;
    setUncollecting(n);
    setCollectErr('');
    try {
      const row = await uncollectInstallment({ plan, installmentN: n });
      setPlan(row);
    } catch (e) {
      console.error('[PaymentPlanCard] uncollect failed:', e);
      setCollectErr('No se pudo deshacer el cobro.');
    } finally {
      setUncollecting(0);
    }
  }

  // Delete the whole plan (e.g. when testing). Cobros already posted are NOT
  // reverted here — undo them first if you need their asientos gone.
  async function deletePlan() {
    if (!plan || deleting) return;
    const hasPaid = (plan.schedule || []).some((r) => r.paidAt);
    const msg = hasPaid
      ? 'Este plan tiene cobros registrados. Al eliminarlo, esos cobros y sus asientos NO se revierten (deshazlos antes si hace falta). ¿Eliminar el plan de pago?'
      : '¿Eliminar el plan de pago de este presupuesto? Esta acción no se puede deshacer.';
    const ok = await confirm({
      title: 'Eliminar plan de pago',
      message: msg,
      confirmLabel: 'Eliminar',
      tone: 'danger',
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await db.paymentPlans.delete(plan.id);
      setPlan(null);
      setForm({
        mode: 'amortized',
        monthlyRatePct: settings?.paymentPlanMonthlyRatePct ?? 2,
        installmentCount: 6,
        firstDueAt: defaultFirstDue(),
        splits: defaultSplits(),
        contractBody: '',
      });
    } catch (e) {
      console.error('[PaymentPlanCard] delete failed:', e);
    } finally {
      setDeleting(false);
    }
  }

  const noTotal = !(totalUsd > 0);
  const isCustom = form.mode === 'custom';
  const isSigned = !!planView?.isSigned;
  // Headline figures + schedule rows: the SAVED plan once one exists (so paid
  // marks + collection mapping hold), the live form preview before that.
  const summary = plan ? planView : preview;
  const rows = planView?.installments || preview.installments;
  const status = statusMeta(planView);
  const financedToPay = Number(planView?.financedToPayUsd || 0);
  const progressPct = financedToPay > 0
    ? Math.min(100, Math.round((Number(planView?.paidUsd || 0) / financedToPay) * 100))
    : 0;

  return (
    <section className="card">
      {/* On its own tab the header is a plain title; inline it's a collapse
          toggle (the plan/contract editor is only usable once opened). */}
      {standalone ? (
        <div className="card-header">
          <h2 className="flex items-center gap-2"><FileSignature size={15} className="text-brand-500" aria-hidden /> Plan de pago y contrato</h2>
          {plan ? (
            <div className="flex items-center gap-2">
              <span className="hidden sm:inline text-[11px] text-ink-400 tabular-nums">{usd(summary.grandTotalToPayUsd)}</span>
              <StatusPill status={status} />
            </div>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={`card-header w-full text-left ${open ? '' : 'border-b-0'}`}
        >
          <h2 className="flex items-center gap-2"><FileSignature size={15} className="text-brand-500" aria-hidden /> Plan de pago y contrato</h2>
          <div className="flex items-center gap-2">
            {plan ? (
              <>
                <span className="hidden sm:inline text-[11px] text-ink-400 tabular-nums">{usd(summary.grandTotalToPayUsd)}</span>
                <StatusPill status={status} />
              </>
            ) : null}
            <ChevronDown size={16} className={`text-ink-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} aria-hidden />
          </div>
        </button>
      )}

      {!open ? null : loading ? (
        <div className="p-5 flex items-center gap-2 text-ink-500 text-sm"><Loader2 size={15} className="animate-spin" /> Cargando plan de pago…</div>
      ) : noTotal ? (
        <div className="p-5">
          <p className="text-sm text-ink-500">Agrega productos con precio a la cotización para crear un plan de pago.</p>
        </div>
      ) : (
        <div className="p-5 space-y-6">
          {/* ── Summary: status + total + collection progress ───────────── */}
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={status} />
                {isSigned ? (
                  <span className="text-[11px] text-ink-500">
                    Firmado por <strong className="text-ink-700">{planView.signerName}</strong>
                    {planView.signedAt ? ` · ${fmtDate(planView.signedAt)}` : ''}
                    {planView.signerDoc ? ` · ${planView.signerDoc}` : ''}
                  </span>
                ) : null}
              </div>
              <div className="mt-2 text-2xl font-bold text-ink-900 tabular-nums leading-none">{usd(summary.grandTotalToPayUsd)}</div>
              {rate ? <div className="mt-0.5 text-xs text-ink-400 tabular-nums">{dop(summary.grandTotalToPayUsd)}</div> : null}
              <p className="mt-1.5 text-[11px] text-ink-500">{breakdownLine(form, summary, usd)}</p>
            </div>

            {plan && rows.length ? (
              <div className="w-full sm:w-56">
                <div className="flex items-baseline justify-between text-[11px] text-ink-500 mb-1">
                  <span>{planView.paidCount}/{rows.length} cuotas cobradas</span>
                  <span className="tabular-nums">{usd(planView.paidUsd)} / {usd(financedToPay)}</span>
                </div>
                <div className="h-1.5 rounded-full bg-ink-100 overflow-hidden">
                  <div className="h-full rounded-full bg-brand-500 transition-[width] duration-300" style={{ width: `${progressPct}%` }} />
                </div>
                {planView.overdueCount > 0 ? (
                  <p className="mt-1 text-[11px] font-medium text-red-600">{planView.overdueCount} {planView.overdueCount === 1 ? 'cuota vencida' : 'cuotas vencidas'}</p>
                ) : planView.outstandingUsd > 0.005 ? (
                  <p className="mt-1 text-[11px] text-ink-400">Pendiente {usd(planView.outstandingUsd)}</p>
                ) : (
                  <p className="mt-1 text-[11px] text-emerald-600">Cuotas saldadas</p>
                )}
              </div>
            ) : null}
          </div>

          {/* ── Condiciones: mode + parameters ─────────────────────────── */}
          <section className="space-y-3 border-t border-ink-100 pt-5">
            <SectionTitle>Condiciones</SectionTitle>
            {isSigned ? (
              <p className="flex items-start gap-1.5 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
                <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" aria-hidden />
                Este plan ya está firmado. Cambiar las condiciones puede invalidar el contrato acordado con el cliente.
              </p>
            ) : null}

            <div className="inline-flex rounded-lg border border-ink-200 p-0.5 text-sm" role="radiogroup" aria-label="Modo del plan de pago">
              <button type="button" role="radio" aria-checked={!isCustom} onClick={() => setForm((f) => ({ ...f, mode: 'amortized' }))}
                className={`px-3 py-1.5 rounded-md transition-colors ${!isCustom ? 'bg-brand-grad text-white shadow-glow' : 'text-ink-600'}`}>
                Financiado (cuotas + interés)
              </button>
              <button type="button" role="radio" aria-checked={isCustom} onClick={() => setForm((f) => ({ ...f, mode: 'custom' }))}
                className={`px-3 py-1.5 rounded-md transition-colors ${isCustom ? 'bg-brand-grad text-white shadow-glow' : 'text-ink-600'}`}>
                Pagos por etapas (%)
              </button>
            </div>

            {isCustom ? (
              <SplitsEditor
                splits={form.splits}
                totalUsd={totalUsd}
                splitTotalPct={splitTotalPct}
                splitsValid={splitsValid}
                usd={usd}
                onChange={(splits) => setForm((f) => ({ ...f, splits }))}
              />
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Field label="Inicial">
                  <div className="input bg-ink-50 cursor-not-allowed text-ink-500">{DOWN_PCT}%</div>
                </Field>
                <Field label="Tasa mensual %">
                  <input type="number" min="0" step="0.01" value={form.monthlyRatePct}
                    onChange={(e) => setForm((f) => ({ ...f, monthlyRatePct: e.target.value }))}
                    onBlur={(e) => {
                      // Clamp on blur so a cleared field reads back as 0 rather
                      // than the empty string the input briefly holds.
                      const n = Math.max(0, Number(e.target.value) || 0);
                      setForm((f) => ({ ...f, monthlyRatePct: n }));
                    }}
                    className="input w-full" />
                </Field>
                <Field label="Nº de cuotas">
                  <input type="number" min="1" step="1" value={form.installmentCount}
                    onChange={(e) => setForm((f) => ({ ...f, installmentCount: e.target.value }))}
                    onBlur={(e) => {
                      // At least one cuota; round a stray decimal to a whole count.
                      const n = Math.max(1, Math.round(Number(e.target.value) || 0));
                      setForm((f) => ({ ...f, installmentCount: n }));
                    }}
                    className="input w-full" />
                </Field>
                <Field label="Primera cuota">
                  <input type="date" value={toDateInput(form.firstDueAt)}
                    onChange={(e) => setForm((f) => ({ ...f, firstDueAt: fromDateInput(e.target.value) }))}
                    className="input w-full" />
                </Field>
              </div>
            )}
          </section>

          {/* ── Calendario: schedule + collections ─────────────────────── */}
          <section className="space-y-2 border-t border-ink-100 pt-5">
            <SectionTitle hint={!plan ? 'Guarda el plan para registrar cobros' : null}>Calendario de pagos</SectionTitle>
            {plan && dirty ? (
              <p className="text-[11px] text-amber-700">Tienes cambios sin guardar. Guarda el plan para actualizar el calendario.</p>
            ) : null}
            <ScheduleTable
              rows={rows}
              isCustom={isCustom}
              canCollect={!!plan}
              collecting={collecting}
              uncollecting={uncollecting}
              onCollect={collectCuota}
              onUncollect={uncollectCuota}
              usd={usd}
            />
            {collectErr ? <p role="alert" className="text-xs text-red-600">{collectErr}</p> : null}
          </section>

          {/* ── Contrato: collapsed by default, sensible default text ───── */}
          <section className="border-t border-ink-100 pt-5">
            <ContractDisclosure
              value={form.contractBody}
              placeholder={defaultBody()}
              onChange={(v) => setForm((f) => ({ ...f, contractBody: v }))}
            />
          </section>

          {/* ── Acciones ───────────────────────────────────────────────── */}
          <section className="border-t border-ink-100 pt-5 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={handleSave} disabled={save === 'saving' || (isCustom && !splitsValid)} className="btn-brand">
                {save === 'saving' ? <Loader2 size={14} className="animate-spin" /> : save === 'saved' ? <Check size={14} /> : <Save size={14} />}
                {save === 'saved' ? 'Guardado' : plan ? 'Guardar cambios' : 'Guardar plan'}
              </button>
              <button type="button" onClick={handleCopyLink} className="btn-ghost">
                {copy === 'done' ? <Check size={14} /> : <Link2 size={14} />}
                {copy === 'done' ? 'Enlace copiado' : 'Compartir contrato'}
              </button>
              <button type="button" onClick={handleDownloadPdf} disabled={pdf === 'working'} className="btn-ghost">
                {pdf === 'working' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                {isSigned ? 'Descargar firmado' : 'Descargar PDF'}
              </button>
              {plan ? (
                <button type="button" onClick={deletePlan} disabled={deleting}
                  className="btn-ghost ml-auto text-red-600 hover:bg-red-50">
                  {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  Eliminar
                </button>
              ) : null}
            </div>
            {save === 'error' ? (
              <p role="alert" className="text-xs text-red-600">{isCustom && !splitsValid ? 'Los porcentajes deben sumar 100% antes de guardar.' : 'No se pudo guardar.'}</p>
            ) : null}
            {pdf === 'error' ? <p role="alert" className="text-xs text-red-600">No se pudo generar el PDF.</p> : null}
            <p className="text-[11px] text-ink-400">
              Comparte el enlace para que el cliente revise y firme el contrato desde su teléfono; la firma queda archivada aquí. Cada cobro se registra en Contabilidad (Cuentas por cobrar).
            </p>
          </section>
        </div>
      )}
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

function SectionTitle({ children, hint }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">{children}</h3>
      {hint ? <span className="text-[11px] text-ink-400">{hint}</span> : null}
    </div>
  );
}

// The plan's at-a-glance status chip — Borrador → Guardado/Activo → Firmado →
// Completado, with "Con atrasos" surfacing overdue cuotas.
function statusMeta(pv) {
  if (!pv) return { label: 'Borrador', cls: 'bg-ink-100 text-ink-500' };
  if (pv.status === 'completed') return { label: 'Completado', cls: 'bg-emerald-100 text-emerald-700' };
  if (pv.isSigned) return { label: 'Firmado', cls: 'bg-emerald-100 text-emerald-700' };
  if (pv.overdueCount > 0) return { label: 'Con atrasos', cls: 'bg-red-100 text-red-700' };
  if (pv.paidCount > 0) return { label: 'Activo', cls: 'bg-brand-100 text-brand-700' };
  return { label: 'Guardado', cls: 'bg-ink-100 text-ink-600' };
}

function StatusPill({ status }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${status.cls}`}>
      {status.label}
    </span>
  );
}

// One-line composition of the plan, so the headline total never needs the old
// four-tile stat grid (which duplicated the schedule).
function breakdownLine(form, s, usd) {
  if (form.mode === 'custom') {
    return `${s.installmentCount} ${s.installmentCount === 1 ? 'pago' : 'pagos'} por etapas · total ${usd(s.totalUsd)}`;
  }
  return `${s.downPaymentPct}% inicial (${usd(s.downPaymentUsd)}) · ${s.installmentCount} ${s.installmentCount === 1 ? 'cuota' : 'cuotas'} de ${usd(s.monthlyUsd)} · interés ${usd(s.totalInterestUsd)} (${s.monthlyRatePct}%/mes)`;
}

// The payment schedule: the live preview before a plan is saved, and the saved
// schedule (with per-cuota collect / undo) once it exists.
function ScheduleTable({ rows, isCustom, canCollect, collecting, uncollecting, onCollect, onUncollect, usd }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-ink-500 border-b border-ink-100">
            <th className="text-left py-1.5 px-2 font-medium">#</th>
            {isCustom ? <th className="text-left py-1.5 px-2 font-medium">Concepto</th> : null}
            <th className="text-left py-1.5 px-2 font-medium">Vence</th>
            <th className="text-right py-1.5 px-2 font-medium">{isCustom ? 'Pago' : 'Cuota'}</th>
            {isCustom ? null : <th className="text-right py-1.5 px-2 font-medium">Interés</th>}
            <th className="text-right py-1.5 px-2 font-medium">Balance</th>
            {canCollect ? <th className="text-center py-1.5 px-2 font-medium">Cobro</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.n} className={`border-b border-ink-50 last:border-0 ${r.isOverdue ? 'bg-red-50/40' : ''}`}>
              <td className="py-1.5 px-2 text-ink-500 tabular-nums">{r.n}</td>
              {isCustom ? <td className="py-1.5 px-2 text-ink-600">{r.label || `Etapa ${r.n}`}{r.pct ? <span className="text-ink-400"> · {r.pct}%</span> : null}</td> : null}
              <td className="py-1.5 px-2 whitespace-nowrap">
                <span className={r.isOverdue && !r.isPaid ? 'text-red-600 font-medium' : 'text-ink-700'}>{fmtDate(r.dueAt)}</span>
                {r.state === 'due-soon' && !r.isPaid ? <span className="ml-1 text-[10px] text-amber-600">pronto</span> : null}
              </td>
              <td className="py-1.5 px-2 text-right font-medium text-ink-900 tabular-nums">{usd(r.amount)}</td>
              {isCustom ? null : <td className="py-1.5 px-2 text-right text-ink-500 tabular-nums">{usd(r.interest)}</td>}
              <td className="py-1.5 px-2 text-right text-ink-500 tabular-nums">{usd(r.balanceAfter)}</td>
              {canCollect ? (
                <td className="py-1.5 px-2 text-center whitespace-nowrap">
                  {r.isPaid ? (
                    <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                      <Check size={13} /> {fmtDate(r.paidAt)}
                      <button type="button" onClick={() => onUncollect(r.n)} disabled={uncollecting === r.n}
                        className="ml-0.5 text-ink-400 hover:text-red-600 disabled:opacity-40"
                        title="Deshacer cobro" aria-label="Deshacer cobro">
                        {uncollecting === r.n ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />}
                      </button>
                    </span>
                  ) : (
                    <button type="button" onClick={() => onCollect(r.n)} disabled={collecting === r.n}
                      className="inline-flex items-center gap-1 rounded-md border border-ink-200 px-2 py-0.5 text-xs font-medium text-brand-700 hover:border-brand-300 hover:bg-brand-50 disabled:opacity-40">
                      {collecting === r.n ? <Loader2 size={12} className="animate-spin" /> : null}
                      Cobrar
                    </button>
                  )}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The contract text, collapsed by default behind a preview — it defaults
// sensibly, so most dealers never need to open it.
function ContractDisclosure({ value, placeholder, onChange }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setShow((s) => !s)}
        className="flex w-full items-center justify-between gap-2 text-left" aria-expanded={show}>
        <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-ink-500">
          <FileText size={13} aria-hidden /> Texto del contrato
        </span>
        <ChevronDown size={14} className={`text-ink-400 transition-transform ${show ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {show ? (
        <textarea
          rows={5}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="input w-full resize-y text-sm mt-2"
        />
      ) : (
        <p className="mt-1.5 text-[11px] text-ink-400 line-clamp-2">{value || placeholder}</p>
      )}
    </div>
  );
}

// The staged-percentage editor (custom mode): presets + per-row pct/date/label,
// with a live "must total 100%" indicator.
function SplitsEditor({ splits, totalUsd, splitTotalPct, splitsValid, usd, onChange }) {
  const setRow = (i, patch) => onChange(splits.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => onChange([...splits, { pct: 0, dueAt: addMonthsMs(splits[splits.length - 1]?.dueAt || defaultFirstDue(), 1), label: '' }]);
  const removeRow = (i) => onChange(splits.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-500">Plantillas:</span>
        {SPLIT_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => onChange(p.pcts.map((pct, i) => ({
              pct, dueAt: addMonthsMs(defaultFirstDue(), i), label: splits[i]?.label || '',
            })))}
            className="text-xs px-2 py-1 rounded-md border border-ink-200 text-ink-600 hover:border-brand-300"
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {splits.map((r, i) => {
          const amount = (totalUsd || 0) * (Number(r.pct) || 0) / 100;
          return (
            <div key={i} className="flex items-end gap-2">
              <Field label={i === 0 ? '%' : ''}>
                <input type="number" min="0" step="1" value={r.pct}
                  onChange={(e) => setRow(i, { pct: e.target.value })}
                  className="input w-16" />
              </Field>
              <Field label={i === 0 ? 'Vence' : ''}>
                <input type="date" value={toDateInput(r.dueAt)}
                  onChange={(e) => setRow(i, { dueAt: fromDateInput(e.target.value) })}
                  className="input w-full" />
              </Field>
              <Field label={i === 0 ? 'Concepto (opcional)' : ''}>
                <input type="text" value={r.label || ''} placeholder={`Etapa ${i + 1}`}
                  onChange={(e) => setRow(i, { label: e.target.value })}
                  className="input w-full" />
              </Field>
              <div className="text-sm text-ink-600 w-24 text-right pb-2">{usd(amount)}</div>
              <button type="button" onClick={() => removeRow(i)} disabled={splits.length <= 1}
                className="pb-2 text-ink-400 hover:text-red-600 disabled:opacity-30" aria-label="Quitar etapa">
                <Trash2 size={15} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between">
        <button type="button" onClick={addRow} className="text-xs text-brand-700 hover:text-brand-900 inline-flex items-center gap-1">
          <Plus size={13} /> Agregar etapa
        </button>
        <span className={`text-xs font-medium ${splitsValid ? 'text-emerald-700' : 'text-red-600'}`}>
          Suma: {splitTotalPct}% {splitsValid ? '✓' : '(debe ser 100%)'}
        </span>
      </div>
    </div>
  );
}

// Build the schedule for the current form, dispatching by mode. Pure-ish (reads
// only the form + total) — the Model does the math.
function buildScheduleFor(form, totalUsd) {
  if (form.mode === 'custom') {
    return buildCustomSchedule({ totalUsd: totalUsd || 0, splits: form.splits || [] });
  }
  return buildPlanSchedule({
    totalUsd: totalUsd || 0,
    downPaymentPct: DOWN_PCT,
    monthlyRatePct: Number(form.monthlyRatePct) || 0,
    installmentCount: Math.max(1, Number(form.installmentCount) || 1),
    firstDueAt: form.firstDueAt,
  });
}

function addMonthsMs(ms, months) {
  const d = new Date(ms || Date.now());
  const day = d.getDate();
  const t = new Date(d.getTime());
  t.setDate(1);
  t.setMonth(t.getMonth() + months);
  const lastDay = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(day, lastDay));
  return t.getTime();
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
