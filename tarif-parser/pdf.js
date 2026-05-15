// PDF.js wrapper. Reads positioned text for a page; optionally renders the
// page bitmap so callers can crop a hero image.
//
//   item = { str, x, y, w, h, fontSize, rotation, hasEOL }
//
//  - origin is top-left, y grows downward
//  - rotation is one of 0, 90, -90, 180

import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let _pdfjs = null;

async function loadPdfjs() {
  if (_pdfjs) return _pdfjs;
  const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Worker setup: resolve the worker file via the package's own location so
  // we don't care whether node_modules is local or hoisted.
  try {
    const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
    mod.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
  } catch {
    // Resolution failure here is non-fatal; pdfjs falls back to an internal
    // worker on Node.
  }
  _pdfjs = mod;
  return mod;
}

export async function openPdf(pdfPath) {
  const pdfjs = await loadPdfjs();
  const { resolve } = await import('node:path');
  const buf = await readFile(resolve(pdfPath));
  const data = new Uint8Array(buf);
  const doc = await pdfjs.getDocument({
    data,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;
  return doc;
}

export async function readPage(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1.0 });
  const tc = await page.getTextContent({ includeMarkedContent: false });
  const items = [];
  for (const it of tc.items) {
    if (!it.str || it.str === ' ') continue;
    const [a, b, , , e, f] = it.transform;
    const x = e;
    const y = viewport.height - f;
    const fontSize = Math.hypot(a, b) || it.height || 10;
    let rotation = 0;
    if (Math.abs(a) < 0.5 && Math.abs(b) > 0.5) rotation = b > 0 ? 90 : -90;
    else if (a < -0.5) rotation = 180;
    items.push({
      str: it.str,
      x,
      y,
      w: it.width || 0,
      h: it.height || fontSize,
      fontSize,
      rotation,
      hasEOL: !!it.hasEOL,
    });
  }
  return { pageNumber, items, width: viewport.width, height: viewport.height, _page: page };
}

// Group upright text items into visual rows (y-proximity), then sort by x.
// Used by every extractor as the primary structural primitive.
export function groupRows(items, yTolerance = 2) {
  const upright = items.filter((it) => it.rotation === 0);
  const sorted = [...upright].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const it of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - it.y) <= yTolerance) {
      last.items.push(it);
      last.y = (last.y * last.n + it.y) / (last.n + 1);
      last.n += 1;
    } else {
      rows.push({ y: it.y, items: [it], n: 1 });
    }
  }
  rows.forEach((r) => r.items.sort((a, b) => a.x - b.x));
  return rows;
}

// Lazy-load a canvas implementation. Tries @napi-rs/canvas first (prebuilt
// binaries for win/mac/linux), falls back to the legacy `canvas` package
// (which needs node-gyp + Cairo).
let _canvasMod = null;
let _canvasErr = null;
async function loadCanvas() {
  if (_canvasMod) return _canvasMod;
  if (_canvasErr) throw _canvasErr;
  const tries = ['@napi-rs/canvas', 'canvas'];
  let lastErr = null;
  for (const name of tries) {
    try {
      const mod = await import(name);
      _canvasMod = mod;
      return mod;
    } catch (err) {
      lastErr = err;
    }
  }
  _canvasErr = new Error(
    'no canvas module available — install @napi-rs/canvas (preferred) or canvas, or run with --no-images. Underlying: ' + (lastErr?.message || 'unknown')
  );
  throw _canvasErr;
}

let _sharpMod = null;
let _sharpErr = null;
async function loadSharp() {
  if (_sharpMod) return _sharpMod;
  if (_sharpErr) throw _sharpErr;
  try {
    _sharpMod = (await import('sharp')).default;
    return _sharpMod;
  } catch (err) {
    _sharpErr = new Error('sharp module not available. Underlying: ' + err.message);
    throw _sharpErr;
  }
}

// Render a PDF page to a PNG buffer at the given scale.
export async function renderPagePng(page, scale = 1.5) {
  const { createCanvas } = await loadCanvas();
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext('2d');
  // pdfjs requires a NodeCanvasFactory in Node; the legacy build accepts the
  // canvas API directly when we set canvasFactory below.
  const canvasFactory = makeNodeCanvasFactory();
  const renderTask = page.render({
    canvasContext: ctx,
    viewport,
    canvasFactory,
    intent: 'print',
  });
  await renderTask.promise;
  return canvas.toBuffer('image/png');
}

// Extract every embedded raster image on a page WITHOUT rendering. Reads
// each paintImageXObject from the operator list, fetches the decoded pixel
// buffer from pdfjs's page.objs, and returns the largest images first
// (most likely the hero product photo). This avoids any dependency on a
// JS canvas implementation.
export async function extractPageImages(page) {
  const pdfjs = await loadPdfjs();
  const ops = await page.getOperatorList();
  const out = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn !== pdfjs.OPS.paintImageXObject && fn !== pdfjs.OPS.paintJpegXObject) continue;
    const objId = ops.argsArray[i][0];
    let obj;
    try {
      obj = page.objs.has(objId)
        ? page.objs.get(objId)
        : (page.commonObjs.has(objId) ? page.commonObjs.get(objId) : null);
    } catch {
      obj = null;
    }
    if (!obj || !obj.data || !obj.width || !obj.height) continue;
    out.push({
      objId,
      width: obj.width,
      height: obj.height,
      data: obj.data,
      kind: obj.kind, // 1=gray, 2=rgb, 3=rgba
    });
  }
  // Largest first — usually the hero photo.
  out.sort((a, b) => b.width * b.height - a.width * a.height);
  return out;
}

// Encode a raw RGB/RGBA pixel buffer to a JPEG. Pure sharp call — needs no
// canvas implementation.
export async function rawToJpeg(rawImage, { maxW = 800, maxH = 800, quality = 82 } = {}) {
  const sharp = await loadSharp();
  const channels = rawImage.kind === 3 ? 4 : rawImage.kind === 2 ? 3 : 1;
  return sharp(Buffer.from(rawImage.data), {
    raw: { width: rawImage.width, height: rawImage.height, channels },
  })
    .resize({ width: maxW, height: maxH, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
}

// Resize a PNG buffer to fit inside maxW × maxH and re-encode as JPEG.
export async function encodeJpeg(pngBuf, { maxW = 800, maxH = 800, quality = 82 } = {}) {
  const sharp = await loadSharp();
  return sharp(pngBuf)
    .resize({ width: maxW, height: maxH, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
}

function makeNodeCanvasFactory() {
  return {
    create(width, height) {
      if (width <= 0 || height <= 0) throw new Error('canvas size must be > 0');
      // Lazy: the create-call is sync but loadCanvas is async; we rely on
      // renderPagePng having already awaited loadCanvas before calling render.
      const { createCanvas } = _canvasMod;
      const canvas = createCanvas(width, height);
      return { canvas, context: canvas.getContext('2d') };
    },
    reset(canvasAndContext, width, height) {
      const c = canvasAndContext.canvas;
      c.width = width;
      c.height = height;
    },
    destroy(canvasAndContext) {
      canvasAndContext.canvas.width = 0;
      canvasAndContext.canvas.height = 0;
      canvasAndContext.canvas = null;
      canvasAndContext.context = null;
    },
  };
}

// Compute a bbox (in viewport coords) covering the "image" area of a page:
// everything that is not text. Used to crop hero images out of rendered pages.
export function imageBoundingBox(pageInfo) {
  // The hero image area on a product page is the largest contiguous region
  // ABOVE the description line and to the right of the banner. We approximate
  // this with the inverse of the text bounding box.
  const { items, width, height } = pageInfo;
  if (!items.length) return null;
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (const it of items) {
    minX = Math.min(minX, it.x);
    minY = Math.min(minY, it.y);
    maxX = Math.max(maxX, it.x + (it.w || it.fontSize * (it.str.length * 0.5)));
    maxY = Math.max(maxY, it.y + it.fontSize);
  }
  // Heuristic: hero image is the area above the variant table, below the
  // top-page metadata band. Use the strip y ∈ [55, 400] cropped by text.
  const topY = 55;
  const bottomY = Math.min(400, height - 50);
  if (topY >= bottomY) return null;
  return { x: 60, y: topY, w: width - 80, h: bottomY - topY };
}
