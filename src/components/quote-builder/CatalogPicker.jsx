import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, MoveHorizontal } from 'lucide-react';
import Modal from '../Modal.jsx';
import MaterialColorPicker from './MaterialColorPicker.jsx';
import ModelBrowser from './ModelBrowser.jsx';
import ModelLinkBar from './ModelLinkBar.jsx';
import { useApp } from '../../context/AppContext.jsx';
import { useLiveQuery } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { productForGrade } from '../../lib/catalog.js';
import { composeSubtype, composeFabricLabel } from '../../lib/subtype.js';
import { formatMoney } from '../../lib/format.js';

/**
 * Catalog picker — the model → fabric(grade)→ price quote flow.
 *
 *   Step 1: find a MODEL (a family of SKUs sharing the 8-digit root, e.g.
 *           "Togo Fireside Chair"). Two ways in:
 *             • Browse — every CATEGORY listed (collapsed); opening one
 *               lazy-loads its models. Mirrors the admin Catalog so the dealer
 *               navigates the catalog the same way everywhere.
 *             • Search — relevance-ranked matches (best first), grouped under
 *               their category. Ranking weights name > family > reference and
 *               exact > prefix > word-start > substring.
 *   Step 2: ONE combined step — a list of fabrics available for that model's
 *           grades, each row showing the fabric, its grade, and the model's
 *           PRICE in that grade. Picking one fills the quote line.
 *
 * Non-graded models (tables, lamps, wood chairs) skip step 2 — picking the
 * model inserts its single priced row directly.
 *
 * The catalog is tens of thousands of SKUs, so nothing pulls the whole table:
 * browse lazy-loads one category at a time, search hits Postgres for a bounded
 * matched set. Materials (a small table) load on open as before.
 */
const usd = (n) => formatMoney(Number(n) || 0, 'USD', { USD: 1 });

export default function CatalogPicker({ open, onClose, onInsert }) {
  const { profileId } = useApp();
  const [sel, setSel] = useState(null);   // selected graded family → step 2

  // Reset to the model list each time the modal (re)opens. ModelBrowser owns
  // its own (debounced) search state and remounts with the modal, so there's
  // nothing else to clear here.
  useEffect(() => {
    if (open) setSel(null);
  }, [open]);

  const materials = useLiveQuery(
    () => (profileId ? db.materials.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId, open],
    [],
  );

  // The selected model's Ligne Roset link + its offered-fabric allowlist (if the
  // dealer has linked it). Drives the fabric restriction in step 2.
  const modelRec = useLiveQuery(
    () => (sel?.root ? db.modelFabrics.get(sel.root) : Promise.resolve(null)),
    [sel?.root],
    null,
  );
  const nameFilter = useMemo(
    () => (modelRec?.patternNames?.length ? new Set(modelRec.patternNames) : undefined),
    [modelRec],
  );

  // Insert a line. `product` carries the price/reference (productForGrade for
  // the chosen grade); `material`+`color` (when present) compose the fabric
  // label and the swatch. Forcing a specific COLOR — not just a grade — means
  // the inserted line lands fully specified ("Grade X — MATERIAL · COLOR
  // (#code)") and its swatch is that color's own photo, mirroring the quote-
  // pane SwatchPicker. A plain (non-upholstered) product keeps its own
  // catalog subtype (the wood finish / variant text).
  function insertProduct(fam, product, grade, material, color) {
    if (!product) return;
    // The catalog's "Description 2" — the model's finish/variant text, e.g.
    // "STANDARD HEADBOARD" — parses into product.subtype. Keep it as the line's
    // read-only `productDescription` (its SECOND identifying line) so it SURVIVES
    // when a fabric grade takes over the subtype, and shows on every surface
    // (quote pane, client preview, public link, PDF). It is kept SEPARATE from
    // the editable `description` so the catalog text never pre-fills the dealer's
    // own "Descripción". The subtype slot is then the fabric (graded) or empty
    // (non-upholstered) — never the finish text masquerading as a fabric.
    onInsert({
      family: product.family || fam.family,
      reference: product.reference,
      name: product.name,
      dimensions: product.dimensions,
      subtype: (grade || material)
        ? composeSubtype(grade, composeFabricLabel(material, color))
        : '',
      productDescription: product.subtype || '',
      unitPrice: product.priceUsd,
      unitCost: product.cost,
      // The catalog's own photo (LSG mirror) rides along, so the line lands
      // fully illustrated with zero extra steps; LR rows carry none.
      imageId: product.imageId ?? null,
      swatchImageId: color?.imageId ?? null,
    });
    onClose();
  }

  function pickFamily(fam) {
    if (!fam.graded) {
      insertProduct(fam, productForGrade(fam, ''), '');
      return;
    }
    setSel(fam);
  }

  // Insert the model WITHOUT a material — a price RANGE line. We snapshot the
  // cheapest and priciest grade prices (grades are price-sorted asc) onto the
  // line so it reads "min – max" and the quote total widens accordingly; the
  // dealer (or the designer) pins a concrete fabric later. Identity comes from
  // the cheapest SKU so the line's reference root still resolves the family
  // when a material is finally chosen.
  function insertRange(fam) {
    const lo = productForGrade(fam, fam.grades[0]);
    const hi = productForGrade(fam, fam.grades[fam.grades.length - 1]);
    if (!lo || !hi) return;
    const min = Number(lo.priceUsd) || 0;
    const max = Number(hi.priceUsd) || 0;
    onInsert({
      family: lo.family || fam.family,
      reference: lo.reference,
      name: lo.name || fam.name,
      dimensions: lo.dimensions,
      subtype: '',
      // Carry the model's second description (finish/variant) — see insertProduct.
      productDescription: lo.subtype || '',
      unitPrice: min,
      unitCost: lo.cost,
      imageId: lo.imageId ?? null,
      swatchImageId: null,
      priceMin: min,
      priceMax: max,
    });
    onClose();
  }

  // Step 2 — does the catalog carry ANY material in one of this model's
  // grades? Drives the fallback: when none match we let the dealer pick the
  // price tier (grade) directly so the flow still works. The actual material→
  // color choice is delegated to the shared <MaterialColorPicker>, filtered to
  // `sel.grades`.
  const hasGradeMaterials = useMemo(() => {
    if (!sel) return false;
    const grades = new Set(sel.grades.map((g) => String(g).toUpperCase()));
    return materials.some((m) => m.grade && grades.has(String(m.grade).toUpperCase()));
  }, [sel, materials]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={sel ? `${sel.name} · elige la tela` : 'Catálogo'}
    >
      {!sel ? (
        <ModelBrowser profileId={profileId} onPick={pickFamily} />
      ) : (
        <>
          <button type="button" onClick={() => setSel(null)} className="back-link"><ChevronLeft size={12} /> Volver a modelos</button>
          {/* Link this model to its Ligne Roset page → restrict the fabric list
              to what the model actually offers (not every fabric in a grade is a
              technical option), and keep the link a click away. */}
          <ModelLinkBar root={sel.root} record={modelRec} />

          {/* Quote this model WITHOUT a material — a price RANGE the designer
              resolves later. A first-class choice above the fabric list, not a
              fallback: the dealer picks the model and defers the fabric. */}
          {sel.grades.length >= 2 && (
            <button
              type="button"
              onClick={() => insertRange(sel)}
              className="w-full text-left rounded-lg border border-dashed border-brand-300 bg-brand-50/40 hover:bg-brand-50 active:bg-brand-100/70 px-3 py-2.5 mb-2 min-h-11 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 transition-colors"
              title="Agregar este modelo sin elegir tela — se cotiza como un rango de precio (del grado más económico al más caro)"
            >
              <span className="text-sm font-medium text-brand-800 inline-flex items-center gap-1.5 min-w-0">
                <MoveHorizontal size={14} className="opacity-70 flex-shrink-0" aria-hidden />
                <span className="truncate">Sin material · cotizar por rango</span>
              </span>
              <span className="text-xs tabular-nums text-brand-800 whitespace-nowrap flex-shrink-0">
                {usd(productForGrade(sel, sel.grades[0])?.priceUsd)} – {usd(productForGrade(sel, sel.grades[sel.grades.length - 1])?.priceUsd)}
              </span>
            </button>
          )}
          {!hasGradeMaterials ? (
            // No fabric in the catalog for this model's grades — let the dealer
            // pick the price tier (grade) directly so the flow still works.
            <div className="max-h-[60vh] overflow-y-auto -mx-1">
              <div className="px-3 pb-2 text-[11px] text-ink-500">Sin telas del catálogo para estos grados — elige el grado por precio:</div>
              {sel.grades.map((g) => {
                const p = productForGrade(sel, g);
                return (
                  <button key={g} type="button" onClick={() => insertProduct(sel, p, g)} className="w-full text-left rounded-md px-3 py-2.5 mx-1 mb-0.5 flex items-center justify-between gap-2 min-h-11 hover:bg-ink-50 active:bg-ink-100 transition-colors">
                    <span className="chip bg-ink-100 text-ink-700 border border-ink-200 flex-shrink-0">Grado {g}</span>
                    <span className="text-sm tabular-nums text-ink-900 whitespace-nowrap">{usd(p?.priceUsd)}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            // Shared material→color body, restricted to the model's grades.
            // Picking forces a specific COLOR before placing: the product
            // (price/reference) comes from the material's own grade, the
            // subtype + swatch from the chosen color.
            <MaterialColorPicker
              materials={materials}
              gradeFilter={sel.grades}
              nameFilter={nameFilter}
              family={sel}
              currentGrade=""
              currentFabric=""
              onPick={(material, color) => {
                const grade = String(material.grade || '').toUpperCase();
                insertProduct(sel, productForGrade(sel, grade), grade, material, color);
              }}
            />
          )}
        </>
      )}
    </Modal>
  );
}
