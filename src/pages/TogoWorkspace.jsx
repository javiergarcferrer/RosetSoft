import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useNavigate } from 'react-router-dom';
import { Inbox, Boxes, ExternalLink, Copy, Check, X, ArrowRight, Maximize2 } from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import { useLiveQuery } from '../db/hooks.js';
import { db } from '../db/database.js';
import { togoEmbedUrl, togoEmbedModalUrl, togoEmbedSnippet, TOGO_EMBED_ALLOW } from '../lib/togoEmbed.js';
import TogoIcon from '../lib/icons/TogoIcon.jsx';
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
  const [open, setOpen] = useState(false);
  const url = togoEmbedUrl();
  const copy = async () => {
    try { await navigator.clipboard.writeText(togoEmbedSnippet()); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-500">
          Así lo ven tus clientes en tu web: un <b className="text-ink-700">card</b> que abre el configurador a <b className="text-ink-700">pantalla completa</b>.
        </p>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={copy} className="btn-ghost text-xs">{copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />} {copied ? 'Copiado' : 'Copiar código'}</button>
          <a href={url} target="_blank" rel="noreferrer" className="btn-ghost text-xs"><ExternalLink size={14} /> Abrir</a>
        </div>
      </div>

      {/* The launch card, on a soft "page" backdrop so it reads as it would on
          the dealer's site. Clicking it opens the fullscreen modal. */}
      <div className="grid place-items-center rounded-2xl border border-ink-200 bg-ink-50/60 px-4 py-12 sm:py-16">
        <TogoLaunchCard onOpen={() => setOpen(true)} />
      </div>

      <TogoConfiguratorModal open={open} url={togoEmbedModalUrl()} onClose={() => setOpen(false)} />
    </div>
  );
}

/** The attractive "Configura tu Togo" launch card — the in-app twin of the
 *  embed snippet's card. Clicking it opens the fullscreen configurator modal. */
function TogoLaunchCard({ onOpen }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group w-full max-w-lg flex items-center gap-4 text-left rounded-2xl border border-ink-200 bg-surface p-4 sm:p-5 shadow-soft hover:shadow-pop hover:-translate-y-0.5 active:translate-y-0 transition-all"
    >
      <span className="shrink-0 w-20 h-20 sm:w-24 sm:h-24 rounded-xl bg-ink-900 text-white grid place-items-center">
        <TogoIcon size={44} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] font-semibold tracking-[0.13em] text-ink-400 uppercase">Ligne Roset · Togo</span>
        <span className="block font-display font-semibold text-lg sm:text-xl text-ink-900 leading-tight mt-0.5">Diseña tu Togo a tu medida</span>
        <span className="block text-xs text-ink-500 mt-1 leading-relaxed">Arma tu sofá modular, pruébalo en distintas telas y recibe tu cotización al instante.</span>
        <span className="inline-flex items-center gap-1.5 mt-2.5 text-sm font-semibold text-ink-900">
          Configurar mi Togo <ArrowRight size={16} className="transition-transform group-hover:translate-x-1" />
        </span>
      </span>
    </button>
  );
}

/** The fullscreen configurator modal — a portalled `fixed inset-0` overlay with a
 *  slim close bar over the live embed iframe. Esc / the X close it; body scroll
 *  locks while open. Mirrors the embed snippet's popup so in-app == on-site. */
function TogoConfiguratorModal({ open, url, onClose }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col bg-surface animate-in fade-in duration-200" role="dialog" aria-modal="true" aria-label="Configurador Togo">
      <div className="flex items-center justify-between h-12 px-2.5 pl-4 border-b border-ink-200 bg-surface shrink-0">
        <span className="inline-flex items-center gap-2 text-sm font-display font-semibold text-ink-800">
          <Maximize2 size={14} className="text-brand-500" /> Configura tu Togo
        </span>
        <button type="button" onClick={onClose} className="btn-icon text-ink-500 hover:text-ink-800 hover:bg-ink-100" aria-label="Cerrar">
          <X size={18} />
        </button>
      </div>
      <iframe
        src={url}
        title="Configurador Togo"
        className="flex-1 w-full border-0 block bg-surface"
        allow={TOGO_EMBED_ALLOW}
        allowFullScreen
      />
    </div>,
    document.body,
  );
}
