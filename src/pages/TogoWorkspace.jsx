import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Sofa, Inbox, Boxes, ExternalLink, Copy, Check } from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import { useLiveQuery } from '../db/hooks.js';
import { db } from '../db/database.js';
import { togoEmbedUrl, togoEmbedSnippet } from '../lib/togoEmbed.js';
import PageHeader from '../components/PageHeader.jsx';
import TogoRequests from './TogoRequests.jsx';
import TogoModels from './admin/TogoCatalog.jsx';

/**
 * The single Togo workspace — everything Togo in ONE pane, no more jumping
 * between /togo (builder) and /admin/catalog/togo (models). Three tabs:
 *   • Configurador — a LIVE PREVIEW of the public embed widget (the ONE
 *                    configurator), in a faux browser shell. No separate in-app
 *                    builder → it can never drift from what's deployed.
 *   • Solicitudes  — the inbox of web leads (togo_requests) the widget captures,
 *                    held here until the dealer promotes them into a quote.
 *   • Modelos      — the DWG model catalog + the website embed snippet (admin).
 * Tab lives in the URL (`/togo`, `/togo/solicitudes`, `/togo/modelos`) so a link
 * (e.g. a future "new request" notification) can deep-link straight to one.
 */
export default function TogoWorkspace() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { isAdmin, profileId } = useApp();

  // Pending web-lead count → the Solicitudes badge.
  const requests = useLiveQuery(
    () => (profileId ? db.togoRequests.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId], [],
  );
  const pendingCount = useMemo(
    () => (requests || []).filter((r) => r.status === 'pending').length,
    [requests],
  );

  const tabs = useMemo(() => [
    { key: 'configurador', label: 'Configurador', icon: Sofa },
    { key: 'solicitudes', label: 'Solicitudes', icon: Inbox, badge: pendingCount },
    ...(isAdmin ? [{ key: 'modelos', label: 'Modelos', icon: Boxes }] : []),
  ], [isAdmin, pendingCount]);

  // Resolve the active tab; gate Modelos to admins, fall back to the builder.
  const allowed = new Set(tabs.map((t) => t.key));
  const active = allowed.has(tab) ? tab : 'configurador';

  const go = (key) => navigate(key === 'configurador' ? '/togo' : `/togo/${key}`);

  return (
    <div>
      <PageHeader title="Togo" subtitle="Configurador en planta · solicitudes web · modelos" />

      <div className="flex items-center gap-1 border-b border-ink-100 mb-5 -mt-1 overflow-x-auto">
        {tabs.map((t) => {
          const on = active === t.key;
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => go(t.key)}
              className={`relative inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
                on ? 'border-brand-500 text-ink-900' : 'border-transparent text-ink-500 hover:text-ink-800'
              }`}
            >
              <Icon size={15} aria-hidden /> {t.label}
              {t.badge > 0 && (
                <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-brand-500 text-white text-[10px] font-semibold tabular-nums">
                  {t.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {active === 'configurador' && <TogoLivePreview />}
      {active === 'solicitudes' && <TogoRequests />}
      {active === 'modelos' && isAdmin && <TogoModels />}
    </div>
  );
}

/**
 * The Configurador tab is a LIVE PREVIEW of the public widget — the exact same
 * embed customers use on the dealer's site, in an <iframe>, inside a faux browser
 * shell so it reads as "this is what's out there on alcover.do". There is no
 * separate in-app configurator anymore: one widget, previewed here, embedded
 * there — so they can never drift. What a visitor builds here lands in
 * Solicitudes (a pending request) to promote into a quote.
 */
function TogoLivePreview() {
  const [copied, setCopied] = useState(false);
  const url = togoEmbedUrl();
  const copy = async () => {
    try { await navigator.clipboard.writeText(togoEmbedSnippet()); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-500">
          Vista <b className="text-ink-700">en vivo</b> del configurador público — exactamente lo que ven tus clientes en tu web.
        </p>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={copy} className="btn-ghost text-xs">{copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />} {copied ? 'Copiado' : 'Copiar código'}</button>
          <a href={url} target="_blank" rel="noreferrer" className="btn-ghost text-xs"><ExternalLink size={14} /> Abrir</a>
        </div>
      </div>

      {/* Browser-shell mockup so the embed reads as it would on the dealer's site. */}
      <div className="rounded-xl border border-ink-200 overflow-hidden shadow-soft bg-white">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-ink-100 bg-ink-50">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
            <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
          </span>
          <span className="flex-1 mx-2 truncate rounded-md bg-surface border border-ink-200 px-3 py-1 text-[11px] text-ink-500 text-center">
            alcover.do
          </span>
        </div>
        <iframe
          src={url}
          title="Configurador Togo — vista en vivo"
          className="w-full bg-white border-0 block h-[78vh] min-h-[560px]"
          loading="lazy"
        />
      </div>
    </div>
  );
}
