import { createContext } from 'react';

// The company (house) account cost discount %, threaded to the editor line
// cards so a company-account quote shows DEALER COST on each product/component
// total (not list). 0 ⇒ a normal customer quote — no scaling. Provided by
// QuoteBuilder, read by QuoteLineItem / its CalculatorBand + ComponentRow, so
// LineItemList doesn't have to carry it per line (same escape hatch as
// FamiliesContext). The editable unit-price input stays on the LIST price; only
// the derived totals are scaled (resolveLineItem applies it).
export const CompanyDiscountContext = createContext(0);
