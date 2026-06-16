// Integraciones — the hub for every external tool Alcover connects to. Lives
// under Configuración. Each tile shows live connection status (read from
// settings) and where to open / configure it; Gmail + Drive are shown as
// "coming soon" placeholders so the roadmap is visible.
import { Link } from 'react-router-dom';
import { MessageCircle, Instagram, ShoppingBag, Mail, HardDrive } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import { useApp } from '../context/AppContext.jsx';

function StatusPill({ connected, comingSoon }) {
  const cls = comingSoon
    ? 'bg-amber-50 text-amber-700'
    : connected
      ? 'bg-emerald-50 text-emerald-700'
      : 'bg-ink-100 text-ink-500';
  const label = comingSoon ? 'Próximamente' : connected ? 'Conectado' : 'Sin conectar';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {!comingSoon && <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-ink-300'}`} />}
      {label}
    </span>
  );
}

function IntegrationCard({ icon: Icon, name, desc, connected, comingSoon, actions = [] }) {
  return (
    <div className={`card card-pad flex flex-col ${comingSoon ? 'opacity-75' : ''}`}>
      <div className="flex items-start gap-3">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-ink-100 text-ink-600">
          <Icon size={22} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium text-ink-900">{name}</h3>
            <StatusPill connected={connected} comingSoon={comingSoon} />
          </div>
          <p className="mt-0.5 text-sm text-ink-500">{desc}</p>
        </div>
      </div>
      <div className="mt-4">
        {comingSoon ? (
          <span className="text-xs text-ink-400">Disponible pronto.</span>
        ) : (
          <div className="flex flex-wrap gap-2">
            {actions.map((a) => (
              <Link key={a.to + a.label} to={a.to} className={`${a.primary ? 'btn-brand' : 'btn-secondary'} text-sm`}>
                {a.label}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Integrations() {
  const { settings } = useApp();
  const cards = [
    {
      icon: MessageCircle, name: 'WhatsApp',
      desc: 'Bandeja, plantillas y difusión por WhatsApp Cloud API.',
      connected: !!settings?.whatsappConnectedAt,
      actions: [{ label: 'Abrir bandeja', to: '/chats', primary: true }, { label: 'Configurar', to: '/settings' }],
    },
    {
      icon: Instagram, name: 'Instagram',
      desc: 'Publicaciones, historias, comentarios y anuncios.',
      connected: !!settings?.metaSocialConnectedAt,
      actions: [{ label: 'Abrir', to: '/marketing', primary: true }, { label: 'Configurar', to: '/settings' }],
    },
    {
      icon: ShoppingBag, name: 'Shopify',
      desc: 'Sincroniza catálogo e inventario con tu tienda.',
      connected: !!settings?.shopifyConnectedAt,
      actions: [{ label: 'Configurar', to: '/settings', primary: true }],
    },
    { icon: Mail, name: 'Gmail', desc: 'Correo y seguimiento de conversaciones con clientes.', comingSoon: true },
    { icon: HardDrive, name: 'Google Drive', desc: 'Documentos, archivos y respaldos en la nube.', comingSoon: true },
  ];
  return (
    <>
      <PageHeader title="Integraciones" subtitle="Conecta tus herramientas a Alcover." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((c) => <IntegrationCard key={c.name} {...c} />)}
      </div>
    </>
  );
}
