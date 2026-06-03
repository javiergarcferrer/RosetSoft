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
import type { LineComponent, QuoteLine } from '../types/domain.ts';

/** Coerce to a finite number, else a fallback. Mirrors lib/pricing. */
function safeNum(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

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
