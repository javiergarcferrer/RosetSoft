import { useEffect, useMemo, useRef, useState } from 'react';
import { PackageSearch, Shield, Upload, Loader2, Check, ChevronRight } from 'lucide-react';
import { useLiveQuery, useLiveQueryStatus } from '../../db/hooks.js';
import { db, searchProducts } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import ListSearchHeader from '../../components/search/ListSearchHeader.jsx';
import { formatMoney } from '../../lib/format.js';
import { parsePriceList, dedupeBySku } from '../../lib/priceListCsv.js';
import { groupFamilies } from '../../lib/catalog.js';

/**
 * Catálogo — the Ligne Roset product catalog, imported from the supplier
 * price-list CSV. Admin-only to manage (same gate as the other /admin pages);
 * RLS lets any team member read so the quote builder's product picker works.
 *
 * Import is a CSV upload (the list is thousands of SKUs and updated
 * periodically): the file is parsed client-side (lib/priceListCsv) and
 * upserted into `products`, keyed by SKU so re-uploading a new list replaces
 * prices in place. Margen % shown per row is the catalog spread
 * (Retail − Cost) / Retail — a quick read on each product's headroom.
 */
export default function Catalog() {
  const { profileId, isAdmin } = useApp();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  // Debounce so each keystroke isn't its own query.
  useEffect(() => {
    const id = setTimeout(() => setDq(q.trim()), 200);
    return () => clearTimeout(id);
  }, [q]);

  // Server-side search: the catalog is tens of thousands of SKUs, never pulled
  // client-side. An empty term returns a bounded first-200 browse set.
  const { data: rows, loaded, error: loadError } = useLiveQueryStatus(
    () => (profileId ? searchProducts(profileId, dq, 200) : Promise.resolve([])),
    [profileId, dq],
    [],
  );
  // Cheap HEAD count for the header total (not a full fetch).
  const total = useLiveQuery(
    () => (profileId ? db.products.where('profileId').equals(profileId).count() : Promise.resolve(0)),
    [profileId],
    0,
  );

  // Group the (already filtered) rows for display: a top-level CATEGORY
  // section, and within it the model FAMILIES (groupFamilies collapses each
  // 8-digit SKU root + its grade variants into one family). Grouping is purely
  // a view over `rows` — search/fetch logic is untouched.
  const sections = useMemo(() => groupByCategory(rows), [rows]);

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Catálogo" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido" description="Solo administradores pueden gestionar el catálogo de productos." />
      </>
    );
  }

  async function onFile(file) {
    if (!file) return;
    setBusy(true);
    setError('');
    setResult('');
    try {
      const text = await file.text();
      // dedupeBySku collapses the list's repeated SKUs (required: a single
      // upsert batch can't touch the same primary key twice) and resolves
      // stale-price duplicates to the canonical current price.
      const parsed = dedupeBySku(parsePriceList(text));
      if (parsed.length === 0) {
        setError('No se reconocieron productos. ¿Es el CSV de la lista de precios de Roset?');
        return;
      }
      // Omit created_at: the upsert leaves it unchanged on existing rows and
      // the column default fills it for new ones — so we never read the table.
      const upserts = parsed.map((p) => ({
        id: p.reference,
        profileId,
        reference: p.reference,
        name: p.name,
        subtype: p.subtype,
        dimensions: p.dimensions,
        family: p.family,
        familyCode: p.familyCode,
        category: p.category,
        priceUsd: p.priceUsd,
        cost: p.cost,
        active: true,
      }));
      await db.products.bulkPut(upserts);
      setResult(`${upserts.length} productos importados.`);
    } catch (e) {
      console.error('[Catalog] import failed:', e);
      setError(e?.message || 'No se pudo importar el archivo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Catálogo"
        subtitle={total > 0 ? `${total} producto(s)` : ' '}
        actions={(
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="btn-primary disabled:opacity-60"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            Importar CSV
          </button>
        )}
      />

      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }}
      />

      {(result || error) && (
        <div className={`mb-4 rounded-md px-3 py-2 text-xs flex items-center gap-2 ${
          error ? 'bg-red-50 border border-red-200 text-red-800' : 'bg-green-50 border border-green-200 text-green-800'
        }`}>
          {error ? null : <Check size={14} />}
          {error || result}
        </div>
      )}

      {!loaded ? (
        <div className="card overflow-hidden"><ListLoading rows={6} /></div>
      ) : loadError ? (
        <EmptyState
          icon={PackageSearch}
          title="No se pudo cargar el catálogo"
          description="La tabla de productos aún no existe en la base de datos (la migración todavía no se ha aplicado en este deploy). Espera a que termine el despliegue y recarga; el catálogo aparecerá en cuanto la migración corra."
        />
      ) : (!dq && rows.length === 0) ? (
        <EmptyState
          icon={PackageSearch}
          title="Catálogo vacío"
          description="Importa la lista de precios de Roset (CSV) para tener un catálogo buscable al cotizar."
          action={<button type="button" onClick={() => inputRef.current?.click()} className="btn-primary"><Upload size={14} /> Importar CSV</button>}
        />
      ) : (
        <>
          <ListSearchHeader
            searchValue={q}
            onSearchChange={setQ}
            searchPlaceholder="Buscar por referencia, nombre o familia…"
            resultCount={rows.length}
            resultNoun={['producto', 'productos']}
          />
          {rows.length === 0 ? (
            <div className="card px-4 py-8 text-center text-sm text-ink-500">Sin coincidencias.</div>
          ) : (
            <div className="space-y-3">
              {sections.map((section) => (
                <CategorySection key={section.key} section={section} />
              ))}
            </div>
          )}
          {rows.length >= 200 && (
            <div className="px-4 py-2 text-[11px] text-ink-500">
              Mostrando los primeros 200. Afina la búsqueda para ver más.
            </div>
          )}
        </>
      )}
    </>
  );
}

const usd = (n) => formatMoney(Number(n) || 0, 'USD', { USD: 1 });
const NO_CATEGORY = 'Sin categoría';

/**
 * Bucket the (filtered) product rows into CATEGORY sections, each holding its
 * model FAMILIES. The CSV's `category` (Category Description) is the top level;
 * `groupFamilies` collapses each family's grade variants underneath. Sections
 * and families are sorted A→Z so the same query always renders the same order.
 */
function groupByCategory(rows) {
  const byCategory = new Map();
  for (const p of rows || []) {
    const key = (p.category || '').trim() || NO_CATEGORY;
    const bucket = byCategory.get(key);
    if (bucket) bucket.push(p);
    else byCategory.set(key, [p]);
  }
  const sections = [];
  for (const [key, items] of byCategory) {
    const families = groupFamilies(items).sort((a, b) =>
      (a.name || a.root).localeCompare(b.name || b.root, 'es', { sensitivity: 'base' }),
    );
    sections.push({ key, category: key, count: items.length, families });
  }
  return sections.sort((a, b) => {
    // Keep the catch-all bucket last; everything else alphabetical.
    if (a.category === NO_CATEGORY) return 1;
    if (b.category === NO_CATEGORY) return -1;
    return a.category.localeCompare(b.category, 'es', { sensitivity: 'base' });
  });
}

/** One collapsible CATEGORY section: a prominent header + its families. */
function CategorySection({ section }) {
  return (
    <details open className="card overflow-hidden group">
      <summary className="card-header cursor-pointer list-none select-none hover:bg-ink-50">
        <span className="flex items-center gap-2 min-w-0">
          <ChevronRight
            size={15}
            className="text-ink-400 flex-shrink-0 transition-transform group-open:rotate-90"
            aria-hidden
          />
          <span className="font-semibold text-sm text-ink-900 truncate" title={section.category}>
            {section.category}
          </span>
        </span>
        <span className="eyebrow-xs tracking-wide flex-shrink-0">
          {section.families.length} familia(s) · {section.count} SKU
        </span>
      </summary>
      <div className="divide-y divide-ink-100">
        {section.families.map((fam) => (
          <FamilyGroup key={fam.root} family={fam} />
        ))}
      </div>
    </details>
  );
}

/**
 * One FAMILY sub-group: a header (model name + member count) over its grade
 * variants/SKUs, listed compactly. A graded model shows its grade letter per
 * row; a standalone product shows just its single SKU.
 */
function FamilyGroup({ family }) {
  // All member SKUs (graded variants first in price order, then any ungraded).
  const members = [
    ...family.grades.map((g) => ({ grade: g, product: family.byGrade.get(g) })),
    ...(family.byGrade.has('') ? [{ grade: '', product: family.byGrade.get('') }] : []),
  ].filter((m) => m.product);

  return (
    <div className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-3 mb-1.5">
        <h3 className="font-medium text-sm text-ink-800 truncate" title={family.name || family.root}>
          {family.name || family.root || '—'}
          {family.family && family.family !== family.name && (
            <span className="ml-2 text-ink-500 font-normal">{family.family}</span>
          )}
        </h3>
        <span className="eyebrow-xs tracking-wide flex-shrink-0">
          {members.length} {members.length === 1 ? 'SKU' : 'SKUs'}
        </span>
      </div>
      <ul className="divide-y divide-ink-100/70">
        {members.map(({ grade, product: p }) => {
          const price = Number(p.priceUsd) || 0;
          const cost = Number(p.cost) || 0;
          const marginPct = price > 0 ? Math.round(((price - cost) / price) * 100) : 0;
          return (
            <li key={p.id} className="flex items-center gap-3 py-1.5 text-sm">
              {grade ? (
                <span className="chip bg-brand-50 text-brand-700 border border-brand-100 flex-shrink-0">
                  {grade}
                </span>
              ) : (
                <span className="chip text-ink-500 border border-dashed border-ink-300 flex-shrink-0">—</span>
              )}
              <span className="font-mono text-xs text-ink-600 flex-shrink-0 w-24 truncate" title={p.reference}>
                {p.reference}
              </span>
              <span className="text-ink-500 text-xs truncate flex-1 min-w-0" title={p.subtype || p.name}>
                {p.subtype || ''}
              </span>
              <span className="tabular-nums text-right w-24 flex-shrink-0">{usd(price)}</span>
              <span className="tabular-nums text-right text-ink-500 w-24 flex-shrink-0 hidden sm:inline">
                {usd(cost)}
              </span>
              <span className="tabular-nums text-right text-ink-500 w-12 flex-shrink-0 hidden lg:inline">
                {marginPct}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
