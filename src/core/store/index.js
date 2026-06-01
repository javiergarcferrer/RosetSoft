// The store (Tienda / showroom) MODEL + ViewModel barrel.
//
// MVVM layering, same as core/quote and core/tracking:
//   • Model      — reused from lib/pricing, lib/orderStages, lib/constants and
//                  core/tracking; the store invents no new pricing/logistics rule.
//   • ViewModel  — resolveStore (views/store.js): the single pure projection the
//                  Tienda page renders, for both the Mercancía and Materiales
//                  segments. The page derives nothing itself.
//   • View       — src/pages/Store.jsx renders this projection.
//
// Import the store ViewModel from here (`core/store`), never reach into the
// views/ file directly — mirrors how the rest of the app imports core barrels.
export {
  resolveStore,
  STORE_VIEW_MERCHANDISE,
  STORE_VIEW_MATERIALS,
} from './views/store.js';
