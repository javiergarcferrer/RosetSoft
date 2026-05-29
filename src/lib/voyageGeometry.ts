/**
 * Spherical geometry for the container voyage map — great-circle paths,
 * bearings, distances, antimeridian splitting. Pure math, no DOM, so it runs
 * in node (unit-tested) and in the browser unchanged.
 *
 * Why great circles: the shortest path between two ports is an arc on the
 * sphere, which on a Web-Mercator map (what Leaflet draws) is a CURVE, not a
 * straight line. Drawing the straight Mercator segment between Le Havre and
 * Caucedo would be both wrong and visually cheap; sampling the great circle
 * into many points and drawing those as a polyline gives the correct, elegant
 * curved route a tracking map is expected to show.
 */

export type LatLon = [number, number]; // [lat, lon] degrees

const R_KM = 6371.0088; // IUGG mean Earth radius
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Great-circle (haversine) distance in kilometres. */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total great-circle length of a chain of points, in kilometres. */
export function pathLengthKm(points: LatLon[]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += haversineKm(points[i - 1], points[i]);
  return sum;
}

/** Initial bearing a→b in degrees (0 = north, clockwise). Used to point the
 *  vessel marker along its direction of travel. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const dLon = toRad(b[1] - a[1]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Sample the great circle a→b into `segments` straight hops (so `segments + 1`
 * points, endpoints included), via spherical linear interpolation on the unit
 * sphere. Degenerate (coincident / antipodal-ish) inputs fall back to the
 * straight segment.
 */
export function greatCircle(a: LatLon, b: LatLon, segments = 64): LatLon[] {
  const f1 = toRad(a[0]); const l1 = toRad(a[1]);
  const f2 = toRad(b[0]); const l2 = toRad(b[1]);
  const v1 = [Math.cos(f1) * Math.cos(l1), Math.cos(f1) * Math.sin(l1), Math.sin(f1)];
  const v2 = [Math.cos(f2) * Math.cos(l2), Math.cos(f2) * Math.sin(l2), Math.sin(f2)];
  const dot = Math.min(1, Math.max(-1, v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]));
  const omega = Math.acos(dot); // angular separation
  if (!Number.isFinite(omega) || omega < 1e-9) return [a, b];
  const sinO = Math.sin(omega);
  const out: LatLon[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const A = Math.sin((1 - t) * omega) / sinO;
    const B = Math.sin(t * omega) / sinO;
    const x = A * v1[0] + B * v2[0];
    const y = A * v1[1] + B * v2[1];
    const z = A * v1[2] + B * v2[2];
    const lat = toDeg(Math.atan2(z, Math.sqrt(x * x + y * y)));
    const lon = toDeg(Math.atan2(y, x));
    out.push([lat, lon]);
  }
  return out;
}

/**
 * Break a polyline wherever consecutive points jump more than 180° of
 * longitude — i.e. cross the antimeridian (±180°). A flat Mercator renderer
 * would otherwise draw a stray line straight across the whole map. Returns one
 * or more sub-paths to draw independently.
 */
export function splitAntimeridian(points: LatLon[]): LatLon[][] {
  if (points.length < 2) return points.length ? [points] : [];
  const segs: LatLon[][] = [];
  let cur: LatLon[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (Math.abs(points[i][1] - points[i - 1][1]) > 180) {
      segs.push(cur);
      cur = [points[i]];
    } else {
      cur.push(points[i]);
    }
  }
  segs.push(cur);
  return segs;
}

/** Build a curved, antimeridian-safe polyline through an ordered list of
 *  waypoints by great-circle–sampling each leg. */
export function arcThrough(waypoints: LatLon[], perLeg = 48): LatLon[][] {
  if (waypoints.length < 2) return [];
  const pts: LatLon[] = [];
  for (let i = 1; i < waypoints.length; i++) {
    const leg = greatCircle(waypoints[i - 1], waypoints[i], perLeg);
    // Drop the duplicated joint point between consecutive legs.
    pts.push(...(i === 1 ? leg : leg.slice(1)));
  }
  return splitAntimeridian(pts);
}
