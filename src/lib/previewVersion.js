// Link-preview cache-buster version, shared by every launcher link builder
// (contract, statement, storefront, configurator).
//
// WhatsApp / Meta freeze a link's preview card per URL STRING for weeks. When we
// re-render the og card images (scripts/genOgCards.mjs → og-*-vN.jpg), a link
// that was already shared keeps showing the OLD cached card. Appending `&pv=<N>`
// to the shared URL makes a freshly-copied link a URL WhatsApp has never crawled,
// so it fetches the new card.
//
// BUMP THIS in lockstep with the og-*-vN.jpg image version every time the cards
// change, so re-copied links always pull the latest card.
export const PREVIEW_VERSION = 7;
