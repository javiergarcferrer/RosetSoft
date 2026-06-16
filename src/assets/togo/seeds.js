// The five seeded Togo pieces as importable catalog rows — the one-tap
// "quick start" the admin uploader offers so a fresh install isn't empty. The
// dealer can then upload their own DWGs alongside (or instead of) these. Pulls
// the inline SVG markup via ?raw so it can be written straight into togo_models.
import { TOGO_PIECES } from './pieces.js';
import svgChauf from './togo_chauf.svg?raw';
import svgA from './togo_a.svg?raw';
import svgGb from './togo_gb.svg?raw';
import svgMc from './togo_mc.svg?raw';
import svgLounge from './togo_lounge.svg?raw';

const SVG_BY_ID = { chauf: svgChauf, a: svgA, gb: svgGb, mc: svgMc, lounge: svgLounge };

export const TOGO_SEEDS = TOGO_PIECES.map((p) => ({
  name: p.label,
  model: p.model,
  widthCm: p.widthCm,
  depthCm: p.depthCm,
  svg: SVG_BY_ID[p.id],
  match: p.match,
}));
