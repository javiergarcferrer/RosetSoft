import { useState } from 'react';
import { ChevronUp, LogOut, Sun, Moon, Monitor } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { getThemePreference, setThemePreference } from '../lib/theme.js';

const THEME_OPTIONS = [
  { value: 'light', label: 'Claro', Icon: Sun },
  { value: 'dark', label: 'Oscuro', Icon: Moon },
  { value: 'system', label: 'Auto', Icon: Monitor },
];

/** Light / Dark / Auto segmented control. Lives in the ProfileMenu so theming
 *  sits with the rest of the per-user account state. */
function ThemeToggle() {
  const [theme, setTheme] = useState(getThemePreference);
  return (
    <div className="px-3 pt-2.5 pb-1">
      <div className="eyebrow-xs text-ink-500 mb-1.5">Tema</div>
      <div className="flex items-center gap-1 rounded-lg bg-white/[0.05] p-0.5">
        {THEME_OPTIONS.map(({ value, label, Icon }) => {
          const active = theme === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => setTheme(setThemePreference(value))}
              aria-pressed={active}
              className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] font-medium transition-colors ${
                active
                  ? 'bg-white/[0.12] text-ink-100 shadow-xs'
                  : 'text-ink-400 hover:text-ink-200 hover:bg-white/[0.06]'
              }`}
            >
              <Icon size={13} aria-hidden /> {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function ProfileMenu({ compact = false }) {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);

  const displayName = user?.user_metadata?.name || user?.email || 'Miembro';

  async function handleSignOut() {
    setOpen(false);
    await signOut();
  }

  return (
    <div className="border-t border-white/[0.06] p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] relative">
      {open && (
        <div className={`absolute bottom-full mb-2 bg-ink-800 rounded-xl border border-white/[0.09] shadow-pop overflow-hidden animate-in slide-in-from-bottom-1 fade-in duration-150 ${compact ? 'left-2 w-56' : 'left-2 right-2'}`}>
          {/* Session info header */}
          <div className="px-3.5 pt-3 pb-2.5">
            <div className="eyebrow-xs text-ink-500 mb-1">Sesión iniciada como</div>
            <div className="text-[11px] font-medium text-ink-300 truncate leading-snug" title={user?.email || ''}>
              {user?.email || '—'}
            </div>
          </div>
          <div className="border-t border-white/[0.07] mx-2 my-1" />
          <ThemeToggle />
          <div className="border-t border-white/[0.07] mx-2 mb-1" />
          <button
            onClick={handleSignOut}
            className="flex items-center gap-2.5 text-sm text-ink-400 hover:text-ink-100 hover:bg-white/[0.07] active:bg-white/[0.12] transition-colors rounded-lg px-3 py-2.5 mx-1 w-[calc(100%-0.5rem)]"
          >
            <LogOut size={13} className="shrink-0 text-ink-500" aria-hidden /> Cerrar sesión
          </button>
          <div className="pb-1" />
        </div>
      )}

      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={compact ? displayName : undefined}
        className={`w-full flex items-center gap-2 px-2.5 py-2.5 rounded-lg hover:bg-white/[0.07] active:bg-white/[0.11] active:scale-[0.99] transition-all duration-150 ${compact ? 'justify-center' : 'justify-between'}`}
      >
        <div className={`flex items-center gap-2.5 min-w-0 ${compact ? 'justify-center' : ''}`}>
          {/* Avatar chip — brand-tinted circle */}
          <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-brand-500/25 text-brand-300 text-[11px] font-bold shrink-0 select-none ring-1 ring-inset ring-brand-400/20">
            {(displayName[0] || '?').toUpperCase()}
          </span>
          {!compact && (
            <div className="text-left min-w-0">
              <div className="text-[11px] font-semibold text-ink-200 truncate leading-tight" title={displayName}>{displayName}</div>
              <div className="text-[10px] text-ink-500 mt-px leading-none">Cuenta</div>
            </div>
          )}
        </div>
        {!compact && (
          <ChevronUp
            size={13}
            aria-hidden
            className={`text-ink-600 transition-transform duration-200 shrink-0 ${open ? '' : 'rotate-180'}`}
          />
        )}
      </button>
    </div>
  );
}
