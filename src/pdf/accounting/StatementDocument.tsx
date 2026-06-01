import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import { C, FS, fs, PAGE, MARGIN } from '../react/theme.js';
import { formatDop } from '../../lib/format.js';

export interface StatementRow { date: number; label: string; ref?: string; charge: number; payment: number; balance: number; }
export interface StatementDocumentProps {
  emisor: { name: string; rnc?: string };
  party: { name: string; rnc?: string };
  title?: string;
  rows: StatementRow[];
  balance: number;
  asOf?: number;
}

const st = StyleSheet.create({
  page: { fontFamily: 'Lausanne', fontSize: FS.body, color: C.ink, padding: MARGIN },
  company: { fontFamily: 'Rauschen B', fontSize: fs(18), color: C.ink },
  meta: { fontSize: fs(8.5), color: C.inkMid, marginTop: 2 },
  title: { fontFamily: 'Sohne', fontSize: fs(11), color: C.brand700, letterSpacing: 1, textTransform: 'uppercase', marginTop: 14 },
  party: { fontSize: fs(12), fontWeight: 'bold', marginTop: 8 },
  partyMeta: { fontSize: fs(9), color: C.inkMid },
  th: { flexDirection: 'row', backgroundColor: C.bgSoft, paddingVertical: 5, paddingHorizontal: 6, marginTop: 12 },
  thCell: { fontFamily: 'Sohne', fontSize: fs(7.5), color: C.inkMid, letterSpacing: 0.6, textTransform: 'uppercase' },
  tr: { flexDirection: 'row', paddingVertical: 4, paddingHorizontal: 6, borderBottomWidth: 0.5, borderBottomColor: C.inkLine },
  cDate: { width: 70 }, cConcept: { flex: 1 }, cRef: { width: 90 },
  cNum: { width: 80, textAlign: 'right' },
  cell: { fontSize: fs(9) },
  band: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: C.bandInk, height: 36, paddingHorizontal: 12, marginTop: 10 },
  bandLabel: { fontFamily: 'Sohne', fontSize: fs(8), color: C.bandCream, letterSpacing: 1.5 },
  bandVal: { fontSize: fs(14), fontWeight: 'bold', color: C.white },
});

const money = (v: number) => formatDop(v);
const d = (ms: number) => {
  const x = new Date(ms);
  return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`;
};

export function StatementDocument({ emisor, party, title = 'Estado de cuenta', rows, balance, asOf }: StatementDocumentProps) {
  return (
    <Document title={`${title} ${party.name}`}>
      <Page size={[PAGE.width, PAGE.height]} style={st.page}>
        <Text style={st.company}>{emisor.name || 'Empresa'}</Text>
        {emisor.rnc ? <Text style={st.meta}>RNC {emisor.rnc}</Text> : null}
        <Text style={st.title}>{title}{asOf ? ` · al ${d(asOf)}` : ''}</Text>
        <Text style={st.party}>{party.name}</Text>
        {party.rnc ? <Text style={st.partyMeta}>RNC/Cédula: {party.rnc}</Text> : null}

        <View style={st.th}>
          <Text style={[st.thCell, st.cDate]}>Fecha</Text>
          <Text style={[st.thCell, st.cConcept]}>Concepto</Text>
          <Text style={[st.thCell, st.cRef]}>Ref.</Text>
          <Text style={[st.thCell, st.cNum]}>Cargo</Text>
          <Text style={[st.thCell, st.cNum]}>Abono</Text>
          <Text style={[st.thCell, st.cNum]}>Saldo</Text>
        </View>
        {rows.map((r, i) => (
          <View key={i} style={st.tr}>
            <Text style={[st.cell, st.cDate]}>{d(r.date)}</Text>
            <Text style={[st.cell, st.cConcept]}>{r.label}</Text>
            <Text style={[st.cell, st.cRef]}>{r.ref || ''}</Text>
            <Text style={[st.cell, st.cNum]}>{r.charge ? money(r.charge) : ''}</Text>
            <Text style={[st.cell, st.cNum]}>{r.payment ? money(r.payment) : ''}</Text>
            <Text style={[st.cell, st.cNum]}>{money(r.balance)}</Text>
          </View>
        ))}

        <View style={st.band}>
          <Text style={st.bandLabel}>BALANCE</Text>
          <Text style={st.bandVal}>{money(balance)}</Text>
        </View>
      </Page>
    </Document>
  );
}
