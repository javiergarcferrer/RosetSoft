import { useEffect, useState } from 'react';
import { Bug, Trash2, Copy, Check, ChevronRight } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import Modal from '../Modal.jsx';
import DevTodos from './DevTodos.jsx';
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
  const sameDay = d.toDateString() === new Date().toDateString();
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
      <div className="w-full flex items-start gap-2 px-4 py-2.5">
        <button type="button" onClick={() => setOpen((v) => !v)} className="min-w-0 flex-1 text-left flex items-start gap-2">
          <ChevronRight size={14} className={`mt-0.5 shrink-0 text-ink-300 transition-transform ${open ? 'rotate-90' : ''}`} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 flex-wrap">
              <span className={`inline-flex shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${badge}`}>{TYPE_LABEL[e.type] || e.type}</span>
              {e.fn && <span className="text-[11px] font-mono text-ink-500 truncate">{e.fn}</span>}
              {e.status !== '' && e.status != null && <span className="text-[11px] font-mono text-rose-600">{e.status}</span>}
              <span className="ml-auto text-[10px] tabular-nums text-ink-400 shrink-0">{fmtTime(e.at)}</span>
            </span>
            <span className="block text-xs text-ink-800 mt-0.5 break-words line-clamp-2">{e.message}</span>
          </span>
        </button>
        <button type="button" onClick={copy} aria-label="Copiar" className="shrink-0 btn-icon text-ink-400 hover:text-ink-700">
          {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
        </button>
      </div>
      {open && (
        <div className="px-4 pb-3 pl-10">
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
 * opens the shared Modal primitive (sheet on mobile, dialog on desktop; handles
 * safe-areas, scroll-lock and Escape for us) listing recent failures with their
 * FULL request + server response + stack, copyable. Backed by the device-local
 * ring buffer (lib/errorLog); nothing leaves the device. Gated to admins.
 */
export default function ErrorConsole() {
  const { isAdmin } = useApp();
  const [list, setList] = useState(getErrors);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('errores');

  useEffect(() => subscribe(setList), []);

  if (!isAdmin) return null;
  const count = list.length;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Consola de errores"
        className={`fixed left-[max(0.75rem,env(safe-area-inset-left))] bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[55] inline-flex items-center justify-center w-10 h-10 rounded-full border border-ink-200 bg-surface shadow-pop transition-opacity ${count ? 'opacity-90' : 'opacity-35 hover:opacity-80'}`}
      >
        <Bug size={16} className={count ? 'text-rose-600' : 'text-ink-500'} />
        {count > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-rose-600 text-white text-[10px] font-semibold inline-flex items-center justify-center tabular-nums">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="Consola de desarrollo" size="lg" flushBody>
        <div className="flex items-center gap-1 px-3 pt-1 shrink-0 border-b border-ink-100">
          {[['errores', `Errores${count ? ` (${count})` : ''}`], ['pendientes', 'Pendientes']].map(([key, label]) => (
            <button
              key={key} type="button" onClick={() => setTab(key)}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === key ? 'border-ink-900 text-ink-900' : 'border-transparent text-ink-500 hover:text-ink-800'}`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'pendientes' ? (
          <DevTodos />
        ) : count === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center text-ink-400 p-8">
            <Bug size={26} className="mb-2 opacity-50" />
            <div className="text-sm">Sin errores registrados.</div>
            <div className="text-xs mt-1">Lo que falle aparecerá aquí con su respuesta completa.</div>
          </div>
        ) : (
          <div className="flex flex-col flex-1 min-h-0">
            <div className="flex items-center px-4 py-1.5 border-b border-ink-100 shrink-0">
              <button type="button" onClick={() => clearErrors()} className="btn-ghost text-xs ml-auto">
                <Trash2 size={14} /> Limpiar
              </button>
            </div>
            <ul className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
              {list.map((e) => <Row key={e.id} e={e} />)}
            </ul>
          </div>
        )}
      </Modal>
    </>
  );
}
