import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  MessageCircle, Send, ArrowLeft, Loader2, Search, Plus, Check, CheckCheck,
  AlertTriangle, Clock, UserSquare2, Users,
} from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Modal from '../components/Modal.jsx';
import { useApp } from '../context/AppContext.jsx';
import { db, invalidate } from '../db/database.js';
import { useLiveQueryStatus } from '../db/hooks.js';
import { resolveConversations, resolveThread, resolveNewChatContacts } from '../core/crm/index.js';
import { displayPhone, phoneKey } from '../lib/phone.js';
import { sendWhatsappText, markThreadRead, draftOutboundMessage } from '../lib/whatsapp.js';

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

  // Opening a thread clears its unread badge.
  useEffect(() => {
    if (!selectedKey) return;
    const unread = messages.filter((m) => phoneKey(m.phone) === selectedKey && m.direction === 'in' && !m.readAt);
    if (unread.length) markThreadRead(unread).catch(() => {});
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
          <button type="button" onClick={() => setPickerOpen(true)} className="btn-primary text-sm inline-flex items-center gap-1.5">
            <Plus size={15} /> Nuevo chat
          </button>
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

function Thread({ contact, thread, connected, onBack, onSend }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
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
      <div className="flex items-end gap-2 px-3 py-3 border-t border-ink-100 bg-white">
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
    </>
  );
}

function Bubble({ m, prev }) {
  const out = m.direction === 'out';
  const day = dayLabel(m.createdAt);
  const showDay = !prev || dayLabel(prev.createdAt) !== day;
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
          {m.templateName && (
            <div className="text-[10px] font-semibold uppercase tracking-wide opacity-60 mb-0.5">Plantilla · {m.templateName}</div>
          )}
          {m.body || <span className="opacity-60 italic">({m.kind || 'mensaje'})</span>}
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
