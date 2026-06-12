import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Shield, Ship, FileText, Container } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import ListSearchHeader from '../../components/search/ListSearchHeader.jsx';
import RowCards from '../../components/RowCards.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { resolveImportacionesList, resolveAccountingConfig } from '../../core/accounting/index.js';
import ExpedienteForm from './ExpedienteForm.jsx';

/** One KPI tile of the band over the filtered expedientes. */
function Stat({ label, value, accent }) {
  return (
    <div className="rounded-xl border border-ink-100 bg-white px-3 py-2 shadow-xs">
      <div className="eyebrow text-ink-400">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${accent || 'text-ink-800'}`}>{value}</div>
    </div>
  );
}

/**
 * Importaciones — the import-expediente workspace (DGA customs). An expediente
 * spans embarques (BLs) → supplier facturas → product lines; it capitalizes
 * CIF + gravamen + selectivo + the prorated cost sheet into a per-line landed
 * cost, credits the ITBIS, posts the asiento and lands each line into inventory.
 * Self-gates on accounting/admin.
 *
 * The module: a searchable/filterable list (free text over BL, DUA, proveedor,
 * contenedor and artículos; supplier + date-range filters; sortable) with a
 * KPI band, each row drilling into `/accounting/importaciones/:id`. Legacy
 * single liquidations stay on a read-only Histórico tab.
 */
export default function Importaciones() {
  const { profileId, currentProfile, settings } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
  const scope = profileId || 'team';
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);
  const navigate = useNavigate();

  const importsQ = useLiveQueryStatus(() => db.importLiquidations.where('profileId').equals(scope).toArray(), [scope], []);
  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const itemsQ = useLiveQueryStatus(() => db.inventoryItems.where('profileId').equals(scope).toArray(), [scope], []);
  const ordersQ = useLiveQueryStatus(() => db.orders.where('profileId').equals(scope).toArray(), [scope], []);
  const containersQ = useLiveQueryStatus(() => db.containers.where('profileId').equals(scope).toArray(), [scope], []);
  const expedientesQ = useLiveQueryStatus(() => db.importExpedientes.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = importsQ.loaded && suppliersQ.loaded && itemsQ.loaded && expedientesQ.loaded;

  const [params] = useSearchParams();
  const [showExpediente, setShowExpediente] = useState(!!params.get('new'));
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('expedientes');
  const [filters, setFilters] = useState({});
  const [sort, setSort] = useState({ key: 'date', dir: 'desc' });

  const vm = useMemo(() => resolveImportacionesList({
    expedientes: expedientesQ.data, imports: importsQ.data, suppliers: suppliersQ.data,
    items: itemsQ.data, containers: containersQ.data, query: search, filters, sort,
  }), [expedientesQ.data, importsQ.data, suppliersQ.data, itemsQ.data, containersQ.data, search, filters, sort]);

  const supplierFilterOpts = useMemo(
    () => suppliersQ.data.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map((s) => ({ value: s.id, label: s.name })),
    [suppliersQ.data],
  );

  if (!allowed) {
    return (
      <>
        <PageHeader title="Importaciones" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }

  const empty = vm.totalCount === 0 && vm.legacy.count === 0;
  const onHistorico = tab === 'historico' && vm.legacy.count > 0;

  return (
    <>
      <PageHeader title="Importaciones" subtitle="Expediente aduanal (DGA) → costo en destino al inventario"
        actions={(
          <button type="button" onClick={() => setShowExpediente((v) => !v)} className="btn-primary"><FileText size={15} /> <span className="hidden sm:inline">Nuevo expediente</span><span className="sm:hidden">Nuevo</span></button>
        )} />

      {showExpediente && loaded && (
        <ExpedienteForm scope={scope} config={config} settings={settings} suppliers={suppliersQ.data} items={itemsQ.data}
          orders={ordersQ.data || []} containers={containersQ.data || []} onClose={() => setShowExpediente(false)} />
      )}

      {!loaded ? <ListLoading /> : empty ? (
        <EmptyState icon={Ship} title="Sin importaciones" description="Registra un expediente con “Nuevo expediente”." />
      ) : (
        <>
          {/* KPI band — follows the active filters */}
          {!onHistorico && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mb-4">
              <Stat label="Expedientes" value={vm.kpis.count} />
              <Stat label="CIF (valor aduana)" value={formatDop(vm.kpis.cif)} />
              <Stat label="Costo en destino" value={formatDop(vm.kpis.landed)} accent="text-emerald-700" />
              <Stat label="ITBIS al crédito" value={formatDop(vm.kpis.itbisCred)} accent="text-sky-700" />
            </div>
          )}

          <ListSearchHeader
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Buscar por BL, DUA, proveedor, contenedor o artículo…"
            tabs={vm.legacy.count > 0 ? [
              { key: 'expedientes', label: 'Expedientes', count: vm.rows.length },
              { key: 'historico', label: 'Liquidaciones (histórico)', count: vm.legacy.count },
            ] : undefined}
            activeTab={tab}
            onTabChange={setTab}
            filters={[
              { key: 'supplierId', label: 'Proveedor', type: 'select', options: supplierFilterOpts },
              { key: 'date', label: 'Fecha', type: 'date-range' },
            ]}
            activeFilters={filters}
            onFiltersChange={setFilters}
            sortOptions={[
              { key: 'date', label: 'Fecha' },
              { key: 'number', label: 'Número' },
              { key: 'cif', label: 'CIF' },
              { key: 'landed', label: 'Costo en destino' },
            ]}
            sort={sort}
            onSortChange={setSort}
            resultCount={onHistorico ? vm.legacy.count : vm.rows.length}
            resultNoun={onHistorico ? ['liquidación', 'liquidaciones'] : ['expediente', 'expedientes']}
          />

          {onHistorico ? (
            <LegacyTable list={vm.legacy} />
          ) : vm.rows.length === 0 ? (
            <EmptyState icon={Ship} title="Sin resultados" description="Ajusta la búsqueda o los filtros." />
          ) : (
            <>
            <RowCards
              rows={vm.rows.map((r) => ({
                key: r.id,
                to: `/accounting/importaciones/${r.id}`,
                title: <>{r.supplierName || '—'}{r.supplierExtra > 0 && <span className="text-ink-400 text-xs"> +{r.supplierExtra}</span>}</>,
                right: formatDop(r.landed),
                sub: <>
                  {r.number != null && <span className="tabular-nums mr-1.5">#{r.number}</span>}
                  <span className="font-mono">{r.bl || '—'}</span>
                  {r.blExtra > 0 && <span> +{r.blExtra}</span>}
                  {r.containerCode && <span className="ml-1.5">{r.containerCode}</span>}
                </>,
                kv: [
                  ['Fecha', formatDate(r.date)],
                  ['Líneas', r.lineCount],
                  ['CIF', formatDop(r.cif)],
                  ['ITBIS créd.', formatDop(r.itbisCred)],
                ],
              }))}
            />
            <div className="hidden md:block card overflow-hidden">
              <div className="overflow-x-auto">
              <table className="table min-w-[680px]">
                <thead>
                  <tr>
                    <th className="whitespace-nowrap">Fecha</th>
                    <th className="whitespace-nowrap">No.</th>
                    <th className="whitespace-nowrap">BL / Contenedor</th>
                    <th>Proveedor</th>
                    <th className="text-right whitespace-nowrap">Líneas</th>
                    <th className="text-right whitespace-nowrap">CIF</th>
                    <th className="text-right whitespace-nowrap">Costo destino</th>
                    <th className="text-right whitespace-nowrap">ITBIS créd.</th>
                  </tr>
                </thead>
                <tbody>
                  {vm.rows.map((r) => (
                    <tr key={r.id}
                      onClick={() => navigate(`/accounting/importaciones/${r.id}`)}
                      onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/accounting/importaciones/${r.id}`); }}
                      tabIndex={0}
                      className="cursor-pointer transition-colors active:bg-ink-100 focus-visible:bg-ink-50 focus-visible:outline-none">
                      <td className="text-ink-500 whitespace-nowrap">{formatDate(r.date)}</td>
                      <td className="tabular-nums text-ink-500 whitespace-nowrap">{r.number != null ? `#${r.number}` : '—'}</td>
                      <td className="whitespace-nowrap">
                        <span className="font-mono text-xs">{r.bl || '—'}</span>
                        {r.blExtra > 0 && <span className="text-ink-400 text-xs"> +{r.blExtra}</span>}
                        {r.containerCode && <span className="ml-1.5 inline-flex items-center gap-0.5 text-[11px] text-ink-400"><Container size={11} />{r.containerCode}</span>}
                      </td>
                      <td className="min-w-0">{r.supplierName || '—'}{r.supplierExtra > 0 && <span className="text-ink-400 text-xs"> +{r.supplierExtra}</span>}</td>
                      <td className="text-right tabular-nums">{r.lineCount}</td>
                      <td className="text-right tabular-nums whitespace-nowrap">{formatDop(r.cif)}</td>
                      <td className="text-right tabular-nums font-medium whitespace-nowrap">{formatDop(r.landed)}</td>
                      <td className="text-right tabular-nums whitespace-nowrap">{formatDop(r.itbisCred)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
            </>
          )}
        </>
      )}
    </>
  );
}

/** The pre-expediente single liquidations, read-only (Histórico tab). */
function LegacyTable({ list }) {
  return (
    <>
    <RowCards
      rows={list.rows.map(({ liq: l, supplier, item, landed, unitCost }) => ({
        key: l.id,
        title: supplier?.name || '—',
        right: formatDop(landed),
        sub: <>{item?.name || '—'}{l.qty ? ` ×${l.qty}` : ''}</>,
        kv: [
          ['Fecha', formatDate(l.liquidatedAt)],
          ['CIF', formatDop(l.cif)],
          ['Gravamen', formatDop(l.duty)],
          ['ITBIS imp.', formatDop(l.importItbis)],
          ['C. unit.', formatDop(unitCost)],
        ],
      }))}
      footer={[
        ['Liquidaciones', list.count],
        ['CIF', formatDop(list.totals.cif)],
        ['Gravamen', formatDop(list.totals.duty)],
        ['ITBIS imp.', formatDop(list.totals.importItbis)],
        ['Costo destino', formatDop(list.totals.landed)],
      ]}
    />
    <div className="hidden md:block card overflow-hidden">
      <div className="overflow-x-auto">
      <table className="table min-w-[640px]">
        <thead>
          <tr>
            <th className="whitespace-nowrap">Fecha</th>
            <th>Proveedor</th>
            <th>Artículo</th>
            <th className="text-right whitespace-nowrap">CIF</th>
            <th className="text-right whitespace-nowrap">Gravamen</th>
            <th className="text-right whitespace-nowrap">ITBIS imp.</th>
            <th className="text-right whitespace-nowrap">Costo destino</th>
            <th className="text-right whitespace-nowrap">C. unit.</th>
          </tr>
        </thead>
        <tbody>
          {list.rows.map(({ liq: l, supplier, item, landed, unitCost }) => (
            <tr key={l.id}>
              <td className="text-ink-500 whitespace-nowrap">{formatDate(l.liquidatedAt)}</td>
              <td className="min-w-0">{supplier?.name || '—'}</td>
              <td className="min-w-0">{item?.name || '—'}{l.qty ? <span className="text-ink-400"> ×{l.qty}</span> : null}</td>
              <td className="text-right tabular-nums whitespace-nowrap">{formatDop(l.cif)}</td>
              <td className="text-right tabular-nums whitespace-nowrap">{formatDop(l.duty)}</td>
              <td className="text-right tabular-nums whitespace-nowrap">{formatDop(l.importItbis)}</td>
              <td className="text-right tabular-nums font-medium whitespace-nowrap">{formatDop(landed)}</td>
              <td className="text-right tabular-nums whitespace-nowrap">{formatDop(unitCost)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-ink-200 font-semibold">
            <td colSpan={3}>{list.count} liquidaciones</td>
            <td className="text-right tabular-nums whitespace-nowrap">{formatDop(list.totals.cif)}</td>
            <td className="text-right tabular-nums whitespace-nowrap">{formatDop(list.totals.duty)}</td>
            <td className="text-right tabular-nums whitespace-nowrap">{formatDop(list.totals.importItbis)}</td>
            <td className="text-right tabular-nums whitespace-nowrap">{formatDop(list.totals.landed)}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
      </div>
    </div>
    </>
  );
}
