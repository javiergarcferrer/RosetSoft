/**
 * UN/LOCODE → geographic coordinate lookup, for plotting container Track &
 * Trace events on a map.
 *
 * DCSA events (see `containerTracking.ts`) carry a port's UN/LOCODE and name
 * but — from Hapag-Lloyd — rarely a latitude/longitude. To drop a pin we map
 * the code to a coordinate ourselves. This is a curated, BUNDLED table — no
 * network, no API key — covering the ports a Ligne Roset shipment
 * (France → Caribbean / Dominican Republic) realistically touches: French &
 * North-European load ports, the Mediterranean and Atlantic transshipment
 * hubs, the Antilles / Hispaniola discharge ports, plus the global majors a
 * re-routed box might pass through. An unknown code yields null (no pin) — the
 * textual timeline still lists it, so coverage gaps degrade gracefully.
 *
 * Coordinates are the port/city centroid (~port-level precision). Track &
 * Trace is event-based, not live GPS, so this is the right granularity: it
 * answers "which port, in what order", not "where is the vessel right now".
 */

export interface PortCoord {
  /** Display name, e.g. 'Le Havre'. */
  name: string;
  lat: number;
  lon: number;
}

// Keyed by UN/LOCODE (5 chars, no space): 2-letter country + 3-letter place.
const PORTS: Record<string, PortCoord> = {
  /* ── France & North Europe (origin / first load) ── */
  FRLEH: { name: 'Le Havre', lat: 49.4861, lon: 0.1056 },
  FRFOS: { name: 'Fos-sur-Mer', lat: 43.4203, lon: 4.8881 },
  FRMRS: { name: 'Marseille', lat: 43.2965, lon: 5.3698 },
  FRDKK: { name: 'Dunkerque', lat: 51.0344, lon: 2.3768 },
  FRBOD: { name: 'Bordeaux', lat: 44.8378, lon: -0.5792 },
  BEANR: { name: 'Antwerp', lat: 51.2603, lon: 4.3914 },
  BEZEE: { name: 'Zeebrugge', lat: 51.3300, lon: 3.2050 },
  NLRTM: { name: 'Rotterdam', lat: 51.9244, lon: 4.4777 },
  DEHAM: { name: 'Hamburg', lat: 53.5511, lon: 9.9937 },
  DEBRV: { name: 'Bremerhaven', lat: 53.5396, lon: 8.5809 },
  GBFXT: { name: 'Felixstowe', lat: 51.9540, lon: 1.3464 },
  GBSOU: { name: 'Southampton', lat: 50.9097, lon: -1.4044 },

  /* ── Iberia / Mediterranean (transshipment) ── */
  ESALG: { name: 'Algeciras', lat: 36.1408, lon: -5.4526 },
  ESVLC: { name: 'Valencia', lat: 39.4440, lon: -0.3170 },
  ESBCN: { name: 'Barcelona', lat: 41.3500, lon: 2.1600 },
  PTSIE: { name: 'Sines', lat: 37.9560, lon: -8.8644 },
  PTLIS: { name: 'Lisbon', lat: 38.7223, lon: -9.1393 },
  ITGOA: { name: 'Genoa', lat: 44.4056, lon: 8.9463 },
  ITSPE: { name: 'La Spezia', lat: 44.1025, lon: 9.8240 },
  ITGIT: { name: 'Gioia Tauro', lat: 38.4244, lon: 15.8989 },
  MAPTM: { name: 'Tanger Med', lat: 35.8839, lon: -5.5000 },
  MACAS: { name: 'Casablanca', lat: 33.5731, lon: -7.5898 },
  EGPSD: { name: 'Port Said', lat: 31.2653, lon: 32.3019 },

  /* ── Caribbean / Central America (transshipment + discharge) ── */
  DOCAU: { name: 'Caucedo', lat: 18.4250, lon: -69.6333 },
  DOHAI: { name: 'Río Haina', lat: 18.4167, lon: -70.0167 },
  DOSDQ: { name: 'Santo Domingo', lat: 18.4861, lon: -69.9312 },
  DOPOP: { name: 'Puerto Plata', lat: 19.7975, lon: -70.6886 },
  PRSJU: { name: 'San Juan', lat: 18.4655, lon: -66.1057 },
  JMKIN: { name: 'Kingston', lat: 17.9712, lon: -76.7928 },
  BSFPO: { name: 'Freeport', lat: 26.5333, lon: -78.7000 },
  PABLB: { name: 'Balboa', lat: 8.9333, lon: -79.5667 },
  PAMIT: { name: 'Manzanillo (PA)', lat: 9.3700, lon: -79.8870 },
  PACTB: { name: 'Cristóbal', lat: 9.3547, lon: -79.9027 },
  COCTG: { name: 'Cartagena', lat: 10.3997, lon: -75.5144 },
  TTPOS: { name: 'Port of Spain', lat: 10.6549, lon: -61.5019 },
  CWWIL: { name: 'Willemstad', lat: 12.1167, lon: -68.9333 },
  GPPTP: { name: 'Pointe-à-Pitre', lat: 16.2333, lon: -61.5333 },
  MQFDF: { name: 'Fort-de-France', lat: 14.6000, lon: -61.0667 },

  /* ── US East/Gulf coast (occasional relay) ── */
  USMIA: { name: 'Miami', lat: 25.7617, lon: -80.1918 },
  USNYC: { name: 'New York', lat: 40.7128, lon: -74.0060 },
  USORF: { name: 'Norfolk', lat: 36.8508, lon: -76.2859 },
  USSAV: { name: 'Savannah', lat: 32.0809, lon: -81.0912 },
  USCHS: { name: 'Charleston', lat: 32.7765, lon: -79.9311 },
  USHOU: { name: 'Houston', lat: 29.7604, lon: -95.3698 },

  /* ── Global majors (for an unusual routing) ── */
  SGSIN: { name: 'Singapore', lat: 1.2644, lon: 103.8200 },
  CNSHA: { name: 'Shanghai', lat: 31.2304, lon: 121.4737 },
  CNNGB: { name: 'Ningbo', lat: 29.8683, lon: 121.5440 },
  CNYTN: { name: 'Yantian', lat: 22.5736, lon: 114.2920 },
  HKHKG: { name: 'Hong Kong', lat: 22.3193, lon: 114.1694 },
  KRPUS: { name: 'Busan', lat: 35.1796, lon: 129.0756 },
  AEJEA: { name: 'Jebel Ali', lat: 25.0110, lon: 55.0610 },
  LKCMB: { name: 'Colombo', lat: 6.9271, lon: 79.8612 },
  MYTPP: { name: 'Tanjung Pelepas', lat: 1.3667, lon: 103.5500 },
};

/** Number of ports in the bundled table (handy for tests/diagnostics). */
export const KNOWN_PORT_COUNT = Object.keys(PORTS).length;

/**
 * Resolve a UN/LOCODE to its coordinate, or null if we don't carry it.
 * Tolerant of casing and embedded separators (e.g. "FR LEH" / "fr-leh").
 */
export function lookupPort(code: string | null | undefined): PortCoord | null {
  if (!code) return null;
  const key = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return PORTS[key] || null;
}
