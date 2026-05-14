import { db, newId } from './database.js';

/* ------------------------------------------------------------------ */
/*  Categories                                                         */
/* ------------------------------------------------------------------ */
export const categoriesRepo = {
  all: () => db.categories.orderBy('sortOrder').toArray(),
  get: (id) => db.categories.get(id),
  upsert: async (data) => {
    const id = data.id || newId();
    await db.categories.put({ ...data, id });
    return id;
  },
  remove: (id) => db.categories.delete(id),
};

/* ------------------------------------------------------------------ */
/*  Materials (fabrics + leathers, both priced by grade letter)        */
/* ------------------------------------------------------------------ */
export const materialsRepo = {
  all: () => db.materials.toArray(),
  byKind: (kind) => db.materials.where('kind').equals(kind).toArray(),
  get: (id) => db.materials.get(id),
  upsert: async (data) => {
    const id = data.id || newId();
    await db.materials.put({ ...data, id });
    return id;
  },
  remove: async (id) => {
    const colors = await db.materialColors.where('materialId').equals(id).toArray();
    await db.materialColors.bulkDelete(colors.map((c) => c.id));
    await db.materials.delete(id);
  },
};

export const colorsRepo = {
  forMaterial: (materialId) =>
    db.materialColors.where('materialId').equals(materialId).toArray(),
  get: (id) => db.materialColors.get(id),
  upsert: async (data) => {
    const id = data.id || newId();
    await db.materialColors.put({ ...data, id });
    return id;
  },
  remove: (id) => db.materialColors.delete(id),
};

/* ------------------------------------------------------------------ */
/*  Products + Variants                                                */
/* ------------------------------------------------------------------ */
export const productsRepo = {
  all: () => db.products.toArray(),
  byCategory: (categoryId) =>
    db.products.where('categoryId').equals(categoryId).toArray(),
  get: (id) => db.products.get(id),
  upsert: async (data) => {
    const id = data.id || newId();
    await db.products.put({ ...data, id });
    return id;
  },
  remove: async (id) => {
    const variants = await db.productVariants.where('productId').equals(id).toArray();
    await db.productVariants.bulkDelete(variants.map((v) => v.id));
    await db.products.delete(id);
  },
};

export const variantsRepo = {
  forProduct: (productId) =>
    db.productVariants.where('productId').equals(productId).toArray(),
  get: (id) => db.productVariants.get(id),
  upsert: async (data) => {
    const id = data.id || newId();
    await db.productVariants.put({ ...data, id });
    return id;
  },
  remove: (id) => db.productVariants.delete(id),
};

/* ------------------------------------------------------------------ */
/*  Customers                                                          */
/* ------------------------------------------------------------------ */
export const customersRepo = {
  forProfile: (profileId) =>
    db.customers.where('profileId').equals(profileId).toArray(),
  get: (id) => db.customers.get(id),
  upsert: async (data) => {
    const id = data.id || newId();
    await db.customers.put({ ...data, id });
    return id;
  },
  remove: (id) => db.customers.delete(id),
};

/* ------------------------------------------------------------------ */
/*  Quotes                                                             */
/* ------------------------------------------------------------------ */
export const quotesRepo = {
  forProfile: (profileId) =>
    db.quotes.where('profileId').equals(profileId).reverse().sortBy('createdAt'),
  get: (id) => db.quotes.get(id),
  upsert: async (data) => {
    const id = data.id || newId();
    const now = Date.now();
    await db.quotes.put({ createdAt: now, ...data, id, updatedAt: now });
    return id;
  },
  remove: async (id) => {
    const lines = await db.quoteLines.where('quoteId').equals(id).toArray();
    await db.quoteLines.bulkDelete(lines.map((l) => l.id));
    await db.quotes.delete(id);
  },
};

export const linesRepo = {
  forQuote: (quoteId) =>
    db.quoteLines.where('quoteId').equals(quoteId).sortBy('sortOrder'),
  upsert: async (data) => {
    const id = data.id || newId();
    await db.quoteLines.put({ ...data, id });
    return id;
  },
  remove: (id) => db.quoteLines.delete(id),
  bulkRemove: (ids) => db.quoteLines.bulkDelete(ids),
};
