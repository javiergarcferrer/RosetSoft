import { createContext, useCallback, useContext, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertCircle, Info } from 'lucide-react';
import Modal from './Modal.jsx';

/**
 * App-wide confirm dialog + toast — the styled, in-app replacement for native
 * window.confirm / window.alert that clashed with the design system and were
 * easy to mis-tap on mobile.
 *
 *   const confirm = useConfirm();
 *   if (await confirm({ title, message, confirmLabel, tone: 'danger' })) { … }
 *
 *   const toast = useToast();
 *   toast('Enlace copiado');            // success (default)
 *   toast('No se pudo copiar', { tone: 'error' });
 *
 * Mounted once high in the tree (App). The dialog is promise-based: confirm()
 * resolves true on confirm, false on cancel / backdrop / Escape.
 */
const ConfirmCtx = createContext(async () => false);
const ToastCtx = createContext(() => {});

export function useConfirm() { return useContext(ConfirmCtx); }
export function useToast() { return useContext(ToastCtx); }

let toastSeq = 0;

export function ConfirmProvider({ children }) {
  const [dialog, setDialog] = useState(null); // { opts, resolve }
  const [toasts, setToasts] = useState([]);

  const confirm = useCallback((opts = {}) => new Promise((resolve) => {
    setDialog({ opts: typeof opts === 'string' ? { message: opts } : opts, resolve });
  }), []);

  function settle(val) {
    if (dialog) dialog.resolve(val);
    setDialog(null);
  }

  const toast = useCallback((message, opts = {}) => {
    const id = ++toastSeq;
    const duration = opts.duration ?? 2800;
    setToasts((ts) => [...ts, { id, message, tone: opts.tone || 'success' }]);
    if (duration > 0) setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), duration);
    return id;
  }, []);

  const o = dialog?.opts || {};
  const danger = o.tone === 'danger';

  return (
    <ConfirmCtx.Provider value={confirm}>
      <ToastCtx.Provider value={toast}>
        {children}
        <Modal
          open={!!dialog}
          onClose={() => settle(false)}
          title={o.title || 'Confirmar'}
          size="sm"
          footer={(
            <>
              <button type="button" className="btn-ghost" onClick={() => settle(false)}>{o.cancelLabel || 'Cancelar'}</button>
              <button
                type="button"
                onClick={() => settle(true)}
                className={danger
                  ? 'inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium bg-rose-600 text-white hover:bg-rose-700 transition-colors'
                  : 'btn-primary'}
              >
                {o.confirmLabel || 'Confirmar'}
              </button>
            </>
          )}
        >
          {o.message && <p className="text-sm text-ink-700 whitespace-pre-line leading-relaxed">{o.message}</p>}
        </Modal>
        {toasts.length > 0 && createPortal(
          <div className="fixed inset-x-0 bottom-4 z-[90] flex flex-col items-center gap-2 px-4 pointer-events-none">
            {toasts.map((t) => {
              const Icon = t.tone === 'error' ? AlertCircle : t.tone === 'info' ? Info : CheckCircle2;
              const cls = t.tone === 'error' ? 'text-rose-600' : t.tone === 'info' ? 'text-ink-500' : 'text-emerald-600';
              return (
                <div key={t.id} className="pointer-events-auto flex items-center gap-2 rounded-lg bg-surface border border-ink-200 shadow-pop px-3.5 py-2.5 text-sm text-ink-800 animate-in fade-in slide-in-from-bottom-2 duration-200 max-w-md">
                  <Icon size={16} className={`${cls} shrink-0`} aria-hidden />
                  <span className="min-w-0">{t.message}</span>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
      </ToastCtx.Provider>
    </ConfirmCtx.Provider>
  );
}
