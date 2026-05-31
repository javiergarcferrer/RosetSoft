/**
 * Node verification harness for the react-pdf quote renderer. Renders a
 * representative quote — normal, discounted, optional, compound, pick-one
 * alternative, take-all set, a material-options grid, and a material-less
 * range line — to ./sample-quote.pdf so the output can be eyeballed without
 * a browser. Images are injected from a local PNG (the real app resolves them
 * from Supabase via images.ts, which needs a browser). Not shipped; a dev tool.
 *
 *   node --import tsx scripts/sample-pdf.tsx
 */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react'; // this script is outside tsconfig's include → classic JSX
import ReactPDF from '@react-pdf/renderer';
import { QuoteDocument } from '../src/pdf/react/QuoteDocument.js';
import { registerInterFonts } from '../src/pdf/react/theme.js';
import { coverKey, swatchKey } from '../src/pdf/react/imageKeys.js';
import type { ImageMap } from '../src/pdf/react/imageKeys.js';
import { computeTotals, lineForTotals } from '../src/lib/pricing.js';
import { isPricedLine } from '../src/lib/constants.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
registerInterFonts(path.join(root, 'public/fonts'));

// A real PNG stands in for product photos / logo / swatch so image layout is
// verifiable in Node (production resolves these from Supabase in the browser).
const png = `data:image/png;base64,${readFileSync(path.join(root, 'public/icon-512.png')).toString('base64')}`;

const now = Date.now();
const sec = (name: string) => ({ id: `s-${name}`, kind: 'section', name });
const item = (o: Record<string, unknown>) => ({ kind: 'item', qty: 1, ...o });

const lines: any[] = [
  sec('Mobiliario de sala'),
  item({
    id: 'l1', name: 'Sofá modular KOBOLD', family: 'KOBOLD',
    subtype: 'Cuero Nappa Cognac', reference: 'KBD-3S', dimensions: '240 × 95 cm',
    unitPrice: 4200, lineDiscountPct: 12, swatchImageId: 'sw-kobold',
    materialOptions: {
      baseGrade: 'M1', baseLabel: 'Cuero Nappa Cognac',
      options: [
        { grade: 'M2', label: 'Cuero Nappa Negro', code: 'NERO' },
        { grade: 'M3', label: 'Tela Lana Gris', code: 'GRIGIO' },
      ],
    },
    description: 'Sofá de tres plazas con chaise longue reversible. Estructura de haya maciza, espuma HR de alta densidad.',
  }),
  item({ id: 'l2', name: 'Mesa de centro EXEDRA', family: 'EXEDRA', reference: 'EXD-CT', unitPrice: 1850, subtype: 'Roble · Natural (#137)', swatchImageId: 'sw-exedra' }),
  item({
    id: 'l3', name: 'Puff PUMPKIN', family: 'PUMPKIN', reference: 'PMP-1', qty: 2,
    unitPrice: 600, isOptional: true, description: 'Complemento opcional, no incluido en el total.',
  }),

  sec('Comedor'),
  item({
    id: 'l4', kind: 'compound', name: 'Comedor PLOUM (compuesto)', family: 'PLOUM',
    components: [
      { id: 'c1', name: 'Tablero roble natural', reference: 'PLM-TOP', unitPrice: 1400, qty: 1 },
      { id: 'c2', name: 'Base de acero lacado', reference: 'PLM-BASE', unitPrice: 900, qty: 1 },
    ],
  }),
  item({ id: 'l5', name: 'Silla TOGO (cuero)', family: 'TOGO', reference: 'TGO-L', qty: 6, unitPrice: 320, alternativeGroup: 'alt1', isSelectedAlternative: true }),
  item({ id: 'l6', name: 'Silla TOGO (tela)', family: 'TOGO', reference: 'TGO-F', qty: 6, unitPrice: 280, alternativeGroup: 'alt1', isSelectedAlternative: false }),
  item({ id: 'l7', name: 'Aparador NABUCCO', family: 'NABUCCO', reference: 'NBC-AP', unitPrice: 2100, setGroup: 'set1' }),
  item({ id: 'l8', name: 'Vitrina NABUCCO', family: 'NABUCCO', reference: 'NBC-VT', unitPrice: 2400, setGroup: 'set1' }),
  item({ id: 'l9', name: 'Lámpara de pie (material por definir)', family: 'LUMEN', reference: 'LMN-FL', priceMin: 800, priceMax: 1200 }),
];

const images: ImageMap = new Map([
  ['logo', png],
  ['rateLogo', png],
  [swatchKey({ imageId: 'sw-kobold' })!, png],
  [swatchKey({ imageId: 'sw-exedra' })!, png],
  ...lines.filter((l) => l.kind !== 'section').map((l) => [coverKey(l.id), png] as [string, string]),
]);

const quote: any = {
  id: 'q1', number: 1042, currencyCode: 'USD', discountPct: 5, shipping: 350, marginPct: 0,
  createdAt: now, updatedAt: now, acceptedAt: now, rates: { USD: 1, DOP: 59.07 },
  terms: 'Precios en USD; el equivalente en RD$ es referencial al tipo de cambio indicado. Cotización válida por 15 días. 50% de anticipo para iniciar el pedido; saldo contra entrega. Tiempo estimado de entrega: 10–14 semanas.',
};
const customer: any = {
  name: 'Eduardo García', company: 'Estudio Norte', address: 'Av. Anacaona 12, Torre A, Apt. 1502',
  city: 'Santo Domingo', state: 'D.N.', country: 'República Dominicana',
  email: 'eduardo@estudionorte.do', phone: '809-555-0142',
};
const seller: any = { name: 'María Reyes' };
const professional: any = { name: 'Arq. Luis Peña', company: 'Peña Arquitectura' };
const settings: any = {
  companyName: 'ALCOVER', companyAddress: 'Av. Roberto Pastoriza 305, Santo Domingo',
  companyPhone: '+1 809 555 0100', companyEmail: 'hola@alcover.do',
};
const quoteGroups: any[] = [
  { id: 'alt1', kind: 'alternative', isOptional: false },
  { id: 'set1', kind: 'set', isOptional: false },
];

const totals = computeTotals(lines.filter(isPricedLine).map(lineForTotals), quote);

const out = path.join(root, 'sample-quote.pdf');
await ReactPDF.renderToFile(
  <QuoteDocument
    quote={quote} settings={settings} lines={lines} totals={totals}
    customer={customer} professional={professional} seller={seller}
    quoteGroups={quoteGroups} families={null} images={images}
  />,
  out,
);
console.log('wrote', out);
