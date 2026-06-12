import { useEffect, useMemo, useRef, useState } from 'react';
import { MessageCircle, ChevronDown } from 'lucide-react';
import ChatThread from './ChatThread.jsx';
import { useApp } from '../../context/AppContext.jsx';
import { db, invalidate } from '../../db/database.js';
import { useLiveQuery } from '../../db/hooks.js';
import { resolveThread } from '../../core/crm/index.js';
import { phoneKey, displayPhone } from '../../lib/phone.js';
import {
  sendWhatsappText, sendWhatsappTemplate, sendWhatsappMedia, sendWhatsappReadReceipt,
  sendWhatsappReaction, sendWhatsappInteractive, sendWhatsappLocation, sendWhatsappContact,
  markThreadRead, draftOutboundMessage,
} from '../../lib/whatsapp.js';

/**
 * A contact's WhatsApp conversation as a collapsible card — embedded wherever
 * the dealer is already working with that contact: the quote workspace (the
 * quote's customer, sends tagged with the quote id), the customer detail page
 * and the professional detail page. Same data path as the Chats inbox: the
 * thread is resolveThread over wa_messages keyed by the contact's phone (so
 * it IS the inbox conversation), the pane is the shared ChatThread, and sends
 * go through wa-send stamped with the contact (and optional quote).
 *
 * Collapsed by default (a header row with the unread count); expanding polls
 * while open, marks the thread read and sends the customer-side read receipt —
 * exactly like opening the thread in the inbox. Renders nothing without a
 * phone or a WhatsApp connection (the contact's own card owns prompting for
 * those).
 *
 * `contact` is a customer or professional row; `contactKind` says which, so
 * the outbound log links the right CRM column.
 */
const POLL_MS = 10000;

export default function ContactChatCard({ contact, contactKind, quoteId = null }) {
  const { profileId, settings } = useApp();
  const connected = !!settings?.whatsappConnectedAt;
  const key = phoneKey(contact?.phone);

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
  // contact's side (read receipt), mirroring the inbox's open-thread effect.
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

  // No phone / no connection → nothing to converse with.
  if (!contact || !key || !connected) return null;

  const isCustomer = contactKind === 'customer';
  const link = {
    customerId: isCustomer ? contact.id : null,
    professionalId: isCustomer ? null : contact.id,
    ...(quoteId ? { quoteId } : {}),
  };
  const threadContact = {
    key,
    phone: contact.phone,
    name: contact.name || contact.company || displayPhone(contact.phone),
    contactKind,
    ...link,
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
          <span className="block font-semibold text-sm text-ink-900">
            {isCustomer ? 'Conversación con el cliente' : 'Conversación con el profesional'}
          </span>
          <span className="block text-[11px] text-ink-400 truncate">
            WhatsApp · {threadContact.name} · {displayPhone(contact.phone)}
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
            contact={threadContact}
            thread={thread}
            connected={connected}
            showHeader={false}
            onSend={async (text, replyTo) => {
              const draft = draftOutboundMessage({
                phone: contact.phone, text, profileId,
                customerId: link.customerId, professionalId: link.professionalId,
              });
              setPending((rows) => [...rows, draft]);
              const res = await sendWhatsappText({ to: contact.phone, text, replyTo, ...link })
                .catch((e) => ({ ok: false, error: e?.message }));
              invalidate();
              return res;
            }}
            onSendMedia={async (file, caption, replyTo) => {
              const res = await sendWhatsappMedia({ to: contact.phone, file, caption, replyTo, ...link })
                .catch((e) => ({ ok: false, error: e?.message }));
              invalidate();
              return res;
            }}
            onSendTemplate={async ({ template, params, lang }) => {
              const res = await sendWhatsappTemplate({ to: contact.phone, template, params, lang, ...link })
                .catch((e) => ({ ok: false, error: e?.message }));
              invalidate();
              return res;
            }}
            onReact={async (m, emoji) => {
              const res = await sendWhatsappReaction({ to: contact.phone, messageId: m.waId, emoji, ...link })
                .catch((e) => ({ ok: false, error: e?.message }));
              invalidate();
              return res;
            }}
            onSendInteractive={async (spec) => {
              const res = await sendWhatsappInteractive({ to: contact.phone, ...spec, ...link })
                .catch((e) => ({ ok: false, error: e?.message }));
              invalidate();
              return res;
            }}
            onSendLocation={async (spec) => {
              const res = await sendWhatsappLocation({ to: contact.phone, ...spec, ...link })
                .catch((e) => ({ ok: false, error: e?.message }));
              invalidate();
              return res;
            }}
            onSendContact={async (spec) => {
              const res = await sendWhatsappContact({ to: contact.phone, ...spec, ...link })
                .catch((e) => ({ ok: false, error: e?.message }));
              invalidate();
              return res;
            }}
          />
        </div>
      )}
    </div>
  );
}
