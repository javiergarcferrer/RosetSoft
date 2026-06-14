import { createPortal } from 'react-dom';
import { Eye, MessageCircle, Pencil } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { useLiveQuery } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { phoneKey } from '../../lib/phone.js';

// Shared per-tab unread pill so the bottom bar and the siderail can't drift.
// Absolutely positioned against the icon's `relative` wrapper in both layouts.
function Badge({ count }) {
  if (count <= 0) return null;
  return (
    <span className="absolute -top-1.5 -right-2.5 min-w-4 h-4 px-1 rounded-full bg-emerald-600 text-white text-[9px] font-bold inline-flex items-center justify-center tabular-nums">
      {count > 99 ? '99+' : count}
    </span>
  );
}

/**
 * Mode switcher for the quote workspace — one tap between the page's three
 * surfaces: the editor (Cotización), the client preview (Cliente) and the
 * customer's WhatsApp conversation (WhatsApp). The three tabs are identical in
 * both layouts; only the chrome flips with the viewport:
 *   • phones (< md): a thumb-reach bottom bar — the native pattern there.
 *   • desktop (md+): a floating vertical siderail pinned to the right edge,
 *     clear of the left nav and the bottom TotalsDock.
 * This is now the ONE switcher at every width (it replaced the header's old
 * ViewToggle), so the WhatsApp mode — previously mobile-only — is reachable
 * on desktop too.
 *
 * Portaled to <body> for the same reason as TotalsDock: position:fixed inside
 * the app shell's scroll container is scoped to that container on iOS WebKit,
 * which would strand the bar above the home indicator. z-30 keeps it under
 * the nav drawer's z-40 dim (the drawer should cover page chrome); the
 * TotalsDock sits at bottom-14 directly above the phone bar, so the two never
 * overlap, and on desktop the dock is at bottom-0 while the rail floats at
 * mid-height, so they stay clear there too. pb-safe-standalone paints the
 * home-indicator inset white in the installed PWA; kb-hide-when-open slides
 * the bar away while typing in the page.
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
    <>
      {/* Phones — bottom bar across the thumb's reach. */}
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
                    <Badge count={badge} />
                  </span>
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </nav>

      {/* Desktop — a thin icon-only rail flush against the right edge of the
          viewport (rounded on the inner side only, so it reads as a tab pinned
          to the screen edge). Same three modes; the left accent bar marks the
          active one, and the label rides a native tooltip (title) instead of
          taking width. */}
      <nav
        aria-label="Modo de la cotización"
        className="hidden md:flex fixed right-0 top-1/2 -translate-y-1/2 z-30 print:hidden flex-col gap-0.5 p-1 rounded-l-xl border border-r-0 border-ink-200 bg-surface/95 supports-[backdrop-filter]:bg-surface/80 backdrop-blur shadow-pop"
      >
        {tabs.map(({ id, label, icon: Icon, badge }) => {
          const active = view === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange(id)}
              aria-pressed={active}
              title={label}
              aria-label={label}
              className={`relative w-9 h-9 inline-flex items-center justify-center rounded-lg transition-colors ${
                active ? 'text-brand-700 bg-brand-50' : 'text-ink-400 hover:text-ink-700 hover:bg-ink-50'
              }`}
            >
              {active && <span aria-hidden className="absolute left-0 inset-y-2 w-0.5 rounded-r bg-brand-grad" />}
              <span className="relative">
                <Icon size={18} aria-hidden />
                <Badge count={badge} />
              </span>
            </button>
          );
        })}
      </nav>
    </>,
    document.body,
  );
}
