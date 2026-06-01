// The store (Tienda / public storefront) ViewModel barrel.
//
// MVVM layering, same as core/quote and core/tracking:
//   • Model      — reused from lib/pricing, lib/orderStages, lib/constants and
//                  lib/statusPill; the store invents no new pricing/logistics rule.
//   • ViewModel  — resolveStore (views/store.js): the single pure projection the
//                  public storefront renders. The page derives nothing itself.
//   • View       — src/pages/PublicStore.jsx renders this projection; the public
//                  `store` Edge Function feeds it the rows.
//
// Import the store ViewModel from here (`core/store`), never reach into the
// views/ file directly — mirrors how the rest of the app imports core barrels.
export { resolveStore } from './views/store.js';
