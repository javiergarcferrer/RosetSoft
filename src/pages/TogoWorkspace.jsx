import { useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Sofa, Inbox, Boxes } from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import { useLiveQuery } from '../db/hooks.js';
import { db } from '../db/database.js';
import PageHeader from '../components/PageHeader.jsx';
import TogoBuilder from './TogoConfigurator.jsx';
import TogoRequests from './TogoRequests.jsx';
import TogoModels from './admin/TogoCatalog.jsx';

/**
 * The single Togo workspace — everything Togo in ONE pane, no more jumping
 * between /togo (builder) and /admin/catalog/togo (models). Three tabs:
 *   • Configurador — drag pieces in a top-down plan → a draft quote.
 *   • Solicitudes  — the inbox of web leads (togo_requests) the embedded widget
 *                    captures, held here until the dealer promotes them.
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

      {active === 'configurador' && <TogoBuilder onManageModels={isAdmin ? () => go('modelos') : undefined} />}
      {active === 'solicitudes' && <TogoRequests />}
      {active === 'modelos' && isAdmin && <TogoModels />}
    </div>
  );
}
