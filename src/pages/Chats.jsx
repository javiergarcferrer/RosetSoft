import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useGoBack } from '../context/NavMemory.jsx';
import { MessageCircle, Loader2, Search, Plus, Megaphone, Users, Instagram } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Modal from '../components/Modal.jsx';
import ChatThread, { StatusTicks, initials, timeLabel } from '../components/whatsapp/ChatThread.jsx';
import GroupsPanel from '../components/whatsapp/GroupsPanel.jsx';
import InstagramInbox from '../components/instagram/InstagramInbox.jsx';
import { useApp } from '../context/AppContext.jsx';
import { db, invalidate } from '../db/database.js';
import { useLiveQueryStatus } from '../db/hooks.js';
import {
  resolveConversations, resolveThread, resolveNewChatContacts, resolveChatTarget, buildOrderRefsParam,
} from '../core/crm/index.js';
import { displayPhone, phoneKey, isGroupKey, groupIdFromKey } from '../lib/phone.js';
import {
  sendWhatsappText, sendWhatsappTemplate, sendWhatsappMedia, sendWhatsappReadReceipt,
  sendWhatsappReaction, sendWhatsappInteractive, sendWhatsappLocation, sendWhatsappContact,
  sendWhatsappProducts, sendWhatsappCatalog, saveChatContact, markThreadRead, draftOutboundMessage,
  suggestWhatsappReply, saveConversationState,
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

// Does a server-logged outbound row reconcile this optimistic draft? wa-send
// doesn't yet echo a client id (the exact fix — see the report), so we pair on
// target + body + a near-coincident timestamp. The window is widened to ±10s
// and made SYMMETRIC: a server row can be stamped slightly BEFORE the local
// optimistic createdAt (clock skew between the device and Supabase), which the
// old `>= createdAt - 1000` one-sided check would miss, stranding the bubble on
// "Enviando" forever. Still conservative enough that a genuinely different
// later message with the same text isn't swallowed.
const OPTIMISTIC_MATCH_MS = 10000;
function optimisticMatch(p, messages) {
  return (messages || []).some((m) =>
    m.direction === 'out'
    && (p.groupId ? m.groupId === p.groupId : (!m.groupId && phoneKey(m.phone) === phoneKey(p.phone)))
    && (m.body || '') === (p.body || '')
    && Math.abs((m.createdAt || 0) - p.createdAt) <= OPTIMISTIC_MATCH_MS);
}

export default function Chats() {
  const { profileId, settings } = useApp();
  const navigate = useNavigate();
  const goBack = useGoBack();
  // How the open thread was reached, so Back knows where to send you:
  // 'deeplink' = arrived from another page (a contact's WhatsApp quick action),
  // so Back returns there; 'list' = picked from the inbox here, so Back just
  // closes the thread back to the list. Defaults to 'list' for direct opens.
  const selectionOrigin = useRef('list');
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
  // Per-conversation CRM state (labels / note / snooze), keyed by phoneKey.
  const { data: convStates } = useLiveQueryStatus(
    () => db.waConversationState.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  // WhatsApp groups + their rosters — group threads sit in the same inbox as
  // 1:1 chats (resolveConversations buckets a message with a groupId into its
  // group thread); the Grupos panel manages them.
  const { data: waGroups } = useLiveQueryStatus(
    () => db.waGroups.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const { data: waGroupParticipants } = useLiveQueryStatus(
    () => db.waGroupParticipants.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [groupsFocus, setGroupsFocus] = useState(null);
  const stateByKey = useMemo(() => {
    const m = new Map();
    for (const s of convStates) m.set(s.phoneKey, s);
    return m;
  }, [convStates]);
  const allLabels = useMemo(() => {
    const set = new Set();
    for (const s of convStates) for (const l of (s.labels || [])) set.add(l);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [convStates]);

  // Near-live: refetch on an interval while the inbox is open — but only while
  // the tab is actually visible. A backgrounded tab keeps no socket and the
  // user sees nothing, so polling it just burns the device/Supabase for
  // nothing; pause it and resume (with an immediate refetch) on focus.
  useEffect(() => {
    let id = null;
    const start = () => {
      if (id == null) id = setInterval(() => invalidate(), POLL_MS);
    };
    const stop = () => {
      if (id != null) { clearInterval(id); id = null; }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') { invalidate(); start(); }
      else stop();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { document.removeEventListener('visibilitychange', onVisibility); stop(); };
  }, []);

  const [needle, setNeedle] = useState('');
  const [selectedKey, setSelectedKey] = useState(null);
  // A "new chat" target has no messages yet, so it isn't in conversations —
  // carry its contact info until the first send materializes the thread.
  const [draftTarget, setDraftTarget] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Inbox status filter — 'all' | 'unread' | 'awaiting'. "Sin responder"
  // (awaiting) is the sales-critical one: a client wrote last and we haven't
  // answered, even if the thread was already opened (so `unread` cleared).
  const [filter, setFilter] = useState('all');
  // Optimistic outbound rows, dropped once the server-logged row arrives.
  const [pending, setPending] = useState([]);

  // The full needle-matched list — selection, deep-links and the Nuevo-chat
  // dedupe all read THIS (never the status-filtered view, so filtering the
  // list never closes an open thread or un-dedupes the picker).
  const allConversations = useMemo(
    () => resolveConversations(messages, customers, professionals, { needle, groups: waGroups }).map((c) => {
      const s = stateByKey.get(c.key) || null;
      return { ...c, state: s, labels: s?.labels || [], snoozeExpiresAt: s?.snoozeExpiresAt || null };
    }),
    [messages, customers, professionals, needle, stateByKey, waGroups],
  );
  // A snoozed conversation drops out of the active inbox until its expiry
  // passes (the 10s poll re-renders and it returns on its own).
  const isSnoozed = (c) => !!(c.snoozeExpiresAt && c.snoozeExpiresAt > Date.now());
  const filterCounts = useMemo(() => ({
    all: allConversations.reduce((n, c) => n + (isSnoozed(c) ? 0 : 1), 0),
    unread: allConversations.reduce((n, c) => n + (c.unread > 0 && !isSnoozed(c) ? 1 : 0), 0),
    awaiting: allConversations.reduce((n, c) => n + (c.awaitingReply && !isSnoozed(c) ? 1 : 0), 0),
    snoozed: allConversations.reduce((n, c) => n + (isSnoozed(c) ? 1 : 0), 0),
  }), [allConversations]); // eslint-disable-line react-hooks/exhaustive-deps
  const conversations = useMemo(() => {
    if (filter === 'snoozed') {
      return allConversations.filter(isSnoozed).sort((a, b) => (a.snoozeExpiresAt || 0) - (b.snoozeExpiresAt || 0));
    }
    const active = allConversations.filter((c) => !isSnoozed(c));
    if (filter === 'unread') return active.filter((c) => c.unread > 0);
    if (filter === 'awaiting') {
      // "Sin responder" is an SLA view, so order it longest-waiting-first
      // (oldest last activity on top) rather than most-recent — the client
      // who has waited the longest is the one to answer next.
      return active.filter((c) => c.awaitingReply).sort((a, b) => (a.lastAt || 0) - (b.lastAt || 0));
    }
    return active;
  }, [allConversations, filter]); // eslint-disable-line react-hooks/exhaustive-deps
  const selected = useMemo(() => {
    if (!selectedKey) return null;
    return allConversations.find((c) => c.key === selectedKey)
      || (draftTarget && draftTarget.key === selectedKey ? draftTarget : null);
  }, [allConversations, selectedKey, draftTarget]);
  // Where a send goes: a group thread by groupId (recipient_type 'group'),
  // otherwise the 1:1 phone. Spread into every send handler below.
  const sendTarget = selected ? (selected.groupId ? { groupId: selected.groupId } : { to: selected.phone }) : null;

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
    const hit = resolveChatTarget(customers, professionals, allConversations, chatParam);
    if (!hit) return;
    selectionOrigin.current = 'deeplink';
    setDraftTarget(hit.existing ? null : hit.target);
    setSelectedKey(hit.key);
  }, [chatParam, loaded, customersLoaded, professionalsLoaded, customers, professionals, allConversations]);

  // Server rows landed → drop the optimistic copies they replace. The match is
  // a heuristic (same target + same body, server row stamped at ~the same
  // moment) because wa-send doesn't yet echo back a client id we could pair
  // on exactly — see optimisticMatch for the widened, single-claim logic.
  useEffect(() => {
    if (!pending.length) return;
    setPending((rows) => rows.filter((p) => !optimisticMatch(p, messages)));
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Opening a thread clears its unread badge — locally AND on the customer's
  // side: the Cloud API read receipt turns their ticks blue (marking the
  // latest inbound also marks everything before it).
  const lastReceiptFor = useRef(null);
  useEffect(() => {
    if (!selectedKey) return;
    const gid = isGroupKey(selectedKey) ? groupIdFromKey(selectedKey) : null;
    const unread = messages.filter((m) =>
      (gid ? m.groupId === gid : (!m.groupId && phoneKey(m.phone) === selectedKey))
      && m.direction === 'in' && !m.readAt);
    if (!unread.length) return;
    markThreadRead(unread).catch(() => {});
    const latest = unread.reduce((a, b) => ((a.createdAt || 0) >= (b.createdAt || 0) ? a : b));
    if (latest.waId && lastReceiptFor.current !== latest.waId) {
      lastReceiptFor.current = latest.waId;
      sendWhatsappReadReceipt(latest.waId);
    }
  }, [selectedKey, messages]);

  const [channel, setChannel] = useState('whatsapp');
  const connected = !!settings?.whatsappConnectedAt;

  // The CRM inbox has two channels — WhatsApp (this file) and Instagram Direct.
  // Instagram renders its own self-contained surface (its own ig_messages data
  // + composer), so every WhatsApp path below stays untouched.
  if (channel === 'instagram') {
    return <InstagramInbox onBack={() => setChannel('whatsapp')} />;
  }

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
      {/* The WhatsApp screen is viewport-LOCKED on a phone: a flex column the
          exact height of the area under the topbar, so the page never
          shell-scrolls (which used to hide the Difusión / Nuevo chat buttons)
          and the composer never floats above a dead gap — only the list and
          the thread scroll, inside the pane. Negative margins cancel the
          shared content-wrapper padding; `kb-inbox-pane` lets the keyboard
          shrink the column. Desktop keeps the original flow via the md heights. */}
      <div className="flex flex-col kb-inbox-pane max-md:h-[calc(var(--rs-vvh,100dvh)-55px-env(safe-area-inset-top)-env(safe-area-inset-bottom))] max-md:-mt-4 max-md:-mb-[calc(1.5rem+env(safe-area-inset-bottom))]">
      {/* On a phone an OPEN thread takes the page over: the page header
          (Difusión, Nuevo chat — list-level actions) steps aside and
          ChatThread's own header carries Back; it returns with the list. */}
      <div className={selectedKey ? 'hidden md:block' : undefined}>
        <PageHeader
          title="WhatsApp"
          subtitle={settings?.whatsappDisplayNumber ? `Número del negocio · ${settings.whatsappDisplayNumber}` : 'Conversaciones con clientes y profesionales'}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setChannel('instagram')} className="btn-secondary text-sm inline-flex items-center gap-1.5" title="Mensajes directos de Instagram" aria-label="Instagram">
                <Instagram size={15} /> <span className="hidden sm:inline">Instagram</span>
              </button>
              <Link to="/chats/difusion" className="btn-secondary text-sm inline-flex items-center gap-1.5" title="Difusión" aria-label="Difusión">
                <Megaphone size={15} /> <span className="hidden sm:inline">Difusión</span>
              </Link>
              <button type="button" onClick={() => { setGroupsFocus(null); setGroupsOpen(true); }} className="btn-secondary text-sm inline-flex items-center gap-1.5" title="Grupos" aria-label="Grupos">
                <Users size={15} /> <span className="hidden sm:inline">Grupos</span>
              </button>
              <button type="button" onClick={() => setPickerOpen(true)} className="btn-primary text-sm inline-flex items-center gap-1.5 ml-auto sm:ml-0">
                <Plus size={15} /> Nuevo chat
              </button>
            </div>
          }
        />
      </div>

      {/* The pane fills the locked column on a phone (flex-1, its own inner
          scroll) so nothing below it can shell-scroll; desktop keeps the fixed
          split-pane height. Thread view bleeds to the screen edges. */}
      <div className={`card overflow-hidden flex max-md:flex-1 max-md:min-h-0 md:min-h-[420px] md:h-[calc(100dvh-230px)] ${
        selectedKey
          ? 'max-md:-mx-4 max-md:rounded-none max-md:border-x-0 max-md:border-t-0 max-md:border-b-0'
          : ''
      }`}>
        {/* Conversation list — full width on a phone until a thread is open. */}
        <div className={`${selectedKey ? 'hidden md:flex' : 'flex'} w-full md:w-[320px] lg:w-[360px] shrink-0 flex-col border-r border-ink-100`}>
          <div className="p-3 border-b border-ink-100 space-y-2.5">
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
            {/* Status filter — "Sin responder" is the ball-in-our-court view. */}
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filtrar conversaciones">
              <FilterChip label="Todas" active={filter === 'all'} onClick={() => setFilter('all')} count={filterCounts.all} />
              <FilterChip label="Sin leer" active={filter === 'unread'} onClick={() => setFilter('unread')} count={filterCounts.unread} tone="emerald" />
              <FilterChip label="Sin responder" active={filter === 'awaiting'} onClick={() => setFilter('awaiting')} count={filterCounts.awaiting} tone="amber" />
              {/* Keep the chip while it's the ACTIVE filter even at count 0 —
                  otherwise the last snooze expiring leaves the user stuck on an
                  invisible filter with no way to see (or leave) it. */}
              {(filterCounts.snoozed > 0 || filter === 'snoozed') && (
                <FilterChip label="Pospuestas" active={filter === 'snoozed'} onClick={() => setFilter('snoozed')} count={filterCounts.snoozed} />
              )}
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
                {needle
                  ? 'Sin resultados.'
                  : filter === 'unread'
                    ? 'No hay conversaciones sin leer.'
                    : filter === 'awaiting'
                      ? 'Todo respondido — ningún cliente espera respuesta.'
                      : filter === 'snoozed'
                        ? 'No hay conversaciones pospuestas.'
                        : 'Aún no hay conversaciones. Cuando un cliente escriba al número del negocio aparecerá aquí — o inicia tú con “Nuevo chat”.'}
              </p>
            )}
            {conversations.map((c) => (
              <ConversationRow key={c.key} c={c} active={c.key === selectedKey}
                onOpen={() => { selectionOrigin.current = 'list'; setSelectedKey(c.key); setDraftTarget(null); }} />
            ))}
          </div>
        </div>

        {/* Thread — on a phone an open conversation is a visual-viewport-locked
            fixed overlay (rs-thread-mobile, see index.css) so the composer rests
            flush on the keyboard with no magic-number height math; md+ keeps the
            in-flow split-pane (rs-thread-mobile is a no-op above the breakpoint). */}
        <div className={`${selectedKey ? 'flex rs-thread-mobile bg-surface' : 'hidden md:flex'} flex-1 min-w-0 flex-col`}>
          {selected && thread ? (
            <ChatThread
              contact={selected}
              thread={thread}
              connected={connected}
              onBack={() => {
                // Closing the thread always drops the local selection back to
                // the list. When the thread was reached from another page (a
                // contact's WhatsApp quick action), ALSO step back to that page
                // — goBack falls back to '/chats' (which clears the deep-link
                // param) when there's no in-app origin to return to.
                setSelectedKey(null);
                if (selectionOrigin.current === 'deeplink') goBack('/chats');
              }}
              onCreateQuote={(order) => {
                // Seed a new quote draft from the client's cart: the items'
                // references + quantities, with the customer pre-filled when
                // the thread is linked to one.
                const params = new URLSearchParams();
                const refs = buildOrderRefsParam(order.items);
                if (refs) params.set('refs', refs);
                if (selected?.customerId) params.set('customer', selected.customerId);
                navigate(`/quotes/new?${params.toString()}`);
              }}
              onSend={async (text, replyTo) => {
                const draft = draftOutboundMessage({
                  phone: selected.phone, groupId: selected.groupId, text,
                  customerId: selected.customerId, professionalId: selected.professionalId,
                  profileId,
                });
                setPending((rows) => [...rows, draft]);
                const res = await sendWhatsappText({
                  ...sendTarget, text, replyTo,
                  customerId: selected.customerId, professionalId: selected.professionalId,
                }).catch((e) => ({ ok: false, error: e?.message }));
                // On failure no server row will ever arrive to reconcile the
                // optimistic copy, so it would hang forever as "Enviando" —
                // drop it here and let ChatThread surface the error banner.
                if (!res?.ok) setPending((rows) => rows.filter((p) => p.id !== draft.id));
                invalidate();
                return res;
              }}
              onSendMedia={async (file, caption, replyTo) => {
                const res = await sendWhatsappMedia({
                  ...sendTarget, file, caption, replyTo,
                  customerId: selected.customerId, professionalId: selected.professionalId,
                }).catch((e) => ({ ok: false, error: e?.message }));
                invalidate();
                return res;
              }}
              onSendTemplate={async ({ template, params, lang }) => {
                const res = await sendWhatsappTemplate({
                  ...sendTarget, template, params, lang,
                  customerId: selected.customerId, professionalId: selected.professionalId,
                }).catch((e) => ({ ok: false, error: e?.message }));
                invalidate();
                return res;
              }}
              onReact={async (m, emoji) => {
                const res = await sendWhatsappReaction({
                  ...sendTarget, messageId: m.waId, emoji,
                  customerId: selected.customerId, professionalId: selected.professionalId,
                }).catch((e) => ({ ok: false, error: e?.message }));
                invalidate();
                return res;
              }}
              onSendInteractive={async (spec) => {
                const res = await sendWhatsappInteractive({
                  ...sendTarget, ...spec,
                  customerId: selected.customerId, professionalId: selected.professionalId,
                }).catch((e) => ({ ok: false, error: e?.message }));
                invalidate();
                return res;
              }}
              onSendLocation={async (spec) => {
                const res = await sendWhatsappLocation({
                  ...sendTarget, ...spec,
                  customerId: selected.customerId, professionalId: selected.professionalId,
                }).catch((e) => ({ ok: false, error: e?.message }));
                invalidate();
                return res;
              }}
              onSendContact={async (spec) => {
                const res = await sendWhatsappContact({
                  ...sendTarget, ...spec,
                  customerId: selected.customerId, professionalId: selected.professionalId,
                }).catch((e) => ({ ok: false, error: e?.message }));
                invalidate();
                return res;
              }}
              onSendProducts={async ({ items, names, text }) => {
                const res = await sendWhatsappProducts({
                  ...sendTarget, items, names, text,
                  customerId: selected.customerId, professionalId: selected.professionalId,
                }).catch((e) => ({ ok: false, error: e?.message }));
                invalidate();
                return res;
              }}
              onSendCatalog={async ({ text }) => {
                const res = await sendWhatsappCatalog({
                  ...sendTarget, text,
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
              onSuggestReply={(payload) =>
                suggestWhatsappReply(payload).catch((e) => ({ ok: false, error: e?.message }))}
              onManageGroup={(groupId) => { setGroupsFocus(groupId); setGroupsOpen(true); }}
              convState={selected ? (stateByKey.get(selected.key) || null) : null}
              allLabels={allLabels}
              onSaveState={async (patch) => {
                const res = await saveConversationState(selected.phone, patch);
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
      </div>

      <NewChatModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        customers={customers}
        professionals={professionals}
        conversations={allConversations}
        onPick={(contact) => {
          selectionOrigin.current = 'list';
          setDraftTarget(contact);
          setSelectedKey(contact.key);
          setPickerOpen(false);
        }}
      />

      <GroupsPanel
        open={groupsOpen}
        onClose={() => { setGroupsOpen(false); setGroupsFocus(null); }}
        groups={waGroups}
        participants={waGroupParticipants}
        messages={messages}
        customers={customers}
        professionals={professionals}
        focusGroupId={groupsFocus}
        onOpenChat={(key) => { selectionOrigin.current = 'list'; setSelectedKey(key); setDraftTarget(null); }}
        onInvalidate={invalidate}
      />
    </>
  );
}

/** One inbox status filter pill — label + live count, tinted when it carries
 *  pending work (emerald for unread, amber for awaiting-reply). */
function FilterChip({ label, active, onClick, count, tone }) {
  // Active tone uses fixed brand/semantic colors, NOT ink-900: the ink ramp
  // inverts in dark mode, so `bg-ink-900 text-white` became white-on-white.
  const activeTone = tone === 'amber'
    ? 'bg-amber-500 text-white border-amber-500'
    : tone === 'emerald'
      ? 'bg-emerald-600 text-white border-emerald-600'
      : 'bg-brand-600 text-white border-brand-600';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 min-h-7 coarse:min-h-9 text-[11px] font-medium transition-colors ${
        active ? activeTone : 'bg-surface border-ink-200 text-ink-600 hover:bg-ink-50'
      }`}
    >
      {label}
      {count > 0 && (
        <span className={`tabular-nums ${active ? 'opacity-90' : tone === 'amber' ? 'text-amber-600' : tone === 'emerald' ? 'text-emerald-600' : 'text-ink-400'}`}>
          {count}
        </span>
      )}
    </button>
  );
}

function ConversationRow({ c, active, onOpen }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`w-full text-left px-4 py-3 flex items-start gap-3 border-b border-ink-50 transition-colors ${active ? 'bg-brand-50' : 'hover:bg-ink-50/60'}`}
    >
      <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
        c.contactKind === 'group' ? 'bg-emerald-100 text-emerald-700' : c.contactKind ? 'bg-brand-100 text-brand-800' : 'bg-ink-100 text-ink-500'
      }`}>
        {c.contactKind === 'group' ? <Users size={16} /> : initials(c.name)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="font-medium text-sm text-ink-900 truncate">{c.name}</span>
          <span className="text-[10px] text-ink-400 shrink-0 tabular-nums">{timeLabel(c.lastAt)}</span>
        </span>
        <span className="flex items-center justify-between gap-2 mt-0.5">
          <span className={`text-xs truncate ${c.unread ? 'text-ink-800 font-medium' : 'text-ink-500'}`}>
            {c.lastDirection === 'out' && <StatusTicks status={c.lastStatus} className="inline mr-1 -mt-px" />}
            {c.lastSenderName ? `${c.lastSenderName}: ` : ''}{c.lastBody || '—'}
          </span>
          {c.unread ? (
            <span className="shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-emerald-600 text-white text-[10px] font-bold inline-flex items-center justify-center">
              {c.unread}
            </span>
          ) : c.awaitingReply ? (
            // Read but unanswered — the client is still waiting on us.
            <span className="shrink-0 inline-flex items-center" title="Sin responder">
              <span className="h-2 w-2 rounded-full bg-amber-500" aria-label="Sin responder" />
            </span>
          ) : null}
        </span>
        {c.labels?.length > 0 && (
          <span className="mt-1 flex flex-wrap gap-1">
            {c.labels.slice(0, 3).map((l) => (
              <span key={l} className="inline-flex max-w-[8rem] truncate rounded-full bg-brand-50 text-brand-700 border border-brand-100 px-1.5 py-0.5 text-[10px] font-medium">
                {l}
              </span>
            ))}
          </span>
        )}
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
  // Matches by name OR by phone digits (≥4, so a short fragment doesn't
  // flood the list), mirroring the contact list's own search.
  const existing = useMemo(() => {
    const q = needle.trim().toLowerCase();
    if (!q) return [];
    const digits = needle.replace(/\D/g, '');
    return (conversations || []).filter((c) =>
      c.name.toLowerCase().includes(q)
      || (digits.length >= 4 && String(c.phone || '').replace(/\D/g, '').includes(digits))).slice(0, 5);
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
