import { Shield } from 'lucide-react';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../PageHeader.jsx';
import EmptyState from '../EmptyState.jsx';

/**
 * Role gate every Contabilidad page sits behind: accounting/admin pass through,
 * anyone else gets the friendly "Acceso restringido" screen (no redirect — the
 * URL stays shareable). Wrap the page's content; pass the page `title` so the
 * restricted screen still shows where the visitor landed.
 */
export default function AccountingGate({ title, children }) {
  const { currentProfile } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
  if (!allowed) {
    return (
      <>
        <PageHeader title={title} subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }
  return children;
}
