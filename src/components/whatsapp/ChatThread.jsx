import { userMessageFor } from '../../lib/errorMessages.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Send, ArrowLeft, Loader2, Check, CheckCheck,
  AlertTriangle, Clock, UserSquare2, Users, Paperclip, LayoutTemplate, Megaphone,
  FileText, Download, Reply, SmilePlus, SquareMenu, ShoppingBag, X, Search,
  Mic, Trash2, ExternalLink, MapPin, ContactRound, UserPlus, Zap, MoreVertical, Ban, Sparkles,
} from 'lucide-react';
import Modal from '../Modal.jsx';
import { resolveReferral, resolveOrderMessage, fillTemplateBody, fillQuickReply, resolveNewChatContacts, buildDraftTurns } from '../../core/crm/index.js';
import { displayPhone, phoneKey } from '../../lib/phone.js';
import { listWaTemplates, listWaCatalog, fetchWaMediaUrl, sendWhatsappTyping, blockWhatsappUser, unblockWhatsappUser } from '../../lib/whatsapp.js';
import { startVoiceRecording, canRecordVoice, preloadVoiceRecorder } from '../../lib/loadOpusRecorder.js';
import { db } from '../../db/database.js';
import { useLiveQuery } from '../../db/hooks.js';
import { useApp } from '../../context/AppContext.jsx';

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
 * Whether this browser can record a voice note, probed once. We don't rely on
 * the native MediaRecorder's formats (Chrome only does webm, Safari only
 * fragmented mp4 — Meta rejects both); the opus-recorder WASM encoder records
 * Ogg/Opus everywhere, so the only gate is mic + Web Audio + wasm support.
 * False hides the mic entirely.
 */
const VOICE_SUPPORTED = canRecordVoice();

function recClock(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function ChatThread({ contact, thread, connected, onBack, onSend, onSendMedia, onSendTemplate, onReact, onSendInteractive, onSendLocation, onSendContact, onSendProducts, onSendCatalog, onSaveContact, onCreateQuote, onSuggestReply, showHeader = true, contextQuoteId = null }) {
  const [text, setText] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [interactiveOpen, setInteractiveOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [productsOpen, setProductsOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  // Contact being saved into the CRM ({ name, phone } from a received card
  // or the unknown-chatter header action), or null.
  const [saveTarget, setSaveTarget] = useState(null);
  // File staged for sending (picked or pasted) + its caption — the preview
  // step between choosing a file and it actually leaving.
  const [pendingFile, setPendingFile] = useState(null);

  // Quote chips on bubbles: messages sent from a quote (the editor's chat
  // pane, the header's "Enviar cotización", campaigns) carry quoteId — map it
  // to the human #number so the thread shows WHICH deal a message was about
  // and deep-links to it. Bubbles of the quote being edited (contextQuoteId,
  // set by the workspace's embedded pane) skip the chip — there it's noise.
  const { profileId, settings } = useApp();
  // Quick replies (canned snippets) the dealer inserts with one tap — only the
  // composer button appears once any are configured (Settings → WhatsApp), so
  // the cluster stays uncluttered until the team opts in. {{nombre}}/{{negocio}}
  // resolve against THIS contact + the dealer's business name at insert time.
  const quickReplies = Array.isArray(settings?.whatsappQuickReplies) ? settings.whatsappQuickReplies : [];
  const quickVars = { nombre: contact.name || '', negocio: settings?.companyName || '' };
  const quotes = useLiveQuery(
    () => (profileId ? db.quotes.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId],
    [],
  );
  const quoteNumberById = useMemo(() => {
    const map = new Map();
    for (const q of quotes) map.set(q.id, q.number);
    return map;
  }, [quotes]);
  const [pendingUrl, setPendingUrl] = useState(null);
  const [caption, setCaption] = useState('');
  // Message being quoted in the composer (set from a bubble's "Responder").
  const [replyTo, setReplyTo] = useState(null);
  // Voice-note recording in flight (state drives the UI; the ref lets
  // unmount/thread-switch cleanups reach the recorder without re-binding).
  const [rec, setRec] = useState(null);
  const [recElapsed, setRecElapsed] = useState(0);
  const recRef = useRef(null);
  const recCancelled = useRef(false);
  const recStarting = useRef(false);
  const typingAt = useRef(0);
  const fileRef = useRef(null);
  const composerRef = useRef(null);
  const listRef = useRef(null);
  // Pin the conversation to its latest message by scrolling the thread's OWN
  // container — NOT scrollIntoView, which on iOS also scrolls every ancestor
  // (the app-shell <main>), yanking the host page when the thread mounts or a
  // message lands. Scoped here, the inbox, the embedded card and the quote
  // workspace's chat pane all keep their page scroll put behind the thread.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.items.length, contact.key]);
  useEffect(() => { setText(''); setError(null); setReplyTo(null); setPendingFile(null); setCaption(''); typingAt.current = 0; }, [contact.key]);
  // Object URL for the staged file's preview, revoked when it changes.
  useEffect(() => {
    if (!pendingFile) { setPendingUrl(null); return undefined; }
    const url = URL.createObjectURL(pendingFile);
    setPendingUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingFile]);
  // Switching threads or unmounting abandons an in-flight recording (and any
  // mid-load start — recCancelled tells startRecording to drop the controller
  // once the encoder finishes loading).
  useEffect(() => () => {
    recCancelled.current = true;
    try { recRef.current?.cancel(); } catch { /* idle */ }
    recRef.current = null;
  }, [contact.key]);
  // Warm the (code-split) Opus encoder once a connected thread is open, so the
  // mic tap can start recording within iOS's user-gesture window.
  useEffect(() => {
    if (VOICE_SUPPORTED && connected) preloadVoiceRecorder().catch(() => {});
  }, [connected]);
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

  // Insert a quick reply into the composer (never auto-send) — the dealer can
  // tweak it before sending, and it rides the same free-text path as typing
  // (so the 24h-window rule applies identically). Appends to any draft rather
  // than clobbering it; caret lands at the end, composer focused.
  function insertQuickReply(qr) {
    const filled = fillQuickReply(qr.text, quickVars);
    setQuickOpen(false);
    setText((t) => (t.trim() ? `${t.replace(/\s+$/, '')} ${filled}` : filled));
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (el) { el.focus(); const n = el.value.length; el.setSelectionRange(n, n); }
    });
  }

  // AI reply suggestion — only offered when there's an inbound message worth
  // answering. Built from the same transcript the inbox would show, sent to the
  // `wa-draft` function, and dropped into the composer like a quick reply:
  // never auto-sent (human-in-the-loop), the dealer edits before sending.
  const { canDraft } = useMemo(() => buildDraftTurns(thread.items), [thread.items]);
  async function suggestReply() {
    if (drafting || !onSuggestReply) return;
    setDrafting(true);
    setError(null);
    const { turns } = buildDraftTurns(thread.items);
    const res = await onSuggestReply({ turns, contactName: contact.name || null });
    setDrafting(false);
    if (!res?.ok || !res.draft) { setError(res?.error || 'No se pudo sugerir una respuesta.'); return; }
    // Replace an empty composer; otherwise append so a half-typed draft survives.
    setText((t) => (t.trim() ? `${t.replace(/\s+$/, '')} ${res.draft}` : res.draft));
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (el) { el.focus(); const n = el.value.length; el.setSelectionRange(n, n); }
    });
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

  // Voice notes — record straight to Ogg/Opus (Meta's native voice-note format)
  // via the opus-recorder WASM encoder and ship through the same media path as
  // attachments. See lib/loadOpusRecorder.js for why the native MediaRecorder
  // can't be used. Browsers without mic/Web-Audio/wasm never see the mic button
  // at all (VOICE_SUPPORTED).
  async function startRecording() {
    if (!VOICE_SUPPORTED || sending || recRef.current || recStarting.current) return;
    setError(null);
    recCancelled.current = false;
    recStarting.current = true;
    let controller;
    try {
      controller = await startVoiceRecording();
    } catch (err) {
      recStarting.current = false;
      if (recCancelled.current) return; // thread switched mid-load — stay quiet
      const denied = /notallowed|permission/i.test(String(err?.name || err?.message || ''));
      setError(denied
        ? 'Sin acceso al micrófono — permítelo en el navegador para grabar notas de voz.'
        : 'No se pudo iniciar la grabación de voz.');
      return;
    }
    recStarting.current = false;
    // Thread switched / unmounted while the encoder loaded — abandon it.
    if (recCancelled.current) { try { controller.cancel(); } catch { /* idle */ } return; }
    recRef.current = controller;
    setRec(controller);
  }

  async function stopRecording(cancel) {
    const controller = recRef.current;
    if (!controller) return;
    recRef.current = null;
    setRec(null);
    if (cancel) { try { controller.cancel(); } catch { /* idle */ } return; }
    let blob = null;
    try { blob = await controller.stop(); } catch { /* nothing recorded */ }
    if (blob) sendVoiceNote(blob);
  }

  async function sendVoiceNote(blob) {
    // A tap shorter than ~½s yields a header-only blob — discard, don't send.
    if (!blob || blob.size < 1024) return;
    const file = new File([blob], 'nota-de-voz.ogg', { type: 'audio/ogg' });
    setSending(true);
    const res = await onSendMedia(file, '', replyTo?.waId || null);
    setReplyTo(null);
    setSending(false);
    if (!res?.ok) setError(res?.error || 'No se pudo enviar la nota de voz.');
  }

  // Attach: picking (or pasting) a file opens a PREVIEW with a caption box —
  // nothing sends until the dealer confirms, like the official app. The
  // current draft text moves into the caption (WhatsApp Web's behavior) and
  // moves back to the composer if the preview is discarded.
  function stageFile(file) {
    if (!file || sending) return;
    setError(null);
    setPendingFile(file);
    setCaption(text.trim());
    setText('');
  }

  function pickFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    stageFile(file);
  }

  // Pasting a screenshot/file into the composer stages it too.
  function pasteFile(e) {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file');
    const file = item?.getAsFile?.();
    if (!file) return; // plain text paste — let it through
    e.preventDefault();
    stageFile(file);
  }

  function discardPending() {
    if (!pendingFile) return;
    setText(caption); // hand the words back to the composer
    setPendingFile(null);
    setCaption('');
  }

  async function sendPending() {
    if (!pendingFile || sending) return;
    setSending(true);
    setError(null);
    const isAudio = (pendingFile.type || '').startsWith('audio/');
    const res = await onSendMedia(pendingFile, isAudio ? '' : caption.trim(), replyTo?.waId || null);
    setSending(false);
    // Keep the staged file on failure so a retry is one tap, not a re-pick.
    if (!res?.ok) { setError(res?.error || 'No se pudo enviar el archivo.'); return; }
    setPendingFile(null);
    setCaption('');
    setReplyTo(null);
  }

  const detailLink = contact.customerId
    ? `/customers/${contact.customerId}`
    : contact.professionalId ? `/professionals/${contact.professionalId}` : null;

  return (
    <>
      {/* Thread header — who, linked to their CRM card. */}
      {showHeader && (
      <div className="flex items-center gap-2 px-4 py-3 border-b border-ink-100 bg-surface">
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
        {/* Unknown chatter → save them into the CRM (the official app's "Add to contacts"). */}
        {onSaveContact && !contact.contactKind && contact.phone && (
          <button
            type="button"
            onClick={() => setSaveTarget({
              name: contact.name && contact.name !== displayPhone(contact.phone) ? contact.name : '',
              phone: contact.phone,
            })}
            className="btn-ghost text-xs inline-flex items-center gap-1.5 shrink-0"
          >
            <UserPlus size={13} /> Guardar
          </button>
        )}
        {/* Overflow actions (block / unblock). Only in the inbox header. */}
        {connected && contact.phone && <BlockMenu phone={contact.phone} onError={setError} />}
      </div>
      )}

      {/* Messages */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-1.5 bg-ink-50/40">
        {thread.items.map((m, i) => (
          <Bubble
            key={m.id}
            m={m}
            prev={thread.items[i - 1]}
            onReply={setReplyTo}
            onReact={onReact ? react : null}
            onSaveCard={onSaveContact ? setSaveTarget : null}
            onCreateOrder={onCreateQuote || null}
            quoteChip={m.quoteId && m.quoteId !== contextQuoteId
              ? { id: m.quoteId, number: quoteNumberById.get(m.quoteId) ?? null }
              : null}
          />
        ))}
        {!thread.items.length && (
          <p className="text-xs text-ink-400 text-center py-8">
            Sin mensajes todavía. {contact.contactKind ? 'Escríbele para iniciar la conversación.' : ''}
          </p>
        )}
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
        <div className="flex items-center gap-2 px-3 py-2 border-t border-ink-100 bg-surface">
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
      <input ref={fileRef} type="file" className="hidden" onChange={pickFile} aria-hidden="true" tabIndex={-1} />
      {pendingFile ? (
        <div className="border-t border-ink-100 bg-surface px-3 py-3 space-y-2.5">
          <div className="flex items-start gap-3">
            <PendingPreview file={pendingFile} url={pendingUrl} />
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="text-sm font-medium text-ink-800 truncate">{pendingFile.name || 'Archivo'}</div>
              <div className="text-[11px] text-ink-400">
                {prettySize(pendingFile.size)}
                {pendingFile.size > 24 * 1024 * 1024 ? ' · supera el límite de 24 MB' : ''}
              </div>
            </div>
            <button
              type="button"
              onClick={discardPending}
              className="p-1.5 -mr-0.5 rounded text-ink-400 hover:text-ink-700 hover:bg-ink-50 shrink-0"
              title="Descartar archivo"
              aria-label="Descartar archivo"
            >
              <X size={15} />
            </button>
          </div>
          <div className="flex items-end gap-1.5">
            {(pendingFile.type || '').startsWith('audio/') ? (
              <span className="flex-1 text-[11px] text-ink-400 self-center">Los audios se envían sin comentario.</span>
            ) : (
              <textarea
                className="input flex-1 min-h-[42px] max-h-32 resize-none text-sm"
                rows={1}
                autoFocus
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPending(); }
                  if (e.key === 'Escape') { e.preventDefault(); discardPending(); }
                }}
                placeholder="Añade un comentario…"
                aria-label="Comentario del archivo"
              />
            )}
            <button
              type="button"
              onClick={sendPending}
              disabled={sending || pendingFile.size > 24 * 1024 * 1024}
              className="btn-primary !px-3 min-h-[42px] disabled:opacity-40 shrink-0"
              title="Enviar archivo"
              aria-label="Enviar archivo"
            >
              {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div>
        </div>
      ) : (
      <div className="flex items-end gap-1.5 px-3 py-3 border-t border-ink-100 bg-surface">
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
            {/* AI reply suggestion — drops a draft into the composer (never
                sends). Shown only with an inbound message to answer and the
                24h window open, so it's zero clutter on cold threads. */}
            {onSuggestReply && canDraft && thread.windowOpen && (
              <button
                type="button"
                onClick={suggestReply}
                disabled={!connected || sending || drafting}
                className="p-2.5 min-h-[42px] rounded-lg text-ink-400 hover:text-brand-700 hover:bg-brand-50 disabled:opacity-40 transition-colors shrink-0"
                title="Sugerir respuesta con IA"
                aria-label="Sugerir respuesta con IA"
                aria-busy={drafting}
              >
                {drafting ? <Loader2 size={17} className="animate-spin" /> : <Sparkles size={17} />}
              </button>
            )}
            {/* Quick replies — leftmost so the upward popover (w-72) stays
                on-screen on a phone. Rendered only once the team has saved
                some (Settings → WhatsApp), so it's zero clutter by default. */}
            {quickReplies.length > 0 && (
              <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setQuickOpen((v) => !v)}
                  disabled={!connected || sending}
                  className="p-2.5 min-h-[42px] rounded-lg text-ink-400 hover:text-brand-700 hover:bg-brand-50 disabled:opacity-40 transition-colors"
                  title="Respuestas rápidas"
                  aria-label="Respuestas rápidas"
                  aria-expanded={quickOpen}
                >
                  <Zap size={17} />
                </button>
                {quickOpen && (
                  <>
                    <button type="button" className="fixed inset-0 z-10 cursor-default" onClick={() => setQuickOpen(false)} aria-label="Cerrar menú" tabIndex={-1} />
                    <div className="absolute bottom-full left-0 mb-2 z-20 w-[min(18rem,calc(100vw-2rem))] max-h-72 overflow-y-auto rounded-xl bg-surface border border-ink-100 shadow-lg py-1">
                      <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-400">Respuestas rápidas</div>
                      {quickReplies.map((qr) => (
                        <button
                          key={qr.id}
                          type="button"
                          onClick={() => insertQuickReply(qr)}
                          className="block w-full text-left px-3 py-2 hover:bg-ink-50 active:bg-ink-100 transition-colors"
                        >
                          <div className="text-sm font-medium text-ink-800 truncate">{qr.label || 'Sin título'}</div>
                          <div className="text-[11px] text-ink-500 truncate">{fillQuickReply(qr.text, quickVars)}</div>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
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
                  <div className="absolute bottom-full left-0 mb-2 z-20 w-48 rounded-xl bg-surface border border-ink-100 shadow-lg overflow-hidden py-1">
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
              ref={composerRef}
              className="input flex-1 min-h-[42px] max-h-32 resize-none text-sm"
              rows={1}
              value={text}
              onChange={(e) => { setText(e.target.value); notifyTyping(); }}
              onPaste={pasteFile}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
              }}
              placeholder={connected ? 'Escribe un mensaje…' : 'Conecta WhatsApp en Configuración para enviar'}
              disabled={!connected}
              aria-label="Mensaje"
            />
            {/* WhatsApp Web pattern: mic on an empty composer, send once there's a draft. */}
            {!text.trim() && VOICE_SUPPORTED && !sending ? (
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
      )}

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
          excludeKey={contact.key}
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
        onSendCatalog={onSendCatalog ? async (spec) => {
          const res = await onSendCatalog(spec);
          if (res?.ok) setProductsOpen(false);
          return res;
        } : null}
      />

      {onSaveContact && (
        <SaveContactModal
          target={saveTarget}
          onClose={() => setSaveTarget(null)}
          onSave={onSaveContact}
        />
      )}
    </>
  );
}

/** The staged file's thumbnail — image/video/audio preview or a doc glyph. */
function PendingPreview({ file, url }) {
  const mime = file.type || '';
  if (url && mime.startsWith('image/')) {
    return <img src={url} alt="Vista previa" className="h-20 w-20 rounded-lg object-cover border border-ink-100 shrink-0" />;
  }
  if (url && mime.startsWith('video/')) {
    return <video src={url} className="h-20 w-28 rounded-lg object-cover border border-ink-100 shrink-0" muted playsInline controls />;
  }
  if (url && mime.startsWith('audio/')) {
    return <audio src={url} controls className="h-10 max-w-[220px] shrink-0" />;
  }
  return (
    <span className="h-20 w-20 rounded-lg bg-ink-50 border border-ink-100 flex items-center justify-center shrink-0">
      <FileText size={24} className="text-ink-400" />
    </span>
  );
}

function prettySize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
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

/**
 * Send a contact card (vCard) the client can save. Picks from the CRM
 * (customers + professionals with a phone, minus this thread's own contact)
 * — tapping a row prefills the form for a quick confirm — or fill the fields
 * manually for someone outside the list.
 */
function ContactSendModal({ open, onClose, excludeKey, onSend }) {
  const [needle, setNeedle] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [org, setOrg] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open) return;
    setNeedle('');
    setName('');
    setPhone('');
    setOrg('');
    setError(null);
  }, [open]);

  // The CRM lists load only while the modal is open (the host pages may not
  // have them — the quote editor's card doesn't fetch professionals).
  const customers = useLiveQuery(
    () => (open ? db.customers.toArray() : Promise.resolve([])),
    [open], [],
  );
  const professionals = useLiveQuery(
    () => (open ? db.professionals.toArray() : Promise.resolve([])),
    [open], [],
  );
  const picks = (open ? resolveNewChatContacts(customers, professionals, [], { needle }) : [])
    .filter((c) => c.key !== excludeKey)
    .slice(0, 30);

  function pick(c) {
    const row = c.customerId
      ? customers.find((r) => r.id === c.customerId)
      : professionals.find((r) => r.id === c.professionalId);
    setName(c.name);
    setPhone(c.phone);
    setOrg(row?.company || '');
    setError(null);
  }

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
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-300" aria-hidden />
          <input
            className="input pl-9 text-sm"
            value={needle}
            onChange={(e) => setNeedle(e.target.value)}
            placeholder="Buscar en clientes y profesionales…"
            aria-label="Buscar contacto"
          />
        </div>
        {picks.length > 0 && (
          <div className="max-h-44 overflow-y-auto -mx-1 px-1 rounded-lg border border-ink-100 divide-y divide-ink-50">
            {picks.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => pick(c)}
                className={`w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors ${
                  phoneKey(phone) === c.key ? 'bg-brand-50' : 'hover:bg-ink-50'
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-ink-900 truncate">{c.name}</span>
                  <span className="block text-[11px] text-ink-400">
                    {displayPhone(c.phone)} · {c.contactKind === 'customer' ? 'Cliente' : 'Profesional'}
                  </span>
                </span>
                {phoneKey(phone) === c.key && <Check size={14} className="text-brand-700 shrink-0" />}
              </button>
            ))}
          </div>
        )}
        <div className="eyebrow-xs text-ink-400">…o escríbelo manualmente</div>
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
 * Save a chat contact (a received vCard, or the unknown number you're
 * chatting with) into the CRM as a customer or professional. Duplicates
 * don't double-save — the existing row is named instead.
 */
function SaveContactModal({ target, onClose, onSave }) {
  const open = !!target;
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [kind, setKind] = useState('customer');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null); // { tone: 'error'|'info', text }
  useEffect(() => {
    if (!target) return;
    setName(target.name || '');
    setPhone(target.phone || '');
    setKind('customer');
    setMsg(null);
  }, [target]);

  async function submit() {
    if (saving) return;
    if (!name.trim() || !phone.trim()) { setMsg({ tone: 'error', text: 'Completa el nombre y el teléfono.' }); return; }
    setSaving(true);
    setMsg(null);
    const res = await onSave({ name: name.trim(), phone: phone.trim(), kind });
    setSaving(false);
    if (!res?.ok) { setMsg({ tone: 'error', text: res?.error || 'No se pudo guardar.' }); return; }
    if (res.existed) { setMsg({ tone: 'info', text: `Ese número ya está guardado${res.name ? ` como ${res.name}` : ''}.` }); return; }
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Guardar contacto" size="sm">
      <div className="space-y-3">
        <div className="flex rounded-lg bg-ink-50 p-0.5">
          {[['customer', 'Cliente'], ['professional', 'Profesional']].map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                kind === k ? 'bg-surface shadow-xs text-ink-900' : 'text-ink-500 hover:text-ink-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div>
          <div className="label">Nombre</div>
          <input className="input text-sm" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <div className="label">Teléfono</div>
          <input className="input text-sm" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        {msg && (
          <p className={`text-xs rounded-lg px-3 py-2 flex items-start gap-1.5 ${
            msg.tone === 'error' ? 'text-red-700 bg-red-50' : 'text-amber-800 bg-amber-50'
          }`}>
            <AlertTriangle size={12} className="mt-0.5 shrink-0" /> <span className="min-w-0 break-words">{msg.text}</span>
          </p>
        )}
        <div className="flex justify-end pt-1">
          <button type="button" onClick={submit} disabled={saving} className="btn-primary text-sm inline-flex items-center gap-1.5">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />} Guardar
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
    }).catch((e) => { setTemplates([]); setLoadError(userMessageFor(e)); });
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
                mode === k ? 'bg-surface shadow-xs text-ink-900' : 'text-ink-500 hover:text-ink-800'
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

function ProductPickerModal({ open, onClose, windowOpen, onSend, onSendCatalog }) {
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
        setLoadError(userMessageFor(e));
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
      setLoadError(userMessageFor(e));
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

  // Send the WHOLE catalog (no selection needed) — the "View catalog" message.
  async function sendCatalog() {
    if (sending || !onSendCatalog) return;
    setSending(true);
    setError(null);
    const res = await onSendCatalog({ text: text.trim() });
    setSending(false);
    if (!res?.ok) setError(res?.error || 'No se pudo enviar el catálogo.');
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
          <div className="flex items-center gap-2">
            {/* Send everything — no selection needed. */}
            {onSendCatalog && (
              <button type="button" onClick={sendCatalog} disabled={sending} className="btn-ghost text-xs inline-flex items-center gap-1.5 disabled:opacity-40" title="Enviar el catálogo completo">
                <ShoppingBag size={13} /> Catálogo completo
              </button>
            )}
            <button type="button" onClick={submit} disabled={sending || !selected.size} className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Enviar
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Overflow menu in the thread header: block / unblock the contact. Meta only
 * allows blocking a number that has messaged the business. Block state isn't
 * persisted (the Block API exposes no per-user "is blocked" query, only a full
 * list) — it's tracked for THIS open thread so the label flips after acting;
 * reopening defaults to "Bloquear" (blocking an already-blocked number is a
 * harmless no-op, and unblock works regardless).
 */
function BlockMenu({ phone, onError }) {
  const [open, setOpen] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  async function toggle() {
    if (busy) return;
    setBusy(true);
    onError(null);
    const fn = blocked ? unblockWhatsappUser : blockWhatsappUser;
    const res = await fn({ to: phone }).catch((e) => ({ ok: false, error: e?.message }));
    setBusy(false);
    setOpen(false);
    if (!res?.ok) { onError(res?.error || 'No se pudo completar la acción.'); return; }
    setBlocked((b) => !b);
  }
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="p-1.5 rounded text-ink-400 hover:text-ink-700 hover:bg-ink-50 transition-colors"
        aria-label="Más acciones"
        aria-expanded={open}
      >
        <MoreVertical size={16} />
      </button>
      {open && (
        <>
          <button type="button" className="fixed inset-0 z-10 cursor-default" onClick={() => setOpen(false)} aria-label="Cerrar menú" tabIndex={-1} />
          <div className="absolute right-0 top-full mt-1 z-20 w-48 rounded-xl bg-surface border border-ink-100 shadow-lg overflow-hidden py-1">
            <button
              type="button"
              onClick={toggle}
              disabled={busy}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-left text-red-600 hover:bg-red-50 active:bg-red-100 disabled:opacity-50 transition-colors"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />}
              {blocked ? 'Desbloquear contacto' : 'Bloquear contacto'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Bubble({ m, prev, onReply, onReact, onSaveCard, onCreateOrder = null, quoteChip = null }) {
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
  const order = resolveOrderMessage(m);
  const loc = m.payload?.location;
  // Reply/react address the message by wamid — without one (an optimistic
  // draft, a failed send) there is nothing to act on.
  const canAct = !!m.waId && !!(onReply || onReact);
  return (
    <>
      {showDay && (
        <div className="text-center py-1.5">
          <span className="text-[10px] font-medium text-ink-400 bg-surface border border-ink-100 rounded-full px-2.5 py-0.5">{day}</span>
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
                : 'bg-surface border border-ink-100 text-ink-900'
            }`
        }`}>
          {referral && (
            <div className="flex items-center gap-1 text-[10px] font-semibold text-violet-700 bg-violet-50 rounded-md px-1.5 py-0.5 mb-1 max-w-full">
              <Megaphone size={10} className="shrink-0" />
              <span className="truncate">Vino de un anuncio{referral.headline ? ` · ${referral.headline}` : ''}</span>
            </div>
          )}
          {/* Which deal this message was about — deep-links into the quote. */}
          {quoteChip && (
            <Link
              to={`/quotes/${quoteChip.id}`}
              className={`flex items-center gap-1 text-[10px] font-semibold rounded-md px-1.5 py-0.5 mb-1 max-w-full transition-colors ${
                out ? 'text-brand-800 bg-white/60 hover:bg-white dark:bg-white/10 dark:hover:bg-white/20' : 'text-brand-700 bg-brand-50 hover:bg-brand-100'
              }`}
              title="Abrir la cotización"
            >
              <FileText size={10} className="shrink-0" />
              <span className="truncate">Cotización{quoteChip.number != null ? ` #${quoteChip.number}` : ''}</span>
            </Link>
          )}
          {m.templateName && (
            <div className="text-[10px] font-semibold uppercase tracking-wide opacity-60 mb-0.5">Plantilla · {m.templateName}</div>
          )}
          {m.quoted && (
            <div className="border-l-2 border-emerald-500/60 bg-black/5 dark:bg-white/[0.06] rounded-r-md pl-2 pr-2.5 py-1 mb-1">
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
                <span key={`${id}-${i}`} className="rounded-full bg-surface/70 border border-ink-200 px-2 py-0.5 text-[11px] text-ink-700 max-w-[180px] truncate">
                  {m.payload.products.names?.[i] || id}
                </span>
              ))}
            </div>
          )}
          {/* A cart the client built from our catalog cards and sent back —
              the bridge from a WhatsApp Commerce browse to a quote. */}
          {order && (
            <div className="mt-1 rounded-lg bg-white/70 dark:bg-white/[0.06] border border-ink-200 overflow-hidden">
              <div className="px-2.5 py-1.5 flex items-center gap-1.5 border-b border-ink-100 bg-emerald-50/70">
                <ShoppingBag size={12} className="text-emerald-700 shrink-0" aria-hidden />
                <span className="text-[11px] font-semibold text-emerald-800">Pedido del catálogo · {order.items.length} producto(s)</span>
              </div>
              <div className="divide-y divide-ink-50">
                {order.items.map((it, i) => (
                  <div key={`${it.retailerId}-${i}`} className="px-2.5 py-1 flex items-center justify-between gap-2 text-[11px]">
                    <span className="font-mono text-ink-600 truncate">{it.retailerId}</span>
                    <span className="text-ink-500 tabular-nums shrink-0">
                      {it.quantity}{it.price > 0 ? ` × ${it.currency} ${it.price.toLocaleString('en-US')}` : ' u.'}
                    </span>
                  </div>
                ))}
              </div>
              {order.total > 0 && (
                <div className="px-2.5 py-1.5 flex items-center justify-between border-t border-ink-100 text-xs font-semibold text-ink-800">
                  <span>Total</span>
                  <span className="tabular-nums">{order.currency} {order.total.toLocaleString('en-US')}</span>
                </div>
              )}
              {order.text && <div className="px-2.5 py-1.5 text-[11px] text-ink-600 border-t border-ink-100 whitespace-pre-wrap">{order.text}</div>}
              {/* Turn the cart into a quote draft — seeds the new quote's lines
                  with these references + quantities and pre-fills the customer. */}
              {onCreateOrder && (
                <button
                  type="button"
                  onClick={() => onCreateOrder(order)}
                  className="w-full px-2.5 py-2 flex items-center justify-center gap-1.5 border-t border-ink-100 text-xs font-semibold text-brand-700 hover:bg-brand-50 active:bg-brand-100 transition-colors"
                >
                  <FileText size={12} /> Crear cotización
                </button>
              )}
            </div>
          )}
          {m.body && !isDocChip && !card && !order
            ? m.body
            : !m.mediaPath && !m.body && !card && !order && <span className="opacity-60 italic">({m.kind || 'mensaje'})</span>}
          {/* Quick-reply buttons WE sent — non-clickable chips showing what the client saw. */}
          {m.payload?.interactive?.buttons?.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {m.payload.interactive.buttons.map((b, i) => (
                <span key={i} className="rounded-full bg-surface/70 border border-ink-200 px-2.5 py-0.5 text-xs text-ink-700">{b}</span>
              ))}
            </div>
          )}
          {/* List menu WE sent — the menu label + its options, as the client saw them. */}
          {m.payload?.interactive?.rows?.length > 0 && (
            <div className="mt-1.5 rounded-lg bg-surface/70 border border-ink-200 overflow-hidden">
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
              className="mt-1.5 flex items-center justify-center gap-1.5 rounded-full bg-surface/70 border border-ink-200 px-2.5 py-1 text-xs font-medium text-sky-700 hover:bg-surface transition-colors"
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
              className="mt-1.5 flex items-center gap-1.5 rounded-lg bg-surface/70 border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-sky-700 hover:bg-surface transition-colors"
            >
              <MapPin size={13} className="shrink-0" />
              <span className="min-w-0 truncate">Ver en el mapa</span>
            </a>
          )}
          {/* Contact card (either direction) — who was shared. Inbound cards
              offer one-tap save into the CRM. */}
          {card && (
            <div className="mt-1.5 flex items-center gap-2 rounded-lg bg-surface/70 border border-ink-200 px-2.5 py-1.5">
              <ContactRound size={15} className="text-ink-400 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-ink-800 truncate">{card.name}</div>
                {card.phone && <div className="text-[11px] text-ink-500">{card.phone}</div>}
              </div>
              {!out && onSaveCard && card.phone && (
                <button
                  type="button"
                  onClick={() => onSaveCard({ name: card.name, phone: card.phone })}
                  className="shrink-0 inline-flex items-center gap-1 rounded-full border border-ink-200 bg-surface px-2 py-1 text-[11px] font-medium text-brand-700 hover:bg-brand-50 transition-colors"
                  title="Guardar en el CRM"
                >
                  <UserPlus size={11} /> Guardar
                </button>
              )}
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
              <span className="inline-flex items-center rounded-full bg-surface border border-ink-100 shadow-xs px-1.5 py-0.5 text-sm leading-none">
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
        <div className="flex items-center gap-0.5 rounded-full bg-surface border border-ink-100 shadow-sm px-1.5 py-1">
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
              className="p-1.5 rounded-full text-ink-400 hover:text-brand-700 hover:bg-surface transition-colors"
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
              className="p-1.5 rounded-full text-ink-400 hover:text-brand-700 hover:bg-surface transition-colors"
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
      className="flex items-center gap-2 rounded-lg bg-black/5 dark:bg-white/[0.06] px-2.5 py-2 mb-1 hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
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
