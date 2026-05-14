import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { db, newId } from '../db/database.js';
import { useApp } from './AppContext.jsx';

/**
 * The "cart" is a running, in-progress draft quote.
 *
 * It's persisted as a real `quote` record in IndexedDB with status='draft' and
 * isCart=true. There's exactly one cart per profile at a time. The sidebar
 * reads + writes this quote's lines. When the user clicks "Save & open quote",
 * we flip isCart=false (and number it / move on) — or simply navigate to the
 * full builder for review.
 */

const Ctx = createContext(null);

export function CartProvider({ children }) {
  const { profileId, settings } = useApp();
  const [cartId, setCartId] = useState(null);
  const [open, setOpen] = useState(false);

  // Find or create the active cart for this profile
  useEffect(() => {
    if (!profileId) return;
    let cancel = false;
    (async () => {
      const existing = await db.quotes
        .where('profileId').equals(profileId)
        .filter((q) => q.isCart === true)
        .first();
      if (cancel) return;
      if (existing) {
        setCartId(existing.id);
      } else {
        const id = newId();
        await db.quotes.put({
          id,
          profileId,
          number: null,
          name: '',
          customerId: null,
          status: 'draft',
          isCart: true,
          currencyCode: 'USD',
          rates: settings?.currencyRates || { USD: 1, DOP: 60 },
          marginPct: 0,
          discountPct: settings?.defaultDiscountPct || 0,
          taxPct: 0,
          shipping: 0,
          terms: settings?.quoteTerms || '',
          notes: '',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        if (!cancel) setCartId(id);
      }
    })();
    return () => { cancel = true; };
  }, [profileId, settings]);

  const addLine = useCallback(async ({ variant, materialId = null, colorId = null, qty = 1, unitPrice = null }) => {
    if (!cartId || !variant) return;
    const existingLines = await db.quoteLines.where('quoteId').equals(cartId).toArray();
    const dupe = existingLines.find(
      (l) => l.productVariantId === variant.id && l.materialId === materialId && l.colorId === colorId
    );
    if (dupe) {
      await db.quoteLines.update(dupe.id, { qty: (dupe.qty || 0) + qty });
    } else {
      await db.quoteLines.put({
        id: newId(),
        quoteId: cartId,
        productVariantId: variant.id,
        materialId,
        colorId,
        qty,
        unitPrice: unitPrice ?? 0,
        priceOverride: null,
        lineMarginPct: 0,
        lineDiscountPct: 0,
        notes: '',
        sortOrder: existingLines.length,
      });
    }
    await db.quotes.update(cartId, { updatedAt: Date.now() });
    setOpen(true);
  }, [cartId]);

  const removeLine = useCallback(async (lineId) => {
    if (!cartId) return;
    await db.quoteLines.delete(lineId);
    await db.quotes.update(cartId, { updatedAt: Date.now() });
  }, [cartId]);

  const updateLine = useCallback(async (lineId, patch) => {
    if (!cartId) return;
    await db.quoteLines.update(lineId, patch);
    await db.quotes.update(cartId, { updatedAt: Date.now() });
  }, [cartId]);

  const clearCart = useCallback(async () => {
    if (!cartId) return;
    const lines = await db.quoteLines.where('quoteId').equals(cartId).toArray();
    await db.quoteLines.bulkDelete(lines.map((l) => l.id));
    await db.quotes.update(cartId, { updatedAt: Date.now() });
  }, [cartId]);

  /** Convert the cart into a numbered quote and reset the cart. */
  const finalizeCart = useCallback(async () => {
    if (!cartId || !settings) return null;
    const number = (settings.quoteCounter || 1000) + 1;
    await db.quotes.update(cartId, {
      isCart: false,
      number,
      updatedAt: Date.now(),
    });
    await db.settings.put({ ...settings, quoteCounter: number });
    setCartId(null); // a new cart will be created by the effect
    setOpen(false);
    return cartId; // the now-finalized quote id
  }, [cartId, settings]);

  return (
    <Ctx.Provider value={{ cartId, open, setOpen, addLine, removeLine, updateLine, clearCart, finalizeCart }}>
      {children}
    </Ctx.Provider>
  );
}

export function useCart() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useCart must be used inside <CartProvider>');
  return ctx;
}
