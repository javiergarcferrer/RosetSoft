import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Send, ArrowLeft, Loader2, Check, CheckCheck,
  AlertTriangle, Clock, UserSquare2, Users, Paperclip, LayoutTemplate, Megaphone,
  FileText, Download,
} from 'lucide-react';
import Modal from '../Modal.jsx';
import { resolveReferral, fillTemplateBody } from '../../core/crm/index.js';
import { displayPhone } from '../../lib/phone.js';
import { listWaTemplates, fetchWaMediaUrl } from '../../lib/whatsapp.js';

/**
 * The WhatsApp conversation thread — header (contact, linked to their CRM
 * card), message bubbles (media, reactions, quoted replies, status ticks),
 * the 24h-window banner and the composer (free text · attach file · approved
 * template). Extracted from the Chats inbox so the SAME thread renders both
 * in the full inbox (split-pane) and embedded in the quote editor
 * (QuoteChatCard) — one surface, no drift.
 *
 * Pure View: the parent owns the data (a `resolveThread` result + the contact)
 * and the send side-effects (`onSend` / `onSendMedia` / `onSendTemplate`, each
 * returning wa-send's `{ ok, error? }`). `onBack` is optional — when given, a
 * back affordance shows on phones (the inbox's list↔thread navigation).
 * `showHeader:false` drops the contact header for hosts that already carry
 * their own (the quote editor's collapsible card).
 */
export default function ChatThread({ contact, thread, connected, onBack, onSend, onSendMedia, onSendTemplate, showHeader = true }) {
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
      {showHeader && (
      <div className="flex items-center gap-2 px-4 py-3 border-b border-ink-100 bg-white">
        {onBack && (
          <button type="button" onClick={onBack} className="md:hidden -ml-1 p-1.5 rounded text-ink-500 hover:bg-ink-50" aria-label="Volver a la lista">
            <ArrowLeft size={16} />
          </button>
        )}
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
      )}

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
          {m.quoted && (
            <div className="border-l-2 border-emerald-500/60 bg-black/5 rounded-r-md pl-2 pr-2.5 py-1 mb-1">
              <div className="text-[10px] font-semibold text-emerald-700">{m.quoted.direction === 'out' ? 'Tú' : 'Cliente'}</div>
              <div className="text-xs opacity-70 truncate max-w-[260px]">{m.quoted.body}</div>
            </div>
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
          {m.reactions?.length > 0 && (
            <div className={`-mb-3 ${out ? 'text-left' : 'text-right'}`}>
              <span className="inline-flex items-center rounded-full bg-white border border-ink-100 shadow-xs px-1.5 py-0.5 text-sm leading-none">
                {m.reactions.join(' ')}
              </span>
            </div>
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

export function StatusTicks({ status, className = '' }) {
  if (status === 'failed') return <AlertTriangle size={11} className={`text-red-500 ${className}`} aria-label="Falló" />;
  if (status === 'sending') return <Clock size={11} className={`opacity-40 ${className}`} aria-label="Enviando" />;
  if (status === 'read') return <CheckCheck size={12} className={`text-sky-500 ${className}`} aria-label="Leído" />;
  if (status === 'delivered') return <CheckCheck size={12} className={`opacity-50 ${className}`} aria-label="Entregado" />;
  return <Check size={12} className={`opacity-50 ${className}`} aria-label="Enviado" />;
}

export function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('') || '?';
}
export function timeOfDay(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' });
}
export function dayLabel(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date();
  const yest = new Date(today); yest.setDate(today.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Hoy';
  if (same(d, yest)) return 'Ayer';
  return d.toLocaleDateString('es-DO', { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
export function timeLabel(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? timeOfDay(ms) : dayLabel(ms);
}
