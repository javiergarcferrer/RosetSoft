import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, Ship, FileText, Container, Calculator } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import ListSearchHeader from '../../components/search/ListSearchHeader.jsx';
import ColumnsMenu from '../../components/search/ColumnsMenu.jsx';
import useColumns from '../../components/search/useColumns.js';
import useColumnWidths from '../../components/search/useColumnWidths.jsx';
import RowCards from '../../components/RowCards.jsx';
import ResultBar from '../../components/accounting/ResultBar.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { resolveImportacionesList } from '../../core/accounting/index.js';

/** A small "Borrador" tag for work-in-progress (un-posted) expedientes. */
function DraftPill() {
  return <span className="inline-flex items-center rounded-full bg-amber-50 text-amber-700 text-[10px] font-semibold px-1.5 py-0.5">Borrador</span>;
}

/** One KPI tile of the band over the filtered expedientes. */
function Stat({ label, value, accent }) {
  return (
    <div className="rounded-xl border border-ink-100 bg-surface px-3 py-2 shadow-xs">
      <div className="eyebrow text-ink-400">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${accent || 'text-ink-800'}`}>{value}</div>
    </div>
  );
}

/**
 * Customizable columns (Shopify-style) for the two desktop tables. ONE ordered
 * definition per table drives both the render (`cell`) and the Columns menu
 * (`label` / `canHide`). The first column is the fixed anchor (`canHide:
 * false`); each `cell` is a pure render off the per-row `ctx` the row builds.
 */
const EXPEDIENTE_COLUMNS = [
  {
    key: 'date', label: 'Fecha', canHide: false,
    thClass: 'whitespace-nowrap', tdClass: 'text-ink-500 whitespace-nowrap',
    cell: ({ r }) => <span className="inline-flex items-center gap-1.5">{formatDate(r.date)}{r.isDraft && <DraftPill />}</span>,
  },
  {
    key: 'number', label: 'No.',
    thClass: 'whitespace-nowrap', tdClass: 'tabular-nums text-ink-500 whitespace-nowrap',
    cell: ({ r }) => (r.number != null ? `#${r.number}` : '—'),
  },
  {
    key: 'bl', label: 'BL / Contenedor',
    thClass: 'whitespace-nowrap', tdClass: 'whitespace-nowrap',
    cell: ({ r }) => (
      <>
        <span className="font-mono text-xs">{r.bl || '—'}</span>
        {r.blExtra > 0 && <span className="text-ink-400 text-xs"> +{r.blExtra}</span>}
        {r.containerCode && <span className="ml-1.5 inline-flex items-center gap-0.5 text-[11px] text-ink-400"><Container size={11} />{r.containerCode}</span>}
      </>
    ),
  },
  {
    key: 'supplier', label: 'Proveedor',
    tdClass: 'min-w-0',
    cell: ({ r }) => (
      <>{r.supplierName || '—'}{r.supplierExtra > 0 && <span className="text-ink-400 text-xs"> +{r.supplierExtra}</span>}</>
    ),
  },
  {
    key: 'lines', label: 'Líneas',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums',
    cell: ({ r }) => r.lineCount,
  },
  {
    key: 'cif', label: 'CIF',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ r }) => formatDop(r.cif),
  },
  {
    key: 'landed', label: 'Costo destino',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums font-medium whitespace-nowrap',
    cell: ({ r }) => formatDop(r.landed),
  },
  {
    key: 'itbisCred', label: 'ITBIS créd.',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ r }) => formatDop(r.itbisCred),
  },
];
const EXPEDIENTE_DEFAULT_COLS = {
  number: true, bl: true, supplier: true, lines: true, cif: true, landed: true, itbisCred: true,
};
const EXPEDIENTE_COLS_STORAGE_KEY = 'rs.importaciones.expedientes.cols.v1';

const LEGACY_COLUMNS = [
  {
    key: 'date', label: 'Fecha', canHide: false,
    thClass: 'whitespace-nowrap', tdClass: 'text-ink-500 whitespace-nowrap',
    cell: ({ l }) => formatDate(l.liquidatedAt),
  },
  {
    key: 'supplier', label: 'Proveedor',
    tdClass: 'min-w-0',
    cell: ({ supplier }) => (supplier?.name || '—'),
  },
  {
    key: 'item', label: 'Artículo',
    tdClass: 'min-w-0',
    cell: ({ l, item }) => (
      <>{item?.name || '—'}{l.qty ? <span className="text-ink-400"> ×{l.qty}</span> : null}</>
    ),
  },
  {
    key: 'cif', label: 'CIF',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ l }) => formatDop(l.cif),
  },
  {
    key: 'duty', label: 'Gravamen',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ l }) => formatDop(l.duty),
  },
  {
    key: 'importItbis', label: 'ITBIS imp.',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ l }) => formatDop(l.importItbis),
  },
  {
    key: 'landed', label: 'Costo destino',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums font-medium whitespace-nowrap',
    cell: ({ landed }) => formatDop(landed),
  },
  {
    key: 'unitCost', label: 'C. unit.',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ unitCost }) => formatDop(unitCost),
  },
];
const LEGACY_DEFAULT_COLS = {
  supplier: true, item: true, cif: true, duty: true, importItbis: true, landed: true, unitCost: true,
};
const LEGACY_COLS_STORAGE_KEY = 'rs.importaciones.historico.cols.v1';

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
  const { profileId, currentProfile } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
  const scope = profileId || 'team';
  const navigate = useNavigate();

  const importsQ = useLiveQueryStatus(() => db.importLiquidations.where('profileId').equals(scope).toArray(), [scope], []);
  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const itemsQ = useLiveQueryStatus(() => db.inventoryItems.where('profileId').equals(scope).toArray(), [scope], []);
  const containersQ = useLiveQueryStatus(() => db.containers.where('profileId').equals(scope).toArray(), [scope], []);
  const expedientesQ = useLiveQueryStatus(() => db.importExpedientes.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = importsQ.loaded && suppliersQ.loaded && itemsQ.loaded && expedientesQ.loaded;

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

  // Column visibility (Shopify "edit columns") for the Expedientes table —
  // persisted per browser. Each table on this page (Expedientes / Histórico)
  // has its own column set + standalone menu since they share no schema.
  const {
    visible: expVisible, setVisible: setExpVisible, reset: resetExpCols, cols: expCols,
  } = useColumns(EXPEDIENTE_COLUMNS, EXPEDIENTE_DEFAULT_COLS, EXPEDIENTE_COLS_STORAGE_KEY);
  // Drag-to-resize widths (persisted) for the Expedientes table.
  const {
    tableRef: expTableRef, tableStyle: expTableStyle, thProps: expThProps,
    ResizeHandle: ExpResizeHandle, reset: resetExpWidths,
  } = useColumnWidths(expCols, 'rs.importaciones.expedientes.widths.v1');

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
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => navigate('/accounting/importaciones/calculadora')} className="btn-secondary"><Calculator size={15} /> <span className="hidden sm:inline">Calculadora</span></button>
            <button type="button" onClick={() => navigate('/accounting/importaciones/nuevo')} className="btn-primary"><FileText size={15} /> <span className="hidden sm:inline">Nuevo expediente</span><span className="sm:hidden">Nuevo</span></button>
          </div>
        )} />

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

          {!onHistorico && (
            <ResultBar count={vm.rows.length} singular="expediente" plural="expedientes"
              total={vm.rows.length > 0 ? formatDop(vm.kpis.landed) : null}
              note={search ? <> · filtrado por “{search}”</> : null} />
          )}

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
                title: <>{r.isDraft && <DraftPill />} {r.supplierName || '—'}{r.supplierExtra > 0 && <span className="text-ink-400 text-xs"> +{r.supplierExtra}</span>}</>,
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
            <div className="hidden md:block">
              {/* Standalone columns control for this table (the search header
                  governs both tables, so each carries its own column menu). */}
              <div className="hidden md:flex justify-end mb-2">
                <ColumnsMenu columns={EXPEDIENTE_COLUMNS} visible={expVisible} onChange={setExpVisible} onReset={() => { resetExpCols(); resetExpWidths(); }} />
              </div>
              <div className="card overflow-hidden">
                <div className="overflow-x-auto">
                <table ref={expTableRef} style={expTableStyle} className="table min-w-[680px]">
                  <thead>
                    <tr>
                      {expCols.map((col) => (
                        <th key={col.key} className={col.thClass || ''} {...expThProps(col.key)}>
                          {col.label}
                          {ExpResizeHandle(col.key)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {vm.rows.map((r) => (
                      <tr key={r.id}
                        onClick={() => navigate(`/accounting/importaciones/${r.id}`)}
                        onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/accounting/importaciones/${r.id}`); }}
                        tabIndex={0}
                        className="cursor-pointer transition-colors active:bg-ink-100 focus-visible:bg-ink-50 focus-visible:outline-none">
                        {expCols.map((col) => (
                          <td key={col.key} className={col.tdClass || ''}>{col.cell({ r })}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
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
  // Column visibility (Shopify "edit columns") for the Histórico table —
  // its own set + standalone menu, separate from Expedientes.
  const {
    visible: legVisible, setVisible: setLegVisible, reset: resetLegCols, cols: legCols,
  } = useColumns(LEGACY_COLUMNS, LEGACY_DEFAULT_COLS, LEGACY_COLS_STORAGE_KEY);
  // Drag-to-resize widths (persisted) for the Histórico table.
  const {
    tableRef, tableStyle, thProps, ResizeHandle, reset: resetLegWidths,
  } = useColumnWidths(legCols, 'rs.importaciones.historico.widths.v1');

  // Per-column totals keyed by column key — the footer renders one cell per
  // visible column, so it stays coherent as columns toggle on/off.
  const footTotals = {
    cif: formatDop(list.totals.cif),
    duty: formatDop(list.totals.duty),
    importItbis: formatDop(list.totals.importItbis),
    landed: formatDop(list.totals.landed),
  };
  // The leading text columns (everything before the first total column) merge
  // into the "N liquidaciones" label cell; each remaining column gets its own
  // total cell (or an empty cell when it has none).
  const firstTotalIdx = legCols.findIndex((c) => footTotals[c.key] != null);
  const labelSpan = firstTotalIdx === -1 ? legCols.length : firstTotalIdx;

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
    <div className="hidden md:block">
      {/* Standalone columns control for this table (the search header governs
          both tables, so each carries its own column menu). */}
      <div className="hidden md:flex justify-end mb-2">
        <ColumnsMenu columns={LEGACY_COLUMNS} visible={legVisible} onChange={setLegVisible} onReset={() => { resetLegCols(); resetLegWidths(); }} />
      </div>
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
        <table ref={tableRef} style={tableStyle} className="table min-w-[640px]">
          <thead>
            <tr>
              {legCols.map((col) => (
                <th key={col.key} className={col.thClass || ''} {...thProps(col.key)}>
                  {col.label}
                  {ResizeHandle(col.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.rows.map(({ liq: l, supplier, item, landed, unitCost }) => {
              const ctx = { l, supplier, item, landed, unitCost };
              return (
                <tr key={l.id}>
                  {legCols.map((col) => (
                    <td key={col.key} className={col.tdClass || ''}>{col.cell(ctx)}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-ink-200 font-semibold">
              <td colSpan={labelSpan || 1}>{list.count} liquidaciones</td>
              {legCols.slice(labelSpan).map((col) => (
                <td key={col.key} className="text-right tabular-nums whitespace-nowrap">
                  {footTotals[col.key] != null ? footTotals[col.key] : ''}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
        </div>
      </div>
    </div>
    </>
  );
}
