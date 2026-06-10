import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, Check, ChevronDown } from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';

// The roles an admin can preview the app as. 'admin' is the "back to
// normal" entry (clears the override); the other two re-gate the whole UI
// to what that role actually sees. Labels/hints mirror the Spanish used
// elsewhere in the app (Empleado = vendedor, Contabilidad = área de cuentas).
const VIEW_OPTIONS = [
  { value: 'admin', label: 'Administrador', hint: 'Tu vista normal' },
  { value: 'employee', label: 'Empleado', hint: 'Vendedor del equipo' },
  { value: 'accounting', label: 'Contabilidad', hint: 'Solo el área de cuentas' },
];

/**
 * Admin-only "Ver como" control. Tucked just under the sidebar brand block
 * so it stays discreet (out of the way of daily work) yet always reachable:
 * critically it gates on the *real* admin role, not the simulated one, so an
 * admin previewing a lesser role can always switch back. Picking a role
 * flips the whole app via AppContext.setViewAsRole and drops the admin on
 * that role's home, so the preview starts where that user would land
 * (Contabilidad, for instance, redirects to its own workspace).
 *
 * Desktop only — the brand asked for it on the desktop shell, and keeping it
 * out of the mobile drawer also avoids any chance of a small-screen admin
 * being stranded in a simulated role with the toggle off-screen.
 */
export default function ViewAsToggle() {
  const { canViewAs, viewAsRole, setViewAsRole } = useApp();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const navigate = useNavigate();

  // Close on outside pointer / Escape — same lightweight pattern as the
  // sibling ProfileMenu below it (no portal needed; the panel overlays the
  // top of the nav).
  useEffect(() => {
    if (!open) return undefined;
    function onPointer(e) {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!canViewAs) return null;

  const active = viewAsRole || 'admin';
  const activeLabel = VIEW_OPTIONS.find((o) => o.value === active)?.label;
  const previewing = !!viewAsRole;

  function pick(value) {
    setOpen(false);
    setViewAsRole(value === 'admin' ? null : value);
    // Land on the role's own home so the preview reflects where that user
    // actually starts (RoleHome sends accounting to its workspace, etc.).
    navigate('/');
  }

  return (
    <div ref={rootRef} className="hidden md:block relative px-2 py-2 border-b border-ink-800">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Ver la aplicación como otro rol"
        className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-xs transition-colors ${
          previewing
            ? 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25'
            : 'text-ink-500 hover:bg-ink-800 hover:text-ink-300'
        }`}
      >
        <Eye size={13} className="flex-shrink-0" />
        <span className="min-w-0 flex-1 text-left truncate">
          {previewing ? (
            <>Viendo como <b className="font-semibold">{activeLabel}</b></>
          ) : (
            'Ver como…'
          )}
        </span>
        <ChevronDown
          size={13}
          className={`flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="dropdown-pop absolute left-2 right-2 top-full z-50 mt-1 rounded-md border border-ink-700 bg-ink-800 py-1 shadow-pop"
        >
          <div className="px-3 py-1.5 eyebrow-xs font-normal tracking-wide text-ink-400">
            Ver la app como
          </div>
          {VIEW_OPTIONS.map((o) => {
            const isActive = o.value === active;
            return (
              <button
                key={o.value}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                onClick={() => pick(o.value)}
                className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-ink-700"
              >
                <Check
                  size={14}
                  className={`mt-0.5 flex-shrink-0 ${isActive ? 'text-amber-400' : 'text-transparent'}`}
                />
                <span className="min-w-0">
                  <span className="block text-sm text-ink-100">{o.label}</span>
                  <span className="block text-[11px] leading-tight text-ink-400">{o.hint}</span>
                </span>
              </button>
            );
          })}
          {previewing && (
            <>
              <div className="my-1 border-t border-ink-700" />
              <button
                type="button"
                onClick={() => pick('admin')}
                className="w-full px-3 py-2 text-left text-xs text-ink-300 hover:bg-ink-700"
              >
                Salir de la vista previa
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
