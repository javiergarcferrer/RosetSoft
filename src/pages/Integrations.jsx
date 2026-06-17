// Integraciones — the hub for every external tool Alcover connects to (under
// Configuración). Each row shows live status and EXPANDS IN PLACE to its real
// connection/config screen (WhatsAppCard + BusinessProfileCard, InstagramCard,
// ShopifyCard). Integration config lives ONLY here — the general Configuración
// view carries no integration cards, so there's no link-out and no duplication.
// Gmail + Drive are shown as "coming soon" placeholders so the roadmap is clear.
import { useState } from 'react';
import { MessageCircle, Instagram as InstagramIcon, ShoppingBag, Mail, HardDrive, ChevronDown } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import { useApp } from '../context/AppContext.jsx';
import WhatsAppCard from '../components/settings/WhatsAppCard.jsx';
import InstagramCard from '../components/settings/InstagramCard.jsx';
import ShopifyCard from '../components/settings/ShopifyCard.jsx';
import GmailCard from '../components/settings/GmailCard.jsx';
import GoogleDriveCard from '../components/settings/GoogleDriveCard.jsx';
import BusinessProfileCard from '../components/whatsapp/BusinessProfileCard.jsx';
import { SHOPIFY_STORE_ALCOVER, SHOPIFY_STORE_LSG } from '../lib/shopifySync.js';

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

export default function Integrations() {
  const { settings, saveSettings } = useApp();
  const [open, setOpen] = useState(null);

  const items = [
    {
      id: 'whatsapp', icon: MessageCircle, name: 'WhatsApp',
      desc: 'Bandeja, plantillas y difusión por WhatsApp Cloud API.',
      connected: !!settings?.whatsappConnectedAt,
      config: (
        <div className="space-y-4">
          <WhatsAppCard settings={settings} saveSettings={saveSettings} />
          <BusinessProfileCard connected={!!settings?.whatsappConnectedAt} />
        </div>
      ),
    },
    {
      id: 'instagram', icon: InstagramIcon, name: 'Instagram',
      desc: 'Publicaciones, historias, comentarios y anuncios.',
      connected: !!settings?.metaSocialConnectedAt,
      config: <InstagramCard />,
    },
    {
      id: 'shopify', icon: ShoppingBag, name: 'Shopify',
      desc: 'Sincroniza catálogo e inventario con tus tiendas.',
      connected: !!settings?.shopifyConnectedAt,
      config: (
        <div className="space-y-4">
          <ShopifyCard settings={settings} store={SHOPIFY_STORE_ALCOVER} />
          <ShopifyCard settings={settings} store={SHOPIFY_STORE_LSG} />
        </div>
      ),
    },
    {
      id: 'gmail', icon: Mail, name: 'Gmail',
      desc: 'Envía cotizaciones y archivos por correo.',
      connected: !!settings?.googleConnectedAt,
      config: <GmailCard />,
    },
    {
      id: 'drive', icon: HardDrive, name: 'Google Drive',
      desc: 'Documentos y carpetas por importación en la nube.',
      connected: !!settings?.googleConnectedAt,
      config: <GoogleDriveCard />,
    },
  ];

  return (
    <>
      <PageHeader title="Integraciones" subtitle="Conecta y configura tus herramientas — todo aquí." />
      <div className="max-w-3xl space-y-3">
        {items.map((it) => {
          const Icon = it.icon;
          const isOpen = open === it.id;
          return (
            <div key={it.id} className={`overflow-hidden rounded-xl border border-ink-200 bg-surface ${it.comingSoon ? 'opacity-75' : ''}`}>
              <button
                type="button"
                disabled={it.comingSoon}
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : it.id)}
                className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-ink-50 disabled:cursor-default disabled:hover:bg-transparent"
              >
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ink-100 text-ink-600">
                  <Icon size={20} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink-900">{it.name}</span>
                    <StatusPill connected={it.connected} comingSoon={it.comingSoon} />
                  </div>
                  <p className="truncate text-sm text-ink-500">{it.desc}</p>
                </div>
                {!it.comingSoon && (
                  <ChevronDown size={18} className={`shrink-0 text-ink-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                )}
              </button>
              {isOpen && !it.comingSoon && (
                <div className="border-t border-ink-100 bg-ink-50/40 p-3 sm:p-4">
                  {it.config}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
