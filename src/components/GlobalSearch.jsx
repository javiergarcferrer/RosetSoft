import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import { useLiveQueryStatus } from '../db/hooks.js';
import { db, searchProducts } from '../db/database.js';
import { navForRole } from '../lib/access.js';
import { resolveGlobalSearch } from '../core/search/index.js';
import { quoteStagePill, orderStatusPill } from '../lib/statusPill.js';
import { formatMoney } from '../lib/format.js';

/**
 * Global ⌘K search — a command-palette overlay across the whole app:
 * cotizaciones, clientes, profesionales, pedidos, catálogo and page
 * shortcuts, grouped and ranked by `resolveGlobalSearch` (core/search).
 *
 * View-layer split (MVVM): this component fetches (db hooks + the
 * server-side catalog search), debounces the query, owns keyboard/selection
 * state and renders; ALL matching/ranking/grouping lives in the pure VM.
 *
 * The data layer mounts ONLY while the palette is open — `GlobalSearch`
 * renders nothing when closed, so no queries run in the background.
 */
export default function GlobalSearch({ open, onClose }) {
  if (!open || typeof document === 'undefined') return null;
  return createPortal(<SearchOverlay onClose={onClose} />, document.body);
}

const DEBOUNCE_MS = 200;

function SearchOverlay({ onClose }) {
  const { profileId, currentProfile } = useApp();
  const navigate = useNavigate();
  const listRef = useRef(null);

  // Raw input → debounced query (~200ms) so we don't re-rank on every key.
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(input), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [input]);

  // Escape closes; body scroll locks while open (same idiom as Modal.jsx).
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  // Profile-scoped rows, fetched only while the palette is mounted (= open).
  const { data: quotes, loaded: quotesLoaded } = useLiveQueryStatus(
    () => db.quotes.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );
  const { data: customers, loaded: customersLoaded } = useLiveQueryStatus(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );
  const { data: professionals, loaded: professionalsLoaded } = useLiveQueryStatus(
    () => db.professionals.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );
  const { data: orders, loaded: ordersLoaded } = useLiveQueryStatus(
    () => db.orders.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );
  const loaded = quotesLoaded && customersLoaded && professionalsLoaded && ordersLoaded;

  // Catalog is tens of thousands of SKUs → server-side search (bounded), and
  // only once the query is substantive (≥2 chars).
  const [products, setProducts] = useState([]);
  useEffect(() => {
    const term = query.trim();
    if (!profileId || term.length < 2) {
      setProducts([]);
      return undefined;
    }
    let active = true;
    searchProducts(profileId, term, 20)
      .then((rows) => { if (active) setProducts(rows); })
      .catch(() => { if (active) setProducts([]); });
    return () => { active = false; };
  }, [profileId, query]);

  // Page shortcuts — exactly the routes this role's sidebar exposes.
  const pages = useMemo(() => {
    const groups = navForRole(currentProfile?.role) || [];
    return groups.flatMap((g) =>
      g.items.map(({ to, label, icon }) => ({ to, label, icon, group: g.label || '' })),
    );
  }, [currentProfile?.role]);

  const result = useMemo(
    () => resolveGlobalSearch({ query, quotes, customers, professionals, orders, products, pages }),
    [query, quotes, customers, professionals, orders, products, pages],
  );

  // ↑/↓ selection across ALL results (flat order). Reset when results change.
  const [active, setActive] = useState(0);
  useEffect(() => { setActive(0); }, [result]);
  const activeItem = result.flat[Math.min(active, result.flat.length - 1)] || null;

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    if (!activeItem || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-key="${CSS.escape(activeItem.key)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeItem]);

  function go(item) {
    if (!item) return;
    navigate(item.to);
    onClose();
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(0, result.flat.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(activeItem);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center p-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:pt-[10vh] animate-in fade-in duration-150"
      role="dialog"
      aria-modal="true"
      aria-label="Búsqueda global"
    >
      <div
        className="fixed inset-0 bg-ink-900/50 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative w-full max-w-xl bg-white rounded-2xl shadow-pop border border-ink-100/60 flex flex-col overflow-hidden max-h-[80vh] sm:max-h-[60vh] animate-in zoom-in-95 duration-150">
        {/* Search field */}
        <div className="relative flex-shrink-0 border-b border-ink-100">
          <Search
            size={16}
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-400"
            aria-hidden
          />
          <input
            autoFocus
            type="text"
            inputMode="search"
            enterKeyHint="go"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Buscar cotizaciones, clientes, productos…"
            aria-label="Buscar en toda la aplicación"
            className="w-full bg-transparent pl-11 pr-12 py-3.5 text-sm text-ink-900 placeholder:text-ink-400 focus:outline-none"
          />
          <kbd className="hidden sm:block absolute right-3.5 top-1/2 -translate-y-1/2 rounded border border-ink-200 bg-ink-50 px-1.5 py-0.5 text-[10px] font-medium text-ink-400">
            esc
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="flex-1 overflow-y-auto overscroll-contain py-2" role="listbox" aria-label="Resultados">
          {result.groups.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-ink-400">
              {loaded ? 'Sin resultados' : 'Buscando…'}
            </p>
          )}
          {result.groups.map((group) => (
            <div key={group.key} className="mb-1 last:mb-0">
              <div className="px-4 pt-2 pb-1 eyebrow-xs select-none">{group.label}</div>
              {group.items.map((item) => (
                <ResultRow
                  key={item.key}
                  item={item}
                  isActive={activeItem?.key === item.key}
                  onPick={() => go(item)}
                  onHover={() => {
                    const idx = result.flat.indexOf(item);
                    if (idx >= 0) setActive(idx);
                  }}
                />
              ))}
              {group.more > 0 && (
                <p className="px-4 py-1 text-[11px] text-ink-400 select-none">{group.more} más…</p>
              )}
            </div>
          ))}
        </div>

        {/* Quiet keyboard legend (pointless on touch → hidden on mobile) */}
        <div className="hidden sm:flex flex-shrink-0 items-center gap-3 border-t border-ink-100 bg-ink-50/50 px-4 py-2 text-[10px] text-ink-400 select-none">
          <span><kbd className="font-sans">↑↓</kbd> navegar</span>
          <span><kbd className="font-sans">↵</kbd> abrir</span>
          <span><kbd className="font-sans">esc</kbd> cerrar</span>
        </div>
      </div>
    </div>
  );
}

/**
 * One result row. Leaf Model-selector calls (status label maps, money
 * formatting) stay here at the render site per the MVVM contract — the VM
 * hands over the raw stage/status key and USD price.
 */
function ResultRow({ item, isActive, onPick, onHover }) {
  const Icon = item.type === 'page' ? item.icon : null;
  const detail = secondaryFor(item);
  return (
    <button
      type="button"
      data-key={item.key}
      role="option"
      aria-selected={isActive}
      onClick={onPick}
      onMouseMove={onHover}
      className={`flex w-full items-center gap-2.5 px-4 py-2 min-h-11 text-left transition-colors ${
        isActive ? 'bg-ink-100' : 'hover:bg-ink-50'
      }`}
    >
      {Icon && (
        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-ink-100 text-ink-500">
          <Icon size={13} aria-hidden />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink-900">{item.primary}</span>
        {detail && <span className="block truncate text-xs text-ink-400">{detail}</span>}
      </span>
      {item.type === 'product' && item.priceUsd != null && (
        <span className="flex-shrink-0 text-xs font-medium tabular-nums text-ink-500">
          {formatMoney(item.priceUsd, 'USD')}
        </span>
      )}
    </button>
  );
}

/** Compose the secondary line — appending the Spanish status label for
 *  quotes/orders via the shared pill maps (same source as the list pages). */
function secondaryFor(item) {
  if (item.type === 'quote') {
    return [item.secondary, quoteStagePill(item.stage).label].filter(Boolean).join(' · ');
  }
  if (item.type === 'order') {
    return [item.secondary, orderStatusPill(item.status).label].filter(Boolean).join(' · ');
  }
  return item.secondary || '';
}
