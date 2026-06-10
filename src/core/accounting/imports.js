// Importaciones ViewModels — the searchable expedientes list (with KPIs and the
// legacy single-liquidation histórico) and the full expediente detail
// projection. Pure: no React, no db.
import { round2 } from '../../lib/accounting/ledger.js';
import { landedCost, landedUnitCost } from '../../lib/accounting/importLiquidation.js';
import {
  resolveExpediente, expedienteLanded, expedienteCreditableItbis, expedienteCostTotals, costLabel,
} from '../../lib/accounting/expediente.js';

export const PAYMENT_LABELS = { bank: 'Banco', credit: 'Crédito', cash: 'Efectivo', card: 'Tarjeta' };

export function resolveImportsList({ imports, suppliers, items, start, end } = {}) {
  const supById = new Map((suppliers || []).map((s) => [s.id, s]));
  const itemById = new Map((items || []).map((i) => [i.id, i]));
  const rows = (imports || [])
    .filter((l) => {
      if (start != null && l.liquidatedAt < start) return false;
      if (end != null && l.liquidatedAt > end) return false;
      return true;
    })
    .map((l) => {
      const landed = landedCost(l);
      return {
        liq: l,
        supplier: l.supplierId ? supById.get(l.supplierId) || null : null,
        item: l.itemId ? itemById.get(l.itemId) || null : null,
        landed,
        unitCost: landedUnitCost(l, l.qty),
        total: round2(landed + (l.importItbis || 0)),
      };
    })
    .sort((a, b) => (b.liq.liquidatedAt || 0) - (a.liq.liquidatedAt || 0));

  const totals = rows.reduce((acc, r) => ({
    cif: acc.cif + (r.liq.cif || 0),
    duty: acc.duty + (r.liq.duty || 0),
    importItbis: acc.importItbis + (r.liq.importItbis || 0),
    landed: acc.landed + r.landed,
  }), { cif: 0, duty: 0, importItbis: 0, landed: 0 });
  for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);

  return { rows, totals, count: rows.length };
}

/**
 * Normalize an expediente to the multi-level shape: pre-embarques records kept
 * their lines flat on the root, so wrap them in a synthetic single embarque /
 * factura (the resolver only walks `embarques`).
 */
export function expedienteEmbarques(e) {
  if (e?.embarques?.length) return e.embarques;
  if (!e?.lines?.length) return [];
  return [{
    id: `${e.id}-legacy`, bl: e.bl || '', customsRef: e.customsRef || '', flete: 0, seguro: 0,
    facturas: [{ id: `${e.id}-legacy-f`, supplierId: e.supplierId || null, invoiceRef: '', ncf: '', lines: e.lines }],
  }];
}

/**
 * The Importaciones workspace list — one row per expediente with everything the
 * table shows plus a prebuilt search corpus (number, BLs, DUAs, supplier names,
 * container code, line names/references). Applies the free-text query, the
 * supplier + date-range filters and the sort; rolls the FILTERED set into the
 * KPI band. The legacy single liquidations ride along (date-filtered only).
 *
 *   filters: { supplierId?: string, date?: { from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' } }
 *   sort:    { key: 'date'|'number'|'cif'|'landed', dir: 'asc'|'desc' }
 */
export function resolveImportacionesList({
  expedientes, imports, suppliers, items, containers, query, filters, sort,
} = {}) {
  const supById = new Map((suppliers || []).map((s) => [s.id, s]));
  const contById = new Map((containers || []).map((c) => [c.id, c]));

  const all = (expedientes || []).map((e) => {
    const embs = expedienteEmbarques(e);
    const bls = embs.map((em) => em.bl).filter(Boolean);
    const duas = embs.map((em) => em.customsRef).filter(Boolean);
    const lines = embs.flatMap((em) => (em.facturas || []).flatMap((f) => f.lines || []));
    const supplierIds = [...new Set(
      [e.supplierId, ...embs.flatMap((em) => (em.facturas || []).map((f) => f.supplierId))].filter(Boolean),
    )];
    const supplierNames = supplierIds.map((sid) => supById.get(sid)?.name).filter(Boolean);
    const container = e.containerId ? contById.get(e.containerId) : null;
    const containerCode = container?.code || container?.number || '';
    return {
      id: e.id,
      number: e.number ?? null,
      date: e.liquidatedAt || 0,
      bl: bls[0] || '',
      blExtra: Math.max(0, bls.length - 1),
      dua: duas[0] || '',
      supplierName: supplierNames[0] || '',
      supplierExtra: Math.max(0, supplierNames.length - 1),
      supplierIds,
      containerCode,
      embCount: embs.length,
      lineCount: lines.length,
      qty: round2(lines.reduce((s, l) => s + (Number(l.qty) || 0), 0)),
      cif: round2(e.cif || 0),
      landed: expedienteLanded(e),
      itbisCred: expedienteCreditableItbis(e),
      search: [
        e.number, ...bls, ...duas, ...supplierNames, containerCode,
        ...lines.map((l) => l.name), ...lines.map((l) => l.reference),
      ].filter(Boolean).join(' ').toLowerCase(),
    };
  });

  const q = (query || '').trim().toLowerCase();
  const from = filters?.date?.from ? Date.parse(`${filters.date.from}T00:00:00`) : null;
  const to = filters?.date?.to ? Date.parse(`${filters.date.to}T23:59:59.999`) : null;
  const supplierId = filters?.supplierId || '';

  const rows = all.filter((r) => {
    if (q && !r.search.includes(q)) return false;
    if (from != null && r.date < from) return false;
    if (to != null && r.date > to) return false;
    if (supplierId && !r.supplierIds.includes(supplierId)) return false;
    return true;
  });

  const key = sort?.key || 'date';
  const dir = sort?.dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const va = a[key] ?? 0;
    const vb = b[key] ?? 0;
    return (va < vb ? -1 : va > vb ? 1 : 0) * dir || (b.date - a.date);
  });

  const kpis = rows.reduce((acc, r) => ({
    cif: round2(acc.cif + r.cif),
    landed: round2(acc.landed + r.landed),
    itbisCred: round2(acc.itbisCred + r.itbisCred),
  }), { cif: 0, landed: 0, itbisCred: 0 });

  const legacy = resolveImportsList({ imports, suppliers, items, start: from ?? undefined, end: to ?? undefined });

  return {
    rows,
    totalCount: all.length,
    kpis: { ...kpis, count: rows.length },
    legacy,
  };
}

/**
 * Full drill-down of ONE saved expediente — re-resolves the landed-cost cascade
 * from the stored structure (so per-line CIF/taxes/unit costs are exact, not
 * cached) and dresses every level with display names: header meta, embarque
 * cards with their facturas + lines, the cost sheet and the rolled-up totals.
 */
export function resolveExpedienteDetail({ expediente, config, suppliers, items, containers, orders } = {}) {
  if (!expediente) return null;
  const supById = new Map((suppliers || []).map((s) => [s.id, s]));
  const itemById = new Map((items || []).map((i) => [i.id, i]));
  const contById = new Map((containers || []).map((c) => [c.id, c]));
  const orderById = new Map((orders || []).map((o) => [o.id, o]));

  const norm = { ...expediente, embarques: expedienteEmbarques(expediente) };
  const resolved = resolveExpediente(norm, config);
  const byLineId = new Map(resolved.lines.map((l) => [l.id, l]));

  const embarques = norm.embarques.map((em) => {
    const container = em.containerId ? contById.get(em.containerId) : null;
    return {
      id: em.id,
      bl: em.bl || '',
      customsRef: em.customsRef || '',
      containerCode: container?.code || container?.number || '',
      flete: round2(em.flete || 0),
      seguro: round2(em.seguro || 0),
      facturas: (em.facturas || []).map((f) => {
        const lines = (f.lines || []).map((l) => {
          const rl = byLineId.get(l.id);
          const item = l.itemId ? itemById.get(l.itemId) : null;
          return {
            id: l.id,
            name: item?.name || l.name || '—',
            reference: item?.sku || l.reference || '',
            inInventory: !!item,
            qty: rl?.qty || 0,
            fob: rl?.fob || 0,
            cif: rl?.cif || 0,
            gravamen: rl?.gravamen || 0,
            selectivo: rl?.selectivo || 0,
            itbis: rl?.itbis || 0,
            taxes: round2((rl?.gravamen || 0) + (rl?.selectivo || 0) + (rl?.itbis || 0)),
            costShare: rl?.costShare || 0,
            landedTotal: rl?.landedTotal || 0,
            landedUnitCost: rl?.landedUnitCost || 0,
          };
        });
        return {
          id: f.id,
          supplierName: (f.supplierId ? supById.get(f.supplierId)?.name : '') || '',
          invoiceRef: f.invoiceRef || '',
          ncf: f.ncf || '',
          lines,
          fob: round2(lines.reduce((s, l) => s + l.fob, 0)),
          landed: round2(lines.reduce((s, l) => s + l.landedTotal, 0)),
        };
      }),
    };
  });

  const costs = (expediente.costs || []).map((c) => {
    const amount = round2(Math.max(0, Number(c.amount) || 0));
    const itbis = Math.min(round2(Math.max(0, Number(c.itbis) || 0)), amount);
    return {
      id: c.id,
      label: costLabel(c),
      supplierName: (c.supplierId ? supById.get(c.supplierId)?.name : '') || '',
      ncf: c.ncf || '',
      amount,
      itbis,
      net: round2(amount - itbis),
      payment: PAYMENT_LABELS[c.paymentMethod] || PAYMENT_LABELS.bank,
    };
  });

  const order = expediente.orderId ? orderById.get(expediente.orderId) : null;
  const headSupplierId = expediente.supplierId
    || norm.embarques[0]?.facturas?.find((f) => f.supplierId)?.supplierId || null;
  const container = expediente.containerId ? contById.get(expediente.containerId) : null;

  return {
    meta: {
      number: expediente.number ?? null,
      date: expediente.liquidatedAt || 0,
      bl: expediente.bl || norm.embarques[0]?.bl || '',
      customsRef: expediente.customsRef || norm.embarques[0]?.customsRef || '',
      supplierName: (headSupplierId ? supById.get(headSupplierId)?.name : '') || '',
      containerCode: container?.code || container?.number || '',
      orderLabel: order ? `#${order.number ?? ''} ${order.name || ''}`.trim() : '',
      payment: PAYMENT_LABELS[expediente.paymentMethod] || PAYMENT_LABELS.bank,
    },
    totals: resolved.totals,
    embarques,
    costs,
    costTotals: expedienteCostTotals(expediente.costs),
    journalEntryId: expediente.journalEntryId || null,
  };
}
