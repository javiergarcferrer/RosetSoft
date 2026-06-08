import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

/**
 * Dropdown — a small, dependency-free popover primitive: a trigger button and
 * a floating panel that opens beneath (or above) it.
 *
 * We keep the native-`<select>`-backed `Select` primitive for form fields and
 * mobile pickers; THIS one is for rich, action-y menus — arbitrary JSX rows
 * that *do* something when picked (e.g. focus a map marker) rather than store a
 * value. It owns the fiddly parts so callers don't:
 *
 *   • the panel is rendered in a portal with fixed coordinates, so no
 *     ancestor's `overflow:hidden` (our cards clip their rounded corners) can
 *     ever crop it, and it stays pinned through scroll/resize;
 *   • it flips above the trigger when there isn't room below;
 *   • click-outside and Escape close it (Escape returns focus to the trigger);
 *   • arrow keys rove across items, Home/End jump to the ends;
 *   • a subtle enter animation (`.dropdown-pop`, reduced-motion aware).
 *
 * Accessible: trigger is aria-haspopup/aria-expanded, panel is role="menu",
 * rows are role="menuitem" (use the companion <DropdownItem>).
 *
 *   <Dropdown label={<>Puntos · 12</>} panelClassName="w-72">
 *     {({ close }) => rows.map((r) => (
 *       <DropdownItem key={r.id} onSelect={() => { focus(r); close(); }}>…</DropdownItem>
 *     ))}
 *   </Dropdown>
 *
 * @param {{
 *   label: import('react').ReactNode,
 *   children: import('react').ReactNode | ((api: { close: () => void }) => import('react').ReactNode),
 *   align?: 'left' | 'right',
 *   disabled?: boolean,
 *   className?: string,
 *   panelClassName?: string,
 * }} props
 */
export default function Dropdown({
  label,
  children,
  align = 'left',
  disabled = false,
  className = '',
  panelClassName = '',
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null); // fixed-coord box, computed from the trigger
  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const triggerRef = useRef(null);
  const menuId = useId();

  const close = useCallback(() => setOpen(false), []);

  // Position the (portaled) panel against the trigger and keep it pinned
  // through scroll/resize. Flip above when there isn't room below.
  useLayoutEffect(() => {
    if (!open) return undefined;
    function place() {
      const t = triggerRef.current?.getBoundingClientRect();
      if (!t) return;
      const gap = 6;
      const margin = 12;
      const below = window.innerHeight - t.bottom;
      const above = t.top;
      const up = below < 220 && above > below;
      setPos({
        up,
        top: up ? undefined : t.bottom + gap,
        bottom: up ? window.innerHeight - t.top + gap : undefined,
        left: align === 'right' ? undefined : t.left,
        right: align === 'right' ? window.innerWidth - t.right : undefined,
        maxHeight: (up ? above : below) - gap - margin,
      });
    }
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, align]);

  // Close on outside pointer / Escape (Escape restores focus to the trigger).
  useEffect(() => {
    if (!open) return undefined;
    function onPointer(e) {
      if (rootRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    function onKey(e) {
      if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); }
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Focus the first item the instant the panel mounts, so the keyboard lands
  // inside the menu and arrow keys rove from there.
  const attachPanel = useCallback((node) => {
    panelRef.current = node;
    if (node) menuItems(node)[0]?.focus();
  }, []);

  function onPanelKeyDown(e) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const list = menuItems(panelRef.current);
    if (!list.length) return;
    e.preventDefault();
    const cur = list.indexOf(document.activeElement);
    const last = list.length - 1;
    const next =
      e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : e.key === 'ArrowDown' ? (cur < 0 ? 0 : (cur + 1) % list.length)
      : (cur <= 0 ? last : cur - 1);
    list[next].focus();
  }

  const body = typeof children === 'function' ? children({ close }) : children;

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 min-h-[2rem] coarse:min-h-[2.75rem] text-xs font-medium text-ink-700 shadow-xs transition-colors hover:border-ink-300 hover:bg-ink-50 hover:text-ink-900 active:scale-[0.97] active:bg-ink-100 disabled:opacity-40 disabled:cursor-not-allowed ${className}`}
      >
        {label}
        <ChevronDown
          size={14}
          aria-hidden
          className={`text-ink-400 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && pos && createPortal(
        <div
          ref={attachPanel}
          id={menuId}
          role="menu"
          onKeyDown={onPanelKeyDown}
          style={{
            position: 'fixed',
            top: pos.top,
            bottom: pos.bottom,
            left: pos.left,
            right: pos.right,
            maxHeight: pos.maxHeight,
          }}
          className={`dropdown-pop z-[2000] min-w-[12rem] overflow-y-auto rounded-xl border border-ink-100/80 bg-white py-1.5 shadow-pop ring-1 ring-inset ring-black/[0.03] ${panelClassName}`}
        >
          {body}
        </div>,
        document.body,
      )}
    </div>
  );
}

function menuItems(node) {
  return node ? [...node.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')] : [];
}

/**
 * One row in a <Dropdown>. A real <button> (role="menuitem") so pointer and
 * keyboard both work; `onSelect` fires on click. `active` marks the current
 * choice; `disabled` removes it from keyboard roving.
 */
export function DropdownItem({ onSelect, active = false, disabled = false, className = '', children }) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={onSelect}
      className={`flex items-start gap-2 px-3 py-2 coarse:py-3 min-h-[2.25rem] coarse:min-h-[2.75rem] text-left text-sm text-ink-700 rounded-lg mx-1 w-[calc(100%-0.5rem)] transition-colors hover:bg-ink-50 focus:bg-ink-50 focus:outline-none disabled:opacity-50 disabled:pointer-events-none ${active ? 'bg-brand-50 text-brand-700 font-medium' : ''} ${className}`}
    >
      {children}
    </button>
  );
}
