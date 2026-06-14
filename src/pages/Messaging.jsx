// Messaging — the Instagram Direct + Facebook Messenger DM inbox. A focused
// read+reply surface: a conversation list on the left, the selected thread on
// the right, and a composer that NEVER auto-sends (the dealer types and presses
// send — human-in-the-loop, the same rule the WhatsApp inbox follows). Tokens
// never reach the browser: every read/send goes through the meta-social Edge
// Function (lib/metaDm helpers), projected by the core/jarvis messaging VMs.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Instagram, Facebook, RefreshCw, Send, Loader2, AlertTriangle, ArrowLeft, MessageCircle, Clock,
} from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import { readMetaDms, readMetaDmThread, sendMetaDm } from '../lib/metaDm.js';
import { resolveDmConversations, resolveDmThread } from '../core/jarvis/index.js';

function PlatformBadge({ platform }) {
  const ig = platform === 'instagram';
  return (
    <span
      className={`inline-flex h-5 w-5 items-center justify-center rounded-full ${ig ? 'bg-pink-100 text-pink-600' : 'bg-sky-100 text-sky-600'}`}
      title={ig ? 'Instagram' : 'Facebook Messenger'}
    >
      {ig ? <Instagram size={12} /> : <Facebook size={12} />}
    </span>
  );
}

function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('') || '?';
}

// ── Conversation list ────────────────────────────────────────────────────
function ConversationList({ conversations, activeId, onSelect }) {
  if (!conversations.length) {
    return (
      <div className="p-6 text-center text-sm text-ink-400">
        <MessageCircle size={28} className="mx-auto mb-2 opacity-40" />
        Sin conversaciones todavía.
      </div>
    );
  }
  return (
    <div className="divide-y divide-ink-100">
      {conversations.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onSelect(c)}
          className={`flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-ink-50 ${activeId === c.id ? 'bg-brand-50' : ''}`}
        >
          <span className="relative shrink-0">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-brand-800 text-[11px] font-semibold">
              {initials(c.participantName)}
            </span>
            <span className="absolute -bottom-1 -right-1"><PlatformBadge platform={c.platform} /></span>
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-display text-sm font-semibold text-ink-900">{c.participantName}</span>
              {c.ago && <span className="ml-auto shrink-0 text-[10px] text-ink-400">{c.ago}</span>}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="truncate text-xs text-ink-500">
                {c.lastDirection === 'out' ? 'Tú: ' : ''}{c.lastText}
              </span>
              {c.unread > 0 && (
                <span className="ml-auto inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] font-semibold text-white tabular-nums">
                  {c.unread}
                </span>
              )}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

// ── Thread view + composer ─────────────────────────────────────────────────
function Thread({ conversation, onBack }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef(null);

  const load = useCallback(async () => {
    if (!conversation) return;
    setLoading(true);
    setError(null);
    const res = await readMetaDmThread({ conversationId: conversation.id, platform: conversation.platform });
    setLoading(false);
    if (!res?.ok) { setError(res?.error || 'No se pudieron cargar los mensajes.'); return; }
    setMessages(res.messages || []);
  }, [conversation]);

  useEffect(() => { setMessages([]); setText(''); setError(null); load(); }, [load]);

  const thread = useMemo(
    () => resolveDmThread(messages, { participantId: conversation?.participantId }),
    [messages, conversation],
  );

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.items]);

  // HUMAN-TRIGGERED send only — explicit button / Enter, never automatic.
  async function submit() {
    const body = text.trim();
    if (!body || sending || !conversation?.participantId) return;
    setSending(true);
    setError(null);
    const res = await sendMetaDm({
      conversationId: conversation.id,
      recipientId: conversation.participantId,
      text: body,
      platform: conversation.platform,
    });
    setSending(false);
    if (!res?.ok) { setError(res?.error || 'No se pudo enviar el mensaje.'); return; }
    setText('');
    // Reflect the sent message immediately, then refresh from the source.
    setMessages((prev) => [...prev, {
      id: res.messageId || `local-${Date.now()}`,
      message: body,
      from: { id: 'self' },
      created_time: new Date().toISOString(),
    }]);
    load();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-ink-100 bg-surface px-4 py-3">
        {onBack && (
          <button type="button" onClick={onBack} className="-ml-1 p-1.5 rounded text-ink-500 hover:bg-ink-50 md:hidden" aria-label="Volver a la lista">
            <ArrowLeft size={16} />
          </button>
        )}
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-800 text-[11px] font-semibold">
          {initials(conversation.participantName)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-sm font-semibold text-ink-900">{conversation.participantName}</div>
          <div className="flex items-center gap-1 text-[11px] text-ink-400">
            <PlatformBadge platform={conversation.platform} />
            {conversation.platform === 'instagram' ? 'Instagram Direct' : 'Facebook Messenger'}
          </div>
        </div>
        <button type="button" onClick={load} disabled={loading} className="btn-ghost text-xs inline-flex items-center gap-1.5 shrink-0" title="Actualizar">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Actualizar
        </button>
      </div>

      {/* Messages */}
      <div ref={listRef} className="flex-1 overflow-y-auto bg-ink-50/40 px-4 py-4">
        {loading && !thread.items.length ? (
          <div className="flex items-center justify-center py-10 text-ink-400"><Loader2 size={20} className="animate-spin" /></div>
        ) : (
          <div className="flex min-h-full flex-col justify-end gap-1.5">
            {thread.items.map((m) => (
              <div key={m.id} className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[78%] rounded-2xl px-3 py-2 text-sm ${
                  m.direction === 'out' ? 'bg-brand-600 text-white rounded-br-sm' : 'bg-surface border border-ink-100 text-ink-900 rounded-bl-sm'
                }`}>
                  {m.mediaUrl && (
                    <a href={m.mediaUrl} target="_blank" rel="noreferrer" className="mb-1 block">
                      <img src={m.mediaUrl} alt="Adjunto" className="max-h-48 rounded-lg object-cover" />
                    </a>
                  )}
                  {m.text && <div className="whitespace-pre-wrap break-words">{m.text}</div>}
                  <div className={`mt-0.5 text-[10px] ${m.direction === 'out' ? 'text-white/70' : 'text-ink-400'}`}>{m.ago}</div>
                </div>
              </div>
            ))}
            {!thread.items.length && !loading && (
              <p className="py-8 text-center text-xs text-ink-400">Sin mensajes en esta conversación.</p>
            )}
          </div>
        )}
      </div>

      {/* 24h-window note + error */}
      <div className="border-t border-amber-100 bg-amber-50 px-4 py-1.5 text-[11px] text-amber-800 flex items-center gap-1.5 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-900/40">
        <Clock size={12} className="shrink-0" />
        Solo puedes responder dentro de la ventana de 24 h desde el último mensaje del cliente.
      </div>
      {error && (
        <div className="border-t border-red-100 bg-red-50 px-4 py-2 text-[11px] text-red-700 flex items-start gap-1.5 dark:bg-red-950/40 dark:text-red-200 dark:border-red-900/40">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      {/* Composer — never auto-sends. */}
      <div className="border-t border-ink-100 bg-surface px-3 py-3">
        <div className="flex items-end gap-1.5">
          <textarea
            className="input min-h-[42px] max-h-32 flex-1 resize-none text-sm"
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing && !coarse) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Escribe una respuesta…"
            aria-label="Mensaje"
          />
          <button
            type="button"
            onClick={submit}
            disabled={sending || !text.trim()}
            className="btn-primary !px-3 min-h-[42px] shrink-0 disabled:opacity-40"
            title="Enviar"
            aria-label="Enviar mensaje"
          >
            {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Messaging() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [active, setActive] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await readMetaDms({ limit: 40 });
    setLoading(false);
    if (!res?.ok && res?.configured === false) { setError('Conecta Meta en Configuración para usar el inbox.'); return; }
    if (!res?.ok && res?.error) { setError(res.error); return; }
    setRows(res?.conversations || []);
    // Surface partial errors (one platform may fail while the other answers).
    const errs = res?.errors && Object.values(res.errors).filter(Boolean);
    if (errs && errs.length && !(res?.conversations || []).length) setError(errs.join(' · '));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const conversations = useMemo(() => resolveDmConversations(rows), [rows]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Mensajes"
        subtitle="Instagram Direct y Facebook Messenger — responde sin salir de ALCOVER."
        actions={(
          <button type="button" onClick={refresh} disabled={loading} className="btn-secondary text-sm inline-flex items-center gap-1.5">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Actualizar
          </button>
        )}
      />

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-900/40">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      <div className="grid min-h-0 flex-1 overflow-hidden rounded-xl border border-ink-100 bg-surface md:grid-cols-[20rem_1fr]">
        {/* List — full width on phones until a thread is open. */}
        <div className={`min-h-0 overflow-y-auto border-ink-100 md:border-r ${active ? 'hidden md:block' : 'block'}`}>
          {loading && !conversations.length ? (
            <div className="flex items-center justify-center py-10 text-ink-400"><Loader2 size={20} className="animate-spin" /></div>
          ) : (
            <ConversationList conversations={conversations} activeId={active?.id} onSelect={setActive} />
          )}
        </div>

        {/* Thread */}
        <div className={`min-h-0 ${active ? 'block' : 'hidden md:block'}`}>
          {active ? (
            <Thread conversation={active} onBack={() => setActive(null)} />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-ink-400">
              <div>
                <MessageCircle size={32} className="mx-auto mb-3 opacity-40" />
                Selecciona una conversación para verla aquí.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
