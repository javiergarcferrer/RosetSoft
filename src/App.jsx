import { Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider, useApp } from './context/AppContext.jsx';
import { CartProvider } from './context/CartContext.jsx';
import Layout from './components/Layout.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Catalog from './pages/Catalog.jsx';
import ProductDetail from './pages/ProductDetail.jsx';
import Materials from './pages/Materials.jsx';
import MaterialDetail from './pages/MaterialDetail.jsx';
import Customers from './pages/Customers.jsx';
import Quotes from './pages/Quotes.jsx';
import QuoteBuilder from './pages/QuoteBuilder.jsx';
import Import from './pages/Import.jsx';
import Settings from './pages/Settings.jsx';

function Gate({ children }) {
  const { ready } = useApp();
  if (!ready) {
    return (
      <div className="h-full flex items-center justify-center text-ink-500 text-sm">
        Loading…
      </div>
    );
  }
  return children;
}

export default function App() {
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
            <Route path="import" element={<Import />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Gate>
      </CartProvider>
    </AppProvider>
  );
}
