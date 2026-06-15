import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Instagram, Send, Search, Loader2, RefreshCw, MessageCircle, ArrowLeft } from 'lucide-react';
import PageHeader from '../PageHeader.jsx';
import EmptyState from '../EmptyState.jsx';
import { initials, timeLabel } from '../whatsapp/ChatThread.jsx';
import { useApp } from '../../context/AppContext.jsx';
import { db, invalidate } from '../../db/database.js';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { resolveIgConversations, resolveIgThread } from '../../core/crm/index.js';
import { sendInstagramDm, backfillInstagramDms, markIgThreadRead } from '../../lib/instagramDm.js';

const POLL_MS = 10000;

/**
 * Instagram Direct — the CRM inbox's second channel (beside the WhatsApp inbox
 * in Chats.jsx). Self-contained: reads ig_messages, projects threads via
 * core/crm (resolveIgConversations / resolveIgThread), sends through the
 * meta-social Edge Function (igSendDm). Inbound arrives server-side via the
 * meta-webhook, so the view polls a refetch while open — near-live without a
 * socket, same as WhatsApp. `onBack` switches the channel toggle to WhatsApp.
 */
export default function InstagramInbox({ onBack }) {
  const { profileId, settings } = useApp();
  const linked = !!settings?.metaSocialConnectedAt;

  const { data: messages, loaded } = useLiveQueryStatus(
    () => db.igMessages.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );

  const [selectedKey, setSelectedKey] = useState(null);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState(null);

  // Poll for inbound the webhook wrote since last fetch (the inbox is near-live).
  useEffect(() => {
    const id = setInterval(() => invalidate(), POLL_MS);
    return () => clearInterval(id);
  }, []);

  const conversations = useMemo(
    () => resolveIgConversations(messages, { needle: search }),
    [messages, search],
  );
  const thread = useMemo(
    () => resolveIgThread(messages, { threadKey: selectedKey }),
    [messages, selectedKey],
  );
  const active = useMemo(
    () => conversations.find((c) => c.key === selectedKey) || null,
    [conversations, selectedKey],
  );

  // Opening a thread clears its unread badge (local read state).
  useEffect(() => {
    if (selectedKey && thread.items.length) markIgThreadRead(thread.items).catch(() => {});
  }, [selectedKey, thread.items]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || !selectedKey || sending) return;
    setSending(true);
    setSendErr(null);
    const r = await sendInstagramDm(selectedKey, text);
    if (r.ok) {
      setDraft('');
      invalidate();
    } else {
      setSendErr(r.error || 'No se pudo enviar');
    }
    setSending(false);
  }, [draft, selectedKey, sending]);

  const sync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncNote(null);
    const r = await backfillInstagramDms();
    setSyncNote(r.ok ? `Sincronizados ${r.count} mensajes` : (r.error || 'No se pudo sincronizar'));
    if (r.ok) invalidate();
    setSyncing(false);
  }, [syncing]);

  const channelToggle = (
    <button type="button" onClick={onBack} className="btn-secondary text-sm inline-flex items-center gap-1.5" title="Cambiar a WhatsApp">
      <MessageCircle size={15} /> WhatsApp
    </button>
  );

  if (!linked) {
    return (
      <>
        <PageHeader title="Instagram Directo" subtitle="Mensajes directos de Instagram" actions={channelToggle} />
        <EmptyState
          icon={Instagram}
          title="Instagram no está conectado"
          description="Conecta tu cuenta de Instagram en Marketing para recibir y responder mensajes directos desde aquí."
          action={<Link to="/marketing" className="btn-primary text-sm">Ir a Marketing</Link>}
        />
      </>
    );
  }

  return (
    <div className="flex flex-col kb-inbox-pane max-md:h-[calc(var(--rs-vvh,100dvh)-55px-env(safe-area-inset-top)-env(safe-area-inset-bottom))] max-md:-mt-4 max-md:-mb-[calc(1.5rem+env(safe-area-inset-bottom))]">
      <div className={selectedKey ? 'hidden md:block' : undefined}>
        <PageHeader
          title="Instagram Directo"
          subtitle={settings?.metaSocialIgUsername ? `@${settings.metaSocialIgUsername}` : 'Mensajes directos de Instagram'}
          actions={
            <div className="flex items-center gap-2">
              <button type="button" onClick={sync} disabled={syncing} className="btn-secondary text-sm inline-flex items-center gap-1.5">
                {syncing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Sincronizar
              </button>
              {channelToggle}
            </div>
          }
        />
        {syncNote && <div className="px-1 pb-2 text-xs text-ink-400">{syncNote}</div>}
      </div>

      <div className="flex-1 min-h-0 md:grid md:grid-cols-[clamp(280px,32%,360px)_1fr] md:gap-4 md:overflow-hidden">
        {/* Conversation list */}
        <div className={`flex flex-col min-h-0 ${selectedKey ? 'hidden md:flex' : 'flex'}`}>
          <div className="relative mb-2">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por @usuario o nombre"
              className="input w-full pl-9 text-sm"
            />
          </div>
          <div className="flex-1 overflow-y-auto -mx-1 px-1">
            {!loaded ? (
              <div className="flex items-center justify-center py-10 text-ink-400"><Loader2 className="animate-spin" /></div>
            ) : conversations.length === 0 ? (
              <div className="py-10 text-center text-sm text-ink-400">
                Sin conversaciones todavía. Pulsa «Sincronizar» para traer el historial reciente.
              </div>
            ) : conversations.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setSelectedKey(c.key)}
                className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors ${c.key === selectedKey ? 'bg-brand-50' : 'hover:bg-ink-50'}`}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-800 text-[11px] font-semibold">
                  {initials(c.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium text-ink-900">{c.name}</span>
                    <span className="shrink-0 text-[10px] tabular-nums text-ink-400">{timeLabel(c.lastAt)}</span>
                  </span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="truncate text-xs text-ink-400">
                      {c.lastDirection === 'out' ? 'Tú: ' : ''}{c.lastBody}
                    </span>
                    {c.unread > 0 && (
                      <span className="ml-auto inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] font-semibold text-white">{c.unread}</span>
                    )}
                    {c.unread === 0 && c.awaitingReply && (
                      <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-amber-500" title="Sin responder" />
                    )}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Thread */}
        <div className={`flex flex-col min-h-0 rounded-2xl border border-ink-100 bg-surface ${selectedKey ? 'flex' : 'hidden md:flex'}`}>
          {!selectedKey ? (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-ink-400">
              Elige una conversación para ver los mensajes.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-ink-100 px-3 py-2.5">
                <button type="button" onClick={() => setSelectedKey(null)} className="md:hidden -ml-1 p-1 text-ink-500"><ArrowLeft size={18} /></button>
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-brand-800 text-[11px] font-semibold">{initials(active?.name || '')}</span>
                <span className="truncate text-sm font-semibold text-ink-900">{active?.name || 'Instagram'}</span>
              </div>

              <ThreadMessages items={thread.items} />

              <div className="border-t border-ink-100 p-2.5">
                {sendErr && <div className="mb-1.5 text-xs text-red-600">{sendErr}</div>}
                {thread.windowOpen ? (
                  <div className="flex items-end gap-2">
                    <textarea
                      rows={1}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                      placeholder="Escribe un mensaje…"
                      className="input flex-1 resize-none text-sm"
                    />
                    <button type="button" onClick={send} disabled={sending || !draft.trim()} className="btn-primary inline-flex h-9 w-9 items-center justify-center p-0">
                      {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                    </button>
                  </div>
                ) : (
                  <div className="rounded-lg bg-ink-50 px-3 py-2 text-center text-xs text-ink-400">
                    Fuera de la ventana de 24 horas. Instagram solo entrega respuestas libres dentro de las 24h desde el último mensaje del contacto.
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** The message bubbles, oldest-first, auto-scrolled to the newest. */
function ThreadMessages({ items }) {
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [items.length]);
  return (
    <div className="flex-1 space-y-1.5 overflow-y-auto p-3">
      {items.map((m) => {
        const out = m.direction === 'out';
        return (
          <div key={m.id} className={`flex ${out ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[78%] rounded-2xl px-3 py-1.5 text-sm ${out ? 'bg-brand-600 text-white' : 'bg-ink-100 text-ink-900'}`}>
              <span className="whitespace-pre-wrap break-words">{m.body || '—'}</span>
              <span className={`mt-0.5 block text-right text-[10px] ${out ? 'text-white/70' : 'text-ink-400'}`}>
                {timeLabel(m.createdAt)}{out && m.status === 'failed' ? ' · falló' : ''}
              </span>
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
