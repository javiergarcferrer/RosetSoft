import { useState } from 'react';
import {
  Command, Moon, Sun, ArrowUpRight, Lock, Check, Plus, Boxes, GitFork,
  Search, Download, Share2, Sparkles,
} from 'lucide-react';

/**
 * /style-studio — a self-contained showcase of the proposed "Warm Instrument"
 * design system. NOT wired into the app's data or shared ViewModels; it exists
 * only to render the full visual vocabulary in one place so the direction can
 * be judged by eye. Public route, no auth, no DB.
 *
 * The thesis: keep RosetSoft's warm Alcover materiality (the ink scale is a
 * warm near-black, accent terracotta, Söhne/Lausanne type) but borrow Hermes'
 * instrument discipline for the thing that matters most in a quoting app —
 * NUMBERS. Tabular figures, a mono companion for codes, and a warm-charcoal
 * "Studio" dark mode for the dealer who lives in the tool all day. The client
 * still receives the light editorial artifact.
 *
 * Everything here is local CSS-variable theming (`data-mode`), so the two
 * modes render side by side without touching the global Tailwind theme.
 */

// The warm-charcoal dark palette — Alcover temperature, Hermes energy. Derived
// by inverting the warm ink ramp (NOT a cold neutral gray) and keeping
// terracotta luminous against it.
const MODES = {
  light: {
    bg: '#f7f7f6', surface: '#ffffff', surfaceAlt: '#faf9f7',
    line: '#e8e7e3', line2: '#cfccc4',
    text: '#171612', textMid: '#6c6859', textSoft: '#aba79a',
    accent: '#c96a2a', accentSoft: '#fdf6f0', accentLine: '#f2cba6',
    band: '#171612', bandText: '#f7f7f6',
  },
  studio: {
    // Warm charcoal — note the brown undertone (not #111). This is the whole
    // point: a dark mode that still feels like Alcover, not a dev console.
    bg: '#14120f', surface: '#1d1a16', surfaceAlt: '#231f1a',
    line: '#2e2a24', line2: '#3b3630',
    text: '#f3f1ec', textMid: '#a8a293', textSoft: '#6f695c',
    accent: '#e8924c', accentSoft: '#2a201600', accentLine: '#5a3f28',
    band: '#e8924c', bandText: '#1a1410',
  },
};

function vars(m) {
  const c = MODES[m];
  return {
    '--bg': c.bg, '--surface': c.surface, '--surface-alt': c.surfaceAlt,
    '--line': c.line, '--line2': c.line2,
    '--text': c.text, '--text-mid': c.textMid, '--text-soft': c.textSoft,
    '--accent': c.accent, '--accent-soft': c.accentSoft, '--accent-line': c.accentLine,
    '--band': c.band, '--band-text': c.bandText,
  };
}

const MONO = "'SF Mono', 'JetBrains Mono', ui-monospace, Menlo, monospace";

export default function StyleStudio() {
  const [mode, setMode] = useState('light');
  const other = mode === 'light' ? 'studio' : 'light';
  return (
    <div className="h-full overflow-y-auto overscroll-contain" style={{ ...vars(mode), background: 'var(--bg)', color: 'var(--text)' }}>
      {/* prototype cross-nav */}
      <div className="sticky top-0 z-20 flex justify-center gap-1 py-2 text-[11px]" style={{ background: 'var(--bg)', borderBottom: '1px solid var(--line)', fontFamily: 'Sohne' }}>
        <span className="px-3 py-1 rounded-full" style={{ background: 'var(--text)', color: 'var(--surface)' }}>Warm Instrument</span>
        <a href="#/atelier" className="px-3 py-1 rounded-full" style={{ color: 'var(--text-mid)' }}>Atelier →</a>
      </div>
      <div className="mx-auto max-w-5xl px-5 sm:px-8 py-10 space-y-12">

        {/* ── Masthead ───────────────────────────────────────────── */}
        <header className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em]" style={{ color: 'var(--text-soft)', fontFamily: 'Sohne' }}>
              RosetSoft · Design System
            </div>
            <h1 className="mt-2 text-4xl sm:text-5xl leading-[0.95]" style={{ fontFamily: 'Sohne' }}>
              Warm Instrument
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed" style={{ color: 'var(--text-mid)' }}>
              The precision of a technical tool, clothed in Alcover&rsquo;s materiality.
              One warm system, two temperatures: an <em>instrument</em> for the dealer,
              an <em>artifact</em> for the client.
            </p>
          </div>
          <ModeToggle mode={mode} onToggle={() => setMode(other)} />
        </header>

        <Hr />

        {/* ── Palette ────────────────────────────────────────────── */}
        <Section eyebrow="01 — Surface" title="Warm neutrals, never gray">
          <p className="mb-5 max-w-2xl text-sm" style={{ color: 'var(--text-mid)' }}>
            The near-black is <Mono>#171612</Mono> — a warm ink with a brown undertone,
            not <Mono>#000</Mono>. Studio mode inverts that ramp into a warm charcoal,
            so the dark UI still reads as Alcover, not a dev console.
          </p>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {[['BG', 'var(--bg)'], ['Surface', 'var(--surface)'], ['Alt', 'var(--surface-alt)'],
              ['Line', 'var(--line)'], ['Ink mid', 'var(--text-mid)'], ['Ink', 'var(--text)']].map(([label, c]) => (
              <Swatch key={label} label={label} color={c} />
            ))}
          </div>
          <div className="mt-2 grid grid-cols-3 sm:grid-cols-6 gap-2">
            <Swatch label="Accent" color="var(--accent)" />
            <Swatch label="Accent line" color="var(--accent-line)" />
            <Swatch label="Band" color="var(--band)" />
          </div>
        </Section>

        <Hr />

        {/* ── Type ───────────────────────────────────────────────── */}
        <Section eyebrow="02 — Type" title="Söhne heads, Lausanne body, mono for facts">
          <div className="space-y-4">
            <TypeRow role="Display · Söhne" cls="text-4xl" family="Sohne">Modular en L</TypeRow>
            <TypeRow role="Title · Söhne" cls="text-xl" family="Sohne">Exclusif Loveseat</TypeRow>
            <TypeRow role="Body · Lausanne" cls="text-sm" family="Lausanne">
              Sofá de tres plazas con chaise longue reversible, espuma HR de alta densidad.
            </TypeRow>
            <TypeRow role="Eyebrow · Söhne" cls="text-[11px] uppercase tracking-[0.14em]" family="Sohne">
              Mobiliario de sala
            </TypeRow>
            <div className="flex items-baseline gap-4">
              <RoleTag>Mono · facts</RoleTag>
              <span style={{ fontFamily: MONO }} className="text-sm tracking-tight">REF. 100029530 · #3075</span>
            </div>
          </div>
        </Section>

        <Hr />

        {/* ── The numeric system — the core idea ─────────────────── */}
        <Section eyebrow="03 — Numbers" title="Money is the product. Treat it like one.">
          <p className="mb-5 max-w-2xl text-sm" style={{ color: 'var(--text-mid)' }}>
            Every figure is tabular (fixed-width digits), right-aligned, and lockable.
            This is where the app borrows Hermes&rsquo; discipline — columns that align to
            the pixel and never jitter as values change.
          </p>
          <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
            {[
              ['EXCLUSIF Right-Arm Loveseat', '1', '13,810.00'],
              ['EXCLUSIF Corner Seat 45°', '1', '7,410.00'],
              ['EXCLUSIF Loveseat w/o Arms', '2', '1,260.00'],
            ].map(([name, qty, amt], i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3 border-b last:border-b-0" style={{ borderColor: 'var(--line)' }}>
                <span className="flex-1 text-sm">{name}</span>
                <span className="text-[13px] tabular-nums" style={{ color: 'var(--text-soft)', fontFamily: MONO }}>×{qty}</span>
                <span className="w-28 text-right text-sm font-medium tabular-nums" style={{ fontFamily: MONO }}>${amt}</span>
              </div>
            ))}
            {/* Grand-total band — the visual climax, with the locked-rate marker */}
            <div className="flex items-center justify-between gap-4 px-5 py-4" style={{ background: 'var(--band)', color: 'var(--band-text)' }}>
              <span className="text-[11px] uppercase tracking-[0.18em]" style={{ fontFamily: 'Sohne' }}>Total</span>
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center gap-1 text-[11px] tabular-nums opacity-80" style={{ fontFamily: MONO }}>
                  <Lock size={11} /> @ 59.07
                </span>
                <span className="text-2xl font-semibold tabular-nums" style={{ fontFamily: MONO }}>$26,415.00</span>
              </div>
            </div>
          </div>
          <p className="mt-2 text-[11px] tabular-nums text-right" style={{ color: 'var(--text-mid)' }}>
            ≈ RD$ 1,560,334 · <span style={{ color: 'var(--accent)' }}>Ahorras $1,240.00</span>
          </p>
        </Section>

        <Hr />

        {/* ── Controls ───────────────────────────────────────────── */}
        <Section eyebrow="04 — Controls" title="Buttons, chips, command">
          <div className="flex flex-wrap items-center gap-2.5 mb-6">
            <Btn primary>{<><Download size={15} /> Exportar PDF</>}</Btn>
            <Btn>{<><Share2 size={15} /> Compartir</>}</Btn>
            <Btn accent>{<><Plus size={15} /> Agregar</>}</Btn>
            <Btn ghost>Cancelar</Btn>
          </div>
          <div className="flex flex-wrap items-center gap-2 mb-6">
            <Chip icon={Boxes}>Conjunto</Chip>
            <Chip icon={GitFork} accent>Alternativa</Chip>
            <Chip dashed>Opcional</Chip>
            <Chip mono>Grade C — TRAMA</Chip>
          </div>
          {/* ⌘K command palette — the "operator tool" affordance */}
          <button
            className="group w-full max-w-md flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors"
            style={{ borderColor: 'var(--line2)', background: 'var(--surface-alt)' }}
          >
            <Search size={16} style={{ color: 'var(--text-soft)' }} />
            <span className="flex-1 text-sm" style={{ color: 'var(--text-mid)' }}>Buscar cotización, cliente, acción…</span>
            <kbd className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] tabular-nums border" style={{ borderColor: 'var(--line2)', color: 'var(--text-mid)', fontFamily: MONO }}>
              <Command size={10} /> K
            </kbd>
          </button>
        </Section>

        <Hr />

        {/* ── The split: instrument vs artifact ──────────────────── */}
        <Section eyebrow="05 — Two surfaces" title="One system, dressed for its reader">
          <div className="grid sm:grid-cols-2 gap-4">
            <SurfaceCard
              kind="Dealer · Instrument"
              icon={Moon}
              desc="Dense, tabular, keyboard-first. Studio dark mode for all-day use."
              tags={['⌘K', 'tabular-nums', 'warm dark', 'density']}
            />
            <SurfaceCard
              kind="Client · Artifact"
              icon={Sparkles}
              desc="Editorial, photographic, spacious. The received proposal feels like alcover.do."
              tags={['cover page', 'big imagery', 'designer credits', 'air']}
            />
          </div>
        </Section>

        <footer className="pt-4 text-[11px]" style={{ color: 'var(--text-soft)', fontFamily: 'Sohne' }}>
          Prototype · not wired to data · /style-studio
        </footer>
      </div>
    </div>
  );
}

/* ── pieces ──────────────────────────────────────────────────────── */

function ModeToggle({ mode, onToggle }) {
  const studio = mode === 'studio';
  return (
    <button
      onClick={onToggle}
      className="inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-medium transition-colors flex-shrink-0"
      style={{ borderColor: 'var(--line2)', color: 'var(--text)', background: 'var(--surface)' }}
      title="Alternar modo"
    >
      {studio ? <Sun size={14} /> : <Moon size={14} />}
      {studio ? 'Light' : 'Studio'}
    </button>
  );
}

function Section({ eyebrow, title, children }) {
  return (
    <section>
      <div className="text-[11px] uppercase tracking-[0.16em] mb-1.5" style={{ color: 'var(--accent)', fontFamily: 'Sohne' }}>{eyebrow}</div>
      <h2 className="text-2xl mb-5" style={{ fontFamily: 'Sohne' }}>{title}</h2>
      {children}
    </section>
  );
}

function Hr() {
  return <div className="h-px" style={{ background: 'var(--line)' }} />;
}

function Swatch({ label, color }) {
  return (
    <div>
      <div className="h-16 rounded-lg border" style={{ background: color, borderColor: 'var(--line2)' }} />
      <div className="mt-1.5 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-soft)', fontFamily: 'Sohne' }}>{label}</div>
    </div>
  );
}

function TypeRow({ role, cls, family, children }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-6">
      <RoleTag>{role}</RoleTag>
      <div className={cls} style={{ fontFamily: family, flex: 1 }}>{children}</div>
    </div>
  );
}

function RoleTag({ children }) {
  return (
    <span className="w-40 flex-shrink-0 text-[10px] uppercase tracking-[0.1em] pt-1" style={{ color: 'var(--text-soft)', fontFamily: 'Sohne' }}>
      {children}
    </span>
  );
}

function Mono({ children }) {
  return <span style={{ fontFamily: MONO }} className="text-[0.9em] px-1 rounded" >{children}</span>;
}

function Btn({ children, primary, accent, ghost }) {
  const base = 'inline-flex items-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-all active:scale-[0.98]';
  let style;
  if (primary) style = { background: 'var(--text)', color: 'var(--surface)' };
  else if (accent) style = { background: 'var(--accent)', color: '#fff' };
  else if (ghost) style = { background: 'transparent', color: 'var(--text-mid)' };
  else style = { background: 'transparent', color: 'var(--text)', border: '1px solid var(--line2)' };
  return <button className={base} style={style}>{children}</button>;
}

function Chip({ children, icon: Icon, accent, dashed, mono }) {
  const style = accent
    ? { background: 'var(--accent-soft)', color: 'var(--accent)', border: '1px solid var(--accent-line)' }
    : dashed
      ? { color: 'var(--text-soft)', border: '1px dashed var(--line2)' }
      : { color: 'var(--text-mid)', border: '1px solid var(--line)', background: 'var(--surface-alt)' };
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]"
      style={{ ...style, fontFamily: mono ? MONO : 'Sohne', textTransform: mono ? 'none' : 'uppercase' }}
    >
      {Icon && <Icon size={11} />}
      {children}
    </span>
  );
}

function SurfaceCard({ kind, icon: Icon, desc, tags }) {
  return (
    <div className="rounded-xl border p-5" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
      <div className="flex items-center gap-2 mb-3">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: 'var(--surface-alt)', color: 'var(--accent)' }}>
          <Icon size={16} />
        </span>
        <span className="text-sm font-medium" style={{ fontFamily: 'Sohne' }}>{kind}</span>
        <ArrowUpRight size={14} className="ml-auto" style={{ color: 'var(--text-soft)' }} />
      </div>
      <p className="text-sm leading-relaxed mb-4" style={{ color: 'var(--text-mid)' }}>{desc}</p>
      <div className="flex flex-wrap gap-1.5">
        {tags.map((t) => (
          <span key={t} className="rounded px-1.5 py-0.5 text-[10px] tabular-nums" style={{ background: 'var(--surface-alt)', color: 'var(--text-soft)', fontFamily: MONO }}>{t}</span>
        ))}
      </div>
    </div>
  );
}
