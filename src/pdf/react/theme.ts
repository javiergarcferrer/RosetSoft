import { Font, StyleSheet } from '@react-pdf/renderer';

/**
 * Palette + type scale + page geometry for the react-pdf quote, ported
 * 1:1 from the legacy pdf-lib `src/pdf/constants.ts` so the declarative
 * renderer reads identically to the hand-drawn one. Colors are the same
 * ink/brand values, expressed as hex (react-pdf takes CSS colors).
 */

// US Letter, portrait — react-pdf uses points like pdf-lib.
export const PAGE = { width: 612, height: 792 } as const;
export const MARGIN = 56;

// Ink scale + brand accents (mirror constants.ts rgb() triples).
export const C = {
  ink: '#171612',        // ink-900
  inkHigh: '#3b3830',    // ink-800
  inkMid: '#6b665c',     // ink-500
  inkSoft: '#a8a396',    // ink-400
  inkLine: '#e8e6e0',    // ink-100
  inkLine2: '#d1cfc7',   // ink-200
  bgSoft: '#f7f6f5',     // ink-50
  accent: '#c76b29',     // brand-500
  brand700: '#7d3e1c',   // brand-700
  brand300: '#e8a76d',   // brand-300
  emerald700: '#056b45',
  // Group-zone tints (page-break-safe container bands).
  bgGroupSet: '#f4f2f0',
  bandGroupSet: '#e9e7e2',
  brand50: '#fbf4ec',
  bandGroupAlt: '#f9ecdf',
  // Grand-total band.
  bandInk: '#12110e',
  bandCream: '#d1c9b8',
  white: '#ffffff',
} as const;

// Type scale — same ~6 roles as constants.ts.
export const FS = {
  display: 22,
  number: 15,
  totalBig: 24,
  title: 13,
  eyebrow: 11,
  body: 9.5,
  meta: 8.5,
  eyebrowSm: 8,
} as const;

/**
 * Register the Alcover brand faces with react-pdf, mirroring the web (one job
 * each): Lausanne = body/UI, Söhne = headers, Rauschen B = the wordmark. `base`
 * is where the files live — the web path `/fonts` in the browser, or an absolute
 * filesystem path when rendering in Node (verification script). react-pdf
 * embeds via fontkit, which reads .ttf (Lausanne) and .otf (Söhne/Rauschen)
 * alike. Idempotent — re-registering a family just overwrites.
 *
 * Lausanne carries the real weight range (400–700) + an italic; Söhne and
 * Rauschen each ship ONE weight, registered without a fontWeight so every
 * weight request resolves to that single cut (no synthesis, no fallback).
 */
export function registerBrandFonts(base = '/fonts'): void {
  Font.register({
    family: 'Lausanne',
    fonts: [
      { src: `${base}/Lausanne-400.ttf`, fontWeight: 'normal' },
      { src: `${base}/Lausanne-400Italic.ttf`, fontStyle: 'italic' },
      { src: `${base}/Lausanne-500.ttf`, fontWeight: 'medium' },
      { src: `${base}/Lausanne-600.ttf`, fontWeight: 'semibold' },
      { src: `${base}/Lausanne-700.ttf`, fontWeight: 'bold' },
    ],
  });
  Font.register({ family: 'Sohne', fonts: [{ src: `${base}/Sohne-Halbfett.otf` }] });
  Font.register({ family: 'Rauschen B', fonts: [{ src: `${base}/RauschenB-Semibold.otf` }] });
  // The app never hyphenates product names mid-line; neither should the
  // PDF. Returning the word whole disables react-pdf's default hyphenation.
  Font.registerHyphenationCallback((word) => [word]);
}

export const s = StyleSheet.create({
  page: {
    fontFamily: 'Lausanne', // body / UI face
    fontSize: FS.body,
    color: C.ink,
    paddingTop: MARGIN,
    paddingBottom: 64, // room for the fixed footer
    paddingHorizontal: MARGIN,
  },

  // ---- Header ----
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  // The company wordmark — Rauschen B (the logo face), shown when no logo image.
  company: { fontFamily: 'Rauschen B', fontSize: FS.display, color: C.ink },
  companyMeta: { fontSize: 9, color: C.inkMid, marginTop: 2 },
  headerRight: { alignItems: 'flex-end' },
  eyebrow: { fontFamily: 'Sohne', fontSize: FS.eyebrowSm, color: C.inkMid, letterSpacing: 1.4, textTransform: 'uppercase' },
  quoteNumber: { fontSize: FS.number, fontWeight: 'bold', color: C.ink, marginTop: 6 },
  quoteDate: { fontSize: 10, color: C.inkMid, marginTop: 4 },
  rule: { borderBottomWidth: 0.5, borderBottomColor: C.inkLine, marginTop: 12, marginBottom: 18 },

  // ---- Customer block ----
  blockRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  custName: { fontSize: FS.number, fontWeight: 'bold', color: C.ink, marginTop: 6 },
  custCompany: { fontSize: 10, color: C.inkHigh, marginTop: 2 },
  custMeta: { fontSize: 9, color: C.inkMid, marginTop: 2 },
  rightEntry: { alignItems: 'flex-end', marginBottom: 8 },
  rightName: { fontSize: 11, fontWeight: 'bold', color: C.ink, marginTop: 2 },
  rightSub: { fontSize: 9, color: C.inkMid, marginTop: 1 },

  // ---- Section header ----
  section: { marginTop: 14 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 8 },
  sectionLabel: { fontFamily: 'Sohne', fontSize: FS.eyebrow, color: C.brand700, letterSpacing: 1.3, textTransform: 'uppercase' },
  sectionTick: { height: 2, width: 36, backgroundColor: C.brand700, borderRadius: 1, marginTop: 5 },
  sectionSubtotal: { fontSize: FS.body, fontWeight: 'bold', color: C.inkHigh },

  // ---- Line row ----
  line: { flexDirection: 'row', gap: 14, paddingVertical: 10, borderBottomWidth: 0.5, borderBottomColor: C.inkLine },
  imgBox: {
    width: 92, height: 92, backgroundColor: C.bgSoft,
    borderWidth: 0.5, borderColor: C.inkLine2, borderRadius: 4,
    alignItems: 'center', justifyContent: 'center',
  },
  imgPlaceholder: { fontSize: 7, color: C.inkSoft, letterSpacing: 1 },
  lineBody: { flex: 1, flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  lineMain: { flex: 1 },
  familyEyebrow: { fontFamily: 'Sohne', fontSize: FS.eyebrowSm, color: C.inkMid, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 1 },
  lineName: { fontSize: FS.title, fontWeight: 'bold', color: C.ink },
  lineSub: { fontSize: FS.meta, color: C.inkMid, marginTop: 2 },
  lineRefRow: { flexDirection: 'row', gap: 8, marginTop: 1 },
  lineRef: { fontSize: 7.5, color: C.inkMid },
  lineDesc: { fontSize: 8.5, color: C.inkHigh, marginTop: 4, maxWidth: 280, lineHeight: 1.35 },
  groupCaption: { fontFamily: 'Sohne', fontSize: 7.5, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 },

  // money cell
  priceCell: { minWidth: 120, alignItems: 'flex-end' },
  priceQty: { fontSize: 9, color: C.inkMid },
  priceStrike: { fontSize: 9, color: C.inkSoft, textDecoration: 'line-through' },
  priceDisc: { fontSize: 8, fontWeight: 'bold', color: C.brand700, marginTop: 1 },
  priceTotal: { fontSize: 13, fontWeight: 'bold', color: C.ink, marginTop: 2 },
  priceNote: { fontSize: 7.5, color: C.inkMid, marginTop: 1 },

  // ---- Group zones ----
  zoneBand: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 10 },
  zoneBandLabel: { fontFamily: 'Sohne', fontSize: FS.eyebrowSm, letterSpacing: 1.2, textTransform: 'uppercase' },
  zoneMember: { paddingLeft: 8, borderLeftWidth: 2 },

  // ---- Totals ----
  totalsWrap: { marginTop: 18, marginLeft: 'auto', width: 300 },
  subRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 },
  subLabel: { fontSize: FS.body },
  band: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: C.bandInk, height: 46, paddingHorizontal: 16, marginTop: 12,
  },
  bandLabel: { fontFamily: 'Sohne', fontSize: FS.eyebrowSm, color: C.bandCream, letterSpacing: 2 },
  bandValue: { fontSize: FS.totalBig, fontWeight: 'bold', color: C.white },
  bandValueRange: { fontSize: 15, fontWeight: 'bold', color: C.white },
  flete: { fontSize: FS.meta, fontWeight: 'bold', color: C.emerald700, textAlign: 'right', textTransform: 'uppercase', marginTop: 10, letterSpacing: 0.5 },
  savings: { fontSize: FS.body, fontWeight: 'bold', color: C.brand700, textAlign: 'right', marginTop: 6 },
  fx: { fontSize: FS.meta, color: C.inkMid, textAlign: 'right', marginTop: 6 },

  // ---- Terms ----
  termsHead: { fontFamily: 'Sohne', fontSize: 7.5, color: C.inkMid, letterSpacing: 1.4, textTransform: 'uppercase', marginTop: 18, marginBottom: 6 },
  termsBody: { fontSize: 9, color: C.inkHigh, lineHeight: 1.4 },

  // ---- Footer (fixed, every page) ----
  footer: {
    position: 'absolute', bottom: 28, left: MARGIN, right: MARGIN,
    flexDirection: 'row', justifyContent: 'space-between',
    borderTopWidth: 0.4, borderTopColor: C.inkLine, paddingTop: 6,
  },
  footerText: { fontSize: 8, color: C.inkMid },
});
