import { Document, Page, View, Text, Image, StyleSheet } from '@react-pdf/renderer';
import { C, FS, fs, PAGE, MARGIN } from '../react/theme.js';
import { coverKey } from '../react/imageKeys.js';
import type { ImageMap } from '../react/imageKeys.js';

/**
 * Orden de almacén — the picking list the dealer hands the WAREHOUSE to pull
 * and prepare a quote's furniture: product photo · reference · name · quantity.
 * Deliberately price-free (a fulfilment doc, not an invoice) and distinct from
 * the supplier "Registro LR": this one carries a PHOTO so the warehouse staff
 * recognise each piece. Content comes pre-resolved from
 * core/quote/views/warehouseOrder; the cover photos arrive in `images`, keyed
 * the same way the quote PDF keys them (coverKey(lineId)).
 */

export interface WarehouseOrderRow {
  reference: string;
  name: string;
  detail: string;
  qty: number;
  /** Owning line id — maps to the cover photo in `images` via coverKey(). */
  lineId: string;
}

export interface WarehouseOrderDocumentProps {
  companyName: string;
  quoteNumber: number | null;
  customerName: string;
  professionalName: string | null;
  sellerName: string | null;
  rows: WarehouseOrderRow[];
  totalPieces: number;
  images: ImageMap;
  generatedAt?: number;
}

const st = StyleSheet.create({
  page: { fontFamily: 'Lausanne', fontSize: FS.body, color: C.ink, padding: MARGIN },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  company: { fontFamily: 'Rauschen B', fontSize: fs(18), color: C.ink },
  note: { fontSize: fs(8.5), color: C.inkMid, marginTop: 6 },
  headerRight: { alignItems: 'flex-end' },
  eyebrow: { fontFamily: 'Sohne', fontSize: FS.eyebrowSm, color: C.brand700, letterSpacing: 1.4, textTransform: 'uppercase' },
  quoteNo: { fontSize: FS.number, fontWeight: 'bold', marginTop: 4 },
  meta: { fontSize: fs(8.5), color: C.inkMid, marginTop: 2 },
  rule: { borderBottomWidth: 0.5, borderBottomColor: C.inkLine, marginTop: 12 },

  ctx: { marginTop: 14 },
  ctxLine: { fontSize: fs(9), color: C.inkHigh },
  ctxMeta: { fontSize: fs(8.5), color: C.inkMid, marginTop: 2 },

  th: { flexDirection: 'row', backgroundColor: C.bgSoft, paddingVertical: 5, paddingHorizontal: 6, marginTop: 14 },
  thCell: { fontFamily: 'Sohne', fontSize: fs(7.5), color: C.inkMid, letterSpacing: 0.6, textTransform: 'uppercase' },
  tr: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 6, borderBottomWidth: 0.5, borderBottomColor: C.inkLine },

  cImg: { width: 64 },
  cRef: { width: 96 },
  cProd: { flex: 1, paddingRight: 8 },
  cQty: { width: 44, textAlign: 'right' },

  imgBox: {
    width: 54, height: 54, backgroundColor: C.bgSoft,
    borderWidth: 0.5, borderColor: C.inkLine2, borderRadius: 4,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  imgPlaceholder: { fontSize: fs(6), color: C.inkSoft, letterSpacing: 0.5 },
  refCell: { fontSize: fs(8.5) },
  prodName: { fontSize: fs(9), fontWeight: 'medium' },
  prodDetail: { fontSize: fs(7.5), color: C.inkMid, marginTop: 1 },
  qtyCell: { fontSize: fs(11), fontWeight: 'bold' },

  band: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: C.bandInk, height: 34, paddingHorizontal: 12, marginTop: 16,
  },
  bandLabel: { fontFamily: 'Sohne', fontSize: fs(8), color: C.bandCream, letterSpacing: 1.5 },
  bandVal: { fontSize: fs(13), fontWeight: 'bold', color: C.white },
});

const d = (ms: number) => {
  const x = new Date(ms);
  return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`;
};

export function WarehouseOrderDocument({
  companyName, quoteNumber, customerName, professionalName, sellerName,
  rows, totalPieces, images, generatedAt = Date.now(),
}: WarehouseOrderDocumentProps) {
  return (
    <Document title={`Orden de almacén ${quoteNumber ? `#${quoteNumber}` : ''}`.trim()}>
      <Page size={[PAGE.width, PAGE.height]} style={st.page}>
        <View style={st.headerRow}>
          <View>
            <Text style={st.company}>{companyName || 'Empresa'}</Text>
            <Text style={st.note}>
              Orden de preparación para el almacén — no es una factura.
            </Text>
          </View>
          <View style={st.headerRight}>
            <Text style={st.eyebrow}>Orden de almacén</Text>
            <Text style={st.quoteNo}>Cotización {quoteNumber ? `#${quoteNumber}` : '—'}</Text>
            <Text style={st.meta}>{d(generatedAt)}</Text>
          </View>
        </View>
        <View style={st.rule} />

        <View style={st.ctx}>
          {customerName ? <Text style={st.ctxLine}>Cliente: {customerName}</Text> : null}
          {(professionalName || sellerName) ? (
            <Text style={st.ctxMeta}>
              {[
                professionalName ? `Decorador: ${professionalName}` : null,
                sellerName ? `Vendedor: ${sellerName}` : null,
              ].filter(Boolean).join(' · ')}
            </Text>
          ) : null}
        </View>

        <View style={st.th}>
          <Text style={[st.thCell, st.cImg]}>Foto</Text>
          <Text style={[st.thCell, st.cRef]}>Referencia</Text>
          <Text style={[st.thCell, st.cProd]}>Producto</Text>
          <Text style={[st.thCell, st.cQty]}>Cant.</Text>
        </View>
        {rows.map((r, i) => {
          const cover = images.get(coverKey(r.lineId));
          return (
            <View key={i} style={st.tr} wrap={false}>
              <View style={st.cImg}>
                <View style={st.imgBox}>
                  {cover
                    ? <Image src={cover} style={{ width: 54, height: 54, objectFit: 'contain' }} />
                    : <Text style={st.imgPlaceholder}>SIN FOTO</Text>}
                </View>
              </View>
              <Text style={[st.refCell, st.cRef]}>{r.reference || '—'}</Text>
              <View style={st.cProd}>
                <Text style={st.prodName}>{r.name}</Text>
                {r.detail ? <Text style={st.prodDetail}>{r.detail}</Text> : null}
              </View>
              <Text style={[st.qtyCell, st.cQty]}>{r.qty}</Text>
            </View>
          );
        })}

        <View style={st.band} wrap={false}>
          <Text style={st.bandLabel}>TOTAL PIEZAS</Text>
          <Text style={st.bandVal}>{totalPieces}</Text>
        </View>
      </Page>
    </Document>
  );
}
