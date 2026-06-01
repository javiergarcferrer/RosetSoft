import { useState } from 'react';
import { ArrowLeft, ArrowRight, Plus } from 'lucide-react';

/**
 * /atelier — the BOLD design-system prototype. Where /style-studio was the
 * tasteful synthesis, this is the swing: it translates the actual visual
 * language of the two reference sites (hermes-agent.nousresearch.com +
 * alcover.do) into one composition.
 *
 * What it borrows, made native to a furniture quoting tool:
 *   • Single-ink monochrome (Hermes' cobalt riso/blueprint) → warm TERRACOTTA
 *     print on cream, with a toggle to Hermes' literal cobalt.
 *   • The triple type: heavy condensed grotesque display (Söhne) + a literary
 *     SERIF body + monospace data. (The serif is the part the tame version
 *     missed — it's what makes it editorial, not "techy".)
 *   • A spec drawing bleeding through (Hermes' classical engraving) → a
 *     furniture BLUEPRINT with dimension callouts + a real title block.
 *   • Hermes' live agent-terminal → a quote COMPOSING in real time.
 *   • Alcover's bold grotesque headers, sharp-cornered OUTLINED buttons,
 *     "PLOUM BY STUDIO BOUROULLEC" tracked-caps attribution, slideshow
 *     counters + hairline arrows, corner-bracket frames.
 *
 * Self-contained: no data, no shared VMs. Pure CSS-variable theming + SVG.
 */

const INKS = {
  terracotta: { ink: '184 94 34', paper: '#f7f1e6', name: 'Terracotta' }, // warm Alcover riso
  cobalt:     { ink: '37 71 190', paper: '#eef1fb', name: 'Cobalt' },      // Hermes literal
};

const SERIF = "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif";
const MONO = "'SF Mono', 'JetBrains Mono', ui-monospace, Menlo, monospace";

// ink helpers — single hue at varying opacity, the whole monochrome idea
const k = (o) => `rgb(var(--ink) / ${o})`;

export default function Atelier() {
  const [ink, setInk] = useState('terracotta');
  const c = INKS[ink];

  return (
    <div
      className="h-full overflow-y-auto overscroll-contain relative"
      style={{ '--ink': c.ink, background: c.paper, color: k(0.92) }}
    >
      {/* riso dot texture over everything — the print grain */}
      <div
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          backgroundImage: `radial-gradient(${k(0.4)} 0.5px, transparent 0.6px)`,
          backgroundSize: '4px 4px', opacity: 0.5,
        }}
        aria-hidden
      />

      {/* prototype cross-nav + ink toggle */}
      <div className="sticky top-0 z-30 flex items-center justify-between px-4 py-2 text-[11px]"
        style={{ background: c.paper, borderBottom: `1px solid ${k(0.25)}`, fontFamily: MONO }}>
        <div className="flex gap-1">
          <a href="#/style-studio" className="px-3 py-1 rounded-full" style={{ color: k(0.55) }}>← Warm Instrument</a>
          <span className="px-3 py-1 rounded-full" style={{ background: k(1), color: c.paper }}>Atelier</span>
        </div>
        <div className="flex items-center gap-2">
          <span style={{ color: k(0.45) }}>INK</span>
          {Object.entries(INKS).map(([key, v]) => (
            <button key={key} onClick={() => setInk(key)}
              className="px-2.5 py-1 rounded-full transition-colors"
              style={ink === key
                ? { background: k(1), color: c.paper }
                : { color: k(0.6), border: `1px solid ${k(0.3)}` }}>
              {v.name}
            </button>
          ))}
        </div>
      </div>

      <div className="relative z-10 mx-auto max-w-6xl px-5 sm:px-8">

        {/* ── Masthead ─────────────────────────────────────────────── */}
        <section className="relative pt-12 pb-8">
          {/* blueprint bleeding through, right side */}
          <div className="pointer-events-none absolute right-[-60px] top-0 w-[560px] max-w-[60vw] opacity-[0.9] hidden md:block" aria-hidden>
            <Blueprint />
          </div>

          <Tracked>Open Atelier · Santo Domingo · Est. 1998</Tracked>

          {/* heavy condensed display — the Hermes / "SHOWROOM" energy */}
          <h1 className="mt-5 font-display font-bold leading-[0.86] tracking-[-0.03em]"
            style={{ fontSize: 'clamp(3rem, 9vw, 8rem)', color: k(1) }}>
            CADA<br />PROPUESTA,<br /><span style={{ WebkitTextStroke: `1.5px ${k(1)}`, color: 'transparent' }}>UNA OBRA.</span>
          </h1>

          {/* the SERIF body — literary, the part the tame version lacked */}
          <p className="mt-6 max-w-lg text-[19px] leading-relaxed italic"
            style={{ fontFamily: SERIF, color: k(0.78) }}>
            No es un formulario con precios. Es la pieza, contada antes de existir —
            tela, dimensión y total, compuestos a la vista del cliente y entregados
            como se entrega un objeto: con intención.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <SharpBtn solid paper={c.paper}>Componer una cotización</SharpBtn>
            <SharpBtn>Ver el catálogo</SharpBtn>
          </div>
        </section>

        <Rule />

        {/* ── The live quote terminal — Hermes' agent panel, reborn ──── */}
        <section className="py-10">
          <Tracked>En vivo — Componiendo</Tracked>
          <div className="mt-4">
            <CornerFrame>
              <div className="px-4 py-2.5 flex items-center gap-2" style={{ borderBottom: `1px solid ${k(0.2)}` }}>
                {[0, 1, 2].map((i) => <span key={i} className="inline-block w-2 h-2 rounded-full" style={{ border: `1px solid ${k(0.5)}` }} />)}
                <span className="ml-2 text-[11px] tracking-[0.2em]" style={{ fontFamily: MONO, color: k(0.55) }}>COTIZACIÓN · #1042</span>
              </div>
              <div className="p-4 sm:p-5 space-y-1.5" style={{ fontFamily: MONO, fontSize: 13 }}>
                <Line prompt>componer · cliente "Estudio Norte" · sala de estar</Line>
                <Term op="add_line " label="EXCLUSIF Right-Arm Loveseat" val="$13,810.00" />
                <Term op="apply    " label="Grade C — TRAMA · Ecru" val="tapizado" muted />
                <Term op="add_line " label="EXCLUSIF Corner Seat 45°" val="$7,410.00" />
                <Term op="set      " label="Conjunto · 3 piezas" val="todas" muted />
                <Term op="pick_one " label="Lounge mini · 2 opciones" val="→" muted />
                <Term op="rate_lock" label="USD→DOP @ 59.07" val="bloqueada" muted />
                <div className="pt-2 mt-1 flex items-center justify-between" style={{ borderTop: `1px solid ${k(0.2)}` }}>
                  <span style={{ color: k(0.55) }}>total ·</span>
                  <span className="text-base font-bold tabular-nums" style={{ color: k(1) }}>
                    $26,415.00<span className="inline-block w-2 h-4 ml-1 align-middle animate-pulse" style={{ background: k(1) }} />
                  </span>
                </div>
              </div>
            </CornerFrame>
          </div>
        </section>

        <Rule />

        {/* ── Designer attribution + slideshow chrome (Alcover) ──────── */}
        <section className="py-10">
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div>
              <Tracked>Pieza destacada</Tracked>
              <h2 className="mt-3 font-display font-bold tracking-[-0.02em]" style={{ fontSize: 'clamp(2rem,5vw,3.5rem)', color: k(1) }}>
                PLOUM
              </h2>
              <p className="mt-1 text-sm tracking-[0.18em]" style={{ fontFamily: MONO, color: k(0.6) }}>
                BY STUDIO BOUROULLEC · 2011
              </p>
            </div>
            {/* slideshow counter + hairline arrows */}
            <div className="flex items-center gap-5">
              <span className="text-sm tabular-nums tracking-[0.2em]" style={{ fontFamily: MONO, color: k(0.6) }}>01 / 04</span>
              <div className="flex gap-2">
                <Arrow dir="left" k={k} />
                <Arrow dir="right" k={k} />
              </div>
            </div>
          </div>
          {/* the piece, framed + duotone */}
          <div className="mt-6">
            <CornerFrame>
              <div className="aspect-[16/7] flex items-center justify-center" style={{ background: k(0.04) }}>
                <PloumGlyph k={k} />
              </div>
            </CornerFrame>
          </div>
        </section>

        <Rule />

        {/* ── The moment of color — deliberate rupture of the monochrome ─ */}
        <section className="py-10">
          <Tracked>…y entonces, color</Tracked>
          <p className="mt-3 max-w-xl text-[19px] leading-relaxed italic" style={{ fontFamily: SERIF, color: k(0.78) }}>
            El sistema es monocromo por disciplina — para que el producto sea lo único
            que grita. La tela elegida es el único color en la página.
          </p>
          <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[['Aubergine', '#4a2d52'], ['Ecru', '#d8cdb8'], ['Cobalt', '#274bbe'], ['Ochre', '#d8a32a']].map(([name, hex]) => (
              <div key={name}>
                <div className="aspect-square rounded-sm" style={{ background: hex, boxShadow: `inset 0 0 0 1px ${k(0.15)}` }} />
                <div className="mt-2 flex items-baseline justify-between">
                  <span className="text-sm" style={{ fontFamily: SERIF }}>{name}</span>
                  <span className="text-[11px] tabular-nums" style={{ fontFamily: MONO, color: k(0.5) }}>{hex}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <footer className="py-10 flex items-end justify-between gap-4" style={{ borderTop: `1px solid ${k(0.25)}` }}>
          <div>
            <div className="font-wordmark text-2xl" style={{ color: k(1) }}>Alcover</div>
            <p className="mt-1 text-[11px] tracking-[0.18em]" style={{ fontFamily: MONO, color: k(0.5) }}>SU ALIADO EN DISEÑO</p>
          </div>
          <span className="text-[11px]" style={{ fontFamily: MONO, color: k(0.45) }}>Prototype · /atelier</span>
        </footer>
      </div>
    </div>
  );
}

/* ── pieces ──────────────────────────────────────────────────────── */

function Tracked({ children }) {
  return <div className="text-[11px] font-bold uppercase tracking-[0.2em]" style={{ fontFamily: MONO, color: k(0.55) }}>{children}</div>;
}

function Rule() {
  return <div className="h-px" style={{ background: k(0.2) }} />;
}

// Sharp-cornered outlined button — Alcover's "Schedule a Showroom Meeting".
// `paper` is the page background, so a solid (ink-filled) button reads its
// label in the paper colour — the monochrome inverse, no third value.
function SharpBtn({ children, solid, paper }) {
  return (
    <button
      className="inline-flex items-center gap-2 px-5 py-3 text-sm font-medium transition-all active:translate-y-px"
      style={solid
        ? { background: k(1), color: paper }
        : { border: `1px solid ${k(0.7)}`, color: k(0.95) }}
    >
      {solid && <Plus size={15} />}{children}
    </button>
  );
}

// Corner-bracket frame — the L-marks at each corner (Hermes + Alcover both).
function CornerFrame({ children }) {
  const B = ({ pos }) => {
    const m = { tl: 'top-0 left-0 border-t border-l', tr: 'top-0 right-0 border-t border-r',
      bl: 'bottom-0 left-0 border-b border-l', br: 'bottom-0 right-0 border-b border-r' }[pos];
    return <span className={`absolute w-3 h-3 ${m}`} style={{ borderColor: k(0.9) }} aria-hidden />;
  };
  return (
    <div className="relative" style={{ outline: `1px solid ${k(0.25)}`, outlineOffset: 4 }}>
      <B pos="tl" /><B pos="tr" /><B pos="bl" /><B pos="br" />
      <div className="relative" style={{ background: k(0.02) }}>{children}</div>
    </div>
  );
}

function Line({ children, prompt }) {
  return (
    <div className="flex gap-2" style={{ color: prompt ? k(0.95) : k(0.7) }}>
      {prompt && <span style={{ color: k(1) }}>›</span>}
      <span className={prompt ? 'font-bold' : ''}>{children}</span>
    </div>
  );
}

function Term({ op, label, val, muted }) {
  return (
    <div className="flex items-center gap-3">
      <span style={{ color: k(0.45) }}>{op}</span>
      <span className="flex-1 truncate" style={{ color: muted ? k(0.6) : k(0.92) }}>{label}</span>
      <span className="tabular-nums" style={{ color: muted ? k(0.5) : k(1) }}>{val}</span>
    </div>
  );
}

function Arrow({ dir, k }) {
  const Icon = dir === 'left' ? ArrowLeft : ArrowRight;
  return (
    <button className="inline-flex items-center justify-center w-10 h-10 transition-colors"
      style={{ border: `1px solid ${k(0.35)}`, color: k(0.8) }}>
      <Icon size={16} strokeWidth={1.5} />
    </button>
  );
}

// A furniture BLUEPRINT — the "engraving bleeding through", made native: a
// rounded sofa elevation with dimension callouts + an architectural title block.
function Blueprint() {
  const stroke = k(0.32);
  const faint = k(0.16);
  return (
    <svg viewBox="0 0 560 520" fill="none" style={{ width: '100%' }} aria-hidden>
      {/* grid */}
      <g stroke={faint} strokeWidth="0.5">
        {Array.from({ length: 14 }, (_, i) => <line key={`v${i}`} x1={i * 40} y1="0" x2={i * 40} y2="520" />)}
        {Array.from({ length: 13 }, (_, i) => <line key={`h${i}`} x1="0" y1={i * 40} x2="560" y2={i * 40} />)}
      </g>
      {/* rounded 2-seat sofa, front elevation */}
      <g stroke={stroke} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round">
        {/* body */}
        <path d="M70 360 L70 250 Q70 175 150 175 L410 175 Q490 175 490 250 L490 360 Z" />
        {/* seat line */}
        <path d="M70 300 L490 300" />
        {/* back cushions (2) */}
        <path d="M150 300 L150 195" /><path d="M280 300 L280 185" /><path d="M410 300 L410 195" />
        {/* arms */}
        <path d="M70 300 Q40 300 40 270 L40 250 Q40 230 70 235" />
        <path d="M490 300 Q520 300 520 270 L520 250 Q520 230 490 235" />
        {/* legs */}
        <path d="M110 360 L100 395" /><path d="M450 360 L460 395" />
        <path d="M210 360 L205 388" /><path d="M350 360 L355 388" />
      </g>
      {/* dimension lines */}
      <g stroke={stroke} strokeWidth="0.8">
        <line x1="40" y1="420" x2="520" y2="420" />
        <line x1="40" y1="412" x2="40" y2="428" /><line x1="520" y1="412" x2="520" y2="428" />
        <line x1="538" y1="175" x2="538" y2="395" />
        <line x1="530" y1="175" x2="546" y2="175" /><line x1="530" y1="395" x2="546" y2="395" />
      </g>
      <text x="280" y="438" textAnchor="middle" fill={stroke} style={{ fontFamily: MONO, fontSize: 13 }}>240 cm</text>
      <text x="538" y="290" textAnchor="middle" fill={stroke} transform="rotate(90 538 285)" style={{ fontFamily: MONO, fontSize: 13 }}>72</text>
      {/* title block */}
      <g stroke={stroke} strokeWidth="0.8">
        <rect x="350" y="458" width="200" height="52" />
        <line x1="350" y1="476" x2="550" y2="476" /><line x1="460" y1="458" x2="460" y2="510" />
      </g>
      <text x="356" y="471" fill={k(0.55)} style={{ fontFamily: MONO, fontSize: 9 }}>PLOUM · ELEVACIÓN</text>
      <text x="356" y="492" fill={k(0.55)} style={{ fontFamily: MONO, fontSize: 9 }}>ESC. 1:20</text>
      <text x="466" y="492" fill={k(0.55)} style={{ fontFamily: MONO, fontSize: 9 }}>REF. PLM-2S</text>
    </svg>
  );
}

// A simple Ploum-ish rounded sofa silhouette filled in ink, for the framed hero.
function PloumGlyph({ k }) {
  return (
    <svg viewBox="0 0 420 180" style={{ width: '70%' }} aria-hidden>
      <path d="M40 150 L40 78 Q40 30 95 30 L325 30 Q380 30 380 78 L380 150 Q380 156 374 156 L300 156 L300 150 Q300 120 270 120 L150 120 Q120 120 120 150 L120 156 L46 156 Q40 156 40 150 Z"
        fill={k(0.85)} />
      <path d="M120 150 L120 156 L300 156 L300 150 Q300 132 282 132 L138 132 Q120 132 120 150 Z" fill={k(0.6)} />
      <line x1="40" y1="156" x2="60" y2="172" stroke={k(0.85)} strokeWidth="6" strokeLinecap="round" />
      <line x1="380" y1="156" x2="360" y2="172" stroke={k(0.85)} strokeWidth="6" strokeLinecap="round" />
    </svg>
  );
}
