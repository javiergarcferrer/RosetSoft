import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, ChevronDown } from 'lucide-react';
import { QUICK_CREATE } from '../lib/accountingSections.js';

/**
 * QuickBooks-style "+ Nuevo" quick-create button — sits above the sidebar nav
 * and drops a grouped menu (Clientes / Proveedores / Empleados / Otros). Each
 * action routes to the page that owns the create flow (with `?new=…` so the
 * form opens immediately).
 */
export default function QuickCreate() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onEsc(e) { if (e.key === 'Escape') setOpen(false); }
    if (open) {
      document.addEventListener('mousedown', onDoc);
      document.addEventListener('keydown', onEsc);
    }
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  function go(to) { setOpen(false); navigate(to); }

  return (
    <div className="px-3 pt-3 relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="btn-brand w-full"
      >
        <Plus size={15} strokeWidth={2.5} aria-hidden />
        Nuevo
        <ChevronDown
          size={13}
          strokeWidth={2.5}
          aria-hidden
          className={`ml-auto opacity-60 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="dropdown-pop absolute left-0 right-0 z-50 mt-2 w-auto min-w-[12rem] rounded-xl bg-surface text-ink-800 shadow-pop border border-ink-100/80 ring-1 ring-inset ring-black/[0.03] py-2 max-h-[70vh] overflow-y-auto">
          {QUICK_CREATE.map((col, gi) => (
            <div key={col.group} className={gi > 0 ? 'mt-0.5 pt-1.5 border-t border-ink-100/60' : ''}>
              <div className="eyebrow-xs text-ink-400 px-3 pt-0.5 pb-1">{col.group}</div>
              {col.items.map((it) => (
                <button
                  key={it.label}
                  type="button"
                  onClick={() => go(it.to)}
                  className="flex items-center text-left text-sm py-2 coarse:py-2.5 px-3 rounded-lg mx-1 w-[calc(100%-0.5rem)] text-ink-700 hover:bg-ink-50 hover:text-ink-900 active:bg-ink-100 transition-colors"
                >
                  {it.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
