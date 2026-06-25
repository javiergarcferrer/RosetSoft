import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import { C, FS, fs, PAGE, MARGIN } from '../react/theme.js';

/**
 * Registro de pedido — the simple list the dealer uses to REGISTER an order
 * with Ligne Roset. Reference · product · quantity, grouped per quote with
 * its customer / decorator / seller. Deliberately price-free: this is a
 * purchasing document, not an invoice (no totals, no taxes, no terms).
 * Content comes pre-resolved from core/quote/views/registration.
 */

export interface RegistrationRow {
  reference: string;
  name: string;
  detail: string;
  qty: number;
}

export interface RegistrationGroup {
  quoteId: string;
  quoteNumber: number | null;
  customerName: string;
  professionalName: string | null;
  professionalTradeNumber?: string | null;
  sellerName: string | null;
  rows: RegistrationRow[];
  pieces: number;
}

export interface RegistrationDocumentProps {
  companyName: string;
  orderNumber: number | null;
  orderName: string;
  groups: RegistrationGroup[];
  totalPieces: number;
  generatedAt?: number;
}

const st = StyleSheet.create({
  page: { fontFamily: 'Lausanne', fontSize: FS.body, color: C.ink, padding: MARGIN },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  company: { fontFamily: 'Rauschen B', fontSize: fs(18), color: C.ink },
  headerRight: { alignItems: 'flex-end' },
  eyebrow: { fontFamily: 'Sohne', fontSize: FS.eyebrowSm, color: C.brand700, letterSpacing: 1.4, textTransform: 'uppercase' },
  orderNo: { fontSize: FS.number, fontWeight: 'bold', marginTop: 4 },
  meta: { fontSize: fs(8.5), color: C.inkMid, marginTop: 2 },
  note: { fontSize: fs(8.5), color: C.inkMid, marginTop: 6 },
  rule: { borderBottomWidth: 0.5, borderBottomColor: C.inkLine, marginTop: 12 },

  group: { marginTop: 16 },
  groupHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 6 },
  groupTitle: { fontSize: fs(11), fontWeight: 'bold', color: C.ink },
  groupMeta: { fontSize: fs(8.5), color: C.inkMid, marginTop: 2 },
  groupPieces: { fontSize: fs(9), color: C.inkHigh, fontWeight: 'bold' },

  th: { flexDirection: 'row', backgroundColor: C.bgSoft, paddingVertical: 5, paddingHorizontal: 6, marginTop: 8 },
  thCell: { fontFamily: 'Sohne', fontSize: fs(7.5), color: C.inkMid, letterSpacing: 0.6, textTransform: 'uppercase' },
  tr: { flexDirection: 'row', paddingVertical: 5, paddingHorizontal: 6, borderBottomWidth: 0.5, borderBottomColor: C.inkLine },
  cRef: { width: 110 },
  cProd: { flex: 1, paddingRight: 8 },
  cQty: { width: 50, textAlign: 'right' },
  cell: { fontSize: fs(9) },
  refCell: { fontSize: fs(8.5) },
  prodName: { fontSize: fs(9), fontWeight: 'medium' },
  prodDetail: { fontSize: fs(7.5), color: C.inkMid, marginTop: 1 },

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

export function RegistrationDocument({
  companyName, orderNumber, orderName, groups, totalPieces, generatedAt = Date.now(),
}: RegistrationDocumentProps) {
  return (
    <Document title={`Registro de pedido ${orderNumber ? `#${orderNumber}` : ''}`.trim()}>
      <Page size={[PAGE.width, PAGE.height]} style={st.page}>
        <View style={st.headerRow}>
          <View>
            <Text style={st.company}>{companyName || 'Empresa'}</Text>
            <Text style={st.note}>
              Documento de registro de pedido para Ligne Roset — no es una factura.
            </Text>
          </View>
          <View style={st.headerRight}>
            <Text style={st.eyebrow}>Registro de pedido</Text>
            <Text style={st.orderNo}>Pedido {orderNumber ? `#${orderNumber}` : '—'}</Text>
            {orderName ? <Text style={st.meta}>{orderName}</Text> : null}
            <Text style={st.meta}>{d(generatedAt)}</Text>
          </View>
        </View>
        <View style={st.rule} />

        {groups.map((g) => (
          <View key={g.quoteId} style={st.group}>
            <View style={st.groupHead} wrap={false}>
              <View>
                <Text style={st.groupTitle}>
                  Cotización {g.quoteNumber ? `#${g.quoteNumber}` : '—'}
                  {g.customerName ? ` · ${g.customerName}` : ''}
                </Text>
                {(g.professionalName || g.professionalTradeNumber || g.sellerName) ? (
                  <Text style={st.groupMeta}>
                    {[
                      g.professionalName ? `Decorador: ${g.professionalName}` : null,
                      g.professionalTradeNumber ? `Comercio LR: ${g.professionalTradeNumber}` : null,
                      g.sellerName ? `Vendedor: ${g.sellerName}` : null,
                    ].filter(Boolean).join(' · ')}
                  </Text>
                ) : null}
              </View>
              <Text style={st.groupPieces}>{g.pieces} pieza{g.pieces === 1 ? '' : 's'}</Text>
            </View>

            <View style={st.th}>
              <Text style={[st.thCell, st.cRef]}>Referencia</Text>
              <Text style={[st.thCell, st.cProd]}>Producto</Text>
              <Text style={[st.thCell, st.cQty]}>Cant.</Text>
            </View>
            {g.rows.map((r, i) => (
              <View key={i} style={st.tr} wrap={false}>
                <Text style={[st.refCell, st.cRef]}>{r.reference || '—'}</Text>
                <View style={st.cProd}>
                  <Text style={st.prodName}>{r.name}</Text>
                  {r.detail ? <Text style={st.prodDetail}>{r.detail}</Text> : null}
                </View>
                <Text style={[st.cell, st.cQty]}>{r.qty}</Text>
              </View>
            ))}
          </View>
        ))}

        <View style={st.band} wrap={false}>
          <Text style={st.bandLabel}>TOTAL PIEZAS</Text>
          <Text style={st.bandVal}>{totalPieces}</Text>
        </View>
      </Page>
    </Document>
  );
}
