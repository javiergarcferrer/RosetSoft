import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bug, X, Trash2, Copy, Check, ChevronRight } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import { getErrors, subscribe, clearErrors } from '../../lib/errorLog.js';

const TYPE_BADGE = {
  handled: 'bg-ink-500/15 text-ink-500',
  window: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  promise: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  render: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  error: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
};
const TYPE_LABEL = {
  handled: 'gestionado', window: 'no capturado', promise: 'promesa', render: 'render', error: 'error',
};

function fmtTime(at) {
  const d = new Date(at);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const t = d.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return sameDay ? t : `${d.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit' })} ${t}`;
}

function Field({ label, value, mono }) {
  if (value == null || value === '') return null;
  return (
    <div className="mt-2">
      <div className="eyebrow-xs text-ink-400 mb-1">{label}</div>
      <pre className={`surface-subtle rounded-md p-2 text-[11px] leading-relaxed text-ink-700 whitespace-pre-wrap break-words overflow-x-auto max-h-72 ${mono ? 'font-mono' : ''}`}>{String(value)}</pre>
    </div>
  );
}

function Row({ e }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const badge = TYPE_BADGE[e.type] || TYPE_BADGE.error;
  const copy = async (ev) => {
    ev.stopPropagation();
    try { await navigator.clipboard.writeText(JSON.stringify(e, null, 2)); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* clipboard blocked */ }
  };
  return (
    <li className="border-b border-ink-100">
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full text-left px-3.5 py-2.5 flex items-start gap-2 hover:bg-ink-50 transition-colors">
        <ChevronRight size={14} className={`mt-0.5 shrink-0 text-ink-300 transition-transform ${open ? 'rotate-90' : ''}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`inline-flex shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${badge}`}>{TYPE_LABEL[e.type] || e.type}</span>
            {e.fn && <span className="text-[11px] font-mono text-ink-500">{e.fn}</span>}
            {e.status !== '' && e.status != null && <span className="text-[11px] font-mono text-rose-600">{e.status}</span>}
            <span className="ml-auto text-[10px] tabular-nums text-ink-400">{fmtTime(e.at)}</span>
          </div>
          <div className="text-xs text-ink-800 mt-0.5 break-words line-clamp-2">{e.message}</div>
        </div>
        <span onClick={copy} role="button" tabIndex={0} aria-label="Copiar" className="shrink-0 -m-1 p-1 text-ink-400 hover:text-ink-700">
          {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
        </span>
      </button>
      {open && (
        <div className="px-3.5 pb-3 -mt-0.5">
          <Field label="Mensaje" value={e.message} />
          <Field label="Respuesta del servidor" value={e.response} mono />
          <Field label="Request" value={e.request} mono />
          <Field label="Stack" value={e.stack} mono />
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-ink-400 font-mono">
            {e.table && <span>tabla: {e.table}</span>}
            {e.source && <span>origen: {e.source}</span>}
            {e.name && <span>{e.name}</span>}
            {e.url && <span className="break-all">{e.url}</span>}
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * Admin-only error console — a floating bug button (badge = captured count) that
 * opens a full-height panel listing recent failures with their FULL request +
 * server response + stack, copyable. Lives off the device-local ring buffer
 * (lib/errorLog); nothing leaves the device. A developer aid, gated to admins.
 */
export default function ErrorConsole() {
  const { isAdmin } = useApp();
  const [list, setList] = useState(getErrors);
  const [open, setOpen] = useState(false);

  useEffect(() => subscribe(setList), []);

  if (!isAdmin) return null;
  const count = list.length;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Consola de errores"
        className={`fixed left-[max(0.75rem,env(safe-area-inset-left))] bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[70] inline-flex items-center justify-center w-10 h-10 rounded-full border border-ink-200 bg-surface shadow-pop transition-opacity ${count ? 'opacity-90' : 'opacity-35 hover:opacity-80'}`}
      >
        <Bug size={16} className={count ? 'text-rose-600' : 'text-ink-500'} />
        {count > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-rose-600 text-white text-[10px] font-semibold inline-flex items-center justify-center tabular-nums">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && createPortal(
        <div className="fixed inset-0 z-[95] flex justify-end bg-black/40" onClick={() => setOpen(false)}>
          <div
            className="w-full sm:max-w-lg h-full bg-surface border-l border-ink-200 flex flex-col shadow-2xl animate-in slide-in-from-right-4 duration-200"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-3.5 py-3 border-b border-ink-100">
              <Bug size={16} className="text-ink-500" />
              <div className="font-display font-semibold text-ink-900">Consola de errores</div>
              <span className="text-xs text-ink-400 tabular-nums">{count}</span>
              <div className="ml-auto flex items-center gap-1">
                <button type="button" onClick={() => { if (count) clearErrors(); }} disabled={!count} className="btn-ghost text-xs disabled:opacity-40" title="Limpiar todo">
                  <Trash2 size={14} /> Limpiar
                </button>
                <button type="button" onClick={() => setOpen(false)} className="btn-icon" aria-label="Cerrar"><X size={16} /></button>
              </div>
            </div>
            {count === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center text-ink-400 p-8">
                <Bug size={26} className="mb-2 opacity-50" />
                <div className="text-sm">Sin errores registrados.</div>
                <div className="text-xs mt-1">Lo que falle aparecerá aquí con su respuesta completa.</div>
              </div>
            ) : (
              <ul className="flex-1 overflow-y-auto overscroll-contain">
                {list.map((e) => <Row key={e.id} e={e} />)}
              </ul>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
