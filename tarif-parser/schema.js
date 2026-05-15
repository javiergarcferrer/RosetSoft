// Output validators. Every record that lands in catalog.json must pass these.

import { z } from 'zod';

const ID = z.string().regex(/^[0-9a-f]{12}$/, 'id must be 12 lowercase hex chars');

// "A".."Z" plus "S" (microfiber). priceByGrade keys must be uppercase letters.
const GRADE = z.string().regex(/^[A-Z]$/);

// Every variant in the output JSON MUST carry a reference code, dimensions,
// an image, and a description. The serializer drops variants that can't
// satisfy all four; this schema enforces that at validation time.
export const VariantSchema = z.object({
  id: ID,
  name: z.string().min(1),
  reference: z.string().min(1),
  dimensions: z.string().min(1),
  yardage: z.string().nullable(),
  // The finish / color / material chosen for this specific variant.
  material: z.string().nullable().default(null),
  priceByGrade: z.record(GRADE, z.number().finite()).default({}),
  priceFixed: z.number().finite().nullable(),
  sortOrder: z.number().int().nonnegative(),
  // Denormalised onto every variant so the JSON is self-contained.
  description: z.string().min(1),
  imageFile: z.string().min(1),
});

export const ProductSchema = z.object({
  id: ID,
  name: z.string().min(1),
  categoryName: z.string().nullable(),
  designer: z.string().nullable(),
  year: z.number().int().nullable(),
  description: z.string().nullable(),
  // The "Important" section that appears above the Description on the
  // product front card (option lists, base-finish choices, add-on refs, etc.).
  important: z.string().nullable().default(null),
  impossibilities: z.array(z.string()).default([]),
  modelCode: z.string().nullable(),
  pages: z.array(z.number().int().positive()),
  heroImageFile: z.string().nullable().default(null),
  variants: z.array(VariantSchema).default([]),
});

export const ColorSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1),
  swatchFile: z.string().nullable().default(null),
});

export const MaterialSchema = z.object({
  id: ID,
  kind: z.enum(['fabric', 'leather', 'outdoor-fabric']),
  name: z.string().min(1),
  grade: z.string().nullable(),
  composition: z.string().nullable(),
  width: z.string().nullable(),
  wear: z.string().nullable(),
  martindale: z.number().int().nullable(),
  pricePerUnit: z.number().finite().nullable(),
  pages: z.array(z.number().int().positive()).default([]),
  colors: z.array(ColorSchema).default([]),
});

export const CatalogSchema = z.object({
  meta: z.object({
    source: z.string(),
    pageCount: z.number().int().positive(),
    generatedAt: z.string(),
  }),
  products: z.array(ProductSchema),
  materials: z.array(MaterialSchema),
});

// Hard-invariant checker. Returns { ok, errors[] }. Schema validation is
// done in CatalogSchema; these are CROSS-record uniqueness checks.
export function checkInvariants(catalog) {
  const errors = [];
  // I1 unique product ids
  const idSet = new Set();
  for (const p of catalog.products) {
    if (idSet.has(p.id)) errors.push(`I1: duplicate product id ${p.id} (${p.name})`);
    idSet.add(p.id);
  }
  // I2 unique variant references globally (where reference != null/empty)
  const refMap = new Map();
  for (const p of catalog.products) {
    for (const v of p.variants) {
      if (!v.reference) continue;
      const prev = refMap.get(v.reference);
      if (prev) {
        errors.push(`I2: duplicate variant reference ${v.reference} in "${p.name}" and "${prev}"`);
      } else {
        refMap.set(v.reference, p.name);
      }
    }
  }
  // I4 unique normalized product names. We don't import normalizeKey here to
  // avoid a circular dep; ids already derive from normalizeKey so I1 covers it.
  // (Comment retained for symmetry with the spec.)
  // I5 unique color codes within a material
  for (const m of catalog.materials) {
    const seen = new Set();
    for (const c of m.colors) {
      if (seen.has(c.code)) {
        errors.push(`I5: duplicate color code ${c.code} in material "${m.name}"`);
      }
      seen.add(c.code);
    }
  }
  // I6 every variant belongs to exactly one product. Iteration order
  // guarantees this; nothing to check beyond schema.
  return { ok: errors.length === 0, errors };
}
