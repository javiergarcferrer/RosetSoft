/**
 * Modules — the catalog-agnostic grouping that turns a compound line's flat
 * component list into a MODULAR product.
 *
 * THE HIERARCHY (Ligne Roset's own terms):
 *   element            an atomic catalog SKU (frame, seat / back / scatter
 *                      cushion, base, bolster) → one LineComponent.
 *   component product  a "complete element": a product MADE OF elements → a
 *                      group of components sharing one `moduleGroup`.
 *   modular product    made of several component products → a compound line
 *                      (`compoundKind: 'modular'`) whose components are grouped
 *                      into named modules.
 *
 * It is ONE uniform structure: a component product is a modular with a single
 * module; a modular is a component product whose elements are grouped into
 * sub-modules. Pricing is the same either way (Σ of priced elements), so the
 * total never diverges — only the grouping depth differs.
 *
 * WHY NO CATALOG LOOKUP / NO CONSTANTS: the price list carries NO composition
 * relationship (no parent-SKU / parts / BOM column — verified against the LR CSV
 * and the `products` table), so which elements compose a module CANNOT be
 * derived and must NOT be hardcoded (a per-model constant breaks the moment the
 * catalog changes). Composition is therefore authored by the dealer at assembly
 * time and stored as `moduleGroup` / `moduleName` on the JSONB component shape —
 * grade-, model- and catalog-agnostic, working for every model with no schema
 * change. This module is pure (no React / db / catalog): grouping is purely
 * structural over the components array.
 */

import { isPricedComponent } from './constants.js';
import { applyLineAdjustments, safeNum } from './pricing.js';
import type { LineComponent, QuoteLine } from '../types/domain.ts';

/** Generates a fresh id for a new module group — the app passes `newId`. */
export type IdFactory = () => string;

/**
 * One module of a modular product — a component product ("complete element").
 * `moduleGroup` is null for an ungrouped component standing on its own; `name`
 * is the module's display label; `components` are its elements in order.
 */
export interface Module {
  moduleGroup: string | null;
  name: string;
  components: LineComponent[];
}

/** True when a compound line should render grouped-by-module: it's explicitly
 *  `'modular'`, or any component already carries a `moduleGroup`. (Absent
 *  `compoundKind` + no grouping ⇒ a plain component product, unchanged.) */
export function isModularLine(
  line: Pick<QuoteLine, 'compoundKind' | 'components'> | null | undefined,
): boolean {
  if (!line) return false;
  if (line.compoundKind === 'modular') return true;
  return (line.components || []).some((c) => !!c?.moduleGroup);
}

/**
 * Partition a components array into ordered modules. Components that share a
 * `moduleGroup` form one module (a component product); an ungrouped component is
 * its own single-element module (`moduleGroup: null`). Module order follows the
 * first appearance of each group, so a reorder inside the list is tolerated. A
 * module's name is the first member's `moduleName`, falling back to its `name`.
 */
export function modulesOf(
  components: readonly LineComponent[] | null | undefined,
): Module[] {
  const list = (components || []).filter(Boolean) as LineComponent[];
  const out: Module[] = [];
  const byGroup = new Map<string, Module>();
  for (const c of list) {
    const g = c.moduleGroup || null;
    if (!g) {
      out.push({ moduleGroup: null, name: c.name || '', components: [c] });
      continue;
    }
    let mod = byGroup.get(g);
    if (!mod) {
      mod = { moduleGroup: g, name: c.moduleName || c.name || '', components: [] };
      byGroup.set(g, mod);
      out.push(mod);
    }
    mod.components.push(c);
  }
  return out;
}

/** Σ of a module's PRICED elements — the component twin of compoundSubtotal,
 *  one module deep. Reuses isPricedComponent so an excluded optional or a
 *  non-selected alternative inside the module drops out exactly as it does in
 *  the compound total (Σ over all modules === compoundSubtotal by construction). */
export function moduleSubtotal(
  components: readonly LineComponent[] | null | undefined,
): number {
  return (components || [])
    .filter((c) => isPricedComponent(c))
    .reduce((sum, c) => sum + safeNum(c?.unitPrice) * safeNum(c?.qty), 0);
}

/**
 * Group the given component ids into ONE named module — stamp a fresh
 * `moduleGroup` (+ `moduleName`) on each. Purely structural: no reorder, no
 * catalog lookup. Returns a NEW array, or null when fewer than one target id
 * resolves (nothing to group). The `name` defaults to the first grouped
 * component's name when blank.
 */
export function groupComponents(
  components: readonly LineComponent[] | null | undefined,
  ids: readonly string[] | null | undefined,
  name: string | null | undefined,
  newId: IdFactory,
): LineComponent[] | null {
  const list = (components || []).filter(Boolean) as LineComponent[];
  const idSet = new Set((ids || []).filter(Boolean));
  if (idSet.size === 0) return null;
  const targets = list.filter((c) => idSet.has(c.id));
  if (targets.length === 0) return null;
  const moduleGroup = newId();
  const moduleName = (name && name.trim()) || targets[0].name || '';
  return list.map((c) =>
    idSet.has(c.id) ? { ...c, moduleGroup, moduleName } : c,
  );
}

/** Ungroup a module — clear `moduleGroup` / `moduleName` on its members so each
 *  becomes a standalone element again. Returns a NEW array. */
export function ungroupModule(
  components: readonly LineComponent[] | null | undefined,
  moduleGroup: string | null | undefined,
): LineComponent[] {
  const list = (components || []).filter(Boolean) as LineComponent[];
  if (!moduleGroup) return list;
  return list.map((c) =>
    c.moduleGroup === moduleGroup
      ? { ...c, moduleGroup: null, moduleName: null }
      : c,
  );
}

/** Rename a module — set `moduleName` on every member of the group. */
export function renameModule(
  components: readonly LineComponent[] | null | undefined,
  moduleGroup: string | null | undefined,
  name: string | null | undefined,
): LineComponent[] {
  const list = (components || []).filter(Boolean) as LineComponent[];
  if (!moduleGroup) return list;
  const moduleName = (name || '').trim();
  return list.map((c) =>
    c.moduleGroup === moduleGroup ? { ...c, moduleName } : c,
  );
}

/**
 * Mark a whole module as an optional add-on (or clear it) — stamp
 * `moduleOptional` on every element of the group so the module drops out of (or
 * back into) the total via isPricedComponent, the module twin of a line's
 * isOptional. Returns a NEW array; a falsy group is a no-op.
 */
export function setModuleOptional(
  components: readonly LineComponent[] | null | undefined,
  moduleGroup: string | null | undefined,
  optional: boolean,
): LineComponent[] {
  const list = (components || []).filter(Boolean) as LineComponent[];
  if (!moduleGroup) return list;
  return list.map((c) =>
    c.moduleGroup === moduleGroup ? { ...c, moduleOptional: !!optional } : c,
  );
}

/**
 * Make a module a pick-one ALTERNATIVE — put it in a `moduleAlternativeGroup`
 * (selecting it if new) and append a COPY of it as a second, non-selected
 * sibling module the dealer then edits. The module twin of a line's "add
 * alternative". Returns a NEW array, or null when the group is empty.
 */
export function addModuleAlternative(
  components: readonly LineComponent[] | null | undefined,
  moduleGroup: string | null | undefined,
  newId: IdFactory,
): LineComponent[] | null {
  const list = (components || []).filter(Boolean) as LineComponent[];
  if (!moduleGroup) return null;
  const members = list.filter((c) => c.moduleGroup === moduleGroup);
  if (members.length === 0) return null;
  const altGroup = members[0].moduleAlternativeGroup || newId();
  const dupGroup = newId();
  const dups = members.map((c) => ({
    ...c,
    id: newId(),
    moduleGroup: dupGroup,
    moduleAlternativeGroup: altGroup,
    moduleSelected: false,
  }));
  // Index of the source module's LAST element, so the copy lands right after it.
  let lastIdx = -1;
  list.forEach((c, i) => { if (c.moduleGroup === moduleGroup) lastIdx = i; });
  const out: LineComponent[] = [];
  list.forEach((c, i) => {
    out.push(
      c.moduleGroup === moduleGroup
        ? {
            ...c,
            moduleAlternativeGroup: altGroup,
            // First time grouping → this module becomes the selected option.
            moduleSelected: c.moduleAlternativeGroup ? !!c.moduleSelected : true,
          }
        : c,
    );
    if (i === lastIdx) out.push(...dups);
  });
  return out;
}

/**
 * Keep component alternative groups well-formed after members leave: a group
 * that drops to a SINGLE member dissolves back to a normal component, and a
 * group that lost its selected member promotes its first survivor — so a
 * removal/extraction can never leave an orphan silently excluded from the
 * total. Shared by the editor's component delete and the line⇄component moves.
 */
export function healComponentAlternatives(
  components: readonly LineComponent[] | null | undefined,
): LineComponent[] {
  const list = (components || []).filter(Boolean) as LineComponent[];
  const counts = new Map<string, number>();
  const hasSelected = new Map<string, boolean>();
  for (const c of list) {
    if (!c.alternativeGroup) continue;
    counts.set(c.alternativeGroup, (counts.get(c.alternativeGroup) || 0) + 1);
    if (c.isSelectedAlternative) hasSelected.set(c.alternativeGroup, true);
  }
  const promoted = new Set<string>();
  return list.map((c) => {
    const g = c.alternativeGroup;
    if (!g) return c;
    if (counts.get(g) === 1) {
      // Lone survivor → no longer an alternative.
      const { alternativeGroup, isSelectedAlternative, ...rest } = c;
      void alternativeGroup; void isSelectedAlternative;
      return rest as LineComponent;
    }
    if (!hasSelected.get(g) && !promoted.has(g)) {
      promoted.add(g);
      return { ...c, isSelectedAlternative: true };
    }
    return c;
  });
}

/* ──────────────────────────────────────────────────────────────────────────
   LINE ⇄ COMPONENT MOVES — the dealer restructures a quote without retyping:
   a top-level product line moves INSIDE a compound/modular (absorb), and a
   component / module moves back OUT to a top-level line (extract). Both are
   pure transforms over the same uniform structure documented above; the
   controller owns persistence.

   LOGIC GATES (every flag/field accounted for):
   • Source line in a Conjunto/Alternativa → the MOVE IS REFUSED upstream (UI
     hides it; controller guards) — yanking a member would corrupt the group.
   • A compound source can only be absorbed by a MODULAR target (its pieces
     become a module / its modules carry over); nesting a compound inside a
     plain component-product is not representable.
   • Line-level margin/discount have no component twin → they are FOLDED into
     each absorbed unit price (and price range) so the quote total is
     IDENTICAL before and after the move.
   • line.isOptional → moduleOptional (modular target: the whole product stays
     an opt-in add-on) or component isOptional (plain target). Extraction maps
     the same flags back up (module/component optional → line isOptional).
   • Module pick-one (moduleAlternativeGroup) can't leave its siblings → a
     module in an alternative group refuses extraction (un-alternative first);
     component-level alternative groups HEAL on both sides instead.
   • All ids (component / module / alternative groups) are re-minted on the
     way in so two absorbs of duplicated lines can never collide.
   • Dropped with eyes open: internal `notes`, the product photo(s) (a
     compound shows ONE cover photo) and `unitCost` (components carry none) —
     none of these affect the client-facing quote or the total.
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Convert a top-level line into the component rows a compound/modular target
 * absorbs. Returns null when the move is not representable (section row, or a
 * compound source into a non-modular target).
 */
export function absorbLineAsComponents(
  line: QuoteLine | null | undefined,
  intoModular: boolean,
  newId: IdFactory,
): LineComponent[] | null {
  if (!line || line.kind === 'section') return null;
  const comps = (line.components || []).filter(Boolean) as LineComponent[];
  const isCompoundSource = comps.length > 0;
  if (isCompoundSource && !intoModular) return null;

  // Fold the line-level margin/discount into unit prices so the total is
  // preserved exactly (components have no per-line adjustment fields).
  const fold = (v: number | null | undefined): number =>
    applyLineAdjustments(safeNum(v), line.lineMarginPct, line.lineDiscountPct);
  const foldRange = (v: number | null | undefined): number | null =>
    v == null ? null : fold(v);

  if (!isCompoundSource) {
    const component: LineComponent = {
      id: newId(),
      name: line.name || '',
      reference: line.reference || '',
      subtype: line.subtype || '',
      dimensions: line.dimensions || '',
      description: line.description || '',
      // Carry the catalog "Description 2" into the component's own read-only
      // identity field — separate from the editable description, exactly as it
      // lives on the line — so the move never pollutes the dealer's field.
      productDescription: line.productDescription || '',
      qty: safeNum(line.qty, 1),
      unitPrice: fold(line.unitPrice),
      priceMin: foldRange(line.priceMin),
      priceMax: foldRange(line.priceMax),
      swatchImageId: line.swatchImageId ?? null,
      materialOptions: line.materialOptions ?? null,
    };
    if (intoModular) {
      // A single product enters as its own single-element module; a line-level
      // optional becomes a module-level optional (same client semantics).
      return [{
        ...component,
        moduleGroup: newId(),
        moduleName: line.name || '',
        moduleOptional: !!line.isOptional,
      }];
    }
    return [{
      ...component,
      isOptional: !!line.isOptional,
      optionalOffered: !!line.optionalOffered,
    }];
  }

  // Compound source into a modular target: existing modules carry over 1:1
  // (fresh group ids), ungrouped elements wrap into ONE module named after the
  // line — so a plain component-product enters as exactly one module.
  const groupMap = new Map<string, string>();
  const altMap = new Map<string, string>();
  const wrapGroup = newId();
  const remap = (m: Map<string, string>, key: string): string => {
    let v = m.get(key);
    if (!v) { v = newId(); m.set(key, v); }
    return v;
  };
  const absorbed = comps.map((c) => {
    const next: LineComponent = {
      ...c,
      id: newId(),
      unitPrice: fold(c.unitPrice),
      priceMin: foldRange(c.priceMin),
      priceMax: foldRange(c.priceMax),
      alternativeGroup: c.alternativeGroup ? remap(altMap, `c-${c.alternativeGroup}`) : c.alternativeGroup,
      moduleGroup: c.moduleGroup ? remap(groupMap, c.moduleGroup) : wrapGroup,
      moduleName: c.moduleGroup ? c.moduleName : (line.name || ''),
      moduleAlternativeGroup: c.moduleAlternativeGroup
        ? remap(altMap, `m-${c.moduleAlternativeGroup}`)
        : c.moduleAlternativeGroup,
    };
    // A whole-line optional makes every absorbed module an opt-in add-on —
    // the closest faithful mapping of "this entire product is optional".
    if (line.isOptional) next.moduleOptional = true;
    return next;
  });
  // Heal component-level alternative groups exactly as the extract path does, so
  // an absorbed pick-one group never lands without a selected member (a source
  // group left with 0 selected, or dissolved to a lone survivor, would silently
  // drop from / corrupt the compound total otherwise).
  return healComponentAlternatives(absorbed);
}

/** Seed for a line extracted out of a compound (consumed by the controller's
 *  addLine-style insert) plus the healed remaining components. */
export interface ExtractedLine {
  seed: {
    family: string;
    name: string;
    reference?: string;
    subtype?: string;
    dimensions?: string;
    description?: string;
    productDescription?: string;
    qty?: number;
    unitPrice?: number;
    priceMin?: number | null;
    priceMax?: number | null;
    swatchImageId?: string | null;
    materialOptions?: QuoteLine['materialOptions'];
    isOptional?: boolean;
    optionalOffered?: boolean;
    components?: LineComponent[];
  };
  remaining: LineComponent[];
}

/**
 * Extract the given components OUT of a compound line as a new top-level line:
 * one component → a simple product line; several (a module) → a compound line
 * of its elements. Returns null when nothing resolves or when any member sits
 * in a module pick-one (extracting one option would strand its siblings — the
 * dealer un-alternatives first). Component-level alternative groups heal on
 * both sides instead of blocking.
 */
export function extractComponentsAsLine(
  line: QuoteLine | null | undefined,
  componentIds: readonly string[] | null | undefined,
  newId: IdFactory,
): ExtractedLine | null {
  if (!line) return null;
  const list = ((line.components || []).filter(Boolean)) as LineComponent[];
  const idSet = new Set((componentIds || []).filter(Boolean));
  const members = list.filter((c) => idSet.has(c.id));
  if (members.length === 0) return null;
  if (members.some((c) => c.moduleAlternativeGroup)) return null;

  const remaining = healComponentAlternatives(list.filter((c) => !idSet.has(c.id)));

  if (members.length === 1) {
    const c = members[0];
    return {
      seed: {
        family: line.family || '',
        name: c.name || '',
        reference: c.reference || '',
        subtype: c.subtype || '',
        dimensions: c.dimensions || '',
        description: c.description || '',
        productDescription: c.productDescription || '',
        qty: safeNum(c.qty, 1),
        unitPrice: safeNum(c.unitPrice),
        priceMin: c.priceMin ?? null,
        priceMax: c.priceMax ?? null,
        swatchImageId: c.swatchImageId ?? null,
        materialOptions: c.materialOptions ?? null,
        // Whichever level marked it an add-on, the extracted line stays one.
        isOptional: !!(c.isOptional || c.moduleOptional),
        optionalOffered: !!c.optionalOffered,
      },
      remaining,
    };
  }

  // A module (or hand-picked group) leaves as a compound line of its elements:
  // module chrome is stripped (fresh single-product context), component-level
  // alternative groups heal within the extracted set too.
  const moduleName = members.find((c) => c.moduleName)?.moduleName || '';
  const moduleOptional = members.some((c) => c.moduleOptional);
  const components = healComponentAlternatives(members).map((c) => {
    const { moduleGroup, moduleName: mn, moduleOptional: mo, moduleAlternativeGroup, moduleSelected, ...rest } = c;
    void moduleGroup; void mn; void mo; void moduleAlternativeGroup; void moduleSelected;
    return { ...rest, id: newId() } as LineComponent;
  });
  return {
    seed: {
      family: line.family || '',
      name: moduleName || line.name || '',
      isOptional: moduleOptional,
      components,
    },
    remaining,
  };
}

/**
 * Select a module within its alternative group — set `moduleSelected` on its
 * elements, clear it on the sibling modules. Returns a NEW array.
 */
export function selectModuleAlternative(
  components: readonly LineComponent[] | null | undefined,
  moduleGroup: string | null | undefined,
): LineComponent[] {
  const list = (components || []).filter(Boolean) as LineComponent[];
  const target = list.find((c) => c.moduleGroup === moduleGroup);
  const altGroup = target?.moduleAlternativeGroup;
  if (!altGroup) return list;
  return list.map((c) =>
    c.moduleAlternativeGroup === altGroup
      ? { ...c, moduleSelected: c.moduleGroup === moduleGroup }
      : c,
  );
}
