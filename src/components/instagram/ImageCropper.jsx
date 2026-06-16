// IG-accurate image cropper — frames a device photo to an Instagram ratio
// (square / portrait / landscape feed, or a 9:16 story) with pan + zoom, then
// exports the EXACT pixels at IG's spec (1080-wide baseline JPEG) so the
// composer preview is what publishes — Meta never silently re-crops it. A
// full-screen overlay (portal to <body>) that sits above the Publicar modal.
// All the cover/clamp/zoom math lives in the pure Model (lib/imageCrop); this
// View only decodes, paints the live frame, and draws the final canvas.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, X, ZoomIn, RefreshCw } from 'lucide-react';
import {
  ratiosForMode, defaultRatio, ratioById, cropWindow, baseCropSize, outputSize,
  clamp, MIN_ZOOM, MAX_ZOOM,
} from '../../lib/imageCrop.js';

const IMG_MAX_BYTES = 8 * 1024 * 1024; // IG feed image cap (mirror of socialUpload)

/** Decode a file to oriented full-res pixels on a master canvas (EXIF baked in,
 *  matching socialUpload's `from-image` path) plus a once-encoded preview URL
 *  the <img> can pan/zoom smoothly on the GPU. */
async function loadOriented(file) {
  let source; let w; let h;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    source = bmp; w = bmp.width; h = bmp.height;
  } catch {
    const url = URL.createObjectURL(file);
    try {
      source = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('decode'));
        el.src = url;
      });
      w = source.naturalWidth; h = source.naturalHeight;
    } finally { URL.revokeObjectURL(url); }
  }
  if (!w || !h) throw new Error('empty');
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no-ctx');
  ctx.drawImage(source, 0, 0, w, h);
  if (typeof source.close === 'function') source.close();
  const previewUrl = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b ? URL.createObjectURL(b) : ''), 'image/jpeg', 0.9));
  return { canvas, w, h, previewUrl };
}

const toJpeg = (canvas, q) => new Promise((resolve, reject) =>
  canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', q));

export default function ImageCropper({ file, mode = 'feed', lockedRatioId = null, onConfirm, onCancel }) {
  const ratios = useMemo(() => ratiosForMode(mode), [mode]);
  const [ratioId, setRatioId] = useState(() => lockedRatioId || defaultRatio(mode).id);
  const [zoom, setZoom] = useState(1);
  const [center, setCenter] = useState({ cx: 0, cy: 0 });
  const [img, setImg] = useState(null); // { canvas, w, h, previewUrl }
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [busy, setBusy] = useState(false);

  // ── decode (once per file) ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let url = '';
    setStatus('loading');
    (async () => {
      try {
        const loaded = await loadOriented(file);
        if (cancelled) { URL.revokeObjectURL(loaded.previewUrl); return; }
        url = loaded.previewUrl;
        setImg(loaded);
        setCenter({ cx: loaded.w / 2, cy: loaded.h / 2 });
        setZoom(1);
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [file]);

  // Locked ratio (carousel) follows the lock; otherwise reset to the mode default
  // whenever the mode changes so a story never opens on a feed ratio.
  useEffect(() => { setRatioId(lockedRatioId || defaultRatio(mode).id); }, [lockedRatioId, mode]);

  const ratio = ratioById(ratioId);

  // ── frame box — fit the target aspect into the measured stage ───────────
  const stageRef = useRef(null);
  const frameRef = useRef(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [status]);

  const frame = useMemo(() => {
    const pad = 0; // the stage already carries the padding
    const boxW = Math.max(0, stage.w - pad);
    const boxH = Math.max(0, stage.h - pad);
    if (!boxW || !boxH) return { w: 0, h: 0 };
    // Fit aspect (w/h) into the box.
    if (boxW / boxH > ratio.aspect) return { w: Math.round(boxH * ratio.aspect), h: Math.round(boxH) };
    return { w: Math.round(boxW), h: Math.round(boxW / ratio.aspect) };
  }, [stage.w, stage.h, ratio.aspect]);

  // Resolve the live crop window + the <img> transform that shows it.
  const view = useMemo(() => {
    if (!img || !frame.w) return null;
    const win = cropWindow(img.w, img.h, ratio.aspect, zoom, center.cx, center.cy);
    const s = frame.w / win.sw; // display scale (frame.h / win.sh is identical)
    return {
      win,
      s,
      imgW: img.w * s,
      imgH: img.h * s,
      left: -win.sx * s,
      top: -win.sy * s,
    };
  }, [img, frame.w, ratio.aspect, zoom, center.cx, center.cy]);

  // ── gestures: pan (1 finger / drag) + pinch-zoom (2 fingers) ────────────
  const pointers = useRef(new Map());
  const pinch = useRef(null); // { dist, zoom }

  // Zoom toward an anchor (client coords) keeping the source point under it
  // fixed; pass null to zoom around the frame center (slider / wheel).
  const applyZoom = useCallback((nextZoom, anchor) => {
    if (!img || !frame.w) return;
    const cur = cropWindow(img.w, img.h, ratio.aspect, zoom, center.cx, center.cy);
    const s0 = frame.w / cur.sw;
    const rect = frameRef.current?.getBoundingClientRect();
    const ax = anchor && rect ? anchor.x - rect.left : frame.w / 2;
    const ay = anchor && rect ? anchor.y - rect.top : frame.h / 2;
    const srcX = cur.sx + ax / s0;
    const srcY = cur.sy + ay / s0;
    const z1 = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    const base = baseCropSize(img.w, img.h, ratio.aspect);
    const sw1 = base.w / z1;
    const sh1 = base.h / z1;
    const s1 = frame.w / sw1;
    const clamped = cropWindow(img.w, img.h, ratio.aspect, z1, srcX - ax / s1 + sw1 / 2, srcY - ay / s1 + sh1 / 2);
    setZoom(z1);
    setCenter({ cx: clamped.cx, cy: clamped.cy });
  }, [img, frame.w, frame.h, ratio.aspect, zoom, center.cx, center.cy]);

  const onPointerDown = useCallback((e) => {
    if (!view) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom };
    }
  }, [view, zoom]);

  const onPointerMove = useCallback((e) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev || !view) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      applyZoom(pinch.current.zoom * (dist / pinch.current.dist), {
        x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
      });
      return;
    }
    // Single-pointer pan: screen delta → image px (inverse of display scale).
    const dx = (e.clientX - prev.x) / view.s;
    const dy = (e.clientY - prev.y) / view.s;
    setCenter((c) => {
      const w = cropWindow(img.w, img.h, ratio.aspect, zoom, c.cx - dx, c.cy - dy);
      return { cx: w.cx, cy: w.cy };
    });
  }, [view, img, ratio.aspect, zoom, applyZoom]);

  const endPointer = useCallback((e) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  }, []);

  const onWheel = useCallback((e) => {
    if (!view) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    applyZoom(zoom * factor, { x: e.clientX, y: e.clientY });
  }, [view, zoom, applyZoom]);

  // Switching ratio re-centers + resets zoom — predictable, like IG.
  const changeRatio = useCallback((id) => {
    setRatioId(id);
    setZoom(1);
    if (img) setCenter({ cx: img.w / 2, cy: img.h / 2 });
  }, [img]);

  // ── export the framed pixels at IG spec ─────────────────────────────────
  const confirm = useCallback(async () => {
    if (!img || busy) return;
    setBusy(true);
    try {
      const win = cropWindow(img.w, img.h, ratio.aspect, zoom, center.cx, center.cy);
      const out = outputSize(ratio.aspect, win.sw);
      const canvas = document.createElement('canvas');
      canvas.width = out.w; canvas.height = out.h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no-ctx');
      ctx.fillStyle = '#ffffff'; // JPEG has no alpha — flatten onto white
      ctx.fillRect(0, 0, out.w, out.h);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img.canvas, win.sx, win.sy, win.sw, win.sh, 0, 0, out.w, out.h);
      let quality = 0.92;
      let blob = await toJpeg(canvas, quality);
      while (blob.size > IMG_MAX_BYTES && quality > 0.5) {
        quality -= 0.1;
        blob = await toJpeg(canvas, quality);
      }
      const cropped = new File([blob], `ig-${ratio.id}.jpg`, { type: 'image/jpeg' });
      onConfirm?.(cropped, ratio.id);
    } catch {
      setBusy(false);
    }
  }, [img, busy, ratio, zoom, center.cx, center.cy, onConfirm]);

  // Esc cancels, Enter confirms — in the CAPTURE phase with stopImmediate so the
  // composer Modal underneath (which also Esc-closes on window) never fires too;
  // refs keep the listener stable without re-binding on every pan/zoom. Body
  // scroll stays locked while the overlay owns the screen.
  const confirmRef = useRef(confirm);
  const cancelRef = useRef(onCancel);
  useEffect(() => { confirmRef.current = confirm; cancelRef.current = onCancel; });
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); cancelRef.current?.(); }
      else if (e.key === 'Enter') { e.stopImmediatePropagation(); confirmRef.current?.(); }
    };
    window.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey, true); document.body.style.overflow = prev; };
  }, []);

  const showRatios = !lockedRatioId && ratios.length > 1;

  return createPortal(
    <div className="fixed inset-0 z-[90] flex flex-col bg-black/95 text-white animate-in fade-in duration-150">
      {/* top bar */}
      <div className="flex shrink-0 items-center justify-between px-3 py-3 sm:px-5">
        <button type="button" onClick={onCancel} className="grid h-11 w-11 place-items-center rounded-full text-white/80 hover:bg-white/10 hover:text-white" aria-label="Cancelar">
          <X size={22} />
        </button>
        <div className="text-sm font-medium text-white/90">
          {mode === 'story' || mode === 'reel' ? 'Recortar historia' : 'Recortar para Instagram'}
        </div>
        <button
          type="button"
          onClick={confirm}
          disabled={status !== 'ready' || busy}
          className="inline-flex h-11 items-center gap-1.5 rounded-full bg-white px-4 text-sm font-semibold text-black hover:bg-white/90 disabled:opacity-40"
        >
          {busy ? <RefreshCw size={16} className="animate-spin" /> : <Check size={17} />} Listo
        </button>
      </div>

      {/* stage — the framing area */}
      <div ref={stageRef} className="relative min-h-0 flex-1 select-none overflow-hidden p-3 sm:p-6">
        <div className="grid h-full w-full place-items-center">
          {status === 'loading' && (
            <div className="flex items-center gap-2 text-sm text-white/70"><RefreshCw size={16} className="animate-spin" /> Cargando imagen…</div>
          )}
          {status === 'error' && (
            <div className="max-w-xs text-center text-sm text-white/80">
              No se pudo leer la imagen. Si es HEIC (foto de iPhone), expórtala como JPG e inténtalo de nuevo.
              <div className="mt-3"><button type="button" onClick={onCancel} className="rounded-full bg-white/15 px-4 py-2 text-white hover:bg-white/25">Cerrar</button></div>
            </div>
          )}
          {status === 'ready' && img && frame.w > 0 && (
            <div
              ref={frameRef}
              className="relative overflow-hidden rounded-lg shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] cursor-grab active:cursor-grabbing"
              style={{ width: frame.w, height: frame.h, touchAction: 'none' }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endPointer}
              onPointerCancel={endPointer}
              onWheel={onWheel}
            >
              {view && (
                <img
                  src={img.previewUrl}
                  alt=""
                  draggable={false}
                  className="pointer-events-none absolute max-w-none select-none"
                  style={{ width: view.imgW, height: view.imgH, left: view.left, top: view.top }}
                />
              )}
              {/* thirds guides — fade out once the user starts framing is overkill;
                  keep them subtle and always on, like IG's grid. */}
              <div className="pointer-events-none absolute inset-0">
                <div className="absolute left-1/3 top-0 h-full w-px bg-white/25" />
                <div className="absolute left-2/3 top-0 h-full w-px bg-white/25" />
                <div className="absolute top-1/3 left-0 w-full h-px bg-white/25" />
                <div className="absolute top-2/3 left-0 w-full h-px bg-white/25" />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* controls */}
      {status === 'ready' && (
        <div className="shrink-0 space-y-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 sm:px-6">
          {/* zoom */}
          <div className="mx-auto flex max-w-md items-center gap-3">
            <ZoomIn size={16} className="shrink-0 text-white/60" />
            <input
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.01}
              value={zoom}
              onChange={(e) => applyZoom(Number(e.target.value), null)}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/25 accent-white"
              aria-label="Zoom"
            />
          </div>
          {/* ratio chips */}
          {showRatios && (
            <div className="flex flex-wrap items-center justify-center gap-2">
              {ratios.map((r) => {
                const on = r.id === ratioId;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => changeRatio(r.id)}
                    className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${on ? 'bg-white text-black' : 'bg-white/12 text-white/80 hover:bg-white/20'}`}
                    aria-pressed={on}
                  >
                    {r.label}
                  </button>
                );
              })}
            </div>
          )}
          {lockedRatioId && (
            <p className="text-center text-[11px] text-white/50">Todo el carrusel comparte el mismo formato ({ratio.label}).</p>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
