import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Inbox, Boxes, ExternalLink, Copy, Check, ArrowRight } from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import { useLiveQuery } from '../db/hooks.js';
import { db } from '../db/database.js';
import { togoEmbedUrl, togoEmbedModalUrl, togoEmbedSnippet } from '../lib/togoEmbed.js';
import TogoIcon from '../lib/icons/TogoIcon.jsx';
import togoHeroSvg from '../assets/togo/togo_gb.svg?raw';
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
    { key: 'configurador', label: 'Configurador', icon: TogoIcon },
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
 * The Configurador tab previews the public LAUNCHER exactly as customers meet it
 * on the dealer's site: an attractive "Configura tu Togo" card that opens the
 * configurator in a FULLSCREEN modal. Same card + popup the embed snippet ships,
 * so the in-app preview can never drift from what's deployed. What a visitor
 * builds in the modal lands in Solicitudes (a pending request) to promote.
 */
function TogoLivePreview() {
  const [copied, setCopied] = useState(false);
  const url = togoEmbedUrl();
  const copy = async () => {
    try { await navigator.clipboard.writeText(togoEmbedSnippet()); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-500">
          Así lo ven tus clientes en tu web: un <b className="text-ink-700">card</b> que abre el configurador en una <b className="text-ink-700">pestaña nueva</b>.
        </p>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={copy} className="btn-ghost text-xs">{copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />} {copied ? 'Copiado' : 'Copiar código'}</button>
          <a href={url} target="_blank" rel="noreferrer" className="btn-ghost text-xs"><ExternalLink size={14} /> Abrir</a>
        </div>
      </div>

      {/* The launch card, on a soft "page" backdrop so it reads as it would on
          the dealer's site. Clicking it opens the configurator in a new tab. */}
      <div className="grid place-items-center rounded-2xl border border-ink-200 bg-ink-50/60 px-4 py-12 sm:py-16">
        <TogoLaunchCard href={togoEmbedModalUrl()} />
      </div>
    </div>
  );
}

/** The attractive launch card — the in-app twin of the embed's hero: a REAL Togo
 *  silhouette, the "Togo Configurator" wordmark in Rauschen, eyebrow in Söhne and
 *  body in Lausanne. Opens the configurator in a NEW TAB. */
function TogoLaunchCard({ href }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="group no-underline w-full max-w-sm flex flex-col items-center text-center rounded-2xl border border-ink-200 bg-[#f4f1ec] p-7 shadow-soft hover:shadow-pop hover:-translate-y-0.5 active:translate-y-0 transition-all"
    >
      <span className="eyebrow text-ink-400">Ligne Roset</span>
      <span
        className="block w-full max-w-[15rem] text-ink-800 mt-3 [&>svg]:w-full [&>svg]:h-auto"
        aria-hidden
        dangerouslySetInnerHTML={{ __html: togoHeroSvg }}
      />
      <span className="block font-wordmark text-2xl sm:text-3xl leading-none tracking-tight text-ink-900 mt-4">Togo Configurator</span>
      <span className="block font-sans text-xs text-ink-500 mt-2 max-w-xs leading-relaxed">Arma tu sofá modular, pruébalo en distintas telas y recibe tu cotización al instante.</span>
      <span className="inline-flex items-center gap-2 mt-5 rounded-full bg-ink-900 text-white px-5 py-2.5 text-sm group-hover:bg-ink-800 transition">
        Empezar a diseñar <ArrowRight size={16} className="transition-transform group-hover:translate-x-1" />
      </span>
    </a>
  );
}
