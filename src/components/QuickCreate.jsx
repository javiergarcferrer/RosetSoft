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
        className="w-full inline-flex items-center justify-center gap-1.5 bg-white text-ink-900 font-semibold rounded-md px-3 py-2 text-sm hover:bg-ink-100 active:bg-ink-200 transition-colors"
      >
        <Plus size={16} /> Nuevo <ChevronDown size={13} className="opacity-50" />
      </button>
      {open && (
        <div className="absolute left-3 z-50 mt-1 w-[min(18rem,calc(100vw-2.5rem))] rounded-lg bg-white text-ink-800 shadow-pop border border-ink-200 p-2.5 max-h-[70vh] overflow-y-auto">
          {QUICK_CREATE.map((col) => (
            <div key={col.group} className="mb-2 last:mb-0">
              <div className="text-[10px] uppercase tracking-widest text-ink-400 px-1.5 mb-0.5">{col.group}</div>
              {col.items.map((it) => (
                <button
                  key={it.label}
                  type="button"
                  onClick={() => go(it.to)}
                  className="block w-full text-left text-sm py-1.5 px-1.5 rounded hover:bg-ink-50"
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
