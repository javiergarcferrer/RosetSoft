import { createPortal } from 'react-dom';
import { Eye, MessageCircle, Pencil } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { useLiveQuery } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { phoneKey } from '../../lib/phone.js';

/**
 * Mobile-only bottom mode bar for the quote workspace — one thumb-reach
 * switch between the page's three surfaces: the editor (Cotización), the
 * client preview (Cliente) and the customer's WhatsApp conversation
 * (WhatsApp). On desktop the header's ViewToggle and the inline chat card
 * cover the same ground, so the bar renders only under md.
 *
 * Portaled to <body> for the same reason as TotalsDock: position:fixed inside
 * the app shell's scroll container is scoped to that container on iOS WebKit,
 * which would strand the bar above the home indicator. z-30 keeps it under
 * the nav drawer's z-40 dim (the drawer should cover page chrome); the
 * TotalsDock sits at bottom-14 directly above, so the two never overlap.
 * pb-safe-standalone paints the home-indicator inset white in the installed
 * PWA; kb-hide-when-open slides the bar away while typing in the page.
 *
 * The WhatsApp tab always switches — when something's missing (no customer,
 * no phone, not connected) the chat view itself explains the next step — and
 * carries the thread's unread count so an unanswered client is visible from
 * any mode.
 */
export default function ModeBar({ view, onChange, customer }) {
  const { profileId, settings } = useApp();
  const connected = !!settings?.whatsappConnectedAt;
  const key = phoneKey(customer?.phone);
  const messages = useLiveQuery(
    () => (profileId && key ? db.waMessages.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId, key],
    [],
  );
  const unread = key
    ? messages.reduce((n, m) => n + (phoneKey(m.phone) === key && m.direction === 'in' && !m.readAt ? 1 : 0), 0)
    : 0;

  const tabs = [
    { id: 'compose', label: 'Cotización', icon: Pencil, badge: 0 },
    { id: 'client', label: 'Cliente', icon: Eye, badge: 0 },
    { id: 'chat', label: 'WhatsApp', icon: MessageCircle, badge: connected ? unread : 0 },
  ];

  return createPortal(
    <nav
      aria-label="Modo de la cotización"
      className="fixed inset-x-0 bottom-0 z-30 md:hidden print:hidden kb-hide-when-open"
    >
      <div className="bg-surface border-t border-ink-200 shadow-pop pb-safe-standalone">
        <div className="grid grid-cols-3">
          {tabs.map(({ id, label, icon: Icon, badge }) => {
            const active = view === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onChange(id)}
                aria-pressed={active}
                className={`relative h-14 inline-flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold transition-colors active:bg-ink-50 ${
                  active ? 'text-brand-700' : 'text-ink-400'
                }`}
              >
                {active && <span aria-hidden className="absolute top-0 inset-x-6 h-0.5 rounded-b bg-brand-grad" />}
                <span className="relative">
                  <Icon size={19} aria-hidden />
                  {badge > 0 && (
                    <span className="absolute -top-1.5 -right-2.5 min-w-4 h-4 px-1 rounded-full bg-emerald-600 text-white text-[9px] font-bold inline-flex items-center justify-center tabular-nums">
                      {badge > 99 ? '99+' : badge}
                    </span>
                  )}
                </span>
                {label}
              </button>
            );
          })}
        </div>
      </div>
    </nav>,
    document.body,
  );
}
