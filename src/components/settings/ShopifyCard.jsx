// ShopifyCard — one Shopify connection card. Extracted from the Settings page
// so both Settings and the Integraciones hub render the SAME config screen (no
// duplication). The app talks to TWO stores, each connected with a Dev
// Dashboard app's Client ID + Client secret:
//   • alcover         — alcover.do, where the inventory sync PUBLISHES in-stock
//     pieces ("Sincronizar todo" reconciles it).
//   • lifestylegarden — lifestylegarden.do, where the brand catalog import
//     PULLS from (the sync button lives on its Catálogos page).
// Credentials are saved through a write-only RPC (never read back); the server
// mints/renews the short-lived tokens itself. Only the domain + a "connected"
// timestamp surface here.
import { useEffect, useState } from 'react';
import { RefreshCw, Check, Loader2, Lock } from 'lucide-react';
import {
  saveShopifyConfig, syncShopify, pingShopify, ensureShopifyRefreshCron,
  SHOPIFY_STORE_ALCOVER, SHOPIFY_STORE_LSG,
} from '../../lib/shopifySync.js';
import { formatDateTime } from '../../lib/format.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import SettingsSection from './SettingsSection.jsx';
import CredentialInput from './CredentialInput.jsx';

export const SHOPIFY_STORES = {
  [SHOPIFY_STORE_ALCOVER]: {
    title: 'Shopify — ALCOVER (inventario)',
    domainField: 'shopifyDomain',
    connectedField: 'shopifyConnectedAt',
    defaultDomain: 'alcoversdq.myshopify.com',
    description: <>Cada artículo en inventario con precio y foto se añade automáticamente a la tienda
      de <strong>alcover.do</strong> dentro de la colección <strong>Ligne Roset Inventory</strong>; al
      agotarse, se retira. Las ventas se pueden manejar desde Shopify o desde el cotizador.</>,
  },
  [SHOPIFY_STORE_LSG]: {
    title: 'Shopify — LifestyleGarden (catálogo)',
    domainField: 'shopifyLsgDomain',
    connectedField: 'shopifyLsgConnectedAt',
    defaultDomain: 'alcoversrl.myshopify.com',
    description: <>La tienda de <strong>lifestylegarden.do</strong> es la fuente del catálogo
      LifestyleGarden del cotizador. Conéctala aquí y sincroniza el catálogo
      desde <strong>Administración › Catálogos › LifestyleGarden</strong>.</>,
  },
};

export default function ShopifyCard({ settings, store }) {
  const cfg = SHOPIFY_STORES[store];
  const savedDomain = settings?.[cfg.domainField] || '';
  const [domain, setDomain] = useState(savedDomain || cfg.defaultDomain);
  // Dev Dashboard app credentials — the server mints + caches the short-lived
  // tokens itself (client credentials grant); no token ever touches the UI.
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [status, setStatus] = useState('idle'); // idle | saving | saved | error
  const [msg, setMsg] = useState('');
  const [syncing, setSyncing] = useState(false);
  const connectedAt = settings?.[cfg.connectedField];
  // Credentials are LOCKED while a connection is saved: the inputs aren't
  // rendered at all (nothing in the DOM for a password manager to autofill —
  // a real incident put the dealer's saved email in the Client ID field)
  // until "Editar credenciales" is clicked. First-time setup shows them.
  const [editing, setEditing] = useState(false);
  const locked = !!connectedAt && !editing;

  useEffect(() => { setDomain(savedDomain || cfg.defaultDomain); }, [savedDomain, cfg.defaultDomain]);

  async function save() {
    setStatus('saving');
    setMsg('');
    try {
      await saveShopifyConfig({ domain, clientId, clientSecret, store });
      setClientId('');
      setClientSecret('');
      setEditing(false); // re-lock the fields
      // Verify the token actually reaches the store before claiming success —
      // a bad or under-scoped credential is caught here, not later as "0 published".
      const ping = await pingShopify(store);
      if (ping?.ok) {
        // LSG is two-way: once connected, register the periodic stock-refresh
        // cron so Shopify-side sales keep our mirror fresh hands-off.
        if (store === SHOPIFY_STORE_LSG) ensureShopifyRefreshCron().catch(() => {});
        const missing = ping.missingScopes || [];
        setStatus(missing.length ? 'error' : 'saved');
        setMsg(missing.length
          ? `Conectado a ${ping.shop}, pero la app no tiene estos permisos: ${missing.join(', ')}. Añádelos a la app en Shopify (y reinstálala en la tienda) y vuelve a guardar.`
          : `Conectado a ${ping.shop}. ✓`);
      } else {
        setStatus('error');
        setMsg(ping?.error || 'Guardado, pero no se pudo verificar la conexión con Shopify.');
      }
      setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 4000);
    } catch (e) {
      setStatus('error');
      setMsg(userMessageFor(e));
    }
  }

  async function syncAll() {
    setSyncing(true);
    setMsg('');
    try {
      const res = await syncShopify();
      if (res?.configured === false) {
        setStatus('error');
        setMsg('Conecta Shopify primero (guarda el Client ID y el Client secret).');
      } else if (res?.error) {
        setStatus('error');
        setMsg(res.error);
      } else {
        const parts = [`${res?.synced ?? 0} publicado(s)`, `${res?.archived ?? 0} retirado(s)`];
        if (res?.skipped) parts.push(`${res.skipped} sin existencia o precio`);
        setStatus('saved');
        setMsg(`Sincronizado: ${parts.join(', ')}.${res?.errors?.length ? ` ${res.errors.length} con error.` : ''}`);
      }
    } catch (e) {
      setStatus('error');
      setMsg(userMessageFor(e));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <SettingsSection title={cfg.title}>
      <p className="text-xs text-ink-500 mb-4">
        {cfg.description}{' '}
        Usa el dominio <code>.myshopify.com</code> de ESA tienda (p. ej. <code>{cfg.defaultDomain}</code>,
        no el dominio público). Crea la app en el <strong>Dev Dashboard</strong> (dev.shopify.com),
        instálala en la tienda con los permisos necesarios, y pega aquí el <strong>Client ID</strong> y
        el <strong>Client secret</strong> de su página Settings — el sistema obtiene y renueva los
        tokens por sí solo. Una misma app instalada en ambas tiendas sirve para las dos conexiones.
      </p>
      {locked ? (
        <div className="rounded-lg border border-ink-100 bg-ink-50/60 px-4 py-3.5 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-ink-600 flex items-start gap-2 min-w-0">
            <Lock size={14} className="text-ink-400 shrink-0 mt-px" aria-hidden />
            <span>
              Credenciales guardadas y <strong>bloqueadas</strong> — Dominio, Client ID y Client secret.
              No se muestran, no se autocompletan y no se pueden modificar sin desbloquear.
            </span>
          </div>
          <button type="button" onClick={() => setEditing(true)} className="btn-ghost text-xs shrink-0">
            Editar credenciales
          </button>
        </div>
      ) : (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="label" htmlFor={`shopify-domain-${store}`}>Dominio</label>
          {/* autoComplete="off" — a .myshopify.com domain doesn't look like a
              username, so "off" is enough here (the autofill incident hit the
              credential-shaped fields below, now CredentialInput). */}
          <input id={`shopify-domain-${store}`} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder={cfg.defaultDomain}
            className="input mt-1" autoComplete="off" />
        </div>
        <div>
          <label className="label" htmlFor={`shopify-client-id-${store}`}>Client ID</label>
          {/* CredentialInput + non-credential name — the password manager once
              autofilled the saved email/password into these fields. */}
          <CredentialInput id={`shopify-client-id-${store}`} name={`shopify-client-id-${store}`}
            value={clientId} onChange={(e) => setClientId(e.target.value)}
            placeholder="p. ej. 8b13…"
            className="input mt-1" />
        </div>
        <div>
          <label className="label" htmlFor={`shopify-client-secret-${store}`}>Client secret</label>
          <CredentialInput secret id={`shopify-client-secret-${store}`} name={`shopify-client-secret-${store}`}
            value={clientSecret} onChange={(e) => setClientSecret(e.target.value)}
            placeholder={connectedAt ? '•••••••• (guardado)' : 'Secret de la app'}
            className="input mt-1" />
        </div>
      </div>
      )}
      <div className="flex flex-wrap items-center gap-2 mt-3">
        {!locked && (
          <button type="button" onClick={save} disabled={status === 'saving'} className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
            {status === 'saving' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Guardar conexión
          </button>
        )}
        {!locked && connectedAt ? (
          <button
            type="button"
            onClick={() => { setClientId(''); setClientSecret(''); setDomain(savedDomain || cfg.defaultDomain); setEditing(false); setMsg(''); setStatus('idle'); }}
            className="btn-ghost text-sm"
          >
            Cancelar
          </button>
        ) : null}
        {store === SHOPIFY_STORE_ALCOVER && (
          <button type="button" onClick={syncAll} disabled={syncing} className="btn-ghost text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
            {syncing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Sincronizar todo
          </button>
        )}
        {connectedAt ? <span className="text-[11px] text-ink-400 min-w-0 truncate">Conectado · {formatDateTime(connectedAt)}</span> : null}
      </div>
      {msg && <p className={`text-xs mt-2 ${status === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-ink-500'}`}>{msg}</p>}
    </SettingsSection>
  );
}
