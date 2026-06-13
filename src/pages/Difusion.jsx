import { userMessageFor } from '../lib/errorMessages.js';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Megaphone, LayoutTemplate, Loader2, Plus, Trash2, Send, Search,
  CheckCheck, AlertTriangle, Users, UserSquare2, RefreshCw, Check, Link2,
} from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import BackLink from '../components/BackLink.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Modal from '../components/Modal.jsx';
import { useApp } from '../context/AppContext.jsx';
import { db } from '../db/database.js';
import { useLiveQueryStatus } from '../db/hooks.js';
import {
  VAR_SOURCES, resolveBroadcastAudience, buildBroadcastRecipients,
  fillTemplateBody, resolveCampaignsList, displayPhone,
} from '../core/crm/index.js';
import {
  listWaTemplates, createWaTemplate, deleteWaTemplate, sendWhatsappBroadcast,
} from '../lib/whatsapp.js';
import { shareLinkBase } from '../lib/quoteShare.js';
import { formatDateTime } from '../lib/format.js';

// wa-send caps one broadcast call; bigger audiences ship in sequential chunks.
const CHUNK = 250;

/**
 * Difusión — the WhatsApp marketing surface. Two tabs:
 *
 *   • Campañas   — send an APPROVED template to a chosen audience (the
 *                  professionals / customers lists), with per-variable
 *                  mapping and a live delivery rollup per past campaign
 *                  (sent → delivered → read, from the webhook truth).
 *   • Plantillas — manage the WABA's message templates: list with approval
 *                  state, create (Meta reviews asynchronously), delete.
 *
 * Inbound Click-to-WhatsApp ad traffic lands in the inbox tagged with its ad
 * referral (see Chats); this page owns the OUTBOUND half of the ads story.
 */
export default function Difusion() {
  const { profileId, settings } = useApp();
  const [tab, setTab] = useState('campaigns');
  // ?campana=profesionales|clientes — deep link from the CRM lists (the
  // Profesionales header's "Difusión" button): land with the campaign wizard
  // already open on that audience.
  const [search] = useSearchParams();
  const campaignParam = search.get('campana');

  // Templates load live from Meta (approval state changes server-side).
  const [templates, setTemplates] = useState(null); // null = loading
  const [templatesError, setTemplatesError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let alive = true;
    setTemplates(null);
    setTemplatesError(null);
    listWaTemplates().then((res) => {
      if (!alive) return;
      if (res?.ok) setTemplates(res.templates || []);
      else { setTemplates([]); setTemplatesError(res?.error || 'No se pudieron cargar las plantillas.'); }
    }).catch((e) => { if (alive) { setTemplates([]); setTemplatesError(userMessageFor(e)); } });
    return () => { alive = false; };
  }, [reloadKey]);

  const { data: campaigns } = useLiveQueryStatus(
    () => db.waCampaigns.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const { data: messages } = useLiveQueryStatus(
    () => db.waMessages.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const { data: customers } = useLiveQueryStatus(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const { data: professionals } = useLiveQueryStatus(
    () => db.professionals.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );

  const campaignRows = useMemo(
    () => resolveCampaignsList({ campaigns, messages }),
    [campaigns, messages],
  );

  const connected = !!settings?.whatsappConnectedAt;
  if (!connected) {
    return (
      <>
        <BackLink to="/chats">Volver a WhatsApp</BackLink>
        <PageHeader title="Difusión" subtitle="Campañas de WhatsApp con plantillas aprobadas" />
        <EmptyState
          icon={Megaphone}
          title="WhatsApp no está conectado"
          description="Conecta tu app de WhatsApp Business (Cloud API) en Configuración para crear plantillas y enviar campañas."
          action={<Link to="/settings" className="btn-primary text-sm">Ir a Configuración</Link>}
        />
      </>
    );
  }

  return (
    <>
      <BackLink to="/chats">Volver a WhatsApp</BackLink>
      <PageHeader
        title="Difusión"
        subtitle="Campañas de marketing por WhatsApp — plantillas aprobadas a tu lista de contactos"
      />

      <div className="flex items-center gap-1.5 mb-4">
        <TabButton active={tab === 'campaigns'} onClick={() => setTab('campaigns')} icon={Megaphone} label="Campañas" />
        <TabButton active={tab === 'templates'} onClick={() => setTab('templates')} icon={LayoutTemplate} label="Plantillas" />
      </div>

      {tab === 'campaigns' ? (
        <CampaignsTab
          templates={templates}
          templatesError={templatesError}
          campaignRows={campaignRows}
          customers={customers}
          professionals={professionals}
          autoOpenKind={campaignParam === 'clientes' ? 'customers' : campaignParam ? 'professionals' : null}
        />
      ) : (
        <TemplatesTab
          templates={templates}
          templatesError={templatesError}
          onReload={() => setReloadKey((k) => k + 1)}
        />
      )}
    </>
  );
}

function TabButton({ active, onClick, icon: Icon, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
        active ? 'bg-brand-600 text-white' : 'text-ink-500 hover:bg-ink-100'
      }`}
    >
      <Icon size={14} /> {label}
    </button>
  );
}

/* ------------------------------- campaigns ------------------------------- */

function CampaignsTab({ templates, templatesError, campaignRows, customers, professionals, autoOpenKind }) {
  const [wizardOpen, setWizardOpen] = useState(!!autoOpenKind);
  const approved = (templates || []).filter((t) => t.status === 'APPROVED');

  return (
    <div className="space-y-4">
      <div className="card card-pad flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink-900">Nueva campaña</div>
          <p className="text-xs text-ink-500 mt-0.5">
            Envía una plantilla aprobada a profesionales o clientes. Meta cobra por conversación de
            marketing iniciada; la entrega y lectura se rastrean aquí.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setWizardOpen(true)}
          disabled={templates === null}
          className="btn-brand shrink-0"
        >
          <Plus size={14} /> Crear campaña
        </button>
      </div>

      {templatesError && (
        <p className="text-xs text-red-700 bg-red-50 rounded-lg px-3 py-2">{templatesError}</p>
      )}

      {/* History with live delivery rollups */}
      {campaignRows.length === 0 ? (
        <div className="card card-pad py-12 flex flex-col items-center gap-3 text-center">
          <span className="w-12 h-12 rounded-full bg-brand-50 flex items-center justify-center">
            <Megaphone size={20} className="text-brand-400" />
          </span>
          <div>
            <p className="text-sm font-medium text-ink-700">Sin campañas todavía</p>
            <p className="text-xs text-ink-400 mt-0.5">Tu primera difusión aparecerá aquí con sus métricas de entrega y lectura.</p>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {campaignRows.map(({ campaign, recipients, sent, delivered, read, failed, billable }) => (
            <div key={campaign.id} className="card card-pad">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-ink-900 truncate">{campaign.name}</div>
                  <div className="text-[11px] text-ink-500 mt-0.5">
                    Plantilla <span className="font-medium">{campaign.templateName}</span>
                    {campaign.audience ? <> · {campaign.audience}</> : null}
                    {' · '}{formatDateTime(campaign.createdAt)}
                    {billable > 0 && <> · <span title="Mensajes que Meta facturó (aplica tu tarifa por país)">{billable} facturable{billable === 1 ? '' : 's'}</span></>}
                  </div>
                </div>
                <div className="flex items-center gap-3 text-center shrink-0">
                  <Metric label="Enviados" value={sent} of={recipients} />
                  <Metric label="Entregados" value={delivered} of={recipients} icon={<CheckCheck size={11} className="opacity-50" />} />
                  <Metric label="Leídos" value={read} of={recipients} icon={<CheckCheck size={11} className="text-sky-500" />} />
                  {failed > 0 && <Metric label="Fallidos" value={failed} of={recipients} tone="text-red-600" />}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <CampaignWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        approved={approved}
        customers={customers}
        professionals={professionals}
        initialKind={autoOpenKind}
      />
    </div>
  );
}

function Metric({ label, value, of, icon, tone = 'text-ink-900' }) {
  return (
    <div>
      <div className={`text-sm font-semibold tabular-nums ${tone} inline-flex items-center gap-1`}>
        {icon}{value}<span className="text-[10px] font-normal text-ink-400">/{of}</span>
      </div>
      <div className="eyebrow-xs text-ink-400">{label}</div>
    </div>
  );
}

const AUDIENCE_KINDS = [
  { value: 'professionals', label: 'Profesionales', icon: UserSquare2 },
  { value: 'customers', label: 'Clientes', icon: Users },
  { value: 'all', label: 'Todos', icon: Megaphone },
];

/** Template → audience → variables → send, in one modal. */
function CampaignWizard({ open, onClose, approved, customers, professionals, initialKind }) {
  const [template, setTemplate] = useState(null);
  const [kind, setKind] = useState(initialKind || 'professionals');
  const [needle, setNeedle] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const [varSpecs, setVarSpecs] = useState([]);
  const [name, setName] = useState('');
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total }
  const [result, setResult] = useState(null); // { sent, failed, errors }
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setTemplate(null);
    setKind(initialKind || 'professionals');
    setNeedle('');
    setPicked(new Set());
    setVarSpecs([]);
    setName('');
    setSending(false);
    setProgress(null);
    setResult(null);
    setError(null);
  }, [open]);

  const audience = useMemo(
    () => resolveBroadcastAudience(customers, professionals, { kind, needle }),
    [customers, professionals, kind, needle],
  );
  // The full (unsearched) audience for "select all" counts.
  const fullAudience = useMemo(
    () => resolveBroadcastAudience(customers, professionals, { kind }),
    [customers, professionals, kind],
  );
  const selectedContacts = useMemo(
    () => fullAudience.filter((c) => picked.has(c.key)),
    [fullAudience, picked],
  );

  function chooseTemplate(t) {
    setTemplate(t);
    setVarSpecs(Array.from({ length: t.varCount }, (_, i) => (i === 0 ? { source: 'firstName' } : { source: 'fixed', text: '' })));
    setName(`${t.name} · ${new Date().toLocaleDateString('es-DO')}`);
  }

  function toggle(key) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const allVisiblePicked = audience.length > 0 && audience.every((c) => picked.has(c.key));
  function toggleAllVisible() {
    setPicked((prev) => {
      const next = new Set(prev);
      if (allVisiblePicked) audience.forEach((c) => next.delete(c.key));
      else audience.forEach((c) => next.add(c.key));
      return next;
    });
  }

  const previewContact = selectedContacts[0] || null;
  const previewParams = previewContact
    ? buildBroadcastRecipients([previewContact], varSpecs)[0]?.params || []
    : [];

  async function send() {
    if (!template || sending) return;
    const recipients = buildBroadcastRecipients(selectedContacts, varSpecs);
    if (!recipients.length) { setError('Elige al menos un destinatario.'); return; }
    if (varSpecs.some((s) => s.source === 'fixed' && !String(s.text || '').trim()) && template.varCount > 0) {
      setError('Completa el texto fijo de todas las variables.');
      return;
    }
    setSending(true);
    setError(null);
    const audienceLabel = `${AUDIENCE_KINDS.find((k) => k.value === kind)?.label || ''} · ${recipients.length} contactos`;
    let sent = 0;
    let failed = 0;
    const errors = [];
    setProgress({ done: 0, total: recipients.length });
    for (let i = 0; i < recipients.length; i += CHUNK) {
      const chunk = recipients.slice(i, i + CHUNK);
      const res = await sendWhatsappBroadcast({
        name: name.trim() || template.name,
        template: template.name,
        lang: template.language,
        audience: audienceLabel,
        recipients: chunk,
      }).catch((e) => ({ ok: false, error: e?.message }));
      if (res && typeof res.sent === 'number') {
        sent += res.sent;
        failed += res.failed || 0;
        for (const er of res.errors || []) errors.push(er);
      } else {
        failed += chunk.length;
        if (res?.error) errors.push({ to: '', error: res.error });
      }
      setProgress({ done: Math.min(i + chunk.length, recipients.length), total: recipients.length });
    }
    setSending(false);
    setResult({ sent, failed, errors: errors.slice(0, 5) });
  }

  return (
    <Modal open={open} onClose={sending ? () => {} : onClose} title="Nueva campaña" size="lg">
      {result ? (
        <div className="space-y-3 text-center py-4">
          <span className={`mx-auto w-12 h-12 rounded-full flex items-center justify-center ${result.failed ? 'bg-amber-50' : 'bg-emerald-50'}`}>
            {result.failed ? <AlertTriangle size={22} className="text-amber-600" /> : <Check size={22} className="text-emerald-600" />}
          </span>
          <p className="text-sm font-medium text-ink-900">
            {result.sent} {result.sent === 1 ? 'mensaje enviado' : 'mensajes enviados'}
            {result.failed ? ` · ${result.failed} fallidos` : ''}
          </p>
          {result.errors.map((e, i) => (
            <p key={i} className="text-xs text-red-700 bg-red-50 rounded-lg px-3 py-2 text-left">
              {e.to ? `${displayPhone(e.to)}: ` : ''}{e.error}
            </p>
          ))}
          <p className="text-xs text-ink-400">La entrega y lectura se actualizan en la lista de campañas a medida que llegan los recibos.</p>
          <button type="button" onClick={onClose} className="btn-primary text-sm">Listo</button>
        </div>
      ) : !template ? (
        <div className="space-y-2">
          <p className="text-xs text-ink-500">Elige la plantilla aprobada que se enviará:</p>
          {approved.length === 0 && (
            <p className="text-xs text-ink-400 text-center py-6">
              No hay plantillas aprobadas. Crea una en la pestaña Plantillas — Meta la revisa primero
              (suele tardar de minutos a horas).
            </p>
          )}
          <div className="max-h-[50vh] overflow-y-auto space-y-1">
            {approved.map((t) => {
              // A dynamic-URL button takes a per-recipient {{1}} suffix, which
              // campaigns can't fill (buildBroadcastRecipients only maps body
              // vars) — those templates belong to the quote-link flow instead.
              const dynamicButton = !!t.buttonUrlVar;
              return (
                <button
                  key={`${t.name}:${t.language}`}
                  type="button"
                  disabled={dynamicButton}
                  onClick={() => chooseTemplate(t)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg ring-1 ring-inset ring-ink-100 transition-colors ${
                    dynamicButton ? 'opacity-50 cursor-not-allowed' : 'hover:bg-brand-50/60 hover:ring-brand-200'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-medium text-ink-900 truncate">{t.name}</span>
                    <CategoryPill category={t.category} />
                  </span>
                  <span className="block text-xs text-ink-500 mt-0.5 line-clamp-2">{t.bodyText}</span>
                  {dynamicButton && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-ink-400 mt-1">
                      <Link2 size={11} /> Botón dinámico — útil para cotizaciones, no para campañas
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Audience */}
          <div>
            <div className="label">Audiencia</div>
            <div className="flex flex-wrap items-center gap-1.5 mb-2">
              {AUDIENCE_KINDS.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setKind(value)}
                  className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    kind === value ? 'bg-brand-600 text-white' : 'bg-ink-100 text-ink-500 hover:bg-ink-200'
                  }`}
                >
                  <Icon size={12} /> {label}
                </button>
              ))}
              <span className="ml-auto text-xs text-ink-500 tabular-nums">{picked.size} seleccionados</span>
            </div>
            <div className="relative mb-1.5">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-300" aria-hidden />
              <input
                className="input pl-8 text-sm"
                value={needle}
                onChange={(e) => setNeedle(e.target.value)}
                placeholder="Buscar contacto…"
              />
            </div>
            <div className="max-h-44 overflow-y-auto rounded-lg ring-1 ring-inset ring-ink-100 divide-y divide-ink-50">
              <label className="flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-ink-600 bg-ink-50/60 cursor-pointer">
                <input type="checkbox" checked={allVisiblePicked} onChange={toggleAllVisible} className="accent-brand-600" />
                Seleccionar visibles ({audience.length})
              </label>
              {audience.map((c) => (
                <label key={c.key} className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-ink-50/60">
                  <input type="checkbox" checked={picked.has(c.key)} onChange={() => toggle(c.key)} className="accent-brand-600" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-ink-900 truncate">{c.name}</span>
                    <span className="block text-[11px] text-ink-400">{displayPhone(c.phone)}</span>
                  </span>
                </label>
              ))}
              {!audience.length && <p className="text-xs text-ink-400 text-center py-4">Sin contactos con teléfono.</p>}
            </div>
          </div>

          {/* Variables */}
          {template.varCount > 0 && (
            <div>
              <div className="label">Variables de la plantilla</div>
              <div className="space-y-2">
                {varSpecs.map((spec, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-ink-500 tabular-nums shrink-0 w-10">{'{{'}{i + 1}{'}}'}</span>
                    <select
                      className="input text-sm flex-1 min-w-0"
                      value={spec.source}
                      onChange={(e) => setVarSpecs((ss) => ss.map((s, j) => (j === i ? { ...s, source: e.target.value } : s)))}
                    >
                      {VAR_SOURCES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
                    </select>
                    {spec.source === 'fixed' && (
                      <input
                        className="input text-sm w-full sm:w-auto sm:flex-1"
                        value={spec.text || ''}
                        placeholder="Texto…"
                        onChange={(e) => setVarSpecs((ss) => ss.map((s, j) => (j === i ? { ...s, text: e.target.value } : s)))}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Name + preview */}
          <div>
            <div className="label">Nombre de la campaña</div>
            <input className="input text-sm" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="rounded-xl bg-emerald-50/60 ring-1 ring-inset ring-emerald-100 px-3 py-2.5">
            <div className="eyebrow-xs text-emerald-700 mb-1">
              Vista previa{previewContact ? ` — ${previewContact.name}` : ''}
            </div>
            <p className="text-sm text-ink-800 whitespace-pre-wrap">
              {fillTemplateBody(template.bodyText, previewParams)}
            </p>
          </div>

          {error && (
            <p className="text-xs text-red-700 bg-red-50 rounded-lg px-3 py-2 flex items-start gap-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" /> <span>{error}</span>
            </p>
          )}
          {progress && (
            <div className="text-xs text-ink-500 flex items-center gap-2">
              <Loader2 size={13} className="animate-spin" /> Enviando… {progress.done}/{progress.total}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            <button type="button" onClick={() => setTemplate(null)} disabled={sending} className="btn-ghost text-sm">Cambiar plantilla</button>
            <button
              type="button"
              onClick={send}
              disabled={sending || !picked.size}
              className="btn-primary text-sm inline-flex items-center gap-1.5"
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Enviar a {picked.size} {picked.size === 1 ? 'contacto' : 'contactos'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------- templates ------------------------------- */

const STATUS_TONE = {
  APPROVED: 'bg-emerald-50 text-emerald-700',
  PENDING: 'bg-amber-50 text-amber-700',
  IN_REVIEW: 'bg-amber-50 text-amber-700',
  REJECTED: 'bg-rose-50 text-rose-700',
  PAUSED: 'bg-ink-100 text-ink-500',
  DISABLED: 'bg-ink-100 text-ink-500',
};
const STATUS_LABEL = {
  APPROVED: 'Aprobada', PENDING: 'En revisión', IN_REVIEW: 'En revisión',
  REJECTED: 'Rechazada', PAUSED: 'Pausada', DISABLED: 'Deshabilitada',
};

function CategoryPill({ category }) {
  const mk = category === 'MARKETING';
  return (
    <span className={`text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 ${mk ? 'bg-violet-50 text-violet-700' : 'bg-sky-50 text-sky-700'}`}>
      {mk ? 'Marketing' : category === 'UTILITY' ? 'Utilidad' : category}
    </span>
  );
}

function TemplatesTab({ templates, templatesError, onReload }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [actionError, setActionError] = useState(null);

  async function remove(t) {
    if (!confirm(`¿Eliminar la plantilla "${t.name}"? Se elimina en todos los idiomas, no se puede deshacer, y Meta reserva el nombre 30 días (no podrás reutilizarlo).`)) return;
    setDeleting(t.name);
    setActionError(null);
    const res = await deleteWaTemplate(t.name).catch((e) => ({ ok: false, error: e?.message }));
    setDeleting(null);
    if (!res?.ok) setActionError(res?.error || 'No se pudo eliminar.');
    else onReload();
  }

  return (
    <div className="space-y-4">
      <div className="card card-pad flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink-900">Plantillas de mensaje</div>
          <p className="text-xs text-ink-500 mt-0.5">
            Las plantillas son la única forma de iniciar una conversación (o escribir fuera de la
            ventana de 24 h). Meta revisa cada plantilla nueva antes de aprobarla.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button type="button" onClick={onReload} className="btn-ghost" title="Actualizar estado">
            <RefreshCw size={14} />
          </button>
          <button type="button" onClick={() => setCreateOpen(true)} className="btn-brand">
            <Plus size={14} /> Nueva plantilla
          </button>
        </div>
      </div>

      {(templatesError || actionError) && (
        <p className="text-xs text-red-700 bg-red-50 rounded-lg px-3 py-2">{templatesError || actionError}</p>
      )}

      {templates === null ? (
        <div className="card card-pad flex items-center justify-center py-10 text-ink-400">
          <Loader2 size={18} className="animate-spin" />
        </div>
      ) : templates.length === 0 && !templatesError ? (
        <div className="card card-pad py-12 flex flex-col items-center gap-3 text-center">
          <span className="w-12 h-12 rounded-full bg-brand-50 flex items-center justify-center">
            <LayoutTemplate size={20} className="text-brand-400" />
          </span>
          <div>
            <p className="text-sm font-medium text-ink-700">Sin plantillas</p>
            <p className="text-xs text-ink-400 mt-0.5">Crea la primera — por ejemplo un saludo de seguimiento de cotización o una promoción.</p>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {templates.map((t) => {
            // Meta's pre-provided samples (hello_world, sample_*) can't be
            // deleted — the API rejects it by design. Don't offer the button.
            const isMetaSample = t.name === 'hello_world' || t.name.startsWith('sample_');
            return (
            <div key={`${t.name}:${t.language}`} className="card card-pad">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-ink-900">{t.name}</span>
                    <span className="text-[10px] text-ink-400 uppercase">{t.language}</span>
                    <CategoryPill category={t.category} />
                    <span className={`text-[10px] font-semibold rounded px-1.5 py-0.5 ${STATUS_TONE[t.status] || 'bg-ink-100 text-ink-500'}`}>
                      {STATUS_LABEL[t.status] || t.status}
                    </span>
                    {isMetaSample && (
                      <span className="text-[10px] font-medium rounded px-1.5 py-0.5 bg-ink-100 text-ink-500" title="Plantilla de ejemplo provista por Meta">
                        Ejemplo de Meta
                      </span>
                    )}
                  </div>
                  {t.headerText && <p className="text-xs font-semibold text-ink-700 mt-1.5">{t.headerText}</p>}
                  <p className="text-xs text-ink-600 mt-1 whitespace-pre-wrap">{t.bodyText}</p>
                  {t.buttonText && (
                    <span
                      className="inline-flex items-center gap-1 mt-1.5 rounded-full ring-1 ring-inset ring-ink-200 px-2 py-0.5 text-[11px] font-medium text-ink-600"
                      title={`Botón de enlace${t.buttonUrlVar ? ' · enlace dinámico ({{1}})' : ''}`}
                    >
                      <Link2 size={11} /> {t.buttonText}
                    </span>
                  )}
                  {t.footerText && <p className="text-[11px] text-ink-400 mt-1">{t.footerText}</p>}
                </div>
                {!isMetaSample && (
                  <button
                    type="button"
                    onClick={() => remove(t)}
                    disabled={deleting === t.name}
                    className="btn-ghost text-red-600 hover:bg-red-50 hover:text-red-700 shrink-0"
                    title="Eliminar plantilla"
                  >
                    {deleting === t.name ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  </button>
                )}
              </div>
            </div>
            );
          })}
        </div>
      )}

      <CreateTemplateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => { setCreateOpen(false); onReload(); }}
      />
    </div>
  );
}

function CreateTemplateModal({ open, onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', category: 'MARKETING', language: 'es', headerText: '', bodyText: '', footerText: '' });
  const [examples, setExamples] = useState({});
  // Optional URL button: registers buttonUrlBase + {{1}} on the template, so
  // sendQuoteLink can fill the per-quote share-path suffix at send time.
  const [withButton, setWithButton] = useState(false);
  const [buttonText, setButtonText] = useState('Ver cotización');
  const [buttonUrlBase, setButtonUrlBase] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setForm({ name: '', category: 'MARKETING', language: 'es', headerText: '', bodyText: '', footerText: '' });
      setExamples({});
      setWithButton(false);
      setButtonText('Ver cotización');
      setButtonUrlBase(shareLinkBase());
      setSaving(false);
      setError(null);
    }
  }, [open]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const varCount = new Set([...form.bodyText.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;

  async function submit() {
    if (saving) return;
    if (!form.name.trim() || !form.bodyText.trim()) { setError('La plantilla necesita nombre y cuerpo.'); return; }
    setSaving(true);
    setError(null);
    const button = withButton && buttonText.trim() && buttonUrlBase.trim()
      ? { buttonText: buttonText.trim(), buttonUrlBase: buttonUrlBase.trim() }
      : {};
    const res = await createWaTemplate({
      ...form,
      exampleParams: Array.from({ length: varCount }, (_, i) => examples[i] || ''),
      ...button,
    }).catch((e) => ({ ok: false, error: e?.message }));
    setSaving(false);
    if (!res?.ok) { setError(res?.error || 'No se pudo crear la plantilla.'); return; }
    onCreated();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Nueva plantilla"
      footer={
        <>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="btn-ghost">Cancelar</button>
          <button type="button" onClick={submit} disabled={saving} className="btn-primary inline-flex items-center gap-1.5">
            {saving ? <Loader2 size={14} className="animate-spin" /> : null} Enviar a revisión
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <div className="label">Nombre (minúsculas y _)</div>
            <input className="input text-sm" value={form.name} onChange={set('name')} placeholder="seguimiento_cotizacion" />
          </div>
          <div>
            <div className="label">Idioma</div>
            <select className="input text-sm" value={form.language} onChange={set('language')}>
              <option value="es">Español (es)</option>
              <option value="es_MX">Español LatAm (es_MX)</option>
              <option value="en_US">English (en_US)</option>
            </select>
          </div>
        </div>
        <div>
          <div className="label">Categoría</div>
          <div className="flex items-center gap-1.5">
            {[['MARKETING', 'Marketing — promos, novedades'], ['UTILITY', 'Utilidad — seguimiento de una transacción']].map(([v, l]) => (
              <button
                key={v}
                type="button"
                onClick={() => setForm((f) => ({ ...f, category: v }))}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${form.category === v ? 'bg-brand-600 text-white' : 'bg-ink-100 text-ink-500 hover:bg-ink-200'}`}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="label">Encabezado (opcional)</div>
          <input className="input text-sm" value={form.headerText} onChange={set('headerText')} />
        </div>
        <div>
          <div className="label">Cuerpo — usa {'{{1}}'}, {'{{2}}'}… como variables</div>
          <textarea
            className="input min-h-[100px] text-sm"
            value={form.bodyText}
            onChange={set('bodyText')}
            placeholder={'Hola {{1}}, tenemos novedades de Ligne Roset que te pueden interesar…'}
          />
        </div>
        {varCount > 0 && (
          <div>
            <div className="label">Valores de ejemplo (Meta los exige para revisar)</div>
            <div className="grid grid-cols-2 gap-2">
              {Array.from({ length: varCount }, (_, i) => (
                <input
                  key={i}
                  className="input text-sm"
                  placeholder={`Ejemplo {{${i + 1}}}`}
                  value={examples[i] || ''}
                  onChange={(e) => setExamples((ex) => ({ ...ex, [i]: e.target.value }))}
                />
              ))}
            </div>
          </div>
        )}
        <div>
          <div className="label">Pie (opcional)</div>
          <input className="input text-sm" value={form.footerText} onChange={set('footerText')} />
        </div>
        <div>
          <label className="flex items-center gap-2 text-sm text-ink-700 cursor-pointer">
            <input
              type="checkbox"
              checked={withButton}
              onChange={(e) => setWithButton(e.target.checked)}
              className="accent-brand-600"
            />
            Añadir botón con enlace a la cotización
          </label>
          {withButton && (
            <div className="mt-2 space-y-2">
              <div>
                <div className="label">Texto del botón</div>
                <input
                  className="input text-sm"
                  maxLength={25}
                  value={buttonText}
                  onChange={(e) => setButtonText(e.target.value)}
                />
              </div>
              <div>
                <div className="label">URL base</div>
                <input
                  className="input text-sm"
                  value={buttonUrlBase}
                  onChange={(e) => setButtonUrlBase(e.target.value)}
                />
                <p className="text-[11px] text-ink-400 mt-1">
                  Al enviar, se añade automáticamente el sufijo del enlace de cada cotización ({'{{1}}'}). Usa la base tal cual para cotizaciones.
                </p>
              </div>
            </div>
          )}
        </div>
        {error && (
          <p className="text-xs text-red-700 bg-red-50 rounded-lg px-3 py-2 flex items-start gap-1.5">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" /> <span className="min-w-0 break-words">{error}</span>
          </p>
        )}
      </div>
    </Modal>
  );
}
