import { useEffect, useMemo, useRef, useState } from 'react';
import { MessageCircle, ChevronDown } from 'lucide-react';
import ChatThread from '../whatsapp/ChatThread.jsx';
import { useApp } from '../../context/AppContext.jsx';
import { db, invalidate } from '../../db/database.js';
import { useLiveQuery } from '../../db/hooks.js';
import { resolveThread } from '../../core/crm/index.js';
import { phoneKey, displayPhone } from '../../lib/phone.js';
import {
  sendWhatsappText, sendWhatsappTemplate, sendWhatsappMedia, sendWhatsappReadReceipt,
  markThreadRead, draftOutboundMessage,
} from '../../lib/whatsapp.js';

/**
 * The client's WhatsApp conversation, embedded in the quote workspace — so the
 * dealer reads and answers the client they're quoting without leaving the
 * editor. Same data path as the Chats inbox: the thread is resolveThread over
 * wa_messages keyed by the customer's phone (so it's the SAME conversation the
 * inbox shows), the pane is the shared ChatThread component, and sends go
 * through wa-send — here additionally stamped with the quote id, so the
 * message log records which quote the exchange was about.
 *
 * Collapsed by default (a header row with the unread count); expanding fetches
 * fresh rows and polls while open, marks the thread read, and sends the
 * customer-side read receipt — exactly like opening the thread in the inbox.
 * Renders nothing without a customer phone or a WhatsApp connection (the
 * WhatsAppChip in the header owns prompting for both).
 */
const POLL_MS = 10000;

export default function QuoteChatCard({ quote, customer }) {
  const { profileId, settings } = useApp();
  const connected = !!settings?.whatsappConnectedAt;
  const key = phoneKey(customer?.phone);

  const [open, setOpen] = useState(false);
  // Optimistic outbound rows, dropped once the server-logged row arrives.
  const [pending, setPending] = useState([]);

  const messages = useLiveQuery(
    () => (profileId && key ? db.waMessages.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId, key],
    [],
  );

  // Near-live while the conversation is open, like the inbox.
  useEffect(() => {
    if (!open) return undefined;
    const id = setInterval(() => invalidate(), POLL_MS);
    return () => clearInterval(id);
  }, [open]);

  const thread = useMemo(
    () => (key ? resolveThread([...messages, ...pending], { key }) : null),
    [messages, pending, key],
  );
  const unread = useMemo(
    () => messages.filter((m) => phoneKey(m.phone) === key && m.direction === 'in' && !m.readAt).length,
    [messages, key],
  );

  // Server rows landed → drop the optimistic copies they replace.
  useEffect(() => {
    if (!pending.length) return;
    setPending((rows) => rows.filter((p) => !messages.some(
      (m) => m.direction === 'out' && phoneKey(m.phone) === phoneKey(p.phone)
        && (m.body || '') === (p.body || '') && (m.createdAt || 0) >= p.createdAt - 1000,
    )));
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Expanding the conversation clears its unread badge — locally AND on the
  // customer's side (read receipt), mirroring the inbox's open-thread effect.
  const lastReceiptFor = useRef(null);
  useEffect(() => {
    if (!open || !key) return;
    const rows = messages.filter((m) => phoneKey(m.phone) === key && m.direction === 'in' && !m.readAt);
    if (!rows.length) return;
    markThreadRead(rows).catch(() => {});
    const latest = rows.reduce((a, b) => ((a.createdAt || 0) >= (b.createdAt || 0) ? a : b));
    if (latest.waId && lastReceiptFor.current !== latest.waId) {
      lastReceiptFor.current = latest.waId;
      sendWhatsappReadReceipt(latest.waId);
    }
  }, [open, key, messages]);

  // No customer phone / no connection → nothing to converse with. The header's
  // WhatsAppChip is where the dealer adds the number or connects the API.
  if (!customer || !key || !connected) return null;

  const contact = {
    key,
    phone: customer.phone,
    name: customer.name || customer.company || displayPhone(customer.phone),
    contactKind: 'customer',
    customerId: customer.id,
    professionalId: null,
  };

  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2.5 px-5 py-3.5 text-left hover:bg-ink-50/60 active:bg-ink-50 transition-colors"
      >
        <MessageCircle size={16} className="text-emerald-600 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-sm text-ink-900">Conversación con el cliente</span>
          <span className="block text-[11px] text-ink-400 truncate">
            WhatsApp · {contact.name} · {displayPhone(customer.phone)}
          </span>
        </span>
        {!open && unread > 0 && (
          <span className="shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-emerald-600 text-white text-[10px] font-bold inline-flex items-center justify-center">
            {unread}
          </span>
        )}
        <ChevronDown
          size={16}
          className={`text-ink-400 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {open && thread && (
        <div className="flex flex-col h-[28rem] border-t border-ink-100">
          <ChatThread
            contact={contact}
            thread={thread}
            connected={connected}
            showHeader={false}
            onSend={async (text) => {
              const draft = draftOutboundMessage({
                phone: customer.phone, text, customerId: customer.id, profileId,
              });
              setPending((rows) => [...rows, draft]);
              const res = await sendWhatsappText({
                to: customer.phone, text, customerId: customer.id, quoteId: quote?.id,
              }).catch((e) => ({ ok: false, error: e?.message }));
              invalidate();
              return res;
            }}
            onSendMedia={async (file, caption) => {
              const res = await sendWhatsappMedia({
                to: customer.phone, file, caption, customerId: customer.id, quoteId: quote?.id,
              }).catch((e) => ({ ok: false, error: e?.message }));
              invalidate();
              return res;
            }}
            onSendTemplate={async ({ template, params, lang }) => {
              const res = await sendWhatsappTemplate({
                to: customer.phone, template, params, lang, customerId: customer.id, quoteId: quote?.id,
              }).catch((e) => ({ ok: false, error: e?.message }));
              invalidate();
              return res;
            }}
          />
        </div>
      )}
    </div>
  );
}
