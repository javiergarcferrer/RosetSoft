import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  MessageCircle, Send, ArrowLeft, Loader2, Search, Plus, Check, CheckCheck,
  AlertTriangle, Clock, UserSquare2, Users, Paperclip, LayoutTemplate, Megaphone,
  FileText, Download,
} from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Modal from '../components/Modal.jsx';
import { useApp } from '../context/AppContext.jsx';
import { db, invalidate } from '../db/database.js';
import { useLiveQueryStatus } from '../db/hooks.js';
import {
  resolveConversations, resolveThread, resolveNewChatContacts, resolveReferral, fillTemplateBody,
} from '../core/crm/index.js';
import { displayPhone, phoneKey } from '../lib/phone.js';
import {
  sendWhatsappText, sendWhatsappTemplate, sendWhatsappMedia, sendWhatsappReadReceipt,
  listWaTemplates, fetchWaMediaUrl, markThreadRead, draftOutboundMessage,
} from '../lib/whatsapp.js';

/**
 * WhatsApp — the CRM inbox. Conversation list + thread, split-pane on
 * desktop, list↔thread navigation on a phone. All derivation lives in
 * core/crm (resolveConversations / resolveThread); this View fetches, holds
 * UI state (selection, search, composer) and renders.
 *
 * Messages arrive server-side (wa-webhook writes wa_messages), so the page
 * polls a refetch while open — the inbox is near-live without a socket.
 */
const POLL_MS = 10000;

export default function Chats() {
  const { profileId, settings } = useApp();
  const { data: messages, loaded } = useLiveQueryStatus(
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

  // Near-live: refetch on an interval while the inbox is open.
  useEffect(() => {
    const id = setInterval(() => invalidate(), POLL_MS);
    return () => clearInterval(id);
  }, []);

  const [needle, setNeedle] = useState('');
  const [selectedKey, setSelectedKey] = useState(null);
  // A "new chat" target has no messages yet, so it isn't in conversations —
  // carry its contact info until the first send materializes the thread.
  const [draftTarget, setDraftTarget] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Optimistic outbound rows, dropped once the server-logged row arrives.
  const [pending, setPending] = useState([]);

  const conversations = useMemo(
    () => resolveConversations(messages, customers, professionals, { needle }),
    [messages, customers, professionals, needle],
  );
  const selected = useMemo(() => {
    if (!selectedKey) return null;
    return conversations.find((c) => c.key === selectedKey)
      || (draftTarget && draftTarget.key === selectedKey ? draftTarget : null);
  }, [conversations, selectedKey, draftTarget]);

  const thread = useMemo(
    () => (selectedKey ? resolveThread([...messages, ...pending], { key: selectedKey }) : null),
    [messages, pending, selectedKey],
  );

  // Server rows landed → drop the optimistic copies they replace.
  useEffect(() => {
    if (!pending.length) return;
    setPending((rows) => rows.filter((p) => !messages.some(
      (m) => m.direction === 'out' && phoneKey(m.phone) === phoneKey(p.phone)
        && (m.body || '') === (p.body || '') && (m.createdAt || 0) >= p.createdAt - 1000,
    )));
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Opening a thread clears its unread badge — locally AND on the customer's
  // side: the Cloud API read receipt turns their ticks blue (marking the
  // latest inbound also marks everything before it).
  const lastReceiptFor = useRef(null);
  useEffect(() => {
    if (!selectedKey) return;
    const unread = messages.filter((m) => phoneKey(m.phone) === selectedKey && m.direction === 'in' && !m.readAt);
    if (!unread.length) return;
    markThreadRead(unread).catch(() => {});
    const latest = unread.reduce((a, b) => ((a.createdAt || 0) >= (b.createdAt || 0) ? a : b));
    if (latest.waId && lastReceiptFor.current !== latest.waId) {
      lastReceiptFor.current = latest.waId;
      sendWhatsappReadReceipt(latest.waId);
    }
  }, [selectedKey, messages]);

  const connected = !!settings?.whatsappConnectedAt;

  if (loaded && !connected && !messages.length) {
    return (
      <>
        <PageHeader title="WhatsApp" subtitle="Conversaciones con clientes y profesionales" />
        <EmptyState
          icon={MessageCircle}
          title="WhatsApp no está conectado"
          description="Conecta tu app de WhatsApp Business (Cloud API) para chatear y enviar cotizaciones desde el número del negocio."
          action={<Link to="/settings" className="btn-primary text-sm">Ir a Configuración</Link>}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="WhatsApp"
        subtitle={settings?.whatsappDisplayNumber ? `Número del negocio · ${settings.whatsappDisplayNumber}` : 'Conversaciones con clientes y profesionales'}
        actions={
          <div className="flex items-center gap-2">
            <Link to="/chats/difusion" className="btn-secondary text-sm inline-flex items-center gap-1.5">
              <Megaphone size={15} /> Difusión
            </Link>
            <button type="button" onClick={() => setPickerOpen(true)} className="btn-primary text-sm inline-flex items-center gap-1.5">
              <Plus size={15} /> Nuevo chat
            </button>
          </div>
        }
      />

      <div className="card overflow-hidden flex h-[calc(100dvh-230px)] min-h-[420px]">
        {/* Conversation list — full width on a phone until a thread is open. */}
        <div className={`${selectedKey ? 'hidden md:flex' : 'flex'} w-full md:w-[320px] lg:w-[360px] shrink-0 flex-col border-r border-ink-100`}>
          <div className="p-3 border-b border-ink-100">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-300" aria-hidden />
              <input
                className="input pl-9 text-sm"
                value={needle}
                onChange={(e) => setNeedle(e.target.value)}
                placeholder="Buscar por nombre o número…"
                aria-label="Buscar conversación"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {!loaded && (
              <div className="flex items-center justify-center py-10 text-ink-400">
                <Loader2 size={18} className="animate-spin" />
              </div>
            )}
            {loaded && !conversations.length && (
              <p className="text-xs text-ink-400 text-center px-6 py-10">
                {needle ? 'Sin resultados.' : 'Aún no hay conversaciones. Cuando un cliente escriba al número del negocio aparecerá aquí — o inicia tú con “Nuevo chat”.'}
              </p>
            )}
            {conversations.map((c) => (
              <ConversationRow key={c.key} c={c} active={c.key === selectedKey}
                onOpen={() => { setSelectedKey(c.key); setDraftTarget(null); }} />
            ))}
          </div>
        </div>

        {/* Thread */}
        <div className={`${selectedKey ? 'flex' : 'hidden md:flex'} flex-1 min-w-0 flex-col`}>
          {selected && thread ? (
            <Thread
              contact={selected}
              thread={thread}
              connected={connected}
              onBack={() => setSelectedKey(null)}
              onSend={async (text) => {
                const draft = draftOutboundMessage({
                  phone: selected.phone, text,
                  customerId: selected.customerId, professionalId: selected.professionalId,
                  profileId,
                });
                setPending((rows) => [...rows, draft]);
                const res = await sendWhatsappText({
                  to: selected.phone, text,
                  customerId: selected.customerId, professionalId: selected.professionalId,
                }).catch((e) => ({ ok: false, error: e?.message }));
                invalidate();
                return res;
              }}
              onSendMedia={async (file, caption) => {
                const res = await sendWhatsappMedia({
                  to: selected.phone, file, caption,
                  customerId: selected.customerId, professionalId: selected.professionalId,
                }).catch((e) => ({ ok: false, error: e?.message }));
                invalidate();
                return res;
              }}
              onSendTemplate={async ({ template, params, lang }) => {
                const res = await sendWhatsappTemplate({
                  to: selected.phone, template, params, lang,
                  customerId: selected.customerId, professionalId: selected.professionalId,
                }).catch((e) => ({ ok: false, error: e?.message }));
                invalidate();
                return res;
              }}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-sm text-ink-400 px-6 text-center">Elige una conversación, o inicia una con “Nuevo chat”.</p>
            </div>
          )}
        </div>
      </div>

      <NewChatModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        customers={customers}
        professionals={professionals}
        conversations={conversations}
        onPick={(contact) => {
          setDraftTarget(contact);
          setSelectedKey(contact.key);
          setPickerOpen(false);
        }}
      />
    </>
  );
}

function ConversationRow({ c, active, onOpen }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`w-full text-left px-4 py-3 flex items-start gap-3 border-b border-ink-50 transition-colors ${active ? 'bg-brand-50' : 'hover:bg-ink-50/60'}`}
    >
      <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${c.contactKind ? 'bg-brand-100 text-brand-800' : 'bg-ink-100 text-ink-500'}`}>
        {initials(c.name)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="font-medium text-sm text-ink-900 truncate">{c.name}</span>
          <span className="text-[10px] text-ink-400 shrink-0 tabular-nums">{timeLabel(c.lastAt)}</span>
        </span>
        <span className="flex items-center justify-between gap-2 mt-0.5">
          <span className={`text-xs truncate ${c.unread ? 'text-ink-800 font-medium' : 'text-ink-500'}`}>
            {c.lastDirection === 'out' && <StatusTicks status={c.lastStatus} className="inline mr-1 -mt-px" />}
            {c.lastBody || '—'}
          </span>
          {c.unread ? (
            <span className="shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-emerald-600 text-white text-[10px] font-bold inline-flex items-center justify-center">
              {c.unread}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

function Thread({ contact, thread, connected, onBack, onSend, onSendMedia, onSendTemplate }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const fileRef = useRef(null);
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }); }, [thread.items.length, contact.key]);
  useEffect(() => { setText(''); setError(null); }, [contact.key]);

  async function submit() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    setText('');
    const res = await onSend(body);
    setSending(false);
    if (!res?.ok) setError(res?.error || 'No se pudo enviar.');
  }

  // Attach: any picked file ships as media (image/video/audio inline,
  // everything else as a document). The current draft text rides as caption.
  async function pickFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || sending) return;
    setSending(true);
    setError(null);
    const caption = text.trim();
    setText('');
    const res = await onSendMedia(file, caption);
    setSending(false);
    if (!res?.ok) setError(res?.error || 'No se pudo enviar el archivo.');
  }

  const detailLink = contact.customerId
    ? `/customers/${contact.customerId}`
    : contact.professionalId ? `/professionals/${contact.professionalId}` : null;

  return (
    <>
      {/* Thread header — who, linked to their CRM card. */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-ink-100 bg-white">
        <button type="button" onClick={onBack} className="md:hidden -ml-1 p-1.5 rounded text-ink-500 hover:bg-ink-50" aria-label="Volver a la lista">
          <ArrowLeft size={16} />
        </button>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-800 text-[11px] font-semibold">
          {initials(contact.name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-sm text-ink-900 truncate">
            {detailLink ? <Link to={detailLink} className="hover:underline">{contact.name}</Link> : contact.name}
          </div>
          <div className="text-[11px] text-ink-400 flex items-center gap-1.5">
            {displayPhone(contact.phone)}
            {contact.contactKind === 'customer' && <span className="inline-flex items-center gap-0.5"><Users size={10} /> Cliente</span>}
            {contact.contactKind === 'professional' && <span className="inline-flex items-center gap-0.5"><UserSquare2 size={10} /> Profesional</span>}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1.5 bg-ink-50/40">
        {thread.items.map((m, i) => (
          <Bubble key={m.id} m={m} prev={thread.items[i - 1]} />
        ))}
        {!thread.items.length && (
          <p className="text-xs text-ink-400 text-center py-8">
            Sin mensajes todavía. {contact.contactKind ? 'Escríbele para iniciar la conversación.' : ''}
          </p>
        )}
        <div ref={endRef} />
      </div>

      {/* 24h-window state + composer */}
      {!thread.windowOpen && (
        <div className="px-4 py-2 bg-amber-50 border-t border-amber-100 text-[11px] text-amber-800 flex items-start gap-1.5">
          <Clock size={12} className="mt-0.5 shrink-0" />
          <span>
            {thread.lastInboundAt
              ? 'Ventana de 24 h cerrada: WhatsApp solo entrega plantillas aprobadas hasta que el cliente vuelva a escribir.'
              : 'Este contacto aún no ha escrito: para iniciar, WhatsApp exige una plantilla aprobada (el texto libre será rechazado).'}
          </span>
        </div>
      )}
      {error && (
        <div className="px-4 py-2 bg-red-50 border-t border-red-100 text-[11px] text-red-700 flex items-start gap-1.5">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> <span className="min-w-0 break-words">{error}</span>
        </div>
      )}
      <div className="flex items-end gap-1.5 px-3 py-3 border-t border-ink-100 bg-white">
        <input ref={fileRef} type="file" className="hidden" onChange={pickFile} aria-hidden="true" tabIndex={-1} />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={!connected || sending}
          className="p-2.5 min-h-[42px] rounded-lg text-ink-400 hover:text-brand-700 hover:bg-brand-50 disabled:opacity-40 transition-colors shrink-0"
          title="Adjuntar archivo (imagen, PDF, video…)"
          aria-label="Adjuntar archivo"
        >
          <Paperclip size={17} />
        </button>
        <button
          type="button"
          onClick={() => setTemplateOpen(true)}
          disabled={!connected || sending}
          className={`p-2.5 min-h-[42px] rounded-lg disabled:opacity-40 transition-colors shrink-0 ${
            thread.windowOpen ? 'text-ink-400 hover:text-brand-700 hover:bg-brand-50' : 'text-amber-600 hover:bg-amber-50'
          }`}
          title={thread.windowOpen ? 'Enviar plantilla' : 'Ventana cerrada — envía una plantilla aprobada'}
          aria-label="Enviar plantilla"
        >
          <LayoutTemplate size={17} />
        </button>
        <textarea
          className="input flex-1 min-h-[42px] max-h-32 resize-none text-sm"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          placeholder={connected ? 'Escribe un mensaje…' : 'Conecta WhatsApp en Configuración para enviar'}
          disabled={!connected}
          aria-label="Mensaje"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!connected || sending || !text.trim()}
          className="btn-primary !px-3 min-h-[42px] disabled:opacity-40 shrink-0"
          title="Enviar"
          aria-label="Enviar mensaje"
        >
          {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
      </div>

      <TemplateSendModal
        open={templateOpen}
        onClose={() => setTemplateOpen(false)}
        contact={contact}
        onSend={async (spec) => {
          const res = await onSendTemplate(spec);
          if (res?.ok) setTemplateOpen(false);
          return res;
        }}
      />
    </>
  );
}

/**
 * Pick an APPROVED template, fill its {{n}} variables, preview, send. This is
 * the only way to reach a contact outside the 24h window — the picker defaults
 * the first variable to the contact's first name to keep the common case
 * one-tap.
 */
function TemplateSendModal({ open, onClose, contact, onSend }) {
  const [templates, setTemplates] = useState(null); // null = loading
  const [loadError, setLoadError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [params, setParams] = useState([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setTemplates(null);
    setLoadError(null);
    setSelected(null);
    setError(null);
    listWaTemplates().then((res) => {
      if (res?.ok) setTemplates((res.templates || []).filter((t) => t.status === 'APPROVED'));
      else { setTemplates([]); setLoadError(res?.error || 'No se pudieron cargar las plantillas.'); }
    }).catch((e) => { setTemplates([]); setLoadError(e?.message || 'No se pudieron cargar las plantillas.'); });
  }, [open]);

  function pick(t) {
    setSelected(t);
    const firstName = (contact?.name || '').trim().split(/\s+/)[0] || '';
    setParams(Array.from({ length: t.varCount }, (_, i) => (i === 0 ? firstName : '')));
    setError(null);
  }

  async function submit() {
    if (!selected || sending) return;
    if (params.some((p) => !String(p).trim())) { setError('Completa todas las variables.'); return; }
    setSending(true);
    setError(null);
    const res = await onSend({ template: selected.name, lang: selected.language, params: params.map((p) => p.trim()) });
    setSending(false);
    if (!res?.ok) setError(res?.error || 'No se pudo enviar la plantilla.');
  }

  return (
    <Modal open={open} onClose={onClose} title={selected ? `Plantilla · ${selected.name}` : 'Enviar plantilla'} size="sm">
      {!selected ? (
        <div className="max-h-[55vh] overflow-y-auto -mx-1 px-1">
          {templates === null && (
            <div className="flex items-center justify-center py-10 text-ink-400"><Loader2 size={18} className="animate-spin" /></div>
          )}
          {loadError && (
            <p className="text-xs text-red-700 bg-red-50 rounded-lg px-3 py-2 mb-2">{loadError}</p>
          )}
          {templates !== null && !loadError && !templates.length && (
            <p className="text-xs text-ink-400 text-center py-8">
              No hay plantillas aprobadas. Créalas en Difusión → Plantillas (Meta las revisa en minutos u horas).
            </p>
          )}
          {(templates || []).map((t) => (
            <button
              key={`${t.name}:${t.language}`}
              type="button"
              onClick={() => pick(t)}
              className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-ink-50 transition-colors"
            >
              <span className="flex items-center gap-2">
                <span className="text-sm font-medium text-ink-900 truncate">{t.name}</span>
                <span className="text-[10px] uppercase tracking-wide text-ink-400">{t.language} · {t.category === 'MARKETING' ? 'Marketing' : t.category === 'UTILITY' ? 'Utilidad' : t.category}</span>
              </span>
              <span className="block text-xs text-ink-500 truncate mt-0.5">{t.bodyText}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {Array.from({ length: selected.varCount }, (_, i) => (
            <div key={i}>
              <div className="label">Variable {'{{'}{i + 1}{'}}'}</div>
              <input
                className="input text-sm"
                value={params[i] || ''}
                onChange={(e) => setParams((ps) => ps.map((p, j) => (j === i ? e.target.value : p)))}
              />
            </div>
          ))}
          <div className="rounded-xl bg-emerald-50/60 ring-1 ring-inset ring-emerald-100 px-3 py-2.5">
            <div className="eyebrow-xs text-emerald-700 mb-1">Vista previa</div>
            <p className="text-sm text-ink-800 whitespace-pre-wrap">{fillTemplateBody(selected.bodyText, params)}</p>
            {selected.footerText && <p className="text-[11px] text-ink-400 mt-1">{selected.footerText}</p>}
          </div>
          {error && (
            <p className="text-xs text-red-700 bg-red-50 rounded-lg px-3 py-2 flex items-start gap-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" /> <span className="min-w-0 break-words">{error}</span>
            </p>
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            <button type="button" onClick={() => setSelected(null)} className="btn-ghost text-sm">Cambiar plantilla</button>
            <button type="button" onClick={submit} disabled={sending} className="btn-primary text-sm inline-flex items-center gap-1.5">
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Enviar
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Bubble({ m, prev }) {
  const out = m.direction === 'out';
  const day = dayLabel(m.createdAt);
  const showDay = !prev || dayLabel(prev.createdAt) !== day;
  const referral = resolveReferral(m);
  // A non-inline attachment renders as a chip that already carries m.body
  // (the filename/caption) — don't repeat it as text below.
  const isDocChip = !!m.mediaPath && !/^(image|video|audio)\//.test(m.mediaMime || '');
  return (
    <>
      {showDay && (
        <div className="text-center py-1.5">
          <span className="text-[10px] font-medium text-ink-400 bg-white border border-ink-100 rounded-full px-2.5 py-0.5">{day}</span>
        </div>
      )}
      <div className={`flex ${out ? 'justify-end' : 'justify-start'}`}>
        <div className={`max-w-[78%] rounded-2xl px-3 py-2 text-sm shadow-xs break-words whitespace-pre-wrap ${
          out
            ? m.status === 'failed' ? 'bg-red-50 border border-red-200 text-red-800' : 'bg-brand-100 text-ink-900'
            : 'bg-white border border-ink-100 text-ink-900'
        }`}>
          {referral && (
            <div className="flex items-center gap-1 text-[10px] font-semibold text-violet-700 bg-violet-50 rounded-md px-1.5 py-0.5 mb-1 max-w-full">
              <Megaphone size={10} className="shrink-0" />
              <span className="truncate">Vino de un anuncio{referral.headline ? ` · ${referral.headline}` : ''}</span>
            </div>
          )}
          {m.templateName && (
            <div className="text-[10px] font-semibold uppercase tracking-wide opacity-60 mb-0.5">Plantilla · {m.templateName}</div>
          )}
          {m.mediaPath && <MediaAttachment m={m} />}
          {m.body && !isDocChip
            ? m.body
            : !m.mediaPath && !m.body && <span className="opacity-60 italic">({m.kind || 'mensaje'})</span>}
          <div className={`flex items-center gap-1 mt-0.5 ${out ? 'justify-end' : ''}`}>
            <span className="text-[10px] opacity-50 tabular-nums">{timeOfDay(m.createdAt)}</span>
            {out && <StatusTicks status={m.status} />}
          </div>
          {m.status === 'failed' && m.error && (
            <div className="text-[11px] mt-1 text-red-700">{m.error}</div>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * The media body of a bubble — images/videos/audio render inline, anything
 * else (PDFs, documents) as a download chip. Bytes come from Storage (where
 * wa-webhook / wa-send persisted them at delivery time) via an object URL,
 * revoked on unmount.
 */
function MediaAttachment({ m }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let objectUrl = null;
    setUrl(null);
    setFailed(false);
    fetchWaMediaUrl(m.mediaPath).then((u) => {
      if (!alive) { if (u) URL.revokeObjectURL(u); return; }
      objectUrl = u;
      if (u) setUrl(u);
      else setFailed(true);
    });
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [m.mediaPath]);

  const mime = m.mediaMime || '';
  if (failed) {
    return <div className="text-[11px] italic opacity-60 mb-1">(archivo no disponible)</div>;
  }
  if (!url) {
    return <div className="flex items-center gap-1.5 text-[11px] opacity-60 mb-1"><Loader2 size={12} className="animate-spin" /> Cargando…</div>;
  }
  if (mime.startsWith('image/')) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block mb-1">
        <img src={url} alt="Imagen adjunta" className="rounded-lg max-h-64 max-w-full object-contain" />
      </a>
    );
  }
  if (mime.startsWith('video/')) {
    return <video src={url} controls className="rounded-lg max-h-64 max-w-full mb-1" />;
  }
  if (mime.startsWith('audio/')) {
    return <audio src={url} controls className="max-w-full mb-1" />;
  }
  return (
    <a
      href={url}
      download={m.body || 'documento'}
      className="flex items-center gap-2 rounded-lg bg-black/5 px-2.5 py-2 mb-1 hover:bg-black/10 transition-colors"
    >
      <FileText size={16} className="shrink-0 opacity-60" />
      <span className="text-xs font-medium truncate flex-1">{m.body || 'Documento'}</span>
      <Download size={13} className="shrink-0 opacity-50" />
    </a>
  );
}

function StatusTicks({ status, className = '' }) {
  if (status === 'failed') return <AlertTriangle size={11} className={`text-red-500 ${className}`} aria-label="Falló" />;
  if (status === 'sending') return <Clock size={11} className={`opacity-40 ${className}`} aria-label="Enviando" />;
  if (status === 'read') return <CheckCheck size={12} className={`text-sky-500 ${className}`} aria-label="Leído" />;
  if (status === 'delivered') return <CheckCheck size={12} className={`opacity-50 ${className}`} aria-label="Entregado" />;
  return <Check size={12} className={`opacity-50 ${className}`} aria-label="Enviado" />;
}

/** Pick a customer/professional with a phone to start a conversation. */
function NewChatModal({ open, onClose, customers, professionals, conversations, onPick }) {
  const [needle, setNeedle] = useState('');
  useEffect(() => { if (open) setNeedle(''); }, [open]);
  const contacts = useMemo(
    () => resolveNewChatContacts(customers, professionals, conversations, { needle }),
    [customers, professionals, conversations, needle],
  );
  // Existing threads also match the search — picking one just opens it.
  const existing = useMemo(() => {
    const q = needle.trim().toLowerCase();
    if (!q) return [];
    return (conversations || []).filter((c) => c.name.toLowerCase().includes(q)).slice(0, 5);
  }, [conversations, needle]);

  return (
    <Modal open={open} onClose={onClose} title="Nuevo chat" size="sm">
      <div className="relative mb-3">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-300" aria-hidden />
        <input
          autoFocus
          className="input pl-9 text-sm"
          value={needle}
          onChange={(e) => setNeedle(e.target.value)}
          placeholder="Buscar cliente o profesional…"
          aria-label="Buscar contacto"
        />
      </div>
      <div className="max-h-[50vh] overflow-y-auto -mx-1 px-1">
        {existing.map((c) => (
          <ContactRow key={`x-${c.key}`} name={c.name} phone={c.phone} kind={c.contactKind} note="Conversación existente" onPick={() => onPick(c)} />
        ))}
        {contacts.map((c) => (
          <ContactRow key={c.key} name={c.name} phone={c.phone} kind={c.contactKind} onPick={() => onPick(c)} />
        ))}
        {!contacts.length && !existing.length && (
          <p className="text-xs text-ink-400 text-center py-8">
            Ningún contacto con teléfono coincide. Agrega el número en la ficha del cliente o profesional.
          </p>
        )}
      </div>
    </Modal>
  );
}

function ContactRow({ name, phone, kind, note, onPick }) {
  return (
    <button type="button" onClick={onPick}
      className="w-full text-left px-3 py-2.5 flex items-center gap-3 rounded-lg hover:bg-ink-50 transition-colors">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-800 text-[11px] font-semibold">
        {initials(name)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink-900 truncate">{name}</span>
        <span className="block text-[11px] text-ink-400">
          {displayPhone(phone)}
          {kind === 'customer' ? ' · Cliente' : kind === 'professional' ? ' · Profesional' : ''}
          {note ? ` · ${note}` : ''}
        </span>
      </span>
      <MessageCircle size={14} className="text-emerald-600 shrink-0" aria-hidden />
    </button>
  );
}

function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('') || '?';
}
function timeOfDay(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' });
}
function dayLabel(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date();
  const yest = new Date(today); yest.setDate(today.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Hoy';
  if (same(d, yest)) return 'Ayer';
  return d.toLocaleDateString('es-DO', { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
function timeLabel(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? timeOfDay(ms) : dayLabel(ms);
}
