// The Shopify control center ViewModel barrel.
//
// MVVM layering, same as core/store and core/tracking:
//   • Model      — src/lib/shopifyOrders.ts (pure fulfillment-state / totals).
//   • ViewModel  — resolveOrdersList (views/ordersView.js): the single pure
//                  projection the orders page renders. The page derives nothing.
//   • View       — src/pages/ShopifyOrders.jsx renders it; the `shopify-sync`
//                  Edge Function (ordersMode) feeds it the rows.
//
// Import from here (`core/shopify`), never reach into views/ directly.
export { resolveOrdersList } from './views/ordersView.js';
