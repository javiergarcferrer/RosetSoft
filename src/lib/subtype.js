/**
 * Subtype is one free-text column on the line row, but in practice dealers
 * write two distinct concepts into it: a fabric/leather *grade* (the price
 * tier — A, B, C… or Cuir / COM) and a *finish* name (the actual fabric,
 * leather, or wood variant — PAMPA, Velvet Smoke, Walnut, etc.).
 *
 * The UI splits the field into two editors (a Grade dropdown + a Fabric
 * input). This module is the bridge: parse a stored subtype into the two
 * concepts on read, and compose them back into the canonical string on
 * write — without ever requiring a DB migration.
 *
 * Canonical compose format mirrors the price list:
 *
 *   "Grade C — PAMPA"     (alpha grade A..H)
 *   "Cuir — Tea"          (named special grade)
 *   "Grade C"             (grade alone)
 *   "PAMPA"               (fabric alone, no grade)
 *
 * Parse is tolerant: anything we don't recognize as a grade is treated as
 * pure fabric, so legacy strings the dealer hand-typed (e.g. "Walnut",
 * "Lacquer black") round-trip intact.
 */

/** Letter grades the price list uses. Single letters A..H. */
const ALPHA_GRADES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/** Named non-letter grades. Stored verbatim; rendered without the "Grade " prefix. */
const NAMED_GRADES = ['Cuir', 'COM'];

/**
 * Built-in dropdown options. Custom grades typed via the raw subtype field
 * still round-trip; they just don't appear in the picker.
 */
export const GRADE_OPTIONS = [
  ...ALPHA_GRADES.map((g) => ({ value: g, label: `Grade ${g}` })),
  { value: 'Cuir', label: 'Cuir (leather)' },
  { value: 'COM', label: 'COM' },
];

/**
 * Parse a stored subtype into { grade, fabric }. Always returns both keys
 * (empty strings, never undefined) so consumers can destructure safely.
 */
export function parseSubtype(subtype) {
  if (!subtype || typeof subtype !== 'string') return { grade: '', fabric: '' };
  const s = subtype.trim();
  if (!s) return { grade: '', fabric: '' };

  // "Grade <token> — Fabric" — token is anything non-whitespace so custom
  // codes (Grade G2, Grade Pro) round-trip. The dash can be em-dash,
  // en-dash, or ASCII hyphen.
  const m1 = s.match(/^Grade\s+(\S+)(?:\s*[—–-]\s*(.+))?$/i);
  if (m1) {
    return { grade: m1[1].toUpperCase(), fabric: (m1[2] || '').trim() };
  }

  // Named grades: "Cuir — Tea", "COM — buyer-supplied", "Cuir" alone, etc.
  // Case-insensitive match on the grade name, then preserve the canonical
  // capitalization from NAMED_GRADES so the dropdown still highlights it.
  for (const named of NAMED_GRADES) {
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
export function composeSubtype(grade, fabric) {
  const g = (grade || '').trim();
  const f = (fabric || '').trim();
  if (!g && !f) return '';
  if (!g) return f;

  // Alpha grades get the "Grade " prefix in the rendered string; named
  // grades (Cuir, COM, custom) are written as-is — that's how the price
  // list reads them.
  const gradeStr = ALPHA_GRADES.includes(g.toUpperCase()) ? `Grade ${g.toUpperCase()}` : g;
  return f ? `${gradeStr} — ${f}` : gradeStr;
}
