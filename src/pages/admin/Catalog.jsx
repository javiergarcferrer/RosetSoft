import { useEffect, useRef, useState } from 'react';
import { PackageSearch, Shield, Upload, Loader2, Check } from 'lucide-react';
import { useLiveQuery, useLiveQueryStatus } from '../../db/hooks.js';
import { db, searchProducts } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import ListSearchHeader from '../../components/search/ListSearchHeader.jsx';
import { formatMoney } from '../../lib/format.js';
import { parsePriceList, dedupeBySku } from '../../lib/priceListCsv.js';

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
          <div className="card overflow-hidden">
            <table className="table">
              <thead>
                <tr>
                  <th>Referencia</th>
                  <th>Nombre</th>
                  <th className="hidden md:table-cell">Familia</th>
                  <th className="text-right">Precio</th>
                  <th className="text-right hidden sm:table-cell">Costo</th>
                  <th className="text-right hidden lg:table-cell">Margen</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const price = Number(p.priceUsd) || 0;
                  const cost = Number(p.cost) || 0;
                  const marginPct = price > 0 ? Math.round(((price - cost) / price) * 100) : 0;
                  return (
                    <tr key={p.id}>
                      <td className="font-mono text-xs text-ink-700">{p.reference}</td>
                      <td className="font-medium truncate max-w-[260px]" title={p.name}>{p.name || '—'}</td>
                      <td className="hidden md:table-cell text-ink-600 truncate max-w-[160px]" title={p.family}>{p.family || '—'}</td>
                      <td className="text-right tabular-nums">{formatMoney(price, 'USD', { USD: 1 })}</td>
                      <td className="text-right tabular-nums text-ink-600 hidden sm:table-cell">{formatMoney(cost, 'USD', { USD: 1 })}</td>
                      <td className="text-right tabular-nums hidden lg:table-cell">{marginPct}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-ink-500">Sin coincidencias.</div>
            )}
            {rows.length >= 200 && (
              <div className="px-4 py-2 text-[11px] text-ink-500 border-t border-ink-100">
                Mostrando los primeros 200. Afina la búsqueda para ver más.
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
