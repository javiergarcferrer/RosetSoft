import { Archive, ChevronDown, FileText, Inbox, Loader2, Mail, MailOpen, Paperclip, Search, Star, Trash2 } from 'lucide-react';
import EmptyState from '../EmptyState.jsx';
import {
  GMAIL_BRAND_TABS, formatGmailDate, senderInitials, avatarColorIndex,
} from '../../core/crm/index.js';

// Deterministic avatar palette — index chosen by avatarColorIndex(email), so a
// sender keeps their color across renders/sessions. Muted-100 backgrounds so
// the initials read in both themes.
const AVATAR_TONES = [
  'bg-brand-100 text-brand-800',
  'bg-emerald-100 text-emerald-700',
  'bg-amber-100 text-amber-700',
  'bg-sky-100 text-sky-700',
  'bg-violet-100 text-violet-700',
  'bg-rose-100 text-rose-700',
];

const EMPTY_BY_TAB = {
  'ligne-roset': 'No hay correos de Ligne Roset.',
  proveedores: 'No hay correspondencia de proveedores.',
  finanzas: 'No hay correos de bancos, cobros ni facturación.',
  operaciones: 'No hay correos de logística, flota ni personal.',
  boletines: 'No hay boletines — el correo masivo se archiva solo aquí.',
  otros: 'No hay correos sin clasificar.',
};

function tabLabel(id) {
  return GMAIL_BRAND_TABS.find((t) => t.id === id)?.label || 'Otros';
}

/** One hover quick-action (desktop) — a compact icon button over the row. */
function QuickAction({ label, onClick, children }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-500 hover:bg-ink-100 hover:text-ink-800"
    >
      {children}
    </button>
  );
}

/**
 * The Gmail inbox's thread list — sender avatars (deterministic colors), unread
 * weight, relative dates, attachment/invoice chips, hover quick-actions
 * (star / read / archive / trash) and a "load older mail" tail. Pure View: all
 * row data comes pre-derived from resolveGmailThreads; actions bubble up.
 */
export default function ThreadList({ threads, selectedId, onOpen, brandTab, needle = '', onRowAction, older }) {
  if (!threads.length) {
    return (
      <div className="flex-1 overflow-y-auto">
        <EmptyState
          icon={needle ? Search : Inbox}
          title={needle ? 'Sin resultados' : 'Sin correos'}
          description={needle
            ? `Ningún correo coincide con «${needle}» en ${tabLabel(brandTab)}.`
            : (EMPTY_BY_TAB[brandTab] || `No hay correos en ${tabLabel(brandTab)}.`)}
        />
        {older?.visible && <LoadOlder older={older} />}
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto overscroll-contain">
      <ul className="divide-y divide-ink-100">
        {threads.map((t) => {
          const selected = selectedId === t.threadId;
          const tone = AVATAR_TONES[avatarColorIndex(t.fromEmail || t.fromName, AVATAR_TONES.length)];
          return (
            <li key={t.threadId} className="group relative">
              <button
                type="button"
                onClick={() => onOpen(t.threadId)}
                className={`w-full text-left pl-3 pr-3.5 py-3 flex items-start gap-2.5 transition ${
                  selected ? 'bg-brand-50/70' : 'hover:bg-ink-50'
                } ${t.unread ? '' : ''}`}
              >
                <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[0.7rem] font-semibold ${tone}`}>
                  {senderInitials(t.fromName, t.fromEmail)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={`truncate text-sm ${t.unread ? 'font-semibold text-ink-900' : 'text-ink-700'}`}>
                      {t.fromName || t.fromEmail || 'Desconocido'}
                      {t.count > 1 && <span className="ml-1 text-xs font-normal text-ink-400 tabular-nums">{t.count}</span>}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span className={`text-xs tabular-nums ${t.unread ? 'font-semibold text-brand-700' : 'text-ink-400'} md:group-hover:invisible`}>
                        {formatGmailDate(t.lastAt)}
                      </span>
                      {t.unread > 0 && <span className="h-2 w-2 rounded-full bg-brand-600 md:group-hover:invisible" aria-label="no leído" />}
                    </span>
                  </span>
                  <span className={`block truncate text-sm ${t.unread ? 'font-medium text-ink-900' : 'text-ink-600'}`}>{t.subject}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-ink-400 line-clamp-2">{t.snippet}</span>
                  {(t.starred || t.hasInvoice || t.hasAttachment) && (
                    <span className="mt-1 flex items-center gap-2">
                      {t.starred && <Star size={11} className="shrink-0 fill-amber-400 text-amber-400" aria-label="destacado" />}
                      {t.hasAttachment && <Paperclip size={11} className="shrink-0 text-ink-400" aria-label="con adjunto" />}
                      {t.hasInvoice && (
                        <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[0.65rem] font-medium text-amber-700">
                          <FileText size={11} /> Factura
                        </span>
                      )}
                    </span>
                  )}
                </span>
              </button>
              {/* Hover quick-actions (fine pointers only) — float over the date
                  corner so the row itself never reflows. */}
              {onRowAction && (
                <div className="absolute right-2 top-2 hidden items-center gap-0.5 rounded-lg border border-ink-100 bg-surface px-0.5 py-0.5 shadow-soft md:group-hover:flex md:group-focus-within:flex">
                  <QuickAction label={t.starred ? 'Quitar estrella' : 'Destacar'} onClick={() => onRowAction(t, 'star')}>
                    <Star size={14} className={t.starred ? 'fill-amber-400 text-amber-400' : ''} />
                  </QuickAction>
                  <QuickAction label={t.unread ? 'Marcar leído' : 'Marcar no leído'} onClick={() => onRowAction(t, 'read')}>
                    {t.unread ? <MailOpen size={14} /> : <Mail size={14} />}
                  </QuickAction>
                  <QuickAction label="Archivar" onClick={() => onRowAction(t, 'archive')}>
                    <Archive size={14} />
                  </QuickAction>
                  <QuickAction label="Mover a papelera" onClick={() => onRowAction(t, 'trash')}>
                    <Trash2 size={14} />
                  </QuickAction>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {older?.visible && <LoadOlder older={older} />}
    </div>
  );
}

/** The list's tail — pulls mail older than the mirror's window on demand. */
function LoadOlder({ older }) {
  if (older.exhausted) {
    return <p className="px-4 py-3 text-center text-xs text-ink-400">No hay correos más antiguos.</p>;
  }
  return (
    <div className="px-3 py-2.5">
      <button
        type="button"
        onClick={older.onLoadMore}
        disabled={older.loading}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-ink-200 bg-surface px-3 py-2 text-xs font-medium text-ink-600 hover:bg-ink-50 disabled:opacity-60"
      >
        {older.loading ? <Loader2 size={14} className="animate-spin" /> : <ChevronDown size={14} />}
        {older.loading ? 'Buscando correos anteriores…' : 'Cargar correos anteriores'}
      </button>
    </div>
  );
}
