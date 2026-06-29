// The accounting "needs attention" center — the single View for every surface
// that renders the prioritized cockpit actions (`resolveAccountingCockpit`).
// Both the Resumen dashboard (vertical ActionList) and the Facturación header
// (horizontal ActionChips) render through here, so the severity skin, the icon
// per kind, and the human copy can NEVER drift between the two. Pure
// presentational: the page resolves the cockpit and hands the actions in.
import { Link, useNavigate } from 'react-router-dom';
import {
  FileWarning, CalendarClock, ArrowUpCircle, ArrowDownCircle,
  FileText, Lock, AlertTriangle,
} from 'lucide-react';
import { formatDop, formatDate } from '../../lib/format.js';

// Severity skins (danger → warn → info), shared so the dashboard list and the
// Facturación strip read the same color language.
// Alpha backgrounds + a dark: text variant so the skins read on BOTH canvases
// (flat rose-50/amber-50 glare on the dark canvas — mirrors MetaReceiptsQueue).
export const SEV_SKIN = {
  danger: 'bg-rose-500/10 text-rose-800 dark:text-rose-300 border-rose-500/20',
  warn: 'bg-amber-500/10 text-amber-800 dark:text-amber-300 border-amber-500/20',
  info: 'bg-ink-500/10 text-ink-700 border-ink-500/20',
};

// Icon per action kind; AlertTriangle is the fallback for an unknown kind.
export const ACTION_ICON = {
  ecfSeq: FileWarning, ecf: FileWarning, deadline: CalendarClock,
  payable: ArrowUpCircle, receivable: ArrowDownCircle, invoice: FileText, periodClose: Lock,
};

// One prioritized cockpit action → its human sentence. The only dependency is
// the money/date formatting, so the copy stays identical on every surface.
export function actionText(a) {
  switch (a.kind) {
    case 'ecfSeq':
      if (a.seqKind === 'none') return `Sin secuencia e-NCF utilizable para ${a.name} — autoriza un rango`;
      if (a.seqKind === 'low') return `Quedan ${a.remaining} e-NCF de ${a.name}`;
      return `La secuencia e-NCF de ${a.name} vence el ${formatDate(a.expiresAt)}`;
    case 'ecf': return `${a.count} e-CF por transmitir a la DGII`;
    case 'deadline': return `${a.name} vence ${a.daysLeft === 0 ? 'hoy' : a.daysLeft === 1 ? 'mañana' : `en ${a.daysLeft} días`} · ${a.periodLabel}`;
    case 'payable': return `${formatDop(a.amount)} en cuentas por pagar vencidas`;
    case 'receivable': return `${formatDop(a.amount)} en cuentas por cobrar vencidas`;
    case 'invoice': return `${a.count} cotización${a.count === 1 ? '' : 'es'} aceptada${a.count === 1 ? '' : 's'} por facturar`;
    case 'periodClose': return `Cierra ${a.label} — el mes anterior sigue abierto`;
    default: return '';
  }
}

/**
 * Vertical action list — the dashboard's "Pendientes" command center. Each row
 * links to the surface that resolves it.
 */
export function ActionList({ actions }) {
  return (
    <ul className="space-y-1.5">
      {actions.map((a) => {
        const Icon = ACTION_ICON[a.kind] || AlertTriangle;
        return (
          <li key={a.id}>
            <Link to={a.to} className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm shadow-xs hover:shadow-sm transition-shadow ${SEV_SKIN[a.severity]}`}>
              <Icon size={15} className="shrink-0" />
              <span className="min-w-0 flex-1 break-words">{actionText(a)}</span>
              <span className="shrink-0 opacity-50">→</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Horizontal attention strip — the same prioritized actions as a scannable,
 * scrollable chip row for an in-context header (Facturación). `onSelect(a)` lets
 * the host resolve an action in-page (e.g. switch tab) and return `true` to skip
 * navigation; anything it doesn't claim routes to the action's own surface.
 */
export function ActionChips({ actions, onSelect }) {
  const navigate = useNavigate();
  if (!actions?.length) return null;
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 mb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {actions.map((a) => {
        const Icon = ACTION_ICON[a.kind] || AlertTriangle;
        return (
          <button key={a.id} type="button"
            onClick={() => { if (!onSelect?.(a)) navigate(a.to); }}
            className={`inline-flex items-center gap-2 shrink-0 rounded-full border px-3 py-1.5 text-sm shadow-xs hover:shadow-sm transition-shadow ${SEV_SKIN[a.severity]}`}>
            <Icon size={14} className="shrink-0" />
            <span className="whitespace-nowrap">{actionText(a)}</span>
          </button>
        );
      })}
    </div>
  );
}
