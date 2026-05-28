/**
 * Segmented "saved views" row — the primary status dimension (Shopify's
 * All / Active / Draft / … tab strip). Presentational only: the parent owns
 * `activeTab` and decides what each key filters.
 *
 * Mobile-first: the strip is horizontally scrollable (a phone can't fit
 * Todas / Borrador / Enviada / Aceptada / Rechazada side by side at 360px),
 * with momentum scroll contained so a swipe on the tabs doesn't drag the
 * whole page. The active tab reads as a filled pill so it's unmistakable at
 * arm's length; inactive tabs are quiet text that darken on hover.
 *
 * Each tab can carry an optional `count` rendered as a trailing number —
 * the at-a-glance "12 enviadas" affordance. Counts are computed by the
 * parent (it has the data); we just render whatever we're handed.
 *
 * Implemented as a radio-group (role="tablist" would imply tab panels we
 * don't have) — `aria-pressed` on each toggle reads correctly to AT, and
 * ArrowLeft / ArrowRight move between tabs like a native segmented control.
 */
export default function FilterTabs({ tabs, activeTab, onTabChange }) {
  if (!tabs || tabs.length === 0) return null;

  function onKeyDown(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const idx = tabs.findIndex((t) => t.key === activeTab);
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    // Clamp at the ends rather than wrap — wrapping a 5-item strip is
    // disorienting on a control this small.
    const next = Math.min(tabs.length - 1, Math.max(0, idx + dir));
    onTabChange(tabs[next].key);
  }

  return (
    <div
      role="group"
      aria-label="Filtrar por estado"
      onKeyDown={onKeyDown}
      className="-mx-1 flex items-center gap-1 overflow-x-auto overscroll-x-contain px-1 py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map((t) => {
        const active = t.key === activeTab;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onTabChange(t.key)}
            aria-pressed={active}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 min-h-9 coarse:min-h-10 text-[13px] font-medium whitespace-nowrap transition-colors active:scale-[0.98] ${
              active
                ? 'bg-ink-900 text-ink-50'
                : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'
            }`}
          >
            {t.label}
            {t.count != null && (
              <span
                className={`tabular-nums rounded px-1.5 py-px text-[11px] font-semibold ${
                  active
                    ? 'bg-white/20 text-ink-50'
                    : t.pillCls
                      ? t.pillCls
                      : 'bg-ink-100 text-ink-500'
                }`}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
