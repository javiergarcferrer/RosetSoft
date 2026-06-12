/**
 * The accounting pages' in-page tab strip (list/606, diario/mayor/balanza, …) —
 * one shared pill row instead of a per-page button group.
 * `tabs`: [{ key, label }] · `active`: current key · `onChange(key)`.
 */
export default function TabPills({ tabs, active, onChange }) {
  return (
    <div className="flex flex-wrap gap-2 mb-4">
      {(tabs || []).map((t) => (
        <button key={t.key} type="button" onClick={() => onChange(t.key)}
          className={`btn ${active === t.key ? 'tab-pill-active' : 'tab-pill'}`}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
