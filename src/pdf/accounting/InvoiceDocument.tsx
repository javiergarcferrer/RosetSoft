import { Document, Page, View, Text, Image, StyleSheet } from '@react-pdf/renderer';
import { C, FS, fs, PAGE, MARGIN } from '../react/theme.js';
import { formatDop } from '../../lib/format.js';
import { ecfTypeLabel } from '../../lib/accounting/ecf.js';

export interface InvoiceItem { name: string; qty: number; unitPrice: number; amount: number; }
export interface InvoicePayment { date?: number | null; method: string; reference?: string; amount: number; }
export interface InvoiceDocumentProps {
  emisor: { name: string; rnc?: string; address?: string; phone?: string; email?: string };
  comprador?: { name?: string; rnc?: string } | null;
  ecfType: string;
  eNcf: string;
  /** Header label override: an e-CF type label, or a plain "Factura de venta". */
  docLabel?: string;
  fechaEmision: number;
  items: InvoiceItem[];
  gravado: number;
  itbis: number;
  total: number;
  itbisRate?: number;
  /** Payment activity (deposit + cobros), dated; renders a "Pagos registrados" block. */
  payments?: InvoicePayment[];
  amountPaid?: number;
  balanceDue?: number;
  securityCode?: string;
  /** Signature timestamp (dd-mm-yyyy HH:mm:ss) — a DGII-required visible element
   *  of the timbre, printed under the código de seguridad. */
  fechaFirma?: string;
  /** PNG data URL of the e-CF QR (built in generate.tsx). */
  qrDataUrl?: string;
  logoDataUrl?: string;
}

const dmy = (ms?: number | null) => {
  if (ms == null) return '';
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
};

const st = StyleSheet.create({
  page: { fontFamily: 'Lausanne', fontSize: FS.body, color: C.ink, padding: MARGIN },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  company: { fontFamily: 'Rauschen B', fontSize: fs(19), color: C.ink },
  meta: { fontSize: fs(8.5), color: C.inkMid, marginTop: 2 },
  docBox: { alignItems: 'flex-end' },
  docType: { fontFamily: 'Sohne', fontSize: fs(8), color: C.brand700, letterSpacing: 1, textTransform: 'uppercase', maxWidth: 200, textAlign: 'right' },
  encf: { fontSize: fs(13), fontWeight: 'bold', marginTop: 4 },
  date: { fontSize: fs(9), color: C.inkMid, marginTop: 2 },
  rule: { borderBottomWidth: 0.5, borderBottomColor: C.inkLine, marginTop: 12, marginBottom: 14 },
  blockLabel: { fontFamily: 'Sohne', fontSize: fs(7.5), color: C.inkMid, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 3 },
  buyerName: { fontSize: fs(12), fontWeight: 'bold' },
  buyerMeta: { fontSize: fs(9), color: C.inkMid, marginTop: 1 },
  th: { flexDirection: 'row', backgroundColor: C.bgSoft, paddingVertical: 5, paddingHorizontal: 6, marginTop: 14 },
  thCell: { fontFamily: 'Sohne', fontSize: fs(7.5), color: C.inkMid, letterSpacing: 0.6, textTransform: 'uppercase' },
  tr: { flexDirection: 'row', paddingVertical: 5, paddingHorizontal: 6, borderBottomWidth: 0.5, borderBottomColor: C.inkLine },
  cDesc: { flex: 1 },
  cQty: { width: 50, textAlign: 'right' },
  cPrice: { width: 90, textAlign: 'right' },
  cAmount: { width: 100, textAlign: 'right' },
  cell: { fontSize: fs(9) },
  totalsWrap: { marginTop: 14, marginLeft: 'auto', width: 240 },
  totRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 },
  totLabel: { fontSize: fs(9.5), color: C.inkMid },
  totVal: { fontSize: fs(9.5) },
  payWrap: { marginTop: 18 },
  payRow: { flexDirection: 'row', paddingVertical: 3.5, borderBottomWidth: 0.5, borderBottomColor: C.inkLine },
  pDate: { width: 80, fontSize: fs(8.5), color: C.inkMid },
  pMethod: { flex: 1, fontSize: fs(8.5) },
  pAmount: { width: 100, textAlign: 'right', fontSize: fs(8.5) },
  payTot: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 },
  payTotLabel: { fontSize: fs(9.5), color: C.inkMid },
  payTotVal: { fontSize: fs(9.5), fontWeight: 'bold' },
  balVal: { fontSize: fs(9.5), fontWeight: 'bold', color: C.brand700 },
  band: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: C.bandInk, height: 38, paddingHorizontal: 12, marginTop: 8 },
  bandLabel: { fontFamily: 'Sohne', fontSize: fs(8), color: C.bandCream, letterSpacing: 1.5 },
  bandVal: { fontSize: fs(15), fontWeight: 'bold', color: C.white },
  qrRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 22 },
  qr: { width: 96, height: 96 },
  qrText: { fontSize: fs(8), color: C.inkMid, maxWidth: 320, lineHeight: 1.4 },
  code: { fontSize: fs(9), fontWeight: 'bold', color: C.ink, marginTop: 3 },
  stamp: { fontSize: fs(8), color: C.inkMid, marginTop: 2 },
  footer: { position: 'absolute', bottom: 28, left: MARGIN, right: MARGIN, borderTopWidth: 0.4, borderTopColor: C.inkLine, paddingTop: 6 },
  footerText: { fontSize: fs(8), color: C.inkMid, textAlign: 'center' },
});

const money = (v: number) => formatDop(v);

export function InvoiceDocument(props: InvoiceDocumentProps) {
  const { emisor, comprador, ecfType, eNcf, items, gravado, itbis, total, itbisRate = 18, securityCode, fechaFirma, qrDataUrl } = props;
  const payments = props.payments || [];
  const amountPaid = props.amountPaid ?? 0;
  const balanceDue = props.balanceDue ?? 0;
  const docLabel = props.docLabel || `${ecfTypeLabel(ecfType)} (e-CF ${ecfType})`;
  const date = new Date(props.fechaEmision);
  const dateStr = `${String(date.getDate()).padStart(2, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${date.getFullYear()}`;

  return (
    <Document title={`Factura ${eNcf || comprador?.name || ''}`.trim()}>
      <Page size={[PAGE.width, PAGE.height]} style={st.page}>
        <View style={st.headerRow}>
          <View>
            {props.logoDataUrl ? <Image src={props.logoDataUrl} style={{ height: 28, marginBottom: 4 }} /> : <Text style={st.company}>{emisor.name || 'Empresa'}</Text>}
            {emisor.rnc ? <Text style={st.meta}>RNC {emisor.rnc}</Text> : null}
            {emisor.address ? <Text style={st.meta}>{emisor.address}</Text> : null}
            {(emisor.phone || emisor.email) ? <Text style={st.meta}>{[emisor.phone, emisor.email].filter(Boolean).join(' · ')}</Text> : null}
          </View>
          <View style={st.docBox}>
            <Text style={st.docType}>{docLabel}</Text>
            {eNcf ? <Text style={st.encf}>{eNcf}</Text> : null}
            <Text style={st.date}>Fecha: {dateStr}</Text>
          </View>
        </View>
        <View style={st.rule} />

        <View>
          <Text style={st.blockLabel}>Cliente</Text>
          <Text style={st.buyerName}>{comprador?.name || 'Consumidor final'}</Text>
          {comprador?.rnc ? <Text style={st.buyerMeta}>RNC/Cédula: {comprador.rnc}</Text> : null}
        </View>

        <View style={st.th}>
          <Text style={[st.thCell, st.cDesc]}>Descripción</Text>
          <Text style={[st.thCell, st.cQty]}>Cant.</Text>
          <Text style={[st.thCell, st.cPrice]}>Precio</Text>
          <Text style={[st.thCell, st.cAmount]}>Importe</Text>
        </View>
        {items.map((it, i) => (
          <View key={i} style={st.tr}>
            <Text style={[st.cell, st.cDesc]}>{it.name}</Text>
            <Text style={[st.cell, st.cQty]}>{it.qty}</Text>
            <Text style={[st.cell, st.cPrice]}>{money(it.unitPrice)}</Text>
            <Text style={[st.cell, st.cAmount]}>{money(it.amount)}</Text>
          </View>
        ))}

        <View style={st.totalsWrap}>
          <View style={st.totRow}><Text style={st.totLabel}>Subtotal gravado</Text><Text style={st.totVal}>{money(gravado)}</Text></View>
          <View style={st.totRow}><Text style={st.totLabel}>ITBIS ({itbisRate}%)</Text><Text style={st.totVal}>{money(itbis)}</Text></View>
          <View style={st.band}>
            <Text style={st.bandLabel}>TOTAL</Text>
            <Text style={st.bandVal}>{money(total)}</Text>
          </View>
        </View>

        {payments.length ? (
          <View style={st.payWrap}>
            <Text style={st.blockLabel}>Pagos registrados</Text>
            {payments.map((pay, i) => (
              <View key={i} style={st.payRow}>
                <Text style={st.pDate}>{dmy(pay.date)}</Text>
                <Text style={st.pMethod}>{[pay.method, pay.reference].filter(Boolean).join(' · ')}</Text>
                <Text style={st.pAmount}>{money(pay.amount)}</Text>
              </View>
            ))}
            <View style={st.payTot}><Text style={st.payTotLabel}>Pagado</Text><Text style={st.payTotVal}>{money(amountPaid)}</Text></View>
            <View style={st.payTot}><Text style={st.payTotLabel}>Balance pendiente</Text><Text style={st.balVal}>{money(balanceDue)}</Text></View>
          </View>
        ) : null}

        {qrDataUrl ? (
          <View style={st.qrRow}>
            <Image src={qrDataUrl} style={st.qr} />
            <View>
              <Text style={st.qrText}>Representación Impresa de un Comprobante Fiscal Electrónico (e-CF). Verifique su validez escaneando el código QR o en la Oficina Virtual de la DGII.</Text>
              {securityCode ? <Text style={st.code}>Código de seguridad: {securityCode}</Text> : null}
              {fechaFirma ? <Text style={st.stamp}>Fecha de firma: {fechaFirma}</Text> : null}
            </View>
          </View>
        ) : null}

        <View style={st.footer} fixed>
          <Text style={st.footerText}>{emisor.name}{emisor.rnc ? ` · RNC ${emisor.rnc}` : ''} · {eNcf}</Text>
        </View>
      </Page>
    </Document>
  );
}
