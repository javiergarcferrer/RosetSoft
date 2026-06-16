import { lazy, Suspense, useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { RefreshCw, Hourglass, LogOut } from 'lucide-react';
import { AppProvider, useApp } from './context/AppContext.jsx';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { NavMemoryProvider } from './context/NavMemory.jsx';
import { safeDynamicImport } from './lib/dynamicImport.js';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import SetPassword from './pages/SetPassword.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Customers from './pages/Customers.jsx';
import CustomerDetail from './pages/CustomerDetail.jsx';
import Professionals from './pages/Professionals.jsx';
import ProfessionalDetail from './pages/ProfessionalDetail.jsx';
import Quotes from './pages/Quotes.jsx';
import QuoteBuilder from './pages/QuoteBuilder.jsx';
import Orders from './pages/Orders.jsx';
import OrderDetail from './pages/OrderDetail.jsx';
import Comisiones from './pages/Comisiones.jsx';
import Chats from './pages/Chats.jsx';
import Difusion from './pages/Difusion.jsx';
import Instagram from './pages/Instagram.jsx';
import PublicStore from './pages/PublicStore.jsx';
import DataDeletion from './pages/DataDeletion.jsx';
import Settings from './pages/Settings.jsx';
import Integrations from './pages/Integrations.jsx';
import PublicQuoteView from './pages/PublicQuoteView.jsx';
import NotFound from './pages/NotFound.jsx';

// Accounting + admin pages are code-split: the CRM bundle (what every seller
// loads daily) stays lean, and each back-office area arrives on demand.
// Layout's <Suspense> shows the loading state while a chunk fetches; the
// safeDynamicImport wrapper recovers stale-deploy chunk misses with a reload.
const lazyPage = (loader) => lazy(() => safeDynamicImport(loader));
const AdminUsers = lazyPage(() => import('./pages/admin/Users.jsx'));
const Jarvis = lazyPage(() => import('./pages/Jarvis.jsx'));
const AdminMaterials = lazyPage(() => import('./pages/admin/Materials.jsx'));
const AdminCatalogs = lazyPage(() => import('./pages/admin/Catalogs.jsx'));
const AdminCatalog = lazyPage(() => import('./pages/admin/Catalog.jsx'));
const InventoryExistencias = lazyPage(() => import('./pages/inventory/Existencias.jsx'));
const InventoryLifestyleGarden = lazyPage(() => import('./pages/inventory/LifestyleGarden.jsx'));
const AccountingWorkspace = lazyPage(() => import('./pages/accounting/Workspace.jsx'));
const AccountingDashboard = lazyPage(() => import('./pages/accounting/Dashboard.jsx'));
const AccountingLedger = lazyPage(() => import('./pages/accounting/Ledger.jsx'));
const AccountingStatements = lazyPage(() => import('./pages/accounting/Statements.jsx'));
const ChartOfAccounts = lazyPage(() => import('./pages/accounting/ChartOfAccounts.jsx'));
const AccountingSettings = lazyPage(() => import('./pages/accounting/AccountingSettings.jsx'));
const AccountingExpenses = lazyPage(() => import('./pages/accounting/Expenses.jsx'));
const AccountingSuppliers = lazyPage(() => import('./pages/accounting/Suppliers.jsx'));
const AccountingFacturacion = lazyPage(() => import('./pages/accounting/Facturacion.jsx'));
const AccountingLigneRoset = lazyPage(() => import('./pages/accounting/LigneRosetSales.jsx'));
const AccountingCompras = lazyPage(() => import('./pages/accounting/Compras.jsx'));
const AccountingImportaciones = lazyPage(() => import('./pages/accounting/Importaciones.jsx'));
const AccountingImportacionDetail = lazyPage(() => import('./pages/accounting/ImportacionDetail.jsx'));
const AccountingECFSequences = lazyPage(() => import('./pages/accounting/ECFSequences.jsx'));
const AccountingCuentas = lazyPage(() => import('./pages/accounting/CuentasCobrarPagar.jsx'));
const AccountingConciliacion = lazyPage(() => import('./pages/accounting/Conciliacion.jsx'));
const AccountingImpuestos = lazyPage(() => import('./pages/accounting/Impuestos.jsx'));
const AccountingInformes = lazyPage(() => import('./pages/accounting/Informes.jsx'));
const AccountingPeriodos = lazyPage(() => import('./pages/accounting/Periodos.jsx'));
const AccountingNomina = lazyPage(() => import('./pages/accounting/Nomina.jsx'));
const AccountingEmpleados = lazyPage(() => import('./pages/accounting/Empleados.jsx'));

/**
 * Loading screen. If the boot takes longer than 5 s — typically because of a
 * stale Supabase token whose getSession() never returns — surface an "escape
 * hatch" button so the user can clear it and continue, instead of staring at
 * a spinner. AuthProvider has its own 3 s timeout, so this button is the
 * second-line defense when even that fallback doesn't recover.
 */
function Loading() {
  const { forceReset } = useAuth();
  const [showEscape, setShowEscape] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShowEscape(true), 5000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="h-full flex flex-col items-center justify-center text-ink-500 text-sm gap-3 px-6">
      <div className="animate-pulse">Cargando…</div>
      {showEscape && (
        <button
          type="button"
          onClick={forceReset}
          className="btn-ghost text-xs inline-flex items-center gap-1.5"
        >
          <RefreshCw size={12} />
          ¿Tardó demasiado? Toca aquí para reiniciar la sesión.
        </button>
      )}
    </div>
  );
}

function RequireAuth({ children }) {
  const { ready, user } = useAuth();
  if (!ready) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function RedirectIfAuthed({ children }) {
  const { ready, user } = useAuth();
  if (!ready) return <Loading />;
  if (user) return <Navigate to="/" replace />;
  return children;
}

function Gate({ children }) {
  const { ready, currentProfile } = useApp();
  const { user, signOut } = useAuth();

  if (!ready) return <Loading />;

  // Deleted-while-signed-in safety net. An admin can hard-delete a
  // user via /admin/users; that removes their `auth.users` row AND
  // their `profiles` row. If the deleted user was holding an active
  // JWT, the access token stays valid until it expires (~1h), so
  // they'd otherwise float around the app with `user` set but no
  // backing profile — and Supabase RLS would deny every query.
  // ensureDefaultProfile() doesn't try to recreate the row because
  // the deletion is the admin's explicit intent. We sign them out
  // immediately so they bounce to /login and can't keep operating
  // on a phantom session.
  if (user && !currentProfile) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6 gap-4">
        <div className="w-12 h-12 rounded-full bg-amber-100 text-amber-700 inline-flex items-center justify-center">
          <Hourglass size={22} />
        </div>
        <div>
          <div className="text-lg font-semibold">Sesión no válida</div>
          <p className="text-sm text-ink-500 max-w-md mt-1">
            Tu cuenta ya no existe o fue eliminada. Cierra sesión para volver a la pantalla de inicio.
          </p>
          <p className="text-xs text-ink-400 mt-3">
            Conectado como <b className="text-ink-700">{user.email}</b>.
          </p>
        </div>
        <button
          type="button"
          onClick={signOut}
          className="btn-primary text-sm inline-flex items-center gap-1.5"
          autoFocus
        >
          <LogOut size={14} />
          Cerrar sesión
        </button>
      </div>
    );
  }

  // First-time invite-flow gate. The invitee just clicked the magic
  // link in their email and is signed in via a recovery-grant
  // session — but they've never set a password. If we let them past
  // here they could navigate the app, and the moment the session
  // expires or they sign out they'd be locked out forever (the
  // magic link is single-use). Forcing them onto SetPassword
  // resolves that: they pick a password, the page calls
  // supabase.auth.updateUser({ password }) + stamps
  // profile.passwordSetAt = now, and the Gate falls through to the
  // app on the next render.
  //
  // Bootstrap admins (created via the Supabase Dashboard's Add User
  // screen) bypass this because ensureDefaultProfile() stamps
  // passwordSetAt on first sign-in for any email in the
  // settings.admin_emails allowlist — they already typed a password
  // when their account was created.
  if (user && currentProfile && !currentProfile.passwordSetAt) {
    return <SetPassword />;
  }

  // The user is authenticated with Supabase but doesn't have an
  // active profile yet — either an admin hasn't activated them, or
  // an admin deactivated them. Either way, they can't see the app.
  // Show a quiet "pending approval" screen with sign-out as the
  // only available action so they can re-sign-in as a different
  // account if needed.
  if (user && currentProfile && !currentProfile.active) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6 gap-4">
        <div className="w-12 h-12 rounded-full bg-amber-100 text-amber-700 inline-flex items-center justify-center">
          <Hourglass size={22} />
        </div>
        <div>
          <div className="text-lg font-semibold">Cuenta pendiente de aprobación</div>
          <p className="text-sm text-ink-500 max-w-md mt-1">
            Tu administrador necesita activar tu cuenta antes de que puedas usar el sistema. Si crees que es un error, contáctalo directamente.
          </p>
          <p className="text-xs text-ink-400 mt-3">
            Has iniciado sesión como <b className="text-ink-700">{user.email}</b>.
          </p>
        </div>
        <button
          type="button"
          onClick={signOut}
          className="btn-ghost text-sm inline-flex items-center gap-1.5"
        >
          <LogOut size={14} />
          Cerrar sesión
        </button>
      </div>
    );
  }
  return children;
}

// Role-aware home: accounting users land on /accounting (a payable-
// oriented view), everyone else gets the sales Dashboard. We can't
// just `<Navigate>` at the route level because currentProfile isn't
// available until AppProvider has resolved, so this thin wrapper
// reads from useApp() at render time and either redirects or
// delegates to Dashboard. Dashboard itself is untouched.
function RoleHome() {
  const { currentProfile } = useApp();
  if (currentProfile?.role === 'accounting') {
    return <Navigate to="/accounting/dashboard" replace />;
  }
  return <Dashboard />;
}

function ProtectedApp() {
  return (
    <AppProvider>
      <Gate>
        <Routes>
          {/* JARVIS — full-screen command center. Lives OUTSIDE Layout on
              purpose: opening it hides the sidebar and app chrome entirely
              (the page owns the whole viewport and its own scrolling); its
              header carries the exit back to the app. Needs its own
              Suspense — Layout's boundary doesn't wrap it. */}
          <Route
            path="jarvis"
            element={(
              <Suspense fallback={<div style={{ height: '100%', background: '#000' }} />}>
                <Jarvis />
              </Suspense>
            )}
          />
          <Route element={<Layout />}>
            <Route index element={<RoleHome />} />
            <Route path="chats" element={<Chats />} />
            <Route path="chats/difusion" element={<Difusion />} />
            <Route path="marketing" element={<Instagram />} />
            <Route path="instagram-studio" element={<Instagram />} />
            <Route path="customers" element={<Customers />} />
            <Route path="customers/:customerId" element={<CustomerDetail />} />
            <Route path="professionals" element={<Professionals />} />
            <Route path="professionals/:professionalId" element={<ProfessionalDetail />} />
            <Route path="quotes" element={<Quotes />} />
            <Route path="quotes/new" element={<QuoteBuilder />} />
            <Route path="quotes/:quoteId" element={<QuoteBuilder />} />
            <Route path="orders" element={<Orders />} />
            <Route path="orders/:orderId" element={<OrderDetail />} />
            {/* Commissions — the CRM↔Accounting bridge surface (role-adaptive). */}
            <Route path="comisiones" element={<Comisiones />} />
            {/* Legacy redirects */}
            <Route path="containers" element={<Navigate to="/orders" replace />} />
            <Route path="containers/:containerId" element={<Navigate to="/orders" replace />} />
            <Route path="settings" element={<Settings />} />
            <Route path="integraciones" element={<Integrations />} />
            {/* Admin-only — the components themselves render a friendly
                "Acceso restringido" empty state when an employee navigates
                here, so we don't have to redirect at the route level. */}
            <Route path="admin/users" element={<AdminUsers />} />
            <Route path="admin/materials" element={<AdminMaterials />} />
            {/* Catálogos — the brand-catalog section: an index of brands, each
                with its own page + import manner. /admin/catalog (the old
                Roset-only URL) is the index now; old bookmarks land one click
                from the Roset page. */}
            <Route path="admin/catalog" element={<AdminCatalogs />} />
            <Route path="admin/catalog/roset" element={<AdminCatalog />} />
            {/* LifestyleGarden moved out of Catálogos into the standalone
                Inventario section — old bookmarks redirect there. */}
            <Route path="admin/catalog/lifestylegarden" element={<Navigate to="/inventario/lifestylegarden" replace />} />
            {/* Inventario — a STANDALONE section (no longer a Contabilidad
                center) while the accounting engine is in testing: just a place
                to hold current stock. Two tabs: manual Existencias + the LSG
                Shopify-synced stock. */}
            <Route path="inventario" element={<Navigate to="/inventario/existencias" replace />} />
            <Route path="inventario/existencias" element={<InventoryExistencias />} />
            <Route path="inventario/lifestylegarden" element={<InventoryLifestyleGarden />} />
            {/* Accounting surface. /accounting lands on the Panel (the
                business overview) — the sales/commissions workspace lives at
                /accounting/ventas with the other Ventas tabs. Every legacy
                sub-path redirects so old bookmarks still work. Pages
                self-gate on the accounting/admin role. */}
            <Route path="accounting" element={<Navigate to="/accounting/dashboard" replace />} />
            <Route path="accounting/ventas" element={<AccountingWorkspace />} />
            <Route path="accounting/dashboard" element={<AccountingDashboard />} />
            <Route path="accounting/ledger" element={<AccountingLedger />} />
            <Route path="accounting/statements" element={<AccountingStatements />} />
            <Route path="accounting/chart" element={<ChartOfAccounts />} />
            <Route path="accounting/settings" element={<AccountingSettings />} />
            <Route path="accounting/expenses" element={<AccountingExpenses />} />
            <Route path="accounting/suppliers" element={<AccountingSuppliers />} />
            <Route path="accounting/facturacion" element={<AccountingFacturacion />} />
            <Route path="accounting/ligne-roset" element={<AccountingLigneRoset />} />
            <Route path="accounting/compras" element={<AccountingCompras />} />
            {/* Inventario left Contabilidad — old accounting bookmarks redirect
                to the standalone section. */}
            <Route path="accounting/inventario" element={<Navigate to="/inventario/existencias" replace />} />
            <Route path="accounting/importaciones" element={<AccountingImportaciones />} />
            <Route path="accounting/importaciones/:id" element={<AccountingImportacionDetail />} />
            <Route path="accounting/ecf" element={<AccountingECFSequences />} />
            <Route path="accounting/cuentas" element={<AccountingCuentas />} />
            <Route path="accounting/conciliacion" element={<AccountingConciliacion />} />
            <Route path="accounting/impuestos" element={<AccountingImpuestos />} />
            <Route path="accounting/informes" element={<AccountingInformes />} />
            <Route path="accounting/periodos" element={<AccountingPeriodos />} />
            <Route path="accounting/nomina" element={<AccountingNomina />} />
            <Route path="accounting/empleados" element={<AccountingEmpleados />} />
            <Route path="accounting/quotes" element={<Navigate to="/accounting/ventas" replace />} />
            <Route path="accounting/commissions" element={<Navigate to="/accounting/ventas" replace />} />
            <Route path="accounting/odoo" element={<Navigate to="/accounting/ventas" replace />} />
            {/* The standalone admin commissions report folded into the
                accounting workspace (comisiones por pagar). Redirect old
                bookmarks there instead of 404'ing. */}
            <Route path="admin/commissions" element={<Navigate to="/comisiones" replace />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Gate>
    </AppProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      {/* Tracks in-app history depth so every "Back" returns you to the page
          you actually came from, not a fixed section list (see NavMemory). */}
      <NavMemoryProvider>
        <Routes>
          <Route path="/login" element={<RedirectIfAuthed><Login /></RedirectIfAuthed>} />
          {/* Public, logged-out interactive quote view. Lives OUTSIDE
              RequireAuth so a client with the link never hits the login wall.
              The optional `:slug` segment carries the human label
              ("eduardo-garcia-cotizacion-1042") so the sent URL reads like the
              PDF — it's purely cosmetic; the token is the real key, and the
              bare `/q/:token` form (older links) still resolves. */}
          <Route path="/q/:token" element={<PublicQuoteView />} />
          <Route path="/q/:slug/:token" element={<PublicQuoteView />} />
          {/* Public, logged-out storefront ("Tienda"). Like the quote link it
              lives OUTSIDE RequireAuth so a customer never hits the login wall;
              the `store` Edge Function serves a public-safe, margin-free catalog. */}
          <Route path="/tienda" element={<PublicStore />} />
          {/* Public, logged-out data-deletion instructions. Lives OUTSIDE
              RequireAuth (a Meta reviewer / a member of the public must reach
              it without a login) and is pinned light by isPublicRoute. This is
              the URL pasted into the Meta App Dashboard's "User Data Deletion". */}
          <Route path="/eliminar-datos" element={<DataDeletion />} />
          <Route path="/*" element={<RequireAuth><ProtectedApp /></RequireAuth>} />
        </Routes>
      </NavMemoryProvider>
    </AuthProvider>
  );
}
