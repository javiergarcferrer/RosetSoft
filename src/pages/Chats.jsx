import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { MessageCircle, Loader2, Search, Plus, Megaphone } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Modal from '../components/Modal.jsx';
import ChatThread, { StatusTicks, initials, timeLabel } from '../components/whatsapp/ChatThread.jsx';
import { useApp } from '../context/AppContext.jsx';
import { db, invalidate } from '../db/database.js';
import { useLiveQueryStatus } from '../db/hooks.js';
import {
  resolveConversations, resolveThread, resolveNewChatContacts, resolveChatTarget,
} from '../core/crm/index.js';
import { displayPhone, phoneKey } from '../lib/phone.js';
import {
  sendWhatsappText, sendWhatsappTemplate, sendWhatsappMedia, sendWhatsappReadReceipt,
  sendWhatsappReaction, sendWhatsappInteractive, sendWhatsappLocation, sendWhatsappContact,
  sendWhatsappProducts, saveChatContact, markThreadRead, draftOutboundMessage,
} from '../lib/whatsapp.js';

/**
 * WhatsApp — the CRM inbox. Conversation list + thread, split-pane on
 * desktop, list↔thread navigation on a phone. All derivation lives in
 * core/crm (resolveConversations / resolveThread); this View fetches, holds
 * UI state (selection, search, composer) and renders. The thread pane itself
 * (bubbles + composer + template picker) is the shared ChatThread component,
 * also embedded in the quote editor.
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
  const { data: customers, loaded: customersLoaded } = useLiveQueryStatus(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const { data: professionals, loaded: professionalsLoaded } = useLiveQueryStatus(
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

  // Deep link: /chats?chat=<phone> (the CRM pages' WhatsApp quick action)
  // opens that conversation — or a draft thread when the contact has never
  // chatted, exactly like picking them in "Nuevo chat". Applied once per
  // param value, only after all three datasets are in (an early run over
  // empty arrays would consume the param and select nothing).
  const [searchParams] = useSearchParams();
  const chatParam = searchParams.get('chat');
  const appliedChatParam = useRef(null);
  useEffect(() => {
    if (!chatParam || !loaded || !customersLoaded || !professionalsLoaded) return;
    if (appliedChatParam.current === chatParam) return;
    appliedChatParam.current = chatParam;
    const hit = resolveChatTarget(customers, professionals, conversations, chatParam);
    if (!hit) return;
    setDraftTarget(hit.existing ? null : hit.target);
    setSelectedKey(hit.key);
  }, [chatParam, loaded, customersLoaded, professionalsLoaded, customers, professionals, conversations]);

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
            <ChatThread
              contact={selected}
              thread={thread}
              connected={connected}
              onBack={() => setSelectedKey(null)}
              onSend={async (text, replyTo) => {
                const draft = draftOutboundMessage({
                  phone: selected.phone, text,
                  customerId: selected.customerId, professionalId: selected.professionalId,
                  profileId,
                });
                setPending((rows) => [...rows, draft]);
                const res = await sendWhatsappText({
                  to: selected.phone, text, replyTo,
                  customerId: selected.customerId, professionalId: selected.professionalId,
                }).catch((e) => ({ ok: false, error: e?.message }));
                invalidate();
                return res;
              }}
              onSendMedia={async (file, caption, replyTo) => {
                const res = await sendWhatsappMedia({
                  to: selected.phone, file, caption, replyTo,
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
              onReact={async (m, emoji) => {
                const res = await sendWhatsappReaction({
                  to: selected.phone, messageId: m.waId, emoji,
                  customerId: selected.customerId, professionalId: selected.professionalId,
                }).catch((e) => ({ ok: false, error: e?.message }));
                invalidate();
                return res;
              }}
              onSendInteractive={async (spec) => {
                const res = await sendWhatsappInteractive({
                  to: selected.phone, ...spec,
                  customerId: selected.customerId, professionalId: selected.professionalId,
                }).catch((e) => ({ ok: false, error: e?.message }));
                invalidate();
                return res;
              }}
              onSendLocation={async (spec) => {
                const res = await sendWhatsappLocation({
                  to: selected.phone, ...spec,
                  customerId: selected.customerId, professionalId: selected.professionalId,
                }).catch((e) => ({ ok: false, error: e?.message }));
                invalidate();
                return res;
              }}
              onSendContact={async (spec) => {
                const res = await sendWhatsappContact({
                  to: selected.phone, ...spec,
                  customerId: selected.customerId, professionalId: selected.professionalId,
                }).catch((e) => ({ ok: false, error: e?.message }));
                invalidate();
                return res;
              }}
              onSendProducts={async ({ items, names, text }) => {
                const res = await sendWhatsappProducts({
                  to: selected.phone, items, names, text,
                  customerId: selected.customerId, professionalId: selected.professionalId,
                }).catch((e) => ({ ok: false, error: e?.message }));
                invalidate();
                return res;
              }}
              onSaveContact={async (spec) => {
                const res = await saveChatContact({ ...spec, profileId })
                  .catch((e) => ({ ok: false, error: e?.message }));
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
