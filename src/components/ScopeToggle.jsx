/**
 * Mías / Equipo scope toggle — a small segmented control shared by the
 * home and the quotes list so a seller can flip between their own quotes
 * (filtered by createdByUserId === the signed-in user) and the whole
 * team's. Stateless: the parent owns `scope` and applies the filter; this
 * just renders the two-state switch. Render only when the current user is
 * known (no meId → nothing to scope to).
 */

export const SCOPE_MINE = 'mias';
export const SCOPE_TEAM = 'equipo';

export default function ScopeToggle({ scope, onChange }) {
  const cls = (active) =>
    active
      ? 'px-3 py-1.5 coarse:py-2 bg-ink-900 text-ink-50'
      : 'px-3 py-1.5 coarse:py-2 text-ink-600 hover:bg-ink-100';
  return (
    <div className="inline-flex rounded-md border border-ink-200 overflow-hidden text-xs font-medium select-none">
      <button type="button" onClick={() => onChange(SCOPE_MINE)} className={cls(scope === SCOPE_MINE)}>
        Mías
      </button>
      <button type="button" onClick={() => onChange(SCOPE_TEAM)} className={cls(scope === SCOPE_TEAM)}>
        Equipo
      </button>
    </div>
  );
}
