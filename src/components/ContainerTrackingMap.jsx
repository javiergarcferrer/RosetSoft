import { useEffect, useRef, useState } from 'react';
import { safeDynamicImport } from '../lib/dynamicImport.js';
import { formatDateTime } from '../lib/format.js';
import { CLASSIFIER_LABELS } from '../lib/containerTracking.js';

/**
 * Renders a container's Track & Trace route on a Leaflet map: one marker per
 * port hop (from `buildTrackingRoute`), a solid line through the legs already
 * sailed and a dashed line to the estimated arrival. It plots port-level
 * positions, NOT live vessel GPS — DCSA Track & Trace is event-based, so the
 * honest unit is "which port, in what order".
 *
 * Leaflet (+ its CSS) is loaded on demand via `safeDynamicImport`, the same
 * code-split path the PDF export uses, so the library stays out of the initial
 * bundle and only downloads when a dealer actually opens tracking. Tiles are
 * CARTO Positron (free, no API key, light styling that fits the app) and load
 * in the dealer's browser at runtime.
 *
 * @param {{ route: import('../lib/containerTracking.js').TrackingRoute }} props
 */
export default function ContainerTrackingMap({ route }) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const [status, setStatus] = useState('loading'); // loading | ready | error

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
          // A panel-embedded map shouldn't hijack the page's scroll; pan/zoom
          // stay available via drag, the zoom control, and double-click.
          scrollWheelZoom: false,
          zoomControl: true,
          attributionControl: true,
        });
        mapRef.current = map;
        map.attributionControl.setPrefix(false);

        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
          attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
          subdomains: 'abcd',
          maxZoom: 19,
        }).addTo(map);

        drawRoute(L, map, route);
        if (cancelled) { map.remove(); mapRef.current = null; return; }
        setStatus('ready');
        // Guard against a zero-size container at first paint (the panel may
        // still be settling its layout); recompute once the frame is in.
        setTimeout(() => { if (!cancelled && mapRef.current) mapRef.current.invalidateSize(); }, 0);
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, [route]);

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <div
          ref={elRef}
          className="h-60 w-full rounded-md border border-ink-100 bg-ink-50 z-0"
          aria-label="Mapa de rastreo del contenedor"
        />
        {status !== 'ready' && (
          <div className="absolute inset-0 flex items-center justify-center rounded-md bg-ink-50/80 text-ink-500 text-[11px] pointer-events-none">
            {status === 'error' ? 'No se pudo cargar el mapa' : 'Cargando mapa…'}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-ink-500">
        <LegendDot className="bg-ink-400" /> Recorrido
        <LegendDot className="bg-emerald-600" /> Posición actual
        <LegendDot className="bg-white border-2 border-brand-600" /> Destino (ETA)
      </div>
    </div>
  );
}

function LegendDot({ className }) {
  return <span className={`inline-block w-2 h-2 rounded-full align-middle mr-0.5 ${className}`} />;
}

/* --------------------------- Leaflet drawing -------------------------- */

const STYLES = {
  leg:    { color: '#544f43', weight: 2.5, opacity: 0.8 },                 // ink-600, travelled
  legEta: { color: '#a55322', weight: 2.5, opacity: 0.8, dashArray: '5,6' }, // brand-600, remaining
  stop:   { radius: 5, color: '#544f43', weight: 1.5, fillColor: '#878374', fillOpacity: 0.9 }, // ink
  last:   { radius: 7, color: '#047857', weight: 2,   fillColor: '#059669', fillOpacity: 1 },   // emerald
  eta:    { radius: 6, color: '#a55322', weight: 2.5, fillColor: '#ffffff', fillOpacity: 1, dashArray: '3' }, // brand ring
};

function drawRoute(L, map, route) {
  const stops = route?.stops || [];
  if (stops.length === 0) {
    map.setView([20, -40], 2); // mid-Atlantic fallback; should be unreachable
    return;
  }

  const pts = stops.map((s) => [s.lat, s.lon]);

  // The voyage line: solid through the legs already sailed (up to the
  // last-known position), dashed onward to the ETA. `cut` is that boundary;
  // -1 means nothing actual yet, so the whole path is the dashed "planned" leg.
  if (pts.length >= 2) {
    const cut = route.lastIndex;
    if (cut >= 1) L.polyline(pts.slice(0, cut + 1), STYLES.leg).addTo(map);
    if (cut >= 0 && cut < pts.length - 1) L.polyline(pts.slice(cut), STYLES.legEta).addTo(map);
    if (cut < 0) L.polyline(pts, STYLES.legEta).addTo(map);
  }

  for (const s of stops) {
    const style = s.isLast ? STYLES.last : s.isEta ? STYLES.eta : STYLES.stop;
    L.circleMarker([s.lat, s.lon], style).addTo(map).bindPopup(popupHtml(s));
  }

  if (pts.length === 1) {
    map.setView(pts[0], 5);
  } else {
    map.fitBounds(L.latLngBounds(pts), { padding: [24, 24], maxZoom: 7 });
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

function popupHtml(stop) {
  const head = `<strong>${esc(stop.name)}</strong>${stop.unloc ? ` · ${esc(stop.unloc)}` : ''}`;
  const rows = stop.events.map((e) => {
    const when = e.at ? formatDateTime(e.at) : '';
    const cls = e.classifier && e.classifier !== 'ACT'
      ? ` (${esc(CLASSIFIER_LABELS[e.classifier] || e.classifier)})`
      : '';
    return `<div style="margin-top:2px">${esc(e.label)}${cls}${when ? ` — <span style="color:#878374">${esc(when)}</span>` : ''}</div>`;
  }).join('');
  return `<div style="font-size:11px;line-height:1.35;min-width:140px">${head}${rows}</div>`;
}
