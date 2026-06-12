import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Send, ArrowLeft, Loader2, Check, CheckCheck,
  AlertTriangle, Clock, UserSquare2, Users, Paperclip, LayoutTemplate, Megaphone,
  FileText, Download, Reply, SmilePlus, SquareMenu, ShoppingBag, X, Search,
  Mic, Trash2, ExternalLink, MapPin, ContactRound,
} from 'lucide-react';
import Modal from '../Modal.jsx';
import { resolveReferral, fillTemplateBody } from '../../core/crm/index.js';
import { displayPhone } from '../../lib/phone.js';
import { listWaTemplates, listWaCatalog, fetchWaMediaUrl, sendWhatsappTyping } from '../../lib/whatsapp.js';

/**
 * The WhatsApp conversation thread — header (contact, linked to their CRM
 * card), message bubbles (media, reactions, quoted replies, status ticks),
 * the 24h-window banner and the composer (free text · attach file · voice
 * note · approved template). Extracted from the Chats inbox so the SAME
 * thread renders both in the full inbox (split-pane) and embedded in the
 * quote editor (QuoteChatCard) — one surface, no drift.
 *
 * Pure View: the parent owns the data (a `resolveThread` result + the contact)
 * and the send side-effects (`onSend(body, replyTo)` / `onSendMedia(file,
 * caption, replyTo)` / `onSendTemplate` / `onReact(m, emoji)` /
 * `onSendInteractive({ text, buttons })` / `onSendProducts({ items, names,
 * text })`, each returning wa-send's `{ ok, error? }`; `replyTo` is the
 * quoted message's wamid or null). `onBack`
 * is optional — when given, a back affordance shows on phones (the inbox's
 * list↔thread navigation). `showHeader:false` drops the contact header for
 * hosts that already carry their own (the quote editor's collapsible card).
 */
/**
 * The first recordable format Meta's audio upload accepts, probed once: Meta
 * takes ogg-opus (the native voice-note format), m4a/aac and mp3 — but NOT
 * webm. Null (webm-only recorder, no MediaRecorder) hides the mic entirely.
 */
const VOICE_MIME = (() => {
  const M = typeof window !== 'undefined' ? window.MediaRecorder : undefined;
  if (!M || typeof M.isTypeSupported !== 'function') return null;
  return ['audio/ogg;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac']
    .find((t) => { try { return M.isTypeSupported(t); } catch { return false; } }) || null;
})();

function recClock(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function ChatThread({ contact, thread, connected, onBack, onSend, onSendMedia, onSendTemplate, onReact, onSendInteractive, onSendLocation, onSendContact, onSendProducts, showHeader = true }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [interactiveOpen, setInteractiveOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [productsOpen, setProductsOpen] = useState(false);
  // Message being quoted in the composer (set from a bubble's "Responder").
  const [replyTo, setReplyTo] = useState(null);
  // Voice-note recording in flight (state drives the UI; the ref lets
  // unmount/thread-switch cleanups reach the recorder without re-binding).
  const [rec, setRec] = useState(null);
  const [recElapsed, setRecElapsed] = useState(0);
  const recRef = useRef(null);
  const recCancelled = useRef(false);
  const typingAt = useRef(0);
  const fileRef = useRef(null);
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }); }, [thread.items.length, contact.key]);
  useEffect(() => { setText(''); setError(null); setReplyTo(null); typingAt.current = 0; }, [contact.key]);
  // Switching threads or unmounting abandons an in-flight recording.
  useEffect(() => () => {
    recCancelled.current = true;
    try { recRef.current?.recorder.stop(); } catch { /* idle */ }
  }, [contact.key]);
  useEffect(() => {
    if (!rec) { setRecElapsed(0); return undefined; }
    const t0 = Date.now();
    const id = setInterval(() => setRecElapsed(Date.now() - t0), 500);
    return () => clearInterval(id);
  }, [rec]);

  // Typing indicator — the customer sees "escribiendo…" while the dealer
  // drafts. Meta addresses typing through the latest inbound wamid and expires
  // it itself (~25s), so fire at most once per 20s. Fire-and-forget leaf call,
  // same standing as fetchWaMediaUrl below.
  function notifyTyping() {
    if (!connected || !thread.windowOpen) return;
    const now = Date.now();
    if (now - typingAt.current < 20000) return;
    const lastIn = [...thread.items].reverse().find((m) => m.direction === 'in' && m.waId);
    if (!lastIn) return;
    typingAt.current = now;
    sendWhatsappTyping(lastIn.waId);
  }

  async function submit() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    setText('');
    const res = await onSend(body, replyTo?.waId || null);
    setReplyTo(null);
    setSending(false);
    if (!res?.ok) setError(res?.error || 'No se pudo enviar.');
  }

  // Reactions fire straight from a bubble; failures surface on the shared
  // error strip (there's no per-bubble composer to anchor them to).
  async function react(m, emoji) {
    setError(null);
    const res = await onReact(m, emoji);
    if (!res?.ok) setError(res?.error || 'No se pudo enviar la reacción.');
  }

  // Share the dealer's current position (the attach menu's "Ubicación").
  function sendCurrentLocation() {
    setAttachOpen(false);
    if (!navigator.geolocation) { setError('Este dispositivo no expone la ubicación.'); return; }
    setSending(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const res = await onSendLocation({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          replyTo: replyTo?.waId || null,
        });
        setReplyTo(null);
        setSending(false);
        if (!res?.ok) setError(res?.error || 'No se pudo enviar la ubicación.');
      },
      () => { setSending(false); setError('Sin acceso a la ubicación — permítela en el navegador.'); },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  // Voice notes — record in a format Meta's audio upload accepts and ship
  // through the same media path as attachments. Browsers that only record
  // webm (which Meta rejects) never see the mic button at all (VOICE_MIME).
  async function startRecording() {
    if (!VOICE_MIME || sending || recRef.current) return;
    setError(null);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError('Sin acceso al micrófono — permítelo en el navegador para grabar notas de voz.');
      return;
    }
    const recorder = new MediaRecorder(stream, { mimeType: VOICE_MIME });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      recRef.current = null;
      setRec(null);
      if (recCancelled.current) return;
      const type = VOICE_MIME.split(';')[0];
      sendVoiceNote(new Blob(chunks, { type }), type);
    };
    recCancelled.current = false;
    recorder.start();
    recRef.current = { recorder };
    setRec({ recorder });
  }

  function stopRecording(cancel) {
    if (!recRef.current) return;
    recCancelled.current = !!cancel;
    try { recRef.current.recorder.stop(); } catch { recRef.current = null; setRec(null); }
  }

  async function sendVoiceNote(blob, type) {
    // A tap shorter than ~½s yields a header-only blob — discard, don't send.
    if (blob.size < 1024) return;
    const ext = { 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/aac': 'aac' }[type] || 'm4a';
    const file = new File([blob], `nota-de-voz.${ext}`, { type });
    setSending(true);
    const res = await onSendMedia(file, '', replyTo?.waId || null);
    setReplyTo(null);
    setSending(false);
    if (!res?.ok) setError(res?.error || 'No se pudo enviar la nota de voz.');
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
    const res = await onSendMedia(file, caption, replyTo?.waId || null);
    setReplyTo(null);
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
          <Bubble key={m.id} m={m} prev={thread.items[i - 1]} onReply={setReplyTo} onReact={onReact ? react : null} />
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
      {/* Quoted-reply preview — same visual language as the in-bubble quote. */}
      {replyTo && (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-ink-100 bg-white">
          <div className="min-w-0 flex-1 border-l-2 border-emerald-500/60 bg-ink-50 rounded-r-md pl-2 pr-2.5 py-1">
            <div className="text-[10px] font-semibold text-emerald-700">{replyTo.direction === 'out' ? 'Tú' : 'Cliente'}</div>
            <div className="text-xs text-ink-500 truncate">{replyTo.body || `(${replyTo.kind || 'mensaje'})`}</div>
          </div>
          <button
            type="button"
            onClick={() => setReplyTo(null)}
            className="p-1.5 rounded text-ink-400 hover:text-ink-700 hover:bg-ink-50 shrink-0"
            title="Cancelar respuesta"
            aria-label="Cancelar respuesta"
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div className="flex items-end gap-1.5 px-3 py-3 border-t border-ink-100 bg-white">
        <input ref={fileRef} type="file" className="hidden" onChange={pickFile} aria-hidden="true" tabIndex={-1} />
        {rec ? (
          <>
            <div className="flex items-center gap-2.5 flex-1 min-h-[42px] rounded-lg bg-red-50 border border-red-100 px-3">
              <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" aria-hidden />
              <span className="text-sm text-red-800 tabular-nums">{recClock(recElapsed)}</span>
              <span className="text-xs text-red-700/70 flex-1 truncate">Grabando nota de voz…</span>
              <button
                type="button"
                onClick={() => stopRecording(true)}
                className="p-1.5 -mr-1 rounded text-red-700 hover:bg-red-100 transition-colors"
                title="Descartar grabación"
                aria-label="Descartar grabación"
              >
                <Trash2 size={15} />
              </button>
            </div>
            <button
              type="button"
              onClick={() => stopRecording(false)}
              className="btn-primary !px-3 min-h-[42px] shrink-0"
              title="Enviar nota de voz"
              aria-label="Enviar nota de voz"
            >
              <Send size={16} />
            </button>
          </>
        ) : (
          <>
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => setAttachOpen((v) => !v)}
                disabled={!connected || sending}
                className="p-2.5 min-h-[42px] rounded-lg text-ink-400 hover:text-brand-700 hover:bg-brand-50 disabled:opacity-40 transition-colors"
                title="Adjuntar (archivo · ubicación · contacto)"
                aria-label="Adjuntar"
                aria-expanded={attachOpen}
              >
                <Paperclip size={17} />
              </button>
              {attachOpen && (
                <>
                  {/* Invisible backdrop — a tap anywhere else closes the menu. */}
                  <button type="button" className="fixed inset-0 z-10 cursor-default" onClick={() => setAttachOpen(false)} aria-label="Cerrar menú" tabIndex={-1} />
                  <div className="absolute bottom-full left-0 mb-2 z-20 w-48 rounded-xl bg-white border border-ink-100 shadow-lg overflow-hidden py-1">
                    <AttachItem icon={FileText} label="Archivo" onClick={() => { setAttachOpen(false); fileRef.current?.click(); }} />
                    {onSendLocation && <AttachItem icon={MapPin} label="Ubicación actual" onClick={sendCurrentLocation} />}
                    {onSendContact && <AttachItem icon={ContactRound} label="Contacto" onClick={() => { setAttachOpen(false); setContactOpen(true); }} />}
                  </div>
                </>
              )}
            </div>
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
            <button
              type="button"
              onClick={() => setInteractiveOpen(true)}
              disabled={!connected || sending}
              className="p-2.5 min-h-[42px] rounded-lg text-ink-400 hover:text-brand-700 hover:bg-brand-50 disabled:opacity-40 transition-colors shrink-0"
              title="Mensaje interactivo (botones · lista · enlace)"
              aria-label="Mensaje interactivo"
            >
              <SquareMenu size={17} />
            </button>
            <button
              type="button"
              onClick={() => setProductsOpen(true)}
              disabled={!connected || sending}
              className={`p-2.5 min-h-[42px] rounded-lg disabled:opacity-40 transition-colors shrink-0 ${
                thread.windowOpen ? 'text-ink-400 hover:text-brand-700 hover:bg-brand-50' : 'text-amber-600 hover:bg-amber-50'
              }`}
              title="Enviar productos del catálogo"
              aria-label="Enviar productos del catálogo"
            >
              <ShoppingBag size={17} />
            </button>
            <textarea
              className="input flex-1 min-h-[42px] max-h-32 resize-none text-sm"
              rows={1}
              value={text}
              onChange={(e) => { setText(e.target.value); notifyTyping(); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
              }}
              placeholder={connected ? 'Escribe un mensaje…' : 'Conecta WhatsApp en Configuración para enviar'}
              disabled={!connected}
              aria-label="Mensaje"
            />
            {/* WhatsApp Web pattern: mic on an empty composer, send once there's a draft. */}
            {!text.trim() && VOICE_MIME && !sending ? (
              <button
                type="button"
                onClick={startRecording}
                disabled={!connected}
                className="p-2.5 min-h-[42px] rounded-lg text-ink-400 hover:text-brand-700 hover:bg-brand-50 disabled:opacity-40 transition-colors shrink-0"
                title="Grabar nota de voz"
                aria-label="Grabar nota de voz"
              >
                <Mic size={17} />
              </button>
            ) : (
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
            )}
          </>
        )}
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

      <InteractiveSendModal
        open={interactiveOpen}
        onClose={() => setInteractiveOpen(false)}
        windowOpen={thread.windowOpen}
        onSend={async (spec) => {
          const res = await onSendInteractive(spec);
          if (res?.ok) setInteractiveOpen(false);
          return res;
        }}
      />

      {onSendContact && (
        <ContactSendModal
          open={contactOpen}
          onClose={() => setContactOpen(false)}
          onSend={async (c) => {
            const res = await onSendContact({ ...c, replyTo: replyTo?.waId || null });
            if (res?.ok) { setContactOpen(false); setReplyTo(null); }
            return res;
          }}
        />
      )}
      <ProductPickerModal
        open={productsOpen}
        onClose={() => setProductsOpen(false)}
        windowOpen={thread.windowOpen}
        onSend={async (spec) => {
          const res = await onSendProducts(spec);
          if (res?.ok) setProductsOpen(false);
          return res;
        }}
      />
    </>
  );
}

/** One row of the attach popover menu. */
function AttachItem({ icon: Icon, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-ink-700 hover:bg-ink-50 transition-colors"
    >
      <Icon size={15} className="text-ink-400 shrink-0" /> {label}
    </button>
  );
}

/** Send a contact card (vCard) the client can save — name + phone (+ company). */
function ContactSendModal({ open, onClose, onSend }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [org, setOrg] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open) return;
    setName('');
    setPhone('');
    setOrg('');
    setError(null);
  }, [open]);

  async function submit() {
    if (sending) return;
    if (!name.trim() || !phone.trim()) { setError('Completa el nombre y el teléfono.'); return; }
    setSending(true);
    setError(null);
    const res = await onSend({ name: name.trim(), phone: phone.trim(), org: org.trim() });
    setSending(false);
    if (!res?.ok) setError(res?.error || 'No se pudo enviar el contacto.');
  }

  return (
    <Modal open={open} onClose={onClose} title="Enviar contacto" size="sm">
      <div className="space-y-3">
        <div>
          <div className="label">Nombre</div>
          <input className="input text-sm" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <div className="label">Teléfono</div>
          <input className="input text-sm" type="tel" inputMode="tel" value={phone} placeholder="809 000 0000" onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div>
          <div className="label">Empresa (opcional)</div>
          <input className="input text-sm" value={org} onChange={(e) => setOrg(e.target.value)} />
        </div>
        {error && (
          <p className="text-xs text-red-700 bg-red-50 rounded-lg px-3 py-2 flex items-start gap-1.5">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" /> <span className="min-w-0 break-words">{error}</span>
          </p>
        )}
        <div className="flex justify-end pt-1">
          <button type="button" onClick={submit} disabled={sending} className="btn-primary text-sm inline-flex items-center gap-1.5">
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Enviar
          </button>
        </div>
      </div>
    </Modal>
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

/**
 * Compose a free-form interactive message in one of three shapes: quick-reply
 * buttons (≤3 · 20 chars — the Cloud API limit), a list menu (≤10 options
 * behind one menu button) or a CTA link button. All obey the same 24h-window
 * rule as plain text; the client's choice arrives back as a normal inbound
 * message carrying the option they tapped.
 */
function InteractiveSendModal({ open, onClose, windowOpen, onSend }) {
  const [mode, setMode] = useState('buttons'); // buttons | list | cta
  const [text, setText] = useState('');
  const [buttons, setButtons] = useState(['', '', '']);
  const [listButton, setListButton] = useState('');
  const [rows, setRows] = useState([{ title: '', description: '' }, { title: '', description: '' }, { title: '', description: '' }]);
  const [ctaText, setCtaText] = useState('');
  const [ctaUrl, setCtaUrl] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setMode('buttons');
    setText('');
    setButtons(['', '', '']);
    setListButton('');
    setRows([{ title: '', description: '' }, { title: '', description: '' }, { title: '', description: '' }]);
    setCtaText('');
    setCtaUrl('');
    setError(null);
  }, [open]);

  async function submit() {
    if (sending) return;
    const body = text.trim();
    if (!body) { setError('Escribe el mensaje.'); return; }
    let spec;
    if (mode === 'buttons') {
      const titles = buttons.map((b) => b.trim()).filter(Boolean);
      if (!titles.length) { setError('Agrega al menos un botón.'); return; }
      spec = { text: body, buttons: titles };
    } else if (mode === 'list') {
      const clean = rows
        .map((r) => ({ title: r.title.trim(), ...(r.description.trim() ? { description: r.description.trim() } : {}) }))
        .filter((r) => r.title);
      if (!clean.length) { setError('Agrega al menos una opción.'); return; }
      spec = { text: body, list: { button: listButton.trim() || 'Ver opciones', rows: clean } };
    } else {
      const url = ctaUrl.trim();
      if (!ctaText.trim()) { setError('Escribe el texto del botón.'); return; }
      if (!/^https?:\/\//i.test(url)) { setError('El enlace debe empezar con https://'); return; }
      spec = { text: body, cta: { displayText: ctaText.trim(), url } };
    }
    setSending(true);
    setError(null);
    const res = await onSend(spec);
    setSending(false);
    if (!res?.ok) setError(res?.error || 'No se pudo enviar.');
  }

  return (
    <Modal open={open} onClose={onClose} title="Mensaje interactivo" size="sm">
      <div className="space-y-3">
        <div className="flex rounded-lg bg-ink-50 p-0.5">
          {[['buttons', 'Botones'], ['list', 'Lista'], ['cta', 'Enlace']].map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => { setMode(k); setError(null); }}
              className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                mode === k ? 'bg-white shadow-xs text-ink-900' : 'text-ink-500 hover:text-ink-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div>
          <div className="label">Mensaje</div>
          <textarea
            className="input text-sm min-h-[72px]"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={mode === 'cta' ? 'Mire nuestro catálogo de temporada' : '¿Le interesa esta propuesta?'}
          />
        </div>
        {mode === 'buttons' && buttons.map((b, i) => (
          <div key={i}>
            <div className="label">Botón {i + 1}{i > 0 ? ' (opcional)' : ''}</div>
            <input
              className="input text-sm"
              maxLength={20}
              value={b}
              onChange={(e) => setButtons((bs) => bs.map((x, j) => (j === i ? e.target.value : x)))}
            />
          </div>
        ))}
        {mode === 'list' && (
          <>
            <div>
              <div className="label">Botón del menú</div>
              <input
                className="input text-sm"
                maxLength={20}
                value={listButton}
                placeholder="Ver opciones"
                onChange={(e) => setListButton(e.target.value)}
              />
            </div>
            {rows.map((r, i) => (
              <div key={i} className="flex gap-2">
                <input
                  className="input text-sm flex-1 min-w-0"
                  maxLength={24}
                  value={r.title}
                  placeholder={`Opción ${i + 1}`}
                  onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
                />
                <input
                  className="input text-sm flex-1 min-w-0"
                  maxLength={72}
                  value={r.description}
                  placeholder="Descripción (opcional)"
                  onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                />
              </div>
            ))}
            {rows.length < 10 && (
              <button
                type="button"
                onClick={() => setRows((rs) => [...rs, { title: '', description: '' }])}
                className="btn-ghost text-xs"
              >
                + Agregar opción ({rows.length}/10)
              </button>
            )}
          </>
        )}
        {mode === 'cta' && (
          <>
            <div>
              <div className="label">Texto del botón</div>
              <input
                className="input text-sm"
                maxLength={20}
                value={ctaText}
                placeholder="Ver catálogo"
                onChange={(e) => setCtaText(e.target.value)}
              />
            </div>
            <div>
              <div className="label">Enlace</div>
              <input
                className="input text-sm"
                type="url"
                inputMode="url"
                value={ctaUrl}
                placeholder="https://…"
                onChange={(e) => setCtaUrl(e.target.value)}
              />
            </div>
          </>
        )}
        <p className="text-[11px] text-ink-400">
          {mode === 'buttons' && 'El cliente toca un botón y su respuesta llega aquí como un mensaje.'}
          {mode === 'list' && 'El cliente abre el menú, elige una opción y su elección llega aquí como un mensaje.'}
          {mode === 'cta' && 'El cliente ve un botón que abre el enlace — sin URLs largas en el texto.'}
        </p>
        {!windowOpen && (
          <p className="text-[11px] text-amber-800 bg-amber-50 rounded-lg px-3 py-2 flex items-start gap-1.5">
            <Clock size={12} className="mt-0.5 shrink-0" />
            <span>Ventana de 24 h cerrada: igual que el texto libre, es probable que no se entregue hasta que el cliente vuelva a escribir.</span>
          </p>
        )}
        {error && (
          <p className="text-xs text-red-700 bg-red-50 rounded-lg px-3 py-2 flex items-start gap-1.5">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" /> <span className="min-w-0 break-words">{error}</span>
          </p>
        )}
        <div className="flex justify-end pt-1">
          <button type="button" onClick={submit} disabled={sending} className="btn-primary text-sm inline-flex items-center gap-1.5">
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Enviar
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Browse the WABA's connected Commerce catalog and send product card(s):
 * search-as-you-type (debounced) over listWaCatalog, cursor-paged "Cargar
 * más", toggle products into a selection (one item sends a single product
 * card, several a browsable list), optional accompanying message. Free-form
 * interactive, so the same 24h-window rule as plain text applies.
 */
const MAX_PRODUCT_ITEMS = 30;

function ProductPickerModal({ open, onClose, windowOpen, onSend }) {
  const [q, setQ] = useState('');
  const [products, setProducts] = useState(null); // null = loading
  const [after, setAfter] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(null);
  // retailerId → name; insertion order is the send order.
  const [selected, setSelected] = useState(() => new Map());
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setSelected(new Map());
    setText('');
    setError(null);
  }, [open]);

  // Debounced search — also runs the initial load when the modal opens.
  useEffect(() => {
    if (!open) return undefined;
    const id = setTimeout(async () => {
      setProducts(null);
      setAfter('');
      setLoadError(null);
      try {
        const res = await listWaCatalog({ q: q.trim() });
        if (res?.ok) { setProducts(res.products || []); setAfter(res.after || ''); }
        else { setProducts([]); setLoadError(res?.error || 'No se pudo cargar el catálogo.'); }
      } catch (e) {
        setProducts([]);
        setLoadError(e?.message || 'No se pudo cargar el catálogo.');
      }
    }, 350);
    return () => clearTimeout(id);
  }, [open, q]);

  async function loadMore() {
    if (!after || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await listWaCatalog({ q: q.trim(), after });
      if (res?.ok) { setProducts((ps) => [...(ps || []), ...(res.products || [])]); setAfter(res.after || ''); }
      else setLoadError(res?.error || 'No se pudieron cargar más productos.');
    } catch (e) {
      setLoadError(e?.message || 'No se pudieron cargar más productos.');
    }
    setLoadingMore(false);
  }

  function toggle(p) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(p.retailerId)) next.delete(p.retailerId);
      else if (next.size < MAX_PRODUCT_ITEMS) next.set(p.retailerId, p.name || '');
      return next;
    });
  }

  async function submit() {
    if (sending || !selected.size) return;
    setSending(true);
    setError(null);
    const items = [...selected.keys()];
    const names = items.map((id) => selected.get(id) || '');
    const res = await onSend({ items, names, text: text.trim() });
    setSending(false);
    if (!res?.ok) setError(res?.error || 'No se pudo enviar.');
  }

  return (
    <Modal open={open} onClose={onClose} title="Enviar productos del catálogo" size="md">
      <div className="space-y-3">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-300" aria-hidden />
          <input
            className="input pl-9 text-sm"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar producto por nombre…"
            aria-label="Buscar producto"
          />
        </div>
        {loadError && (
          <p className="text-xs text-red-700 bg-red-50 rounded-lg px-3 py-2">{loadError}</p>
        )}
        <div className="max-h-[42vh] overflow-y-auto -mx-1 px-1">
          {products === null && (
            <div className="flex items-center justify-center py-10 text-ink-400"><Loader2 size={18} className="animate-spin" /></div>
          )}
          {products !== null && !loadError && !products.length && (
            <p className="text-xs text-ink-400 text-center py-8">
              {q.trim() ? 'Ningún producto coincide con la búsqueda.' : 'El catálogo no tiene productos.'}
            </p>
          )}
          {(products || []).map((p) => {
            const picked = selected.has(p.retailerId);
            const soldOut = p.availability === 'out of stock';
            return (
              <button
                key={p.retailerId}
                type="button"
                onClick={() => toggle(p)}
                aria-pressed={picked}
                className={`w-full text-left px-2 py-2 flex items-center gap-3 rounded-lg transition-colors ${picked ? 'bg-brand-50 ring-1 ring-inset ring-brand-200' : 'hover:bg-ink-50'}`}
              >
                {p.imageUrl ? (
                  <img src={p.imageUrl} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover bg-ink-100" />
                ) : (
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-ink-100 text-ink-300">
                    <ShoppingBag size={16} aria-hidden />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink-900 truncate">{p.name || p.retailerId}</span>
                  <span className="flex items-center gap-1.5 text-[11px] text-ink-400">
                    {p.price && <span>{p.price}</span>}
                    {soldOut && (
                      <span className="inline-flex items-center gap-1 text-red-600">
                        <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden /> Agotado
                      </span>
                    )}
                  </span>
                </span>
                {picked && <Check size={15} className="text-brand-700 shrink-0" aria-hidden />}
              </button>
            );
          })}
          {!!after && products !== null && (
            <div className="text-center py-2">
              <button type="button" onClick={loadMore} disabled={loadingMore} className="btn-ghost text-xs inline-flex items-center gap-1.5">
                {loadingMore && <Loader2 size={12} className="animate-spin" />} Cargar más
              </button>
            </div>
          )}
        </div>
        <div>
          <div className="label">Mensaje (opcional)</div>
          <input
            className="input text-sm"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Mira estas opciones que te pueden interesar…"
          />
        </div>
        {!windowOpen && (
          <p className="text-[11px] text-amber-800 bg-amber-50 rounded-lg px-3 py-2 flex items-start gap-1.5">
            <Clock size={12} className="mt-0.5 shrink-0" />
            <span>Ventana de 24 h cerrada: igual que el texto libre, es probable que no se entregue hasta que el cliente vuelva a escribir.</span>
          </p>
        )}
        {error && (
          <p className="text-xs text-red-700 bg-red-50 rounded-lg px-3 py-2 flex items-start gap-1.5">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" /> <span className="min-w-0 break-words">{error}</span>
          </p>
        )}
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-xs text-ink-500">
            {selected.size} seleccionado{selected.size === 1 ? '' : 's'}{selected.size >= MAX_PRODUCT_ITEMS ? ` (máx. ${MAX_PRODUCT_ITEMS})` : ''}
          </span>
          <button type="button" onClick={submit} disabled={sending || !selected.size} className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Enviar
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Bubble({ m, prev, onReply, onReact }) {
  const out = m.direction === 'out';
  const day = dayLabel(m.createdAt);
  const showDay = !prev || dayLabel(prev.createdAt) !== day;
  const referral = resolveReferral(m);
  // A non-inline attachment renders as a chip that already carries m.body
  // (the filename/caption) — don't repeat it as text below.
  const isDocChip = !!m.mediaPath && !/^(image|video|audio)\//.test(m.mediaMime || '');
  // Stickers render bare — no bubble chrome — like the official app.
  const isSticker = m.kind === 'sticker' && !!m.mediaPath;
  const card = contactCard(m);
  const loc = m.payload?.location;
  // Reply/react address the message by wamid — without one (an optimistic
  // draft, a failed send) there is nothing to act on.
  const canAct = !!m.waId && !!(onReply || onReact);
  return (
    <>
      {showDay && (
        <div className="text-center py-1.5">
          <span className="text-[10px] font-medium text-ink-400 bg-white border border-ink-100 rounded-full px-2.5 py-0.5">{day}</span>
        </div>
      )}
      <div className={`group flex items-center gap-1 ${out ? 'justify-end' : 'justify-start'}`}>
        {out && canAct && <BubbleActions m={m} onReply={onReply} onReact={onReact} />}
        {/* tabIndex: a tap focuses the bubble, revealing the actions on touch. */}
        <div tabIndex={canAct ? 0 : undefined} className={`max-w-[78%] text-sm break-words whitespace-pre-wrap focus:outline-none ${
          isSticker
            ? 'px-1 py-0.5'
            : `rounded-2xl px-3 py-2 shadow-xs ${
              out
                ? m.status === 'failed' ? 'bg-red-50 border border-red-200 text-red-800' : 'bg-brand-100 text-ink-900'
                : 'bg-white border border-ink-100 text-ink-900'
            }`
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
          {/* Catalog products WE sent — compact chips showing what the client saw. */}
          {m.payload?.products?.items?.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 mb-1">
              <ShoppingBag size={12} className="shrink-0 opacity-60" aria-hidden />
              {m.payload.products.items.map((id, i) => (
                <span key={`${id}-${i}`} className="rounded-full bg-white/70 border border-ink-200 px-2 py-0.5 text-[11px] text-ink-700 max-w-[180px] truncate">
                  {m.payload.products.names?.[i] || id}
                </span>
              ))}
            </div>
          )}
          {m.body && !isDocChip && !card
            ? m.body
            : !m.mediaPath && !m.body && !card && <span className="opacity-60 italic">({m.kind || 'mensaje'})</span>}
          {/* Quick-reply buttons WE sent — non-clickable chips showing what the client saw. */}
          {m.payload?.interactive?.buttons?.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {m.payload.interactive.buttons.map((b, i) => (
                <span key={i} className="rounded-full bg-white/70 border border-ink-200 px-2.5 py-0.5 text-xs text-ink-700">{b}</span>
              ))}
            </div>
          )}
          {/* List menu WE sent — the menu label + its options, as the client saw them. */}
          {m.payload?.interactive?.rows?.length > 0 && (
            <div className="mt-1.5 rounded-lg bg-white/70 border border-ink-200 overflow-hidden">
              <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-ink-400 border-b border-ink-100">
                {m.payload.interactive.listButton || 'Opciones'}
              </div>
              {m.payload.interactive.rows.map((t, i) => (
                <div key={i} className="px-2.5 py-1 text-xs text-ink-700 border-b border-ink-50 last:border-0">{t}</div>
              ))}
            </div>
          )}
          {/* CTA link button WE sent — tappable here too. */}
          {m.payload?.interactive?.cta?.url && (
            <a
              href={m.payload.interactive.cta.url}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 flex items-center justify-center gap-1.5 rounded-full bg-white/70 border border-ink-200 px-2.5 py-1 text-xs font-medium text-sky-700 hover:bg-white transition-colors"
            >
              <ExternalLink size={11} className="shrink-0" /> {m.payload.interactive.cta.displayText || 'Abrir enlace'}
            </a>
          )}
          {/* Location pin (either direction) — opens in Maps. */}
          {loc?.latitude != null && (
            <a
              href={`https://maps.google.com/?q=${loc.latitude},${loc.longitude}`}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 flex items-center gap-1.5 rounded-lg bg-white/70 border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-sky-700 hover:bg-white transition-colors"
            >
              <MapPin size={13} className="shrink-0" />
              <span className="min-w-0 truncate">Ver en el mapa</span>
            </a>
          )}
          {/* Contact card (either direction) — who was shared. */}
          {card && (
            <div className="mt-1.5 flex items-center gap-2 rounded-lg bg-white/70 border border-ink-200 px-2.5 py-1.5">
              <ContactRound size={15} className="text-ink-400 shrink-0" />
              <div className="min-w-0">
                <div className="text-xs font-medium text-ink-800 truncate">{card.name}</div>
                {card.phone && <div className="text-[11px] text-ink-500">{card.phone}</div>}
              </div>
            </div>
          )}
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
        {!out && canAct && <BubbleActions m={m} onReply={onReply} onReact={onReact} />}
      </div>
    </>
  );
}

/**
 * A contact-card message's { name, phone } — ours ride logPayload.contact,
 * the client's arrive as Meta's contacts[] array. Null = not a card message.
 */
function contactCard(m) {
  const p = m.payload;
  if (p?.contact?.name) return { name: p.contact.name, phone: p.contact.phone || '' };
  const c = Array.isArray(p?.contacts) ? p.contacts[0] : null;
  if (!c) return null;
  return { name: c.name?.formatted_name || c.name?.first_name || 'Contacto', phone: c.phones?.[0]?.phone || '' };
}

const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '🙏'];

/**
 * The reply/react cluster beside a bubble. Hidden until the row is hovered
 * (desktop) or anything in it is focused — the bubble itself is tabbable, so
 * on touch a tap on the bubble reveals it. "Reaccionar" swaps the cluster for
 * a tiny emoji row (✕ removes our existing reaction).
 */
function BubbleActions({ m, onReply, onReact }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <div className="self-center flex items-center gap-0.5 shrink-0 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-opacity">
      {pickerOpen && onReact ? (
        <div className="flex items-center gap-0.5 rounded-full bg-white border border-ink-100 shadow-sm px-1.5 py-1">
          {REACTION_EMOJIS.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => { setPickerOpen(false); onReact(m, e); }}
              className="px-0.5 text-base leading-none hover:scale-125 transition-transform"
              title={`Reaccionar con ${e}`}
              aria-label={`Reaccionar con ${e}`}
            >
              {e}
            </button>
          ))}
          {m.reactions?.length > 0 && (
            <button
              type="button"
              onClick={() => { setPickerOpen(false); onReact(m, ''); }}
              className="p-0.5 text-ink-400 hover:text-red-600 transition-colors"
              title="Quitar reacción"
              aria-label="Quitar reacción"
            >
              <X size={13} />
            </button>
          )}
        </div>
      ) : (
        <>
          {onReply && (
            <button
              type="button"
              onClick={() => onReply(m)}
              className="p-1.5 rounded-full text-ink-400 hover:text-brand-700 hover:bg-white transition-colors"
              title="Responder"
              aria-label="Responder"
            >
              <Reply size={14} />
            </button>
          )}
          {onReact && (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="p-1.5 rounded-full text-ink-400 hover:text-brand-700 hover:bg-white transition-colors"
              title="Reaccionar"
              aria-label="Reaccionar"
            >
              <SmilePlus size={14} />
            </button>
          )}
        </>
      )}
    </div>
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
  if (m.kind === 'sticker') {
    return <img src={url} alt="Sticker" className="max-h-36 max-w-[160px] object-contain mb-1" />;
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
