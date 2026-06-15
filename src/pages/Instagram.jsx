// Instagram — one home for the two Instagram surfaces, behind a tab toggle:
//   • Marketing — publish, schedule, comment triage, ad campaigns.
//   • Studio    — audience intelligence, content grid + per-post insights,
//                 best-time heatmap, stories, mentions, real-time activity.
//
// The two pages are kept intact; this shell only switches between them. Only the
// ACTIVE tab is mounted, so only that surface's Graph read fires (Marketing's
// `snapshot` vs Studio's `igStudio`) — no double-fetch. `/marketing` and
// `/instagram-studio` both route here, opening the matching tab, so old links
// and the JARVIS deep-link keep working.
import { useState } from 'react';
import { Megaphone, Sparkles } from 'lucide-react';
import Marketing from './Marketing.jsx';
import InstagramStudio from './InstagramStudio.jsx';

const TABS = [
  { id: 'marketing', label: 'Marketing', icon: Megaphone },
  { id: 'studio', label: 'Studio', icon: Sparkles },
];

export default function Instagram({ initialTab = 'marketing' }) {
  const [tab, setTab] = useState(initialTab === 'studio' ? 'studio' : 'marketing');
  return (
    <>
      <div className="mb-3 inline-flex rounded-full border border-ink-200 bg-surface p-0.5 text-sm" role="tablist" aria-label="Instagram">
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
              className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 font-medium transition-colors ${active ? 'bg-brand-600 text-white' : 'text-ink-500 hover:text-ink-800'}`}
            >
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>
      {tab === 'studio' ? <InstagramStudio /> : <Marketing />}
    </>
  );
}
