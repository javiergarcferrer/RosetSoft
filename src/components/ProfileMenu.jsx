import { useState } from 'react';
import { ChevronUp, LogOut } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';

export default function ProfileMenu() {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);

  const displayName = user?.user_metadata?.name || user?.email || 'Member';

  async function handleSignOut() {
    setOpen(false);
    await signOut();
  }

  return (
    <div className="border-t border-ink-800 p-2 relative">
      {open && (
        <div className="absolute bottom-full left-2 right-2 mb-1 bg-ink-800 rounded-md border border-ink-700 shadow-xl py-1">
          <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-ink-400">Signed in as</div>
          <div className="px-3 pb-2 text-xs text-ink-200 truncate" title={user?.email || ''}>
            {user?.email || '—'}
          </div>
          <div className="border-t border-ink-700 my-1" />
          <button
            onClick={handleSignOut}
            className="w-full text-left px-3 py-2 text-sm text-ink-200 hover:bg-ink-700 flex items-center gap-2"
          >
            <LogOut size={14} /> Sign out
          </button>
        </div>
      )}

      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md hover:bg-ink-800"
      >
        <div className="text-left min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-ink-400">Cuenta</div>
          <div className="text-sm font-medium text-ink-100 truncate" title={displayName}>{displayName}</div>
        </div>
        <ChevronUp size={16} className={`text-ink-400 transition-transform ${open ? '' : 'rotate-180'}`} />
      </button>
    </div>
  );
}
