// Helpers for normalising text extracted from the PDF.

const FRACTION_MAP = {
  '¼': 0.25, '½': 0.5, '¾': 0.75,
  '⅓': 1 / 3, '⅔': 2 / 3,
  '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
  '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
  '⅙': 1 / 6, '⅚': 5 / 6,
};

export function parseDimension(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s) return null;
  const cleaned = s.replace(/["''′]/g, '').replace(/in\b/i, '').trim();
  if (/^\d+$/.test(cleaned)) return Number(cleaned);
  const mixed = cleaned.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const justFrac = cleaned.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (justFrac) return Number(justFrac[1]) / Number(justFrac[2]);
  const uniFrac = cleaned.match(/^(\d*)\s*([¼½¾⅓⅔⅛⅜⅝⅞⅕⅖⅗⅘⅙⅚])$/);
  if (uniFrac) {
    const whole = uniFrac[1] === '' ? 0 : Number(uniFrac[1]);
    return whole + FRACTION_MAP[uniFrac[2]];
  }
  if (/^\d+\.\d+$/.test(cleaned)) return Number(cleaned);
  return null;
}

export function parseYardage(str) {
  if (str == null) return null;
  const m = String(str).match(/(\d+(?:\.\d+)?)\s*yd/i);
  return m ? Number(m[1]) : null;
}

export function parsePrice(str) {
  if (str == null) return null;
  const cleaned = String(str).replace(/[\s,'']/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function slugify(str) {
  return String(str)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function clusterByKey(items, getKey, tol) {
  const sorted = [...items].sort((a, b) => getKey(a) - getKey(b));
  const out = [];
  let cur = null;
  for (const it of sorted) {
    const k = getKey(it);
    if (!cur || k - cur.last > tol) {
      cur = { key: k, last: k, members: [it] };
      out.push(cur);
    } else {
      cur.members.push(it);
      cur.last = k;
      cur.key = cur.members.reduce((s, m) => s + getKey(m), 0) / cur.members.length;
    }
  }
  return out;
}

export function normalizeText(str) {
  return String(str)
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Compose a single human-readable dimension string from the per-axis
 * numeric values produced by extractProducts. Inverse of the catalog's
 * "H 33 / W 30¼ / D 32¼ / S 15¾" notation.
 */
export function formatDimensions(d) {
  const parts = [];
  const push = (label, value) => {
    if (value == null) return;
    parts.push(`${label} ${formatInches(value)}`);
  };
  push('H', d.height_in);
  push('W', d.width_in);
  push('D', d.depth_in);
  push('S', d.seat_height_in);
  push('T', d.thickness_in);
  push('L', d.length_in);
  return parts.join(' · ');
}

function formatInches(n) {
  if (n == null) return '';
  // Render simple decimals as their nearest 1/4 fraction for readability,
  // falling back to the decimal form for finer values.
  const whole = Math.floor(n);
  const frac = n - whole;
  const map = { 0.25: '¼', 0.5: '½', 0.75: '¾' };
  for (const key of Object.keys(map)) {
    const k = Number(key);
    if (Math.abs(frac - k) < 0.02) return whole === 0 ? map[key] : `${whole}${map[key]}`;
  }
  if (Math.abs(frac) < 0.02) return String(whole);
  return n.toFixed(2).replace(/0$/, '').replace(/\.$/, '');
}
