// Instagram — one home for the two Instagram surfaces, behind a tab toggle:
//   • Marketing — publish, schedule, comment triage, ad campaigns.
//   • Studio    — audience intelligence, content grid + per-post insights,
//                 best-time heatmap, stories, mentions, real-time activity.
//
// The two pages are kept intact; this shell switches between them AND owns the
// shared chrome: one unified header (title · @handle · the single live pill)
// plus the segmented tab control. Only the ACTIVE tab is mounted, so only that
// surface's Graph read fires (Marketing's `snapshot` vs Studio's `igStudio`) —
// no double-fetch; the active tab publishes its fetch status up to the header
// via InstagramLiveProvider. `/marketing` and `/instagram-studio` both route
// here, opening the matching tab, so old links and the JARVIS deep-link work.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Megaphone, Sparkles, Instagram as InstagramIcon } from 'lucide-react';
import Marketing from './Marketing.jsx';
import InstagramStudio from './InstagramStudio.jsx';
import { useApp } from '../context/AppContext.jsx';
import { InstagramLiveProvider, LivePill, freshLabel } from '../components/instagram/chrome.jsx';

const TABS = [
  { id: 'marketing', label: 'Marketing', icon: Megaphone },
  { id: 'studio', label: 'Studio', icon: Sparkles },
];

export default function Instagram({ initialTab = 'marketing' }) {
  const { settings } = useApp();
  const linked = !!settings?.metaSocialConnectedAt;
  const username = settings?.metaSocialIgUsername;
  const [tab, setTab] = useState(initialTab === 'studio' ? 'studio' : 'marketing');

  // The active tab publishes its live-fetch status here (loading / freshness /
  // refresh handler) so the header can show ONE live pill for whichever tab is
  // mounted. null = nothing published yet (or not connected).
  const [live, setLive] = useState(null);

  // Own the freshness ticker so the pill's "hace 3 s" updates once per second
  // without re-rendering the active tab's subtree (paused while hidden).
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === 'visible') setNowTick(Date.now()); }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <InstagramLiveProvider value={setLive}>
      <header className="mb-5 pb-4 border-b border-ink-100">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <h1 className="font-display text-2xl sm:text-3xl font-semibold tracking-tight leading-tight">Instagram</h1>
            <p className="text-sm text-ink-500 mt-1.5 leading-snug">
              {linked ? (username ? `@${username}` : 'Cuenta conectada') : 'Sin conectar'}
            </p>
          </div>
          {linked ? (
            live && (
              <LivePill
                loading={live.loading}
                hasData={live.hasData}
                error={live.error}
                sinceLabel={freshLabel(live.loadedAt, nowTick)}
                onRefresh={live.onRefresh}
              />
            )
          ) : (
            <Link to="/settings" className="btn-brand">
              <InstagramIcon size={14} /> Conectar Instagram
            </Link>
          )}
        </div>

        {/* Segmented tab control — full-width 50/50 on a phone (big touch
            targets), shrinks to content width inline from sm+. */}
        <div
          className="mt-4 inline-flex w-full sm:w-auto rounded-full border border-ink-200 bg-surface p-0.5"
          role="tablist"
          aria-label="Vistas de Instagram"
        >
          {TABS.map((t) => {
            const active = tab === t.id;
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                className={`inline-flex flex-1 sm:flex-none items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors ${active ? 'bg-brand-600 text-white shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}
              >
                <Icon size={15} /> {t.label}
              </button>
            );
          })}
        </div>
      </header>

      {tab === 'studio' ? <InstagramStudio /> : <Marketing />}
    </InstagramLiveProvider>
  );
}
