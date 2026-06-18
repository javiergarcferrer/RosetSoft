import { Document, Page, View, Text, Image, StyleSheet } from '@react-pdf/renderer';
import { C, FS, fs, PAGE, MARGIN } from '../react/theme.js';
import { formatMoney } from '../../lib/format.js';

export interface ContractInstallment {
  n: number;
  dueAt: number;
  amount: number;
  capital: number;
  interest: number;
  balanceAfter: number;
}

export interface ContractDocumentProps {
  emisor: { name: string; rnc?: string; address?: string; phone?: string; email?: string };
  customer: { name?: string; company?: string; address?: string; doc?: string } | null;
  plan: {
    number?: number | null;
    totalUsd: number;
    downPaymentPct: number;
    downPaymentUsd: number;
    financedUsd: number;
    monthlyRatePct: number;
    installmentCount: number;
    monthlyUsd: number;
    totalInterestUsd: number;
    grandTotalToPayUsd: number;
    installments: ContractInstallment[];
  };
  contractBody?: string;
  /** DOP-per-USD so each figure shows a RD$ twin under the USD. */
  rates?: { USD: number; DOP: number };
  /** Signed state — when present, the signature block is stamped. `src` is a
   *  data URL (browser signing) or a public image URL (dealer re-render). */
  signature?: { name?: string; doc?: string; signedAt?: number; src?: string } | null;
}

const st = StyleSheet.create({
  page: { fontFamily: 'Lausanne', fontSize: FS.body, color: C.ink, padding: MARGIN },
  company: { fontFamily: 'Rauschen B', fontSize: fs(18), color: C.ink },
  meta: { fontSize: fs(8.5), color: C.inkMid, marginTop: 2 },
  title: { fontFamily: 'Sohne', fontSize: fs(12), color: C.brand700, letterSpacing: 1, textTransform: 'uppercase', marginTop: 16 },
  rule: { borderBottomWidth: 0.5, borderBottomColor: C.inkLine, marginTop: 10, marginBottom: 14 },

  twoCol: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  eyebrow: { fontFamily: 'Sohne', fontSize: fs(7.5), color: C.inkMid, letterSpacing: 0.8, textTransform: 'uppercase' },
  party: { fontSize: fs(11), fontWeight: 'bold', marginTop: 3 },
  partyMeta: { fontSize: fs(9), color: C.inkMid, marginTop: 1 },

  body: { fontSize: fs(9.5), color: C.inkHigh, lineHeight: 1.5, marginTop: 14 },

  // Summary grid.
  summary: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 14, borderWidth: 0.5, borderColor: C.inkLine, borderRadius: 4 },
  sCell: { width: '33.33%', padding: 8 },
  sLabel: { fontFamily: 'Sohne', fontSize: fs(7), color: C.inkMid, letterSpacing: 0.6, textTransform: 'uppercase' },
  sVal: { fontSize: fs(11), fontWeight: 'bold', color: C.ink, marginTop: 2 },
  sSub: { fontSize: fs(8), color: C.inkMid, marginTop: 1 },

  // Schedule table.
  th: { flexDirection: 'row', backgroundColor: C.bgSoft, paddingVertical: 5, paddingHorizontal: 6, marginTop: 18 },
  thCell: { fontFamily: 'Sohne', fontSize: fs(7), color: C.inkMid, letterSpacing: 0.5, textTransform: 'uppercase' },
  tr: { flexDirection: 'row', paddingVertical: 4, paddingHorizontal: 6, borderBottomWidth: 0.5, borderBottomColor: C.inkLine },
  cN: { width: 28 }, cDate: { width: 78 },
  cNum: { flex: 1, textAlign: 'right' },
  cell: { fontSize: fs(9) },

  band: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: C.bandInk, height: 36, paddingHorizontal: 12, marginTop: 10 },
  bandLabel: { fontFamily: 'Sohne', fontSize: fs(8), color: C.bandCream, letterSpacing: 1.5 },
  bandVal: { fontSize: fs(13), fontWeight: 'bold', color: C.white },

  // Signature block.
  signWrap: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 40 },
  signBox: { width: '45%' },
  signLine: { borderTopWidth: 0.8, borderTopColor: C.ink, marginTop: 44, paddingTop: 4 },
  signImg: { height: 44, marginBottom: -4, objectFit: 'contain' },
  signName: { fontSize: fs(9), fontWeight: 'bold', color: C.ink },
  signMeta: { fontSize: fs(8), color: C.inkMid, marginTop: 1 },
});

const usd = (v: number) => formatMoney(v, 'USD');
const dop = (v: number, rates?: { DOP: number }) => (rates?.DOP ? formatMoney(v, 'DOP', { DOP: rates.DOP }) : '');
const d = (ms: number) => {
  if (!ms) return '';
  const x = new Date(ms);
  return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`;
};

export function ContractDocument({ emisor, customer, plan, contractBody, rates, signature }: ContractDocumentProps) {
  const title = `Contrato de venta a plazos${plan.number ? ` Nº ${plan.number}` : ''}`;
  return (
    <Document title={`${title}${customer?.name ? ` — ${customer.name}` : ''}`}>
      <Page size={[PAGE.width, PAGE.height]} style={st.page} wrap>
        <Text style={st.company}>{emisor.name || 'Empresa'}</Text>
        {emisor.rnc ? <Text style={st.meta}>RNC {emisor.rnc}</Text> : null}
        {emisor.address ? <Text style={st.meta}>{emisor.address}</Text> : null}

        <Text style={st.title}>{title}</Text>
        <View style={st.rule} />

        <View style={st.twoCol}>
          <View>
            <Text style={st.eyebrow}>Cliente</Text>
            <Text style={st.party}>{customer?.name || '—'}</Text>
            {customer?.company ? <Text style={st.partyMeta}>{customer.company}</Text> : null}
            {customer?.doc ? <Text style={st.partyMeta}>RNC/Cédula: {customer.doc}</Text> : null}
            {customer?.address ? <Text style={st.partyMeta}>{customer.address}</Text> : null}
          </View>
        </View>

        {contractBody ? <Text style={st.body}>{contractBody}</Text> : null}

        {/* Financial summary */}
        <View style={st.summary}>
          <View style={st.sCell}>
            <Text style={st.sLabel}>Total</Text>
            <Text style={st.sVal}>{usd(plan.totalUsd)}</Text>
            <Text style={st.sSub}>{dop(plan.totalUsd, rates)}</Text>
          </View>
          <View style={st.sCell}>
            <Text style={st.sLabel}>Inicial ({plan.downPaymentPct}%)</Text>
            <Text style={st.sVal}>{usd(plan.downPaymentUsd)}</Text>
            <Text style={st.sSub}>{dop(plan.downPaymentUsd, rates)}</Text>
          </View>
          <View style={st.sCell}>
            <Text style={st.sLabel}>A financiar</Text>
            <Text style={st.sVal}>{usd(plan.financedUsd)}</Text>
            <Text style={st.sSub}>{dop(plan.financedUsd, rates)}</Text>
          </View>
          <View style={st.sCell}>
            <Text style={st.sLabel}>Tasa mensual</Text>
            <Text style={st.sVal}>{plan.monthlyRatePct}%</Text>
          </View>
          <View style={st.sCell}>
            <Text style={st.sLabel}>Cuotas</Text>
            <Text style={st.sVal}>{plan.installmentCount} × {usd(plan.monthlyUsd)}</Text>
            <Text style={st.sSub}>{dop(plan.monthlyUsd, rates)}/mes</Text>
          </View>
          <View style={st.sCell}>
            <Text style={st.sLabel}>Interés total</Text>
            <Text style={st.sVal}>{usd(plan.totalInterestUsd)}</Text>
          </View>
        </View>

        {/* Schedule */}
        <View style={st.th}>
          <Text style={[st.thCell, st.cN]}>#</Text>
          <Text style={[st.thCell, st.cDate]}>Vencimiento</Text>
          <Text style={[st.thCell, st.cNum]}>Capital</Text>
          <Text style={[st.thCell, st.cNum]}>Interés</Text>
          <Text style={[st.thCell, st.cNum]}>Cuota</Text>
          <Text style={[st.thCell, st.cNum]}>Balance</Text>
        </View>
        {plan.installments.map((r) => (
          <View key={r.n} style={st.tr} wrap={false}>
            <Text style={[st.cell, st.cN]}>{r.n}</Text>
            <Text style={[st.cell, st.cDate]}>{d(r.dueAt)}</Text>
            <Text style={[st.cell, st.cNum]}>{usd(r.capital)}</Text>
            <Text style={[st.cell, st.cNum]}>{usd(r.interest)}</Text>
            <Text style={[st.cell, st.cNum]}>{usd(r.amount)}</Text>
            <Text style={[st.cell, st.cNum]}>{usd(r.balanceAfter)}</Text>
          </View>
        ))}

        <View style={st.band}>
          <Text style={st.bandLabel}>TOTAL A PAGAR</Text>
          <Text style={st.bandVal}>{usd(plan.grandTotalToPayUsd)}</Text>
        </View>

        {/* Signatures */}
        <View style={st.signWrap} wrap={false}>
          <View style={st.signBox}>
            <Text style={st.eyebrow}>Por la empresa</Text>
            <View style={st.signLine}>
              <Text style={st.signName}>{emisor.name}</Text>
              {emisor.rnc ? <Text style={st.signMeta}>RNC {emisor.rnc}</Text> : null}
            </View>
          </View>
          <View style={st.signBox}>
            <Text style={st.eyebrow}>El cliente</Text>
            {signature?.src ? <Image style={st.signImg} src={signature.src} /> : null}
            <View style={st.signLine}>
              <Text style={st.signName}>{signature?.name || customer?.name || ''}</Text>
              {signature?.doc ? <Text style={st.signMeta}>Cédula/RNC: {signature.doc}</Text> : null}
              {signature?.signedAt ? <Text style={st.signMeta}>Firmado el {d(signature.signedAt)}</Text> : null}
            </View>
          </View>
        </View>
      </Page>
    </Document>
  );
}
