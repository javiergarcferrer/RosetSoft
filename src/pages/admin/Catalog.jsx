import { useMemo, useRef, useState } from 'react';
import { PackageSearch, Shield, Upload, Loader2, Check } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import ListSearchHeader from '../../components/search/ListSearchHeader.jsx';
import { formatMoney } from '../../lib/format.js';
import { parsePriceList } from '../../lib/priceListCsv.js';

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
  const { data: products, loaded } = useLiveQueryStatus(
    () => db.products.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = needle
      ? products.filter((p) => (
        (p.reference || '').toLowerCase().includes(needle) ||
        (p.name || '').toLowerCase().includes(needle) ||
        (p.family || '').toLowerCase().includes(needle)
      ))
      : products;
    // Cap the rendered rows — the catalog is large; search narrows it.
    return [...rows].sort((a, b) => (a.name || '').localeCompare(b.name || '')).slice(0, 200);
  }, [products, q]);

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
      const parsed = parsePriceList(text);
      if (parsed.length === 0) {
        setError('No se reconocieron productos. ¿Es el CSV de la lista de precios de Roset?');
        return;
      }
      const now = Date.now();
      const byId = new Map(products.map((p) => [p.id, p]));
      const rows = parsed.map((p) => ({
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
        createdAt: byId.get(p.reference)?.createdAt || now,
      }));
      await db.products.bulkPut(rows);
      setResult(`${rows.length} productos importados.`);
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
        subtitle={loaded ? `${products.length} producto(s)` : ' '}
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
      ) : products.length === 0 ? (
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
            resultCount={filtered.length}
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
                {filtered.map((p) => {
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
            {products.length > filtered.length && (
              <div className="px-4 py-2 text-[11px] text-ink-500 border-t border-ink-100">
                Mostrando {filtered.length} de {products.length}. Usa la búsqueda para acotar.
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
