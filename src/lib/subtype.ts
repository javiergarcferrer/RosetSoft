/**
 * Subtype is one free-text column on the line row, but in practice dealers
 * write two distinct concepts into it: a fabric/leather *grade* (the price
 * tier — A, B, C… or COM) and a *finish* name (the actual fabric, leather,
 * or wood variant — PAMPA, Velvet Smoke, Walnut, etc.).
 *
 * The UI splits the field into two editors (a Grade dropdown + a Fabric
 * input). This module is the bridge: parse a stored subtype into the two
 * concepts on read, and compose them back into the canonical string on
 * write — without ever requiring a DB migration.
 *
 * Canonical compose format mirrors the price list:
 *
 *   "Grade C — PAMPA"     (alpha grade A..X excluding T/Y/Z)
 *   "Grade U — Tea"       (leather grade is just another letter)
 *   "COM — buyer supplied"
 *   "Grade C"             (grade alone)
 *   "PAMPA"               (fabric alone, no grade)
 *
 * Parse is tolerant: anything we don't recognize as a grade is treated as
 * pure fabric, so legacy strings the dealer hand-typed (e.g. "Walnut",
 * "Cuir — Tea") round-trip intact.
 */

/** Parsed projection of a subtype field — both keys always present. */
export interface ParsedSubtype {
  grade: string;
  fabric: string;
}

/** One row in `GRADE_GROUPS` — a labelled `<optgroup>` worth of grades. */
export interface GradeGroup {
  label: string;
  grades: readonly string[];
}

/**
 * The full Ligne Roset grade taxonomy, grouped as the price list lays it
 * out. The picker renders these groups as <optgroup>s so the dealer sees
 * the same structure they read on paper. T, Y, and Z are intentionally
 * absent — the price list skips them.
 *
 *   Telas       A..R   (18 fabric grades)
 *   Microfibras S      (1)
 *   Pieles      U..X   (4 leather grades)
 *
 * Plus one special non-letter grade we accept: COM (customer's own
 * material).
 */
export const GRADE_GROUPS: readonly GradeGroup[] = [
  { label: 'Telas',       grades: ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R'] },
  { label: 'Microfibras', grades: ['S'] },
  { label: 'Pieles',      grades: ['U','V','W','X'] },
];

/** Special non-letter grades that still get a "Grade —"-less render. */
export const SPECIAL_GRADES: readonly string[] = ['COM'];

/**
 * Legacy values that may exist in older quotes but are no longer offered
 * in the picker. Listed here so the parser still recognises them on read
 * (round-trip safe) and the picker can render them as a hidden option
 * whenever the current value matches — otherwise a native <select> would
 * silently revert to its first option and lose the dealer's data.
 */
export const LEGACY_NAMED_GRADES: readonly string[] = ['Cuir', 'Leather'];

/** Every valid alpha grade across all groups — used by parser + composer. */
export const ALPHA_GRADES: readonly string[] = GRADE_GROUPS.flatMap((g) => g.grades);

/** Every recognized grade value (alpha + special + legacy). */
const RECOGNIZED_NAMED: ReadonlySet<string> = new Set([...SPECIAL_GRADES, ...LEGACY_NAMED_GRADES]);

/**
 * Parse a stored subtype into { grade, fabric }. Always returns both keys
 * (empty strings, never undefined) so consumers can destructure safely.
 */
export function parseSubtype(subtype: string | null | undefined): ParsedSubtype {
  if (!subtype || typeof subtype !== 'string') return { grade: '', fabric: '' };
  const s = subtype.trim();
  if (!s) return { grade: '', fabric: '' };

  // "Grade <token> — Fabric" — token is anything non-whitespace so custom
  // codes round-trip. Dash can be em-dash, en-dash, or ASCII hyphen.
  const m1 = s.match(/^Grade\s+(\S+)(?:\s*[—–-]\s*(.+))?$/i);
  if (m1) {
    return { grade: m1[1].toUpperCase(), fabric: (m1[2] || '').trim() };
  }

  // Named grades: "COM — buyer-supplied", "Cuir — Tea", or the name alone.
  // Case-insensitive match; canonical capitalisation is preserved so the
  // dropdown still highlights it.
  for (const named of RECOGNIZED_NAMED) {
    const m2 = s.match(new RegExp(`^${named}(?:\\s*[—–-]\\s*(.+))?$`, 'i'));
    if (m2) {
      return { grade: named, fabric: (m2[1] || '').trim() };
    }
  }

  // Nothing matches — treat the whole string as fabric.
  return { grade: '', fabric: s };
}

/**
 * Compose grade + fabric back into a canonical subtype string. Inverse of
 * parseSubtype: composeSubtype(parseSubtype(s)) === canonicalise(s) for
 * any input we'd actually store.
 */
export function composeSubtype(
  grade: string | null | undefined,
  fabric: string | null | undefined,
): string {
  const g = (grade || '').trim();
  const f = (fabric || '').trim();
  if (!g && !f) return '';
  if (!g) return f;

  // Alpha grades get the "Grade " prefix in the rendered string; named
  // grades (COM, legacy Cuir/Leather, anything custom) are written as-is.
  const gradeStr = ALPHA_GRADES.includes(g.toUpperCase()) ? `Grade ${g.toUpperCase()}` : g;
  return f ? `${gradeStr} — ${f}` : gradeStr;
}

/**
 * A subtype as shown to a CLIENT — the stored string minus the embedded catalog
 * colour code. We persist "Grade C — TRAMA · ECRU (#3075)" so swatchMatch can
 * locate the colour again, but the "(#3075)" is a technical token that has no
 * business on a customer's quote. Strips every "(#…)" group:
 *   "Grade C — TRAMA · ECRU (#3075)" → "Grade C — TRAMA · ECRU"
 * Display-only — never write this back to the row (it would lose the code).
 */
export function fabricDisplay(subtype: string | null | undefined): string {
  return String(subtype ?? '').replace(/\s*\(#[^)]*\)/g, '').trim();
}

/** A catalog material the picker can compose a fabric label from. */
export interface MaterialLike {
  name?: string | null;
}

/** A catalog color (the picked variant) — carries the code we embed. */
export interface ColorLike {
  name?: string | null;
  code?: string | null;
}

/**
 * Compose the fabric portion of a quote line's subtype from a catalog
 * material + (optional) color:
 *
 *   material + color → "MATERIAL · COLOR (#code)"
 *   material only    → "MATERIAL"
 *
 * The result lands as the second segment of composeSubtype(grade, fabric),
 * so the on-screen + PDF render stays consistent with hand-typed values and
 * the embedded "(#code)" lets swatchMatch.locateColor find it again later.
 *
 * Shared by both material pickers (the quote-pane SwatchPicker and the
 * catalog flow) so the codes never drift between the two entry points.
 */
export function composeFabricLabel(
  material: MaterialLike | null | undefined,
  color: ColorLike | null | undefined,
): string {
  const name = (material?.name || '').trim();
  if (!color) return name;
  const colorName = (color.name || '').trim();
  const code = (color.code || '').trim();
  const colorBit = code ? `${colorName} (#${code})` : colorName;
  if (!colorBit) return name;
  return name ? `${name} · ${colorBit}` : colorBit;
}

/* ------------------------------------------------------------------------- *
 * Material identity — "do two pieces wear the same material?"
 *
 * A compound article (a sectional, a modular sofa) is one parent line holding
 * several components, and dealers/clients almost always dress every component
 * in the SAME fabric — so re-picking it per component is busywork. These two
 * pure helpers back the "pick once, apply to all" shortcut the editor and the
 * client preview both surface: `materialIdentity` is the key two pieces compare
 * equal on, and `canPropagateMaterial` is the SMART-visibility predicate. They
 * live in the Model so the editor and the preview can never disagree on what
 * "the same material" means.
 * ------------------------------------------------------------------------- */

/** The fields a line OR a component exposes for material identity. */
export interface MaterialBearing {
  id?: string;
  subtype?: string | null;
  swatchImageId?: string | null;
}

/**
 * Stable key for a piece's chosen material: its grade+fabric (the `subtype`)
 * plus the specific colour swatch. Two pieces wear the same material iff their
 * keys are equal. JSON-encoding the pair keeps it collision-free — a fabric
 * name can't be confused with the swatch id no matter what it contains.
 */
export function materialIdentity(entity: MaterialBearing | null | undefined): string {
  return JSON.stringify([(entity?.subtype || '').trim(), entity?.swatchImageId || '']);
}

/**
 * Whether to offer "apply this material to every sibling" for `entity` within
 * `siblings` (the full peer list, INCLUDING entity). True only when there is
 * redundancy worth removing: at least two pieces, `entity` carries an actual
 * material (a grade or a fabric — not a blank sub-piece), and at least one other
 * sibling differs from it. It flips back to false the moment everything already
 * matches, so the affordance disappears once it would be a no-op — the "smart"
 * part of the request.
 */
export function canPropagateMaterial(
  entity: MaterialBearing | null | undefined,
  siblings: ReadonlyArray<MaterialBearing> | null | undefined,
): boolean {
  if (!entity || !Array.isArray(siblings) || siblings.length < 2) return false;
  const { grade, fabric } = parseSubtype(entity.subtype);
  if (!grade && !fabric) return false; // nothing worth applying yet
  const key = materialIdentity(entity);
  return siblings.some((s) => s && s.id !== entity.id && materialIdentity(s) !== key);
}

/* ------------------------------------------------------------------------- *
 * Compound upholstery — "is this whole piece dressed in ONE fabric?"
 *
 * A sectional or modular sofa is one parent line holding several components,
 * and the NORM is that every component wears the same fabric. Rendered naively
 * that stamps the identical swatch on every row (and a stale parent swatch on
 * top) — visual noise that reads like a data dump, not a proposal. This pure
 * derivation lets every client-facing surface (the screen preview, the public
 * link, the PDF) answer once: do the pieces share a single upholstery? When
 * they do, the surfaces hoist it to ONE "Tapizado" swatch + label at the
 * compound header and render the pieces as a clean name + price list; when they
 * genuinely differ, the per-piece swatches stay (they're now informative). One
 * Model rule ⇒ screen and paper can't disagree on when to collapse.
 * ------------------------------------------------------------------------- */

/** A compound component as this derivation reads it (material + per-piece config). */
export interface CompoundComponentLike extends MaterialBearing {
  isOptional?: boolean | null;
  optionalOffered?: boolean | null;
  alternativeGroup?: string | null;
  materialOptions?: { options?: unknown[] | null } | null;
}

/** The shared upholstery of a compound — `uniform:false` when the pieces differ. */
export interface CompoundFabric {
  uniform: boolean;
  subtype: string;
  swatchImageId: string | null;
}

/**
 * Reduce a compound's components to their shared upholstery, or report that
 * they differ. Uniform iff every MATERIAL-BEARING piece (one carrying a grade
 * or fabric) shares the same `materialIdentity`. Returns `uniform:false` when:
 *   • any piece offers per-piece configuration — a pick-one alternative, a
 *     client-toggleable optional, or its own material-options grid — because
 *     those are meant to be read/configured individually, never collapsed; or
 *   • no piece carries a material at all (nothing to hoist).
 * Non-bearing pieces (a metal base, a glass top) don't break uniformity — they
 * simply have no fabric to compare — so a sofa whose upholstered parts all match
 * still collapses cleanly around them.
 */
export function compoundFabric(
  components: ReadonlyArray<CompoundComponentLike> | null | undefined,
): CompoundFabric {
  const NONE: CompoundFabric = { uniform: false, subtype: '', swatchImageId: null };
  if (!Array.isArray(components) || components.length === 0) return NONE;

  // Any per-piece configuration ⇒ the pieces stand on their own, never collapse.
  const hasPerPieceConfig = components.some((c) => !!c && (
    c.isOptional || c.optionalOffered || c.alternativeGroup ||
    (Array.isArray(c.materialOptions?.options) && (c.materialOptions!.options!.length > 0))
  ));
  if (hasPerPieceConfig) return NONE;

  // The pieces that actually carry a material (a grade or a fabric name).
  const bearing = components.filter((c) => {
    const { grade, fabric } = parseSubtype(c?.subtype);
    return !!(grade || fabric);
  });
  if (bearing.length === 0) return NONE;

  const key = materialIdentity(bearing[0]);
  if (!bearing.every((c) => materialIdentity(c) === key)) return NONE;
  return {
    uniform: true,
    subtype: (bearing[0]?.subtype || '').trim(),
    swatchImageId: bearing[0]?.swatchImageId ?? null,
  };
}
