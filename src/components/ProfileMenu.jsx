import { useState } from 'react';
import { ChevronUp, UserPlus, Check } from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import { db, newId } from '../db/database.js';

export default function ProfileMenu() {
  const { profileId, profiles, switchProfile, refreshProfiles } = useApp();
  const [open, setOpen] = useState(false);
  const active = profiles.find((p) => p.id === profileId);

  async function createProfile() {
    const name = prompt('Profile name (e.g. "Maria — Showroom Brickell"):');
    if (!name?.trim()) return;
    const id = newId();
    await db.profiles.put({ id, name: name.trim(), createdAt: Date.now() });
    await db.settings.put({
      profileId: id,
      companyName: 'Tu Empresa',
      defaultCurrency: 'USD',
      currencyRates: { USD: 1, DOP: 60.0 },
      bpd: { buy: null, sell: null, updatedAt: null },
      market: { rate: null, date: null, source: null },
      dopRateMode: 'bpd-sell',
      defaultMarginPct: 0,
      defaultDiscountPct: 0,
      quoteTerms: '',
      quoteCounter: 1000,
    });
    await refreshProfiles();
    await switchProfile(id);
    setOpen(false);
  }

  return (
    <div className="border-t border-ink-800 p-2 relative">
      {open && (
        <div className="absolute bottom-full left-2 right-2 mb-1 bg-ink-800 rounded-md border border-ink-700 shadow-xl py-1 max-h-80 overflow-y-auto">
          {profiles.map((p) => (
            <button
              key={p.id}
              onClick={() => { switchProfile(p.id); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-sm text-ink-100 hover:bg-ink-700 flex items-center gap-2"
            >
              {p.id === profileId ? <Check size={14} /> : <span className="w-3.5" />}
              <span className="truncate">{p.name}</span>
            </button>
          ))}
          <div className="border-t border-ink-700 my-1" />
          <button
            onClick={createProfile}
            className="w-full text-left px-3 py-2 text-sm text-ink-200 hover:bg-ink-700 flex items-center gap-2"
          >
            <UserPlus size={14} />
            New profile…
          </button>
        </div>
      )}

      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md hover:bg-ink-800"
      >
        <div className="text-left min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-ink-400">Profile</div>
          <div className="text-sm font-medium text-ink-100 truncate">{active?.name || '—'}</div>
        </div>
        <ChevronUp size={16} className={`text-ink-400 transition-transform ${open ? '' : 'rotate-180'}`} />
      </button>
    </div>
  );
}
