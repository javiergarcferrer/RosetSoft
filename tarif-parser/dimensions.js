// Parse a Ligne Roset dimensions string into structured tokens.
// The PDF places labels (H/W/D/S/T/DIAM) and values on separate text items;
// productParser stitches them into "H 28 W 32 D 32 S 16" before calling us.

const LABELS = ['H', 'W', 'D', 'S', 'T', 'DIAM', 'DIAM.'];
const LABEL_RE = /^(?:H|W|D|S|T|DIAM\.?)$/i;
// Imperial fraction characters Roset uses (¼½¾ as Unicode glyphs).
const FRACTION_RE = /[¼½¾]/;

export function parseDimensions(str) {
  if (!str) return { raw: '', parts: {} };
  const raw = String(str).trim();
  if (!raw) return { raw: '', parts: {} };
  // Tokenise: split on whitespace and "·".
  const tokens = raw.split(/[\s·]+/).filter(Boolean);
  const parts = {};
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    if (!LABEL_RE.test(t)) continue;
    const v = tokens[i + 1];
    if (!v) continue;
    // Value must look numeric (with optional fraction/slash).
    if (/^[0-9./¾½¼-]+$/.test(v)) {
      const key = t.replace(/\.$/, '').toUpperCase();
      parts[key] = v;
      i++;
    }
  }
  return { raw, parts };
}

export function joinDimensions(parts) {
  const order = ['H', 'W', 'D', 'S', 'T', 'DIAM'];
  return order
    .filter((k) => parts[k] != null && parts[k] !== '')
    .map((k) => `${k} ${parts[k]}`)
    .join(' ');
}

// Heuristic: is the given token a dimension value (number or fraction)?
export function looksLikeDimensionValue(s) {
  if (!s) return false;
  const t = String(s).trim();
  if (!t) return false;
  return /^[0-9]+([./¾½¼\- ]?[0-9./¾½¼]+)?$/.test(t) || FRACTION_RE.test(t);
}
