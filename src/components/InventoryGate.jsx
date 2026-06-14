import { Shield } from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import PageHeader from './PageHeader.jsx';
import EmptyState from './EmptyState.jsx';

/**
 * Role gate for the standalone Inventario section. Admins and the accounting
 * team pass through (the accounting team still manages stock even while the
 * accounting engine itself is in testing); anyone else gets the friendly
 * "Acceso restringido" screen — no redirect, so the URL stays shareable.
 */
export default function InventoryGate({ title, children }) {
  const { isAdmin, isAccounting } = useApp();
  if (!isAdmin && !isAccounting) {
    return (
      <>
        <PageHeader title={title} subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo puede gestionar el inventario." />
      </>
    );
  }
  return children;
}
