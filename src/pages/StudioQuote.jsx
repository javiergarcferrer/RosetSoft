import { Lock, Truck, Check, Boxes, GitFork } from 'lucide-react';

/**
 * /studio-quote — the "Warm Instrument" (light) design language applied to the
 * REAL client-facing quote: the public link + PDF surface (ClientPreview).
 *
 * This is the implementation render of the chosen direction. It is built on the
 * actual quote structures — a sectioned list, a compound article with a uniform
 * "Tapizado" hero (the swatch-collapse shipped earlier), a pick-one alternative
 * group, a locked USD→DOP rate, savings — so what you see is what the live
 * component would become. It stays self-contained (sample data, no auth/DB) only
 * because the live ClientPreview needs the edge function + real data to render;
 * porting these styles onto it is mechanical once the look is approved.
 *
 * The language: warm-neutral surfaces, Söhne headers / Lausanne body, a MONO
 * companion for every figure and code (tabular, aligned, locked), terracotta
 * reserved for the things the client should feel — the discount, the savings,
 * the chosen fabric.
 */

// Warm Instrument · light — the palette from /style-studio.
const C = {
  bg: '#f1efea', surface: '#ffffff', surfaceAlt: '#faf9f7',
  line: '#e8e7e3', line2: '#cfccc4',
  text: '#171612', textMid: '#6c6859', textSoft: '#aba79a',
  accent: '#c96a2a', accentSoft: '#fdf6f0', accentLine: '#f2cba6',
  emerald: '#3f6b54',
  band: '#171612', bandText: '#f7f7f6', bandSoft: '#a8a293',
};
const MONO = "'SF Mono', 'JetBrains Mono', ui-monospace, Menlo, monospace";

// One place for the money type: tabular mono, right-aligned, never jitters.
function Money({ children, size = 'sm', strong, soft, accent }) {
  const px = { xs: 11, sm: 13, md: 16, xl: 26 }[size];
  return (
    <span style={{
      fontFamily: MONO, fontVariantNumeric: 'tabular-nums', fontSize: px,
      fontWeight: strong ? 600 : 400,
      color: accent ? C.accent : soft ? C.textSoft : C.text,
      whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

function Eyebrow({ children, accent, style }) {
  return (
    <div style={{
      fontFamily: 'Sohne', fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
      letterSpacing: '0.14em', color: accent ? C.accent : C.textSoft, ...style,
    }}>{children}</div>
  );
}

export default function StudioQuote() {
  return (
    <div className="h-full overflow-y-auto overscroll-contain" style={{ background: C.bg, color: C.text, fontFamily: 'Lausanne' }}>
      {/* prototype cross-nav */}
      <div className="sticky top-0 z-20 flex justify-center gap-1 py-2 text-[11px]"
        style={{ background: C.bg, borderBottom: `1px solid ${C.line}`, fontFamily: MONO }}>
        <a href="#/style-studio" className="px-3 py-1 rounded-full" style={{ color: C.textMid }}>← System</a>
        <span className="px-3 py-1 rounded-full" style={{ background: C.text, color: C.surface }}>Client Quote · Studio Light</span>
        <a href="#/atelier" className="px-3 py-1 rounded-full" style={{ color: C.textMid }}>Atelier →</a>
      </div>

      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8">
        <div className="overflow-hidden rounded-2xl" style={{ background: C.surface, border: `1px solid ${C.line}`, boxShadow: '0 1px 2px rgba(23,22,18,0.04), 0 12px 40px rgba(23,22,18,0.07)' }}>

          {/* ── Masthead ──────────────────────────────────────────── */}
          <div className="px-7 sm:px-10 pt-9 pb-7 flex items-start justify-between gap-6" style={{ borderBottom: `1px solid ${C.line}` }}>
            <div>
              <div className="font-wordmark" style={{ fontSize: 30, lineHeight: 1, color: C.text }}>Alcover</div>
              <div className="mt-3 text-[11px] leading-relaxed" style={{ color: C.textMid }}>
                C/ Juan Isidro Ortega 102<br />Santo Domingo · +1 809 706 0361
              </div>
            </div>
            <div className="text-right">
              <Eyebrow>Propuesta</Eyebrow>
              <div className="mt-1" style={{ fontFamily: MONO, fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em' }}>#1042</div>
              <div className="mt-2 text-[11px]" style={{ color: C.textSoft, fontFamily: MONO }}>01 JUN 2026</div>
            </div>
          </div>

          {/* ── Client / vendor / professional ────────────────────── */}
          <div className="px-7 sm:px-10 py-6 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-5" style={{ borderBottom: `1px solid ${C.line}` }}>
            <div className="min-w-0">
              <Eyebrow>Preparada para</Eyebrow>
              <div className="mt-1.5 text-lg font-semibold" style={{ fontFamily: 'Sohne' }}>Eduardo García</div>
              <div className="text-xs" style={{ color: C.textMid }}>Estudio Norte</div>
              <div className="mt-1 text-[11px]" style={{ color: C.textSoft }}>Av. Anacaona 12, Torre A · Santo Domingo</div>
            </div>
            <div className="flex gap-8 sm:text-right">
              <div>
                <Eyebrow>Vendedor</Eyebrow>
                <div className="mt-1.5 text-sm font-medium" style={{ fontFamily: 'Sohne' }}>María Reyes</div>
              </div>
              <div>
                <Eyebrow>Profesional</Eyebrow>
                <div className="mt-1.5 text-sm font-medium" style={{ fontFamily: 'Sohne' }}>Arq. Luis Peña</div>
                <div className="text-[11px]" style={{ color: C.textSoft }}>Peña Arquitectura</div>
              </div>
            </div>
          </div>

          {/* ── Section ───────────────────────────────────────────── */}
          <div className="px-7 sm:px-10 pt-7 pb-2 flex items-end justify-between">
            <div>
              <Eyebrow accent>Sala de estar</Eyebrow>
              <div className="mt-1.5 h-[2px] w-9 rounded-full" style={{ background: C.accent }} />
            </div>
            <Money size="sm" soft>$34,215.00</Money>
          </div>

          {/* Compound — uniform fabric hero + clean component list */}
          <CompoundLine />

          {/* Alternative group card */}
          <AlternativeCard />

          {/* ── Totals ────────────────────────────────────────────── */}
          <div className="px-7 sm:px-10 pt-7 pb-9">
            <div className="ml-auto w-full sm:max-w-sm">
              <TotalRow label="Subtotal" value="$36,695.00" />
              <TotalRow label="Descuento (5%)" value="–$1,834.75" accent />
              <TotalRow label="ITBIS (18%)" value="$6,274.84" soft />
              <TotalRow label="Envío" value="$350.00" soft />

              {/* Grand-total band with the locked-rate marker */}
              <div className="mt-3 flex items-center justify-between gap-4 px-5 py-4 rounded-lg"
                style={{ background: C.band, color: C.bandText }}>
                <Eyebrow style={{ color: C.bandSoft, letterSpacing: '0.18em' }}>Total</Eyebrow>
                <div className="flex items-center gap-3">
                  <span className="inline-flex items-center gap-1 text-[11px]" style={{ fontFamily: MONO, color: C.bandSoft }}>
                    <Lock size={10} /> @ 59.07
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 26, fontWeight: 600, color: '#fff' }}>$41,484.09</span>
                </div>
              </div>

              {/* freight inclusion + DOP shadow + savings */}
              <div className="mt-2.5 flex items-center justify-end gap-1.5" style={{ color: C.emerald }}>
                <Truck size={13} />
                <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ fontFamily: 'Sohne' }}>Flete y agenciamiento incluido</span>
              </div>
              <div className="mt-1.5 text-right">
                <Money size="xs" soft>≈ RD$ 2,450,466 · a 59.07 DOP/USD</Money>
              </div>
              <div className="mt-1 text-right">
                <span className="text-xs font-medium" style={{ color: C.accent, fontFamily: 'Sohne' }}>Ahorras $1,834.75 en esta propuesta</span>
              </div>
            </div>
          </div>

          {/* ── Terms ─────────────────────────────────────────────── */}
          <div className="px-7 sm:px-10 py-6" style={{ borderTop: `1px solid ${C.line}`, background: C.surfaceAlt }}>
            <Eyebrow>Términos</Eyebrow>
            <p className="mt-2 text-[11px] leading-relaxed" style={{ color: C.textMid }}>
              Precios en USD; el equivalente en RD$ es referencial al tipo de cambio indicado.
              Válida por 15 días. 50% de anticipo para iniciar el pedido; saldo contra entrega.
              Tiempo estimado: 10–14 semanas.
            </p>
          </div>
        </div>

        <div className="py-6 text-center text-[11px]" style={{ color: C.textSoft, fontFamily: MONO }}>Prototype · /studio-quote</div>
      </div>
    </div>
  );
}

/* ── line items ──────────────────────────────────────────────────── */

// A compound article where every piece shares one fabric → the swatch is
// hoisted to ONE "Tapizado" hero and the pieces collapse to name + price.
function CompoundLine() {
  const comps = [
    ['EXCLUSIF Right-Arm Loveseat', '100029530', '13,810.00'],
    ['EXCLUSIF Corner Seat 45°', '17220600', '7,410.00'],
    ['EXCLUSIF Loveseat w/o Arms', '100029500', '1,260.00'],
  ];
  return (
    <div className="px-7 sm:px-10 py-5" style={{ borderTop: `1px solid ${C.line}` }}>
      <div className="flex flex-col sm:flex-row gap-5">
        {/* product image */}
        <div className="flex-shrink-0">
          <div className="w-full sm:w-44 aspect-square rounded-xl flex items-center justify-center"
            style={{ background: C.surfaceAlt, border: `1px solid ${C.line}` }}>
            <SofaGlyph />
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <Eyebrow style={{ letterSpacing: '0.12em' }}>EXCLUSIF</Eyebrow>
          <div className="mt-0.5 text-lg font-semibold leading-tight" style={{ fontFamily: 'Sohne' }}>Modular en L · 3 piezas</div>

          {/* the Tapizado hero — fabric stated ONCE */}
          <div className="mt-3 flex items-center gap-3 rounded-lg p-2.5" style={{ background: C.surfaceAlt, border: `1px solid ${C.line}` }}>
            <span className="w-12 h-12 rounded flex-shrink-0" style={{ background: 'linear-gradient(135deg,#8a7d6a,#6f6353)', border: `1px solid ${C.line2}` }} />
            <div>
              <Eyebrow style={{ fontSize: 10 }}>Tapizado</Eyebrow>
              <div className="text-sm font-medium" style={{ fontFamily: 'Sohne' }}>Grade C — TRAMA · Ecru</div>
            </div>
          </div>

          {/* clean component list — name + ref + price */}
          <div className="mt-3.5" style={{ borderTop: `1px solid ${C.line}` }}>
            {comps.map(([name, ref, amt], i) => (
              <div key={i} className="flex items-baseline justify-between gap-3 py-2.5"
                style={{ borderBottom: i < comps.length - 1 ? `1px solid ${C.line}` : 'none' }}>
                <div className="min-w-0">
                  <div className="text-sm">{name}</div>
                  <div style={{ fontFamily: MONO, fontSize: 10, color: C.textSoft }}>REF. {ref}</div>
                </div>
                <Money size="sm" strong>${amt}</Money>
              </div>
            ))}
          </div>

          {/* compound roll-up */}
          <div className="mt-3 flex items-baseline justify-between">
            <Eyebrow style={{ fontSize: 10 }}>Total del conjunto</Eyebrow>
            <Money size="md" strong>$22,480.00</Money>
          </div>
        </div>
      </div>
    </div>
  );
}

// A pick-one alternative group — the chosen option in accent, the rest quiet.
function AlternativeCard() {
  const opts = [
    ['EXCLUSIF Mini Lounge Left', '10003972', '5,420.00', true],
    ['EXCLUSIF Asymmetrical Mini Lounge', '10003978', '6,180.00', false],
  ];
  return (
    <div className="px-7 sm:px-10 py-5" style={{ borderTop: `1px solid ${C.line}` }}>
      <div className="rounded-xl overflow-hidden" style={{ border: `1.5px solid ${C.accentLine}` }}>
        <div className="px-4 py-2 flex items-center justify-between" style={{ background: C.accentSoft }}>
          <span className="inline-flex items-center gap-1.5" style={{ fontFamily: 'Sohne', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: C.accent }}>
            <GitFork size={12} /> Alternativas — elige una
          </span>
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.textSoft }}>2 opciones</span>
        </div>
        {opts.map(([name, ref, amt, sel], i) => (
          <div key={i} className="px-4 py-3 flex items-center gap-3"
            style={{ borderTop: i ? `1px solid ${C.line}` : 'none', background: sel ? C.surface : C.surfaceAlt, opacity: sel ? 1 : 0.62 }}>
            <span className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full"
              style={{ border: `2px solid ${sel ? C.accent : C.line2}`, background: sel ? C.accent : 'transparent', color: '#fff' }}>
              {sel && <Check size={11} strokeWidth={3} />}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium" style={{ fontFamily: 'Sohne' }}>
                {name}
                {sel && <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide" style={{ color: C.accent }}>Tu elección</span>}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: C.textSoft }}>REF. {ref} · Grade C — TRAMA</div>
            </div>
            <Money size="sm" strong={sel}>${amt}</Money>
          </div>
        ))}
        <div className="px-4 py-2.5 flex items-center justify-between" style={{ background: C.accentSoft, borderTop: `1px solid ${C.accentLine}` }}>
          <span className="inline-flex items-center gap-1.5" style={{ fontFamily: 'Sohne', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: C.accent }}>
            <Boxes size={11} /> Total
          </span>
          <Money size="sm" strong>$5,420.00</Money>
        </div>
      </div>
    </div>
  );
}

function TotalRow({ label, value, soft, accent }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-sm" style={{ color: accent ? C.accent : soft ? C.textMid : C.text, fontWeight: accent ? 500 : 400 }}>{label}</span>
      <Money size="sm" soft={soft} accent={accent}>{value}</Money>
    </div>
  );
}

// A rounded modular-sofa silhouette in warm ink, for the product tile.
function SofaGlyph() {
  return (
    <svg viewBox="0 0 200 130" style={{ width: '74%' }} aria-hidden>
      <path d="M24 104 L24 56 Q24 30 56 30 L150 30 Q176 30 176 56 L176 104 Q176 108 172 108 L150 108 L150 102 Q150 86 134 86 L78 86 Q62 86 62 102 L62 108 L28 108 Q24 108 24 104 Z"
        fill="#cfc7b8" />
      <path d="M62 104 L62 108 L150 108 L150 102 Q150 92 140 92 L72 92 Q62 92 62 104 Z" fill="#b3a994" />
      <line x1="24" y1="108" x2="34" y2="120" stroke="#cfc7b8" strokeWidth="5" strokeLinecap="round" />
      <line x1="176" y1="108" x2="166" y2="120" stroke="#cfc7b8" strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}
