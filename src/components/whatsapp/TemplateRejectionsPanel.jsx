import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, XCircle } from 'lucide-react';
import { db } from '../../db/database.js';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { resolveTemplateHealth } from '../../core/crm/index.js';
import { useApp } from '../../context/AppContext.jsx';
import { formatDateTime } from '../../lib/format.js';

/**
 * The durable record of templates Meta REJECTED — and the exact reason why —
 * so the dealer can fix and resubmit. wa-webhook persists each rejection
 * (name, language, reason) into wa_template_rejections on the
 * message_template_status_update event; this panel reads them live and runs the
 * reasons through resolveTemplateHealth (the shared VM that maps Meta's machine
 * codes to dealer-readable Spanish). Mount it on the Difusión "Plantillas" tab.
 */
export default function TemplateRejectionsPanel() {
  const { profileId } = useApp();
  const { data: rejections } = useLiveQueryStatus(
    () => db.waTemplateRejections.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );

  // Feed the durable rows into the shared health VM (each is a REJECTED
  // "template"), so the Spanish reason mapping lives in one place. Newest first.
  const rows = useMemo(() => {
    const sorted = [...(rejections || [])].sort(
      (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
    );
    const asTemplates = sorted.map((r) => ({
      name: r.templateName,
      language: r.language,
      status: 'REJECTED',
      rejectedReason: r.rejectedReason || '',
    }));
    const health = resolveTemplateHealth(asTemplates, sorted);
    // Re-attach updatedAt for display (VM is presentation-agnostic).
    return health.map((h, i) => ({ ...h, updatedAt: sorted[i]?.updatedAt || null }));
  }, [rejections]);

  if (!rows.length) return null;

  return (
    <div className="card card-pad">
      <div className="flex items-center gap-2 mb-1">
        <XCircle size={16} className="text-rose-600" aria-hidden />
        <div className="font-display text-sm font-semibold text-ink-900">Plantillas rechazadas por Meta</div>
      </div>
      <p className="text-xs text-ink-500 mb-3">
        Meta rechazó estas plantillas. Corrige el motivo y vuelve a enviarlas a revisión (crea una
        nueva con el mismo contenido ajustado).
      </p>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={`${r.name}:${r.language}`} className="rounded-lg ring-1 ring-inset ring-rose-100 bg-rose-50/40 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-medium text-ink-900">{r.name}</span>
              {r.language && <span className="text-[10px] text-ink-400 uppercase">{r.language}</span>}
              <span className="text-[10px] font-semibold rounded px-1.5 py-0.5 bg-rose-100 text-rose-700">Rechazada</span>
              {r.updatedAt && <span className="ml-auto text-[10px] text-ink-400">{formatDateTime(r.updatedAt)}</span>}
            </div>
            {r.reason ? (
              <p className="text-xs text-rose-700 mt-1 flex items-start gap-1.5">
                <AlertTriangle size={12} className="mt-px shrink-0" />
                <span className="min-w-0">{r.reason}{r.reasonCode ? <span className="text-rose-400"> ({r.reasonCode})</span> : null}</span>
              </p>
            ) : (
              <p className="text-xs text-ink-500 mt-1">
                Meta no detalló el motivo. Revisa la plantilla en{' '}
                <Link to="/settings" className="text-emerald-700 hover:underline">WhatsApp Manager</Link>.
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
