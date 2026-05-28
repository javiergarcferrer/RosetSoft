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
