-- Quote terms presets — the dealer's small library of named terms templates.
-- Until now there was ONE default terms string (settings.quote_terms) copied
-- onto every new quote. Ligne Roset sells two very different ways, though: a
-- PISO (stock/floor) sale ships from inventory now, while a SPECIAL order ships
-- in a container weeks out — different validity, lead time and payment language.
-- So terms become a named library the dealer applies to a quote with one tap
-- (the quote editor's picker writes the chosen body into quotes.terms, which
-- every surface already renders — client preview, public link, PDF).
--
-- Stored as a jsonb array of { id, label, body, orderType? } on settings
-- (team-readable, non-secret), surfaced by rowMapping as `quoteTermsPresets`.
-- rowMapping treats jsonb VALUES as opaque (only top-level row keys are
-- camel/snake-converted), so the `orderType` key round-trips verbatim — the
-- seed below matches exactly what the app writes. `orderType` tags which preset
-- the picker suggests for a piso vs special quote. Seeded with two presets so
-- the dealer starts with a sensible piso + special pair (DEFAULT mirrored in
-- src/lib/quoteTerms.ts).
alter table settings
  add column if not exists quote_terms_presets jsonb not null default
  '[{"id":"preset-piso","label":"Pedido de piso","orderType":"floor","body":"Cotización válida por 15 días. Precios en pesos dominicanos. Entrega inmediata sujeta a disponibilidad en almacén. Se requiere el pago total para apartar y retirar la mercancía."},{"id":"preset-especial","label":"Pedido especial","orderType":"special","body":"Cotización válida por 30 días. Precios en pesos dominicanos. Tiempo de entrega aproximado: 12–16 semanas. Se requiere un depósito del 50% para iniciar el pedido; el balance se paga antes de la entrega. Sujeto a disponibilidad del fabricante."}]'::jsonb;

notify pgrst, 'reload schema';
