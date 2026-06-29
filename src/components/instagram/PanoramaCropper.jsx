// Panorama cropper — frames a wide landscape and cuts it into N equal Instagram
// tiles for a "sliding feed" carousel: swiping the carousel pans across one
// continuous image. It's the single ImageCropper generalized to N outputs —
// N tiles of the chosen per-slide ratio = ONE crop window of aspect N·ratio
// (panoramaFrameAspect), so the same cover/clamp/zoom Model frames the band and
// `sliceWindows` cuts it into seam-continuous strips. Exports N exact-spec
// 1080-wide baseline JPEGs in swipe order. Full-screen overlay (portal to
// <body>) that sits above the Publicar modal. All the geometry lives in the pure
// Model (lib/imageCrop); this View only decodes, paints the live band, draws the
// slice guides, and renders each final strip to its own canvas.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, X, ZoomIn, RefreshCw, Minus, Plus, MoveHorizontal } from 'lucide-react';
import {
  TILE_RATIOS, MIN_SLICES, MAX_SLICES, panoramaFrameAspect, sliceWindows, clampSlices,
  cropWindow, baseCropSize, outputSize, clamp, MIN_ZOOM, MAX_ZOOM,
} from '../../lib/imageCrop.js';
import { loadOriented, toJpeg, IMG_MAX_BYTES } from './cropCanvas.js';

const IG_MIN_TILE_W = 320; // IG rejects carousel images narrower than this

export default function PanoramaCropper({ file, maxSlices = MAX_SLICES, onConfirm, onCancel }) {
  // The carousel's remaining room caps the count; never below 2 (it's a panorama).
  const slideCap = clamp(Math.round(maxSlices), MIN_SLICES, MAX_SLICES);
  const [tileId, setTileId] = useState(TILE_RATIOS[0].id);
  const [slices, setSlices] = useState(() => clampSlices(3, slideCap));
  const [zoom, setZoom] = useState(1);
  const [center, setCenter] = useState({ cx: 0, cy: 0 });
  const [img, setImg] = useState(null); // { canvas, w, h, previewUrl }
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [busy, setBusy] = useState(false);

  const tile = useMemo(() => TILE_RATIOS.find((r) => r.id === tileId) || TILE_RATIOS[0], [tileId]);
  const frameAspect = panoramaFrameAspect(slices, tile.aspect);

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

  // Keep the count inside the carousel's room if the cap tightens.
  useEffect(() => { setSlices((n) => clampSlices(n, slideCap)); }, [slideCap]);

  // ── frame box — fit the (wide) band aspect into the measured stage ──────
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
    const boxW = stage.w;
    const boxH = stage.h;
    if (!boxW || !boxH) return { w: 0, h: 0 };
    if (boxW / boxH > frameAspect) return { w: Math.round(boxH * frameAspect), h: Math.round(boxH) };
    return { w: Math.round(boxW), h: Math.round(boxW / frameAspect) };
  }, [stage.w, stage.h, frameAspect]);

  // Resolve the live crop window + the <img> transform that shows it.
  const view = useMemo(() => {
    if (!img || !frame.w) return null;
    const win = cropWindow(img.w, img.h, frameAspect, zoom, center.cx, center.cy);
    const s = frame.w / win.sw; // display scale (frame.h / win.sh is identical)
    return {
      win,
      s,
      imgW: img.w * s,
      imgH: img.h * s,
      left: -win.sx * s,
      top: -win.sy * s,
    };
  }, [img, frame.w, frameAspect, zoom, center.cx, center.cy]);

  // ── gestures: pan (1 finger / drag) + pinch-zoom (2 fingers) ────────────
  const pointers = useRef(new Map());
  const pinch = useRef(null); // { dist, zoom }

  // Zoom toward an anchor (client coords) keeping the source point under it
  // fixed; pass null to zoom around the frame center (slider / wheel).
  const applyZoom = useCallback((nextZoom, anchor) => {
    if (!img || !frame.w) return;
    const cur = cropWindow(img.w, img.h, frameAspect, zoom, center.cx, center.cy);
    const s0 = frame.w / cur.sw;
    const rect = frameRef.current?.getBoundingClientRect();
    const ax = anchor && rect ? anchor.x - rect.left : frame.w / 2;
    const ay = anchor && rect ? anchor.y - rect.top : frame.h / 2;
    const srcX = cur.sx + ax / s0;
    const srcY = cur.sy + ay / s0;
    const z1 = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    const base = baseCropSize(img.w, img.h, frameAspect);
    const sw1 = base.w / z1;
    const sh1 = base.h / z1;
    const s1 = frame.w / sw1;
    const clamped = cropWindow(img.w, img.h, frameAspect, z1, srcX - ax / s1 + sw1 / 2, srcY - ay / s1 + sh1 / 2);
    setZoom(z1);
    setCenter({ cx: clamped.cx, cy: clamped.cy });
  }, [img, frame.w, frame.h, frameAspect, zoom, center.cx, center.cy]);

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
      const w = cropWindow(img.w, img.h, frameAspect, zoom, c.cx - dx, c.cy - dy);
      return { cx: w.cx, cy: w.cy };
    });
  }, [view, img, frameAspect, zoom, applyZoom]);

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

  // Re-center + reset zoom whenever the band aspect changes (count or tile
  // ratio) so the new frame opens predictably on the middle of the photo.
  useEffect(() => {
    setZoom(1);
    setCenter((c) => (img ? { cx: img.w / 2, cy: img.h / 2 } : c));
  }, [slices, tileId, img]);

  const setCount = useCallback((n) => setSlices(clampSlices(n, slideCap)), [slideCap]);

  // Live per-tile source width → flag a count that would publish below IG's min.
  const tileSrcW = view ? view.win.sw / slices : 0;
  const lowRes = status === 'ready' && tileSrcW > 0 && Math.min(1080, Math.round(tileSrcW)) < IG_MIN_TILE_W;

  // ── export each strip at IG spec ─────────────────────────────────────────
  const confirm = useCallback(async () => {
    if (!img || busy || status !== 'ready') return;
    setBusy(true);
    try {
      const win = cropWindow(img.w, img.h, frameAspect, zoom, center.cx, center.cy);
      const rects = sliceWindows(win, slices);
      const files = [];
      for (let i = 0; i < rects.length; i += 1) {
        const r = rects[i];
        const out = outputSize(tile.aspect, r.sw);
        const canvas = document.createElement('canvas');
        canvas.width = out.w; canvas.height = out.h;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no-ctx');
        ctx.fillStyle = '#ffffff'; // JPEG has no alpha — flatten onto white
        ctx.fillRect(0, 0, out.w, out.h);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img.canvas, r.sx, r.sy, r.sw, r.sh, 0, 0, out.w, out.h);
        let quality = 0.92;
        // eslint-disable-next-line no-await-in-loop
        let blob = await toJpeg(canvas, quality);
        while (blob.size > IMG_MAX_BYTES && quality > 0.5) {
          quality -= 0.1;
          // eslint-disable-next-line no-await-in-loop
          blob = await toJpeg(canvas, quality);
        }
        files.push(new File([blob], `ig-pano-${i + 1}.jpg`, { type: 'image/jpeg' }));
      }
      onConfirm?.(files, tile.id);
    } finally {
      // Always clear busy — on success the parent unmounts us, but if it keeps
      // the overlay open (or onConfirm throws) the button would otherwise stay
      // stuck spinning and disabled.
      setBusy(false);
    }
  }, [img, busy, status, frameAspect, zoom, center.cx, center.cy, slices, tile, onConfirm]);

  // Esc cancels, Enter confirms — capture phase + stopImmediate so the composer
  // Modal underneath (which also Esc-closes) never fires too; refs keep the
  // listener stable without re-binding on every pan/zoom. Body scroll stays
  // locked while the overlay owns the screen.
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

  // The interior slice boundaries (fractions of the frame width) for the guides.
  const dividers = useMemo(
    () => Array.from({ length: Math.max(0, slices - 1) }, (_, i) => ((i + 1) / slices) * 100),
    [slices],
  );

  return createPortal(
    <div className="fixed inset-0 z-[90] flex flex-col bg-black/95 text-white animate-in fade-in duration-150">
      {/* top bar */}
      <div className="flex shrink-0 items-center justify-between px-3 py-3 sm:px-5">
        <button type="button" onClick={onCancel} className="grid h-11 w-11 place-items-center rounded-full text-white/80 hover:bg-white/10 hover:text-white" aria-label="Cancelar">
          <X size={22} />
        </button>
        <div className="text-sm font-medium text-white/90">Panorámica deslizante</div>
        <button
          type="button"
          onClick={confirm}
          disabled={status !== 'ready' || busy}
          className="inline-flex h-11 items-center gap-1.5 rounded-full bg-white px-4 text-sm font-semibold text-black hover:bg-white/90 disabled:opacity-40"
        >
          {busy ? <RefreshCw size={16} className="animate-spin" /> : <Check size={17} />} Crear {slices}
        </button>
      </div>

      {/* stage — the framing band */}
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
              {/* slice guides — one line per cut, plus a card number per tile, so
                  the dealer sees exactly what each carousel slide will be. */}
              <div className="pointer-events-none absolute inset-0">
                {dividers.map((pct, i) => (
                  <div key={i} className="absolute top-0 h-full w-px bg-white/70 shadow-[0_0_0_0.5px_rgba(0,0,0,0.4)]" style={{ left: `${pct}%` }} />
                ))}
                {Array.from({ length: slices }, (_, i) => (
                  <span
                    key={i}
                    className="absolute top-2 grid h-6 min-w-6 -translate-x-1/2 place-items-center rounded-full bg-black/55 px-1.5 text-[11px] font-semibold text-white"
                    style={{ left: `${((i + 0.5) / slices) * 100}%` }}
                  >
                    {i + 1}
                  </span>
                ))}
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

          {/* slice count + per-tile ratio */}
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCount(slices - 1)}
                disabled={slices <= MIN_SLICES}
                className="grid h-9 w-9 place-items-center rounded-full bg-white/12 text-white hover:bg-white/20 disabled:opacity-30"
                aria-label="Menos imágenes"
              >
                <Minus size={16} />
              </button>
              <span className="min-w-20 text-center text-sm tabular-nums text-white/90">{slices} imágenes</span>
              <button
                type="button"
                onClick={() => setCount(slices + 1)}
                disabled={slices >= slideCap}
                className="grid h-9 w-9 place-items-center rounded-full bg-white/12 text-white hover:bg-white/20 disabled:opacity-30"
                aria-label="Más imágenes"
              >
                <Plus size={16} />
              </button>
            </div>
            <div className="flex items-center gap-2">
              {TILE_RATIOS.map((r) => {
                const on = r.id === tileId;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setTileId(r.id)}
                    className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${on ? 'bg-white text-black' : 'bg-white/12 text-white/80 hover:bg-white/20'}`}
                    aria-pressed={on}
                  >
                    {r.label}
                  </button>
                );
              })}
            </div>
          </div>

          <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-white/50">
            <MoveHorizontal size={13} /> Se publican {slices} tarjetas; al deslizar el carrusel se ve la imagen completa.
          </p>
          {lowRes && (
            <p className="text-center text-[11px] text-amber-300/90">
              Con {slices} cortes cada imagen queda algo pequeña ({Math.round(tileSrcW)} px). Usa menos cortes o una foto más ancha para máxima nitidez.
            </p>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
