import { Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider, useApp } from './context/AppContext.jsx';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { CartProvider } from './context/CartContext.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Catalog from './pages/Catalog.jsx';
import ProductDetail from './pages/ProductDetail.jsx';
import Materials from './pages/Materials.jsx';
import MaterialDetail from './pages/MaterialDetail.jsx';
import Customers from './pages/Customers.jsx';
import Quotes from './pages/Quotes.jsx';
import QuoteBuilder from './pages/QuoteBuilder.jsx';
import Containers from './pages/Containers.jsx';
import ContainerDetail from './pages/ContainerDetail.jsx';
import CatalogImport from './pages/CatalogImport.jsx';
import Settings from './pages/Settings.jsx';

function Loading() {
  return <div className="h-full flex items-center justify-center text-ink-500 text-sm">Loading…</div>;
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
  const { ready } = useApp();
  if (!ready) return <Loading />;
  return children;
}

function ProtectedApp() {
  return (
    <AppProvider>
      <CartProvider>
        <Gate>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Dashboard />} />
              <Route path="catalog" element={<Catalog />} />
              <Route path="catalog/:productId" element={<ProductDetail />} />
              <Route path="materials" element={<Materials />} />
              <Route path="materials/:materialId" element={<MaterialDetail />} />
              <Route path="customers" element={<Customers />} />
              <Route path="quotes" element={<Quotes />} />
              <Route path="quotes/new" element={<QuoteBuilder />} />
              <Route path="quotes/:quoteId" element={<QuoteBuilder />} />
              <Route path="containers" element={<Containers />} />
              <Route path="containers/:containerId" element={<ContainerDetail />} />
              <Route path="import" element={<CatalogImport />} />
              <Route path="settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </Gate>
      </CartProvider>
    </AppProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<RedirectIfAuthed><Login /></RedirectIfAuthed>} />
        <Route path="/*" element={<RequireAuth><ProtectedApp /></RequireAuth>} />
      </Routes>
    </AuthProvider>
  );
}
