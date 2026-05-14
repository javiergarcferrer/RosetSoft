import Dexie from 'dexie';

/**
 * Roset Soft local database (IndexedDB via Dexie).
 *
 * Data model overview:
 *  - profiles: local "users" of the app (no real auth yet — switch on login screen)
 *  - settings: per-profile company info, default currency, logo, currency rates, terms
 *  - categories: top-level sections (Seats, Beds, Dining Chairs, etc.)
 *  - materials: unified fabrics + leathers — both priced by grade letter, both have colors
 *  - materialColors: each color belongs to a material (with optional swatch image)
 *  - products: a model (e.g., ANDY, ARCHI) — has many variants, references designer/year/notes
 *  - productVariants: a configuration of a product (e.g., "ARMCHAIR", "SOFA") with own
 *    dimensions, yardage, reference code, and a price-by-grade table
 *  - images: blob storage for product photos and material swatches
 *  - customers: client records
 *  - quotes: top-level quote (status, customer, currency, discount, terms)
 *  - quoteLines: line items on a quote (productVariantId + materialId + colorId + qty + price)
 */

class RosetDatabase extends Dexie {
  constructor() {
    super('RosetSoft');
    this.version(1).stores({
      profiles: 'id, name, createdAt',
      settings: 'profileId',
      categories: 'id, name, sortOrder',
      materials: 'id, kind, name, grade',
      materialColors: 'id, materialId, name, code',
      products: 'id, categoryId, name, designer, year',
      productVariants: 'id, productId, name, reference, sortOrder',
      images: 'id, kind, ownerId',
      customers: 'id, profileId, name, company, email',
      quotes: 'id, profileId, customerId, number, status, createdAt, updatedAt',
      quoteLines: 'id, quoteId, productVariantId, materialId, sortOrder',
    });
    this.version(2).stores({
      quotes: 'id, profileId, customerId, number, status, isCart, createdAt, updatedAt',
    });
  }
}

export const db = new RosetDatabase();

/** Generate a short, sortable ID. */
export function newId() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  );
}

/** Convert a File or Blob into a Blob suitable for the images table. */
export async function fileToBlob(file) {
  if (file instanceof Blob) return file;
  const buf = await file.arrayBuffer();
  return new Blob([buf], { type: file.type || 'application/octet-stream' });
}

/** Saves a Blob/File as an image record and returns the image id. */
export async function saveImage({ kind, ownerId, file, label = '' }) {
  const blob = await fileToBlob(file);
  const id = newId();
  await db.images.put({ id, kind, ownerId, label, blob, contentType: blob.type, size: blob.size, createdAt: Date.now() });
  return id;
}

/** Returns an object URL for an image id, or null if missing. Caller must revokeObjectURL when done. */
export async function imageObjectUrl(id) {
  if (!id) return null;
  const rec = await db.images.get(id);
  if (!rec || !rec.blob) return null;
  return URL.createObjectURL(rec.blob);
}

export async function deleteImage(id) {
  if (!id) return;
  await db.images.delete(id);
}

/** Returns the current active profile or creates a default one. */
export async function ensureDefaultProfile() {
  const count = await db.profiles.count();
  if (count === 0) {
    const id = newId();
    await db.profiles.put({ id, name: 'Default', createdAt: Date.now() });
    await db.settings.put({
      profileId: id,
      companyName: 'Tu Empresa',
      companyAddress: 'Santo Domingo, República Dominicana',
      companyEmail: '',
      companyPhone: '',
      logoImageId: null,
      defaultCurrency: 'USD',
      currencyRates: { USD: 1, DOP: 60.0 },
      bpd: { buy: null, sell: null, updatedAt: null },
      market: { rate: null, date: null, source: null },
      dopRateMode: 'bpd-sell',
      defaultMarginPct: 0,
      defaultDiscountPct: 0,
      quoteTerms: 'Cotización válida por 30 días. Precios en pesos dominicanos. Tiempo de entrega aproximado: 12–16 semanas. Sujeto a disponibilidad.',
      quoteFooter: '',
      quoteCounter: 1000,
    });
    return id;
  }
  // return most-recent
  const profiles = await db.profiles.orderBy('createdAt').reverse().toArray();
  return profiles[0].id;
}

export async function getSettings(profileId) {
  return db.settings.get(profileId);
}

export async function updateSettings(profileId, patch) {
  const cur = (await db.settings.get(profileId)) || { profileId };
  await db.settings.put({ ...cur, ...patch });
}
