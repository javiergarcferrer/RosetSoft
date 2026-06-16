import PageHeader from '../../components/PageHeader.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import LigneRosetReport from '../../components/accounting/LigneRosetReport.jsx';

/**
 * Ventas Ligne Roset — the monthly supplier sell-through report, as its own
 * page (deep-linkable / sidebar-reachable). The report body lives in the shared
 * <LigneRosetReport> so it's identical to the "Ligne Roset" lens of the sales
 * command screen (the Ventas workspace) — one source of truth, no drift.
 * Self-gates on accounting/admin.
 */
export default function LigneRosetSales() {
  return (
    <AccountingGate title="Ventas Ligne Roset">
      <PageHeader title="Ventas Ligne Roset"
        subtitle="Reporte mensual de ventas de piso para el proveedor" />
      <LigneRosetReport />
    </AccountingGate>
  );
}
