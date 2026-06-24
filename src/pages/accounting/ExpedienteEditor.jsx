import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { Shield, Ship } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import BackLink from '../../components/BackLink.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { resolveAccountingConfig } from '../../core/accounting/index.js';
import ExpedienteForm from './ExpedienteForm.jsx';

/**
 * Expediente editor — the full-window workspace for a NEW import expediente
 * (`/accounting/importaciones/nuevo`) or for resuming a saved DRAFT
 * (`/accounting/importaciones/:id/editar`). It owns the data fetch + role gate
 * and renders ExpedienteForm full-page (with a BackLink), instead of stacking
 * the form above the list. The form itself holds the entry logic, autosave, the
 * Drive documents folder and the save/contabilizar actions. A POSTED expediente
 * isn't editable here — it bounces back to its read-only detail.
 */
export default function ExpedienteEditor() {
  const { id } = useParams();                 // present ⇒ editing a saved draft
  const { profileId, currentProfile, settings } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
  const scope = profileId || 'team';
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);

  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const itemsQ = useLiveQueryStatus(() => db.inventoryItems.where('profileId').equals(scope).toArray(), [scope], []);
  const ordersQ = useLiveQueryStatus(() => db.orders.where('profileId').equals(scope).toArray(), [scope], []);
  const containersQ = useLiveQueryStatus(() => db.containers.where('profileId').equals(scope).toArray(), [scope], []);
  const productsQ = useLiveQueryStatus(() => db.products.where('profileId').equals(scope).toArray(), [scope], []);
  const materialsQ = useLiveQueryStatus(() => db.materials.where('profileId').equals(scope).toArray(), [scope], []);
  // Compras y gastos for the "pull in registered costs" picker (link existing
  // gastos/compras to this expediente). Cheap lists; the form filters them.
  const expensesQ = useLiveQueryStatus(() => db.expenses.where('profileId').equals(scope).toArray(), [scope], []);
  const purchasesQ = useLiveQueryStatus(() => db.purchases.where('profileId').equals(scope).toArray(), [scope], []);
  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);
  const expQ = useLiveQueryStatus(() => (id ? db.importExpedientes.get(id) : Promise.resolve(null)), [id], null);

  const loaded = suppliersQ.loaded && itemsQ.loaded && (!id || expQ.loaded);
  const existing = id ? expQ.data : null;
  const backTo = id ? `/accounting/importaciones/${id}` : '/accounting/importaciones';

  if (!allowed) {
    return (
      <>
        <PageHeader title="Importaciones" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }
  if (!loaded) return <ListLoading />;
  if (id && !existing) {
    return (
      <>
        <BackLink to="/accounting/importaciones">Volver a importaciones</BackLink>
        <EmptyState icon={Ship} title="Expediente no encontrado" description="Puede haber sido registrado en otro perfil." />
      </>
    );
  }
  // Both drafts AND posted expedientes are editable here: editing a posted one
  // reverses its liquidación asiento + kardex and re-posts, preserving the
  // number (see ExpedienteForm.post → reverseExpedientePosting).

  return (
    <>
      <BackLink to={backTo}>{id ? 'Volver al expediente' : 'Volver a importaciones'}</BackLink>
      <PageHeader
        title={id ? `Editar expediente${existing?.number != null ? ` #${existing.number}` : ''}` : 'Nuevo expediente'}
        subtitle="Expediente aduanal (DGA) → costo en destino al inventario"
      />
      <ExpedienteForm
        key={existing?.id || 'new'}
        scope={scope} config={config} settings={settings}
        suppliers={suppliersQ.data} items={itemsQ.data}
        orders={ordersQ.data || []} containers={containersQ.data || []}
        products={productsQ.data || []} materials={materialsQ.data || []}
        expenses={expensesQ.data || []} purchases={purchasesQ.data || []} accounts={accountsQ.data || []}
        existing={existing}
      />
    </>
  );
}
