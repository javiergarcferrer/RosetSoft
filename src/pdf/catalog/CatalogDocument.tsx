import { Document, Page, View, Text, Image, Link, StyleSheet } from '@react-pdf/renderer';
import { formatMoney, formatDate } from '../../lib/format.js';
import { C, FS, fs, MARGIN } from '../react/theme.js';
import type { CatalogImageMap } from './images.js';

/**
 * The LifestyleGarden catalog PDF — the client-facing "what's on the floor"
 * book: ONLY in-stock pieces (the VM already filtered), grouped by collection,
 * two cards per row. Each card is a LINK to the product's own page on
 * lifestylegarden.do; prices are store USD (no DOP conversion — this is a
 * browsable list, not a quote); the available quantity reads plainly under
 * the price. Shapes come from core/catalog's resolveLsgCatalogBook.
 */

interface BookMember {
  id: string;
  reference?: string;
  subtype?: string;
  priceUsd?: number | null;
  stockQty?: number | null;
}

interface BookModel {
  key: string;
  name: string;
  family?: string;
  storeUrl?: string | null;
  /** Lead member's photo pointers — generate.tsx resolves them up front. */
  imageId?: string | null;
  imageSrc?: string | null;
  stockQty: number;
  priceMin: number | null;
  priceMax: number | null;
  members: BookMember[];
}

export interface CatalogBook {
  sections: Array<{ category: string; models: BookModel[] }>;
  models: number;
  skus: number;
}

export interface CatalogDocumentProps {
  book: CatalogBook;
  images?: CatalogImageMap;
  /** ms timestamp the stock was read at (the generate call's "now"). */
  generatedAt: number;
}

const usd = (n: number | null | undefined) => formatMoney(n ?? null, 'USD', { USD: 1 });

const priceLabel = (m: BookModel): string => {
  if (m.priceMin == null || m.priceMax == null) return '—';
  return m.priceMin === m.priceMax ? usd(m.priceMin) : `${usd(m.priceMin)} – ${usd(m.priceMax)}`;
};

const qtyLabel = (n: number): string => (n === 1 ? '1 disponible' : `${n} disponibles`);

// Cards keep wrap={false}; a model with a huge variant list must not outgrow
// a page, so the tail collapses into a "+N variantes más" line.
const MAX_VARIANT_ROWS = 6;

const st = StyleSheet.create({
  page: {
    fontFamily: 'Lausanne',
    fontSize: FS.body,
    color: C.ink,
    paddingTop: MARGIN,
    paddingBottom: 64,
    paddingHorizontal: MARGIN,
  },

  // ---- cover header (first page) ----
  eyebrow: { fontFamily: 'Sohne', fontSize: FS.eyebrowSm, color: C.brand700, letterSpacing: 1.4, textTransform: 'uppercase' },
  title: { fontFamily: 'Rauschen B', fontSize: FS.display, color: C.ink, marginTop: 6 },
  headMeta: { fontSize: fs(9), color: C.inkMid, marginTop: 4 },
  rule: { borderBottomWidth: 0.5, borderBottomColor: C.inkLine, marginTop: 12, marginBottom: 6 },

  // ---- collection band ----
  section: { marginTop: 14 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 8 },
  sectionLabel: { fontFamily: 'Sohne', fontSize: FS.eyebrow, color: C.brand700, letterSpacing: 1.3, textTransform: 'uppercase' },
  sectionTick: { height: 2, width: 36, backgroundColor: C.brand700, borderRadius: 1, marginTop: 5 },
  sectionCount: { fontSize: FS.meta, color: C.inkMid },

  // ---- card grid ----
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  cardSlot: { width: '48.5%', marginBottom: 12, textDecoration: 'none' },
  card: { borderWidth: 0.5, borderColor: C.inkLine2, borderRadius: 4, overflow: 'hidden', backgroundColor: C.white },
  imgBox: { width: '100%', height: 150, backgroundColor: C.bgSoft, alignItems: 'center', justifyContent: 'center' },
  img: { width: '100%', height: 150, objectFit: 'cover' },
  imgPlaceholder: { fontFamily: 'Sohne', fontSize: fs(7), color: C.inkSoft, letterSpacing: 1.4, textTransform: 'uppercase' },
  cardBody: { padding: 9 },
  familyEyebrow: { fontFamily: 'Sohne', fontSize: FS.eyebrowSm, color: C.inkMid, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 1 },
  name: { fontSize: fs(10.5), fontWeight: 'bold', color: C.ink, lineHeight: 1.25 },
  ref: { fontSize: fs(7.5), color: C.inkMid, marginTop: 2 },
  priceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 6 },
  price: { fontSize: fs(11), fontWeight: 'bold', color: C.ink },
  qty: { fontSize: fs(8), fontWeight: 'bold', color: C.emerald700, textTransform: 'uppercase', letterSpacing: 0.4 },

  // variant rows (multi-variant models)
  variants: { marginTop: 5, borderTopWidth: 0.5, borderTopColor: C.inkLine, paddingTop: 4 },
  variantRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 2 },
  variantName: { fontSize: fs(8), color: C.inkHigh, flexShrink: 1, paddingRight: 6 },
  variantMeta: { fontSize: fs(8), color: C.inkMid },
  variantMore: { fontSize: fs(7.5), color: C.inkSoft, marginTop: 3 },

  // ---- footer (fixed, every page) ----
  footer: {
    position: 'absolute', bottom: 28, left: MARGIN, right: MARGIN,
    flexDirection: 'row', justifyContent: 'space-between',
    borderTopWidth: 0.5, borderTopColor: C.inkLine, paddingTop: 6,
  },
  footerText: { fontSize: fs(8), color: C.inkMid },
});

function Card({ model, images }: { model: BookModel; images?: CatalogImageMap }) {
  const uri = images?.get(model.key);
  const single = model.members.length === 1;
  const lead = model.members[0];
  const shown = model.members.slice(0, MAX_VARIANT_ROWS);
  const hidden = model.members.length - shown.length;
  const body = (
    <View style={st.card} wrap={false}>
      <View style={st.imgBox}>
        {uri ? <Image src={uri} style={st.img} /> : <Text style={st.imgPlaceholder}>LifestyleGarden</Text>}
      </View>
      <View style={st.cardBody}>
        {model.family ? <Text style={st.familyEyebrow}>{model.family}</Text> : null}
        <Text style={st.name}>{model.name}</Text>
        {single && lead?.reference ? <Text style={st.ref}>Ref. {lead.reference}</Text> : null}
        <View style={st.priceRow}>
          <Text style={st.price}>{priceLabel(model)}</Text>
          <Text style={st.qty}>{qtyLabel(model.stockQty)}</Text>
        </View>
        {!single && (
          <View style={st.variants}>
            {shown.map((v) => (
              <View key={v.id} style={st.variantRow}>
                <Text style={st.variantName}>{v.subtype || v.reference || '—'}</Text>
                <Text style={st.variantMeta}>{Number(v.stockQty) || 0} · {usd(v.priceUsd)}</Text>
              </View>
            ))}
            {hidden > 0 && <Text style={st.variantMore}>+{hidden} variantes más en la tienda</Text>}
          </View>
        )}
      </View>
    </View>
  );
  // The whole card is a tap target to the product's store page.
  return model.storeUrl
    ? <Link src={model.storeUrl} style={st.cardSlot}>{body}</Link>
    : <View style={st.cardSlot}>{body}</View>;
}

export function CatalogDocument({ book, images, generatedAt }: CatalogDocumentProps) {
  return (
    <Document title="Catálogo LifestyleGarden" creator="RosetSoft" producer="RosetSoft">
      <Page size="LETTER" style={st.page}>
        <View>
          <Text style={st.eyebrow}>Catálogo · piezas en existencia</Text>
          <Text style={st.title}>LifestyleGarden</Text>
          <Text style={st.headMeta}>
            {formatDate(generatedAt)} · {book.models} modelo(s) · precios en USD · toca una pieza para verla en lifestylegarden.do
          </Text>
          <View style={st.rule} />
        </View>

        {book.sections.map((s) => (
          <View key={s.category || '__none__'} style={st.section}>
            <View style={st.sectionHead} wrap={false} minPresenceAhead={120}>
              <View>
                <Text style={st.sectionLabel}>{s.category || 'Otros'}</Text>
                <View style={st.sectionTick} />
              </View>
              <Text style={st.sectionCount}>{s.models.length} modelo(s)</Text>
            </View>
            <View style={st.grid}>
              {s.models.map((m) => <Card key={m.key} model={m} images={images} />)}
            </View>
          </View>
        ))}

        <View style={st.footer} fixed>
          <Text style={st.footerText}>LifestyleGarden · www.lifestylegarden.do</Text>
          <Text
            style={st.footerText}
            render={({ pageNumber, totalPages }) => `Existencias al ${formatDate(generatedAt)} · pág. ${pageNumber} / ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  );
}
