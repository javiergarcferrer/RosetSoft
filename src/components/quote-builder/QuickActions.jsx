import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Plus, Hash, Download, Eye, BookOpen, X, FileText, User as UserIcon, Container as ContainerIcon } from 'lucide-react';
import { useQuoteAutocomplete } from './useQuoteAutocomplete.js';
import { shortcutLabel } from '../../lib/useKeyboardShortcut.js';
import { formatMoney } from '../../lib/format.js';

/**
 * Command palette (⌘K / Ctrl+K). Drives the most-used workflows from the
 * keyboard:
 *
 *   - Actions: add line, add section, export PDF, toggle client view, toggle
 *     price-list panel.
 *   - Recent items: deduped past quote lines (from useQuoteAutocomplete);
 *     selecting inserts a new line pre-filled with that item's fields.
 *   - Customers: switches the assigned customer.
 *
 * Keyboard model:
 *   - ↑/↓ moves selection across all categories (single flat index).
 *   - Enter triggers the highlighted row.
 *   - Esc closes.
 *
 * Built without any external library — pattern is simple enough that the
 * dep cost outweighs the abstraction win.
 */
export default function QuickActions({
  open, onClose,
  customers, currentCustomerId,
  onInsertLine, onAddSection, onSelectCustomer,
  onExportPdf, onToggleClientView, onTogglePdfPanel,
  hasPdfPanel, clientView,
  currency, rates,
}) {
  const [q, setQ] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef(null);
  const { search } = useQuoteAutocomplete();

  useEffect(() => {
    if (!open) return;
    setQ('');
    setActiveIdx(0);
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  // Bind global Escape while the palette is open. ⌘K is bound by the parent
  // so it can toggle the palette without our component being mounted.
  useEffect(() => {
    if (!open) return;
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // ---- Filtered rows ----
  const actions = useMemo(() => buildActions({
    onInsertLine, onAddSection, onExportPdf, onToggleClientView, onTogglePdfPanel,
    hasPdfPanel, clientView,
  }), [onInsertLine, onAddSection, onExportPdf, onToggleClientView, onTogglePdfPanel, hasPdfPanel, clientView]);

  const filteredActions = useMemo(() => filterByLabel(actions, q), [actions, q]);
  const recentItems = useMemo(() => search(q, 8), [search, q]);
  const filteredCustomers = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? customers.filter((c) => (
        (c.name || '').toLowerCase().includes(needle) ||
        (c.company || '').toLowerCase().includes(needle)
      ))
      : customers.slice(0, 5);
    return list.slice(0, 6);
  }, [customers, q]);

  const groups = useMemo(() => {
    const g = [];
    if (filteredActions.length) g.push({ heading: 'Acciones', rows: filteredActions.map((a) => ({ kind: 'action', ...a })) });
    if (recentItems.length) g.push({ heading: 'Artículos recientes', rows: recentItems.map((r) => ({ kind: 'item', ...r })) });
    if (filteredCustomers.length) g.push({ heading: 'Clientes', rows: filteredCustomers.map((c) => ({ kind: 'customer', ...c })) });
    return g;
  }, [filteredActions, recentItems, filteredCustomers]);

  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

  function pick(row) {
    if (!row) return;
    if (row.kind === 'action') {
      row.run();
    } else if (row.kind === 'item') {
      onInsertLine({
        family: row.family,
        reference: row.reference,
        name: row.name,
        subtype: row.subtype,
        dimensions: row.dimensions,
        pageRef: row.pageRef,
        unitPrice: row.unitPrice,
        description: row.description,
        // Don't carry imageId across quotes — each line gets its own image.
        imageId: null,
      });
    } else if (row.kind === 'customer') {
      onSelectCustomer(row.id);
    }
    onClose();
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(flat[activeIdx]);
    }
  }

  if (!open) return null;

  // Sheet-from-bottom on phones, centered modal on tablets up. Same layout as
  // the generic Modal but tuned for the palette's search-first interaction —
  // the input sits at the top so the iOS keyboard pushes the list above it.
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-start justify-center sm:p-4 sm:pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Acciones rápidas"
    >
      <div className="fixed inset-0 bg-ink-900/50" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-xl bg-white shadow-pop border border-ink-100 overflow-hidden flex flex-col rounded-t-2xl sm:rounded-xl max-h-[85vh] sm:max-h-[80vh] pb-[env(safe-area-inset-bottom)] sm:pb-0">
        <div className="sm:hidden pt-2 pb-1 flex justify-center" aria-hidden>
          <div className="w-9 h-1 rounded-full bg-ink-200" />
        </div>
        <div className="relative border-b border-ink-100">
          <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setActiveIdx(0); }}
            onKeyDown={onKeyDown}
            placeholder="Buscar acción, artículo o cliente…"
            className="w-full pl-11 pr-12 py-4 sm:py-3.5 text-sm focus:outline-none placeholder:text-ink-400"
            type="search"
            inputMode="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="search"
          />
          {q && (
            <button
              type="button"
              onClick={() => { setQ(''); inputRef.current?.focus(); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-9 h-9 rounded-md text-ink-400 hover:text-ink-700 hover:bg-ink-100 active:bg-ink-200 transition-colors"
              aria-label="Limpiar búsqueda"
            >
              <X size={16} />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain py-1">
          {flat.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-ink-500">
              Sin resultados. Pulsa <kbd className="kbd">Esc</kbd> para cerrar.
            </div>
          ) : (
            groups.map((g) => (
              <Group key={g.heading} heading={g.heading}>
                {g.rows.map((row) => {
                  const flatIdx = flat.indexOf(row);
                  const isActive = activeIdx === flatIdx;
                  return (
                    <RowButton
                      key={`${row.kind}:${row.id || row.key || row.label}`}
                      row={row}
                      active={isActive}
                      currency={currency}
                      rates={rates}
                      currentCustomerId={currentCustomerId}
                      onHover={() => setActiveIdx(flatIdx)}
                      onClick={() => pick(row)}
                    />
                  );
                })}
              </Group>
            ))
          )}
        </div>

        {/* Hide the keyboard-hint strip on touch — keys are inert there and it
            steals vertical space that the keyboard already pinches. */}
        <div className="hidden sm:flex border-t border-ink-100 px-3 py-2 items-center justify-between text-[10px] text-ink-500">
          <div className="flex items-center gap-3">
            <span><kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> Navegar</span>
            <span><kbd className="kbd">{shortcutLabel('enter')}</kbd> Elegir</span>
            <span><kbd className="kbd">Esc</kbd> Cerrar</span>
          </div>
          <span>{shortcutLabel('mod+k')} para abrir</span>
        </div>
      </div>
    </div>
  );
}

function Group({ heading, children }) {
  return (
    <div className="py-1">
      <div className="px-3 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-ink-400">{heading}</div>
      {children}
    </div>
  );
}

function RowButton({ row, active, currency, rates, currentCustomerId, onHover, onClick }) {
  const Icon = row.kind === 'action' ? row.icon
    : row.kind === 'item' ? FileText
    : UserIcon;
  return (
    <button
      type="button"
      onMouseEnter={onHover}
      onClick={onClick}
      className={`w-full text-left flex items-center gap-3 px-3 py-3 sm:py-2 min-h-12 sm:min-h-0 transition-colors active:bg-ink-200 ${
        active ? 'bg-ink-100' : 'hover:bg-ink-50'
      }`}
    >
      <span className={`inline-flex items-center justify-center w-7 h-7 rounded-md flex-shrink-0 ${
        row.kind === 'item' ? 'bg-brand-100 text-brand-700' :
        row.kind === 'customer' ? 'bg-ink-100 text-ink-700' :
        'bg-ink-900 text-white'
      }`}>
        <Icon size={13} />
      </span>
      <div className="min-w-0 flex-1">
        {row.kind === 'action' ? (
          <>
            <div className="text-sm text-ink-900">{row.label}</div>
            {row.hint && <div className="text-[11px] text-ink-500 truncate">{row.hint}</div>}
          </>
        ) : row.kind === 'item' ? (
          <>
            <div className="text-sm text-ink-900 truncate">
              {row.family ? <span className="text-[10px] font-semibold uppercase tracking-widest text-brand-700 mr-1.5">{row.family}</span> : null}
              <b>{row.name || row.reference || '—'}</b>
            </div>
            <div className="text-[11px] text-ink-500 truncate">
              {row.reference ? <span className="font-mono">ref {row.reference}</span> : null}
              {row.subtype ? <span> · {row.subtype}</span> : null}
              {row.unitPrice ? <span> · {formatMoney(row.unitPrice, currency, rates)}</span> : null}
            </div>
          </>
        ) : (
          <>
            <div className="text-sm text-ink-900 truncate">
              {row.name}
              {row.id === currentCustomerId && <span className="ml-1.5 text-[10px] text-brand-700 font-medium">· actual</span>}
            </div>
            <div className="text-[11px] text-ink-500 truncate">
              {[row.company, row.email, row.city].filter(Boolean).join(' · ') || '—'}
            </div>
          </>
        )}
      </div>
      {row.kind === 'action' && row.kbd && (
        <kbd className="kbd hidden sm:inline-flex">{row.kbd}</kbd>
      )}
      {row.kind === 'item' && (
        <span className="text-[10px] text-ink-400 hidden sm:inline">Insertar</span>
      )}
    </button>
  );
}

function buildActions({ onInsertLine, onAddSection, onExportPdf, onToggleClientView, onTogglePdfPanel, hasPdfPanel, clientView }) {
  const list = [
    { id: 'add-item', label: 'Agregar artículo en blanco', icon: Plus, kbd: shortcutLabel('mod+enter'), run: () => onInsertLine({}) },
    { id: 'add-section', label: 'Agregar sección', icon: Hash, hint: 'Encabezado para agrupar (ej. "Sala")', run: () => onAddSection() },
    { id: 'export', label: 'Exportar PDF', icon: Download, kbd: shortcutLabel('mod+p'), run: () => onExportPdf() },
    { id: 'client-view', label: clientView ? 'Volver a edición' : 'Vista del cliente', icon: Eye, run: () => onToggleClientView() },
  ];
  if (hasPdfPanel) {
    list.push({ id: 'pdf-panel', label: 'Mostrar / ocultar lista de precios', icon: BookOpen, run: () => onTogglePdfPanel() });
  }
  list.push({ id: 'change-container', label: 'Cambiar contenedor', icon: ContainerIcon, hint: 'Asignar el quote a un contenedor', run: () => {/* opens via chip; included as discovery */} });
  return list;
}

function filterByLabel(actions, q) {
  const needle = (q || '').trim().toLowerCase();
  if (!needle) return actions;
  return actions.filter((a) => a.label.toLowerCase().includes(needle) || (a.hint || '').toLowerCase().includes(needle));
}
