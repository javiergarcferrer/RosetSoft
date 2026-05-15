import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { db, newId } from '../db/database.js';
import { useApp } from './AppContext.jsx';

/**
 * The "cart" is a running, in-progress draft quote.
 *
 * It's persisted as a real `quote` record with isCart=true. There's at most
 * one cart per profile. We DO NOT create the cart row up front — that would
 * leave an empty quote in the database for every user who merely opens the
 * app. Instead, we lazily create the cart on the first addLine() call.
 *
 * Listing queries elsewhere filter `isCart=true` rows out, but the cart row
 * still simply doesn't exist until the user actually puts something in it.
 */

const Ctx = createContext(null);

export function CartProvider({ children }) {
  const { profileId, settings } = useApp();
  const [cartId, setCartId] = useState(null);
  const [open, setOpen] = useState(false);

  // Adopt an existing cart for this profile if one is already on disk. We
  // never create one here — see ensureCart() below.
  useEffect(() => {
    if (!profileId) return;
    let cancel = false;
    (async () => {
      const existing = await db.quotes
        .where('profileId').equals(profileId)
        .filter((q) => q.isCart === true)
        .first();
      if (cancel) return;
      if (existing) setCartId(existing.id);
    })();
    return () => { cancel = true; };
  }, [profileId]);


  // Lazily create the cart row the first time the user actually adds an item.
  const ensureCart = useCallback(async () => {
    if (cartId) return cartId;
    const existing = await db.quotes
      .where('profileId').equals(profileId)
      .filter((q) => q.isCart === true)
      .first();
    if (existing) {
      setCartId(existing.id);
      return existing.id;
    }
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
    setCartId(id);
    return id;
  }, [cartId, profileId, settings]);

  const addLine = useCallback(async ({ variant, materialId = null, colorId = null, qty = 1, unitPrice = null }) => {
    if (!variant || !profileId) return;
    const id = await ensureCart();
    const existingLines = await db.quoteLines.where('quoteId').equals(id).toArray();
    const dupe = existingLines.find(
      (l) => l.productVariantId === variant.id && l.materialId === materialId && l.colorId === colorId
    );
    if (dupe) {
      await db.quoteLines.update(dupe.id, { qty: (dupe.qty || 0) + qty });
    } else {
      await db.quoteLines.put({
        id: newId(),
        quoteId: id,
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
    await db.quotes.update(id, { updatedAt: Date.now() });
    setOpen(true);
  }, [ensureCart, profileId]);

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
    const finalizedId = cartId;
    setCartId(null); // a new cart will be lazily created on the next addLine
    setOpen(false);
    return finalizedId;
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
