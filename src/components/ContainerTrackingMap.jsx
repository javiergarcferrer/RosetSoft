import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Maximize2, Minimize2, LocateFixed } from 'lucide-react';
import { safeDynamicImport } from '../lib/dynamicImport.js';
import { formatDateTime } from '../lib/format.js';
import { CLASSIFIER_LABELS, MODE_LABELS } from '../lib/containerTracking.js';
import { greatCircle, splitAntimeridian, bearingDeg } from '../lib/voyageGeometry.js';
import { resolveVoyageHud } from '../core/tracking/voyage.js';

/**
 * The container voyage map. Draws a Hapag-Lloyd Track & Trace route as
 * great-circle arcs (curved, the way a real sea route reads on a Mercator
 * map), with the legs already sailed solid and the leg still to come animated
 * toward the destination; a heading-rotated vessel marker sits at the
 * last-known position. A glass HUD reports origin → destination, vessel,
 * carrier, ETA and great-circle progress.
 *
 * Honest scope: these are PORT-level positions derived from DCSA events, not
 * live vessel GPS — the vessel marker sits at the last reported port, pointed
 * at the next one.
 *
 * Leaflet (+ CSS) loads on demand via `safeDynamicImport`, the same code-split
 * path the PDF export uses, so the library stays out of the initial bundle.
 * Tiles are CARTO (free, keyless) and load in the dealer's browser.
 *
 * Exposes `focusStop(index)` via ref so the timeline can drive the map.
 *
 * @param {{ route: import('../lib/containerTracking.js').TrackingRoute,
 *           voyage: import('../lib/containerTracking.js').VoyageSummary }} props
 */
const ContainerTrackingMap = forwardRef(function ContainerTrackingMap({ route, voyage }, ref) {
  const wrapRef = useRef(null);
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);   // stop index → Leaflet marker
  const boundsRef = useRef(null);  // fitted bounds, for the reset control
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [expanded, setExpanded] = useState(false);

  // Let the timeline pan the map to a stop and pop its detail.
  useImperativeHandle(ref, () => ({
    focusStop(index) {
      const map = mapRef.current;
      const marker = markersRef.current[index];
      if (!map || !marker) return;
      map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 4), { duration: 0.6 });
      marker.openPopup();
    },
  }), []);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');

    (async () => {
      try {
        const mod = await safeDynamicImport(() => import('leaflet'));
        await import('leaflet/dist/leaflet.css');
        if (cancelled || !elRef.current) return;
        const L = mod.default || mod;

        const map = L.map(elRef.current, {
          scrollWheelZoom: false,        // don't hijack page scroll
          zoomControl: false,            // re-added bottom-right, clear of the HUD
          attributionControl: true,
          worldCopyJump: true,
        });
        mapRef.current = map;
        map.attributionControl.setPrefix(false);
        L.control.zoom({ position: 'bottomright' }).addTo(map);

        // Soft coloured land, then a labels-only layer on top so place names
        // sit above the route without the basemap competing with it.
        const tile = (suffix) => L.tileLayer(
          `https://{s}.basemaps.cartocdn.com/rastertiles/${suffix}/{z}/{x}/{y}{r}.png`,
          { attribution: '&copy; OpenStreetMap contributors &copy; CARTO', subdomains: 'abcd', maxZoom: 19 },
        );
        tile('voyager_nolabels').addTo(map);
        tile('voyager_only_labels').addTo(map);

        drawVoyage(L, map, route, voyage, markersRef, boundsRef);
        if (cancelled) { map.remove(); mapRef.current = null; return; }
        setStatus('ready');
        setTimeout(() => { if (!cancelled && mapRef.current) mapRef.current.invalidateSize(); }, 0);
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      markersRef.current = [];
      boundsRef.current = null;
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, [route, voyage]);

  // Resize the map when toggling the expanded (near-fullscreen) overlay.
  useEffect(() => {
    if (mapRef.current) setTimeout(() => mapRef.current && mapRef.current.invalidateSize(), 60);
  }, [expanded]);

  function resetView() {
    if (mapRef.current && boundsRef.current) {
      mapRef.current.fitBounds(boundsRef.current, FIT_PADDING);
    }
  }

  return (
    <div
      ref={wrapRef}
      className={`vmap-leaf min-w-0 w-full ${expanded ? 'fixed inset-2 z-[60] sm:inset-4' : 'relative'}`}
    >
      <div className="relative h-full w-full">
        <div
          ref={elRef}
          className={`w-full rounded-lg border border-ink-100 bg-ink-50 z-0 ${expanded ? 'h-full' : 'h-48 sm:h-64'}`}
          aria-label="Mapa del viaje del contenedor"
        />

        {/* The panel above carries the voyage summary inline, so the map stays
            clean; the overlay HUD only appears when expanded to full screen. */}
        {status === 'ready' && expanded && voyage?.origin && (
          <VoyageHud voyage={voyage} />
        )}

        {/* Top-right controls */}
        <div className="absolute top-2 right-2 z-[1000] flex gap-1">
          <MapButton title="Centrar el recorrido" onClick={resetView}><LocateFixed size={14} /></MapButton>
          <MapButton title={expanded ? 'Reducir' : 'Ampliar'} onClick={() => setExpanded((v) => !v)}>
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </MapButton>
        </div>

        {status !== 'ready' && (
          <div className="absolute inset-0 z-[500] flex items-center justify-center rounded-lg bg-ink-50/80 text-ink-500 text-[11px]">
            {status === 'error' ? 'No se pudo cargar el mapa' : 'Cargando mapa…'}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-ink-500 mt-1.5 min-w-0 w-full">
        <LegendDot className="bg-brand-600" /> Recorrido
        <LegendDot className="ring-2 ring-ink-500 bg-white" /> Escala
        <LegendDot className="bg-emerald-600" /> Posición actual
        <LegendDot className="ring-2 ring-brand-600 bg-white" /> Destino
      </div>
    </div>
  );
});

export default ContainerTrackingMap;

/* -------------------------------- HUD -------------------------------- */

function VoyageHud({ voyage }) {
  const { originName, destName, meta, etaLabel, progressPct, progressLabel, arrived, updatedLabel } =
    resolveVoyageHud(voyage);

  return (
    <div className="absolute top-2 left-2 z-[1000] max-w-[min(20rem,calc(100%-5rem))] rounded-lg border border-white/60 bg-surface/85 backdrop-blur-md shadow-pop px-3 py-2 text-xs">
      {/* Port names wrap, never truncate — the HUD grows downward over the map. */}
      <div className="flex items-center gap-1.5 font-semibold text-ink-900 leading-tight">
        <span className="min-w-0 break-words">{originName}</span>
        <span className="text-ink-300" aria-hidden>→</span>
        <span className="min-w-0 break-words">{destName}</span>
      </div>
      {meta && <div className="text-[10px] text-ink-500 mt-0.5 break-words">{meta}</div>}

      <div className="mt-2 h-1.5 rounded-full bg-ink-100 overflow-hidden">
        <div
          className={`h-full rounded-full ${arrived ? 'bg-emerald-600' : 'bg-brand-500'}`}
          style={{ width: `${Math.max(2, Math.round(progressPct))}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-2 mt-1 text-[10px]">
        <span className={arrived ? 'text-emerald-700 font-medium' : 'text-ink-600 font-medium'}>
          {progressLabel}
        </span>
        {etaLabel && <span className="min-w-0 text-right break-words text-ink-500">{etaLabel}</span>}
      </div>
      {updatedLabel && <div className="text-[10px] text-ink-400 mt-0.5">{updatedLabel}</div>}
    </div>
  );
}

function MapButton({ title, onClick, children }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="w-7 h-7 coarse:w-11 coarse:h-11 grid place-items-center rounded-md border border-ink-200 bg-surface/90 backdrop-blur text-ink-600 hover:text-ink-900 hover:border-ink-400 shadow-soft transition-colors"
    >
      {children}
    </button>
  );
}

function LegendDot({ className }) {
  return <span className={`inline-block w-2.5 h-2.5 rounded-full align-middle mr-0.5 ${className}`} />;
}

/* --------------------------- Leaflet drawing -------------------------- */

const FIT_PADDING = { paddingTopLeft: [44, 88], paddingBottomRight: [44, 36], maxZoom: 6 };

// Navigation glyph pointing north (0°); rotated to the vessel's heading.
const VESSEL_SVG =
  '<svg viewBox="0 0 24 24" fill="#059669" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round">' +
  '<path d="M12 1.8 L19.6 21 L12 16.3 L4.4 21 Z"/></svg>';

// Route arcs in brand-600 (the exact tailwind ramp hex) — Leaflet takes raw
// colors, so these can't come from a utility class.
const SAILED_STYLE = { color: '#a85620', weight: 3.5, opacity: 0.95, lineCap: 'round', lineJoin: 'round' };
const REMAIN_STYLE = { color: '#a85620', weight: 3, opacity: 0.7, lineCap: 'round', className: 'vmap-flow' };

function dotIcon(L, cls, size) {
  return L.divIcon({
    className: 'vmap-icon',
    html: `<span class="vmap-dot ${cls}"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function vesselIcon(L, headingDeg) {
  return L.divIcon({
    className: 'vmap-icon',
    html: `<div class="vmap-vessel-wrap"><span class="vmap-vessel-halo"></span>`
      + `<span class="vmap-vessel-glyph" style="transform:rotate(${headingDeg}deg)">${VESSEL_SVG}</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function drawVoyage(L, map, route, voyage, markersRef, boundsRef) {
  const stops = route?.stops || [];
  if (stops.length === 0) { map.setView([24, -45], 3); return; }

  const ll = stops.map((s) => [s.lat, s.lon]);
  const lastIndex = route.lastIndex;
  const destIndex = route.etaIndex >= 0 ? route.etaIndex : stops.length - 1;
  const arrived = !!voyage?.arrived;
  const allPts = [];

  // Route arcs: per leg, sampled along the great circle and split at the
  // antimeridian. Legs up to the last-known stop are "sailed"; the rest flow.
  for (let i = 1; i < stops.length; i++) {
    const sailed = lastIndex >= 0 && i <= lastIndex;
    const style = sailed ? SAILED_STYLE : REMAIN_STYLE;
    for (const seg of splitAntimeridian(greatCircle(ll[i - 1], ll[i], 48))) {
      if (seg.length >= 2) { L.polyline(seg, style).addTo(map); allPts.push(...seg); }
    }
  }
  if (allPts.length === 0) allPts.push(...ll);

  // Port markers.
  markersRef.current = [];
  stops.forEach((s, i) => {
    const cls = i === destIndex
      ? `vmap-dest${arrived ? ' vmap-arrived' : ''}`
      : i === 0 ? 'vmap-origin' : 'vmap-via';
    const size = i === destIndex ? 15 : i === 0 ? 13 : 11;
    const marker = L.marker([s.lat, s.lon], { icon: dotIcon(L, cls, size), zIndexOffset: i === destIndex ? 200 : 100 })
      .addTo(map)
      .bindPopup(popupHtml(s));
    if (i === 0 || i === destIndex) {
      marker.bindTooltip(s.name, { permanent: true, direction: i === 0 ? 'right' : 'left', className: 'vmap-label', offset: i === 0 ? [8, 0] : [-8, 0] });
    }
    markersRef.current[i] = marker;
  });

  // Vessel at the last-known position, pointed at the next stop. When the box
  // has arrived we leave the (checked) destination marker speak for itself.
  if (!arrived && lastIndex >= 0 && lastIndex < stops.length) {
    const next = stops[Math.min(lastIndex + 1, stops.length - 1)];
    const cur = stops[lastIndex];
    const heading = next && next !== cur ? bearingDeg([cur.lat, cur.lon], [next.lat, next.lon]) : 0;
    L.marker([cur.lat, cur.lon], { icon: vesselIcon(L, heading), zIndexOffset: 1000 })
      .addTo(map)
      .bindPopup(popupHtml(cur));
  }

  // Fit to the arcs (not just the stops) so the curves never clip.
  if (allPts.length === 1) {
    map.setView(allPts[0], 4);
    boundsRef.current = null;
  } else {
    const bounds = L.latLngBounds(allPts);
    boundsRef.current = bounds;
    map.fitBounds(bounds, FIT_PADDING);
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function popupHtml(stop) {
  const head = `<strong>${esc(stop.name)}</strong>${stop.unloc ? ` · <span style="color:#878374">${esc(stop.unloc)}</span>` : ''}`;
  const rows = (stop.events || []).map((e) => {
    const when = e.at ? formatDateTime(e.at) : '';
    const bits = [
      e.mode ? esc(MODE_LABELS[e.mode] || e.mode) : null,
      e.classifier && e.classifier !== 'ACT' ? esc(CLASSIFIER_LABELS[e.classifier] || e.classifier) : null,
    ].filter(Boolean).join(' · ');
    return `<div style="margin-top:3px">${esc(e.label)}${bits ? ` <span style="color:#aba79a">(${bits})</span>` : ''}`
      + `${when ? `<br><span style="color:#878374">${esc(when)}</span>` : ''}</div>`;
  }).join('');
  return `<div style="font-size:11px;line-height:1.35;min-width:150px">${head}${rows}</div>`;
}
