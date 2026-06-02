/**
 * Architecture fitness function — the guard that keeps the MVVM layering and the
 * CRM↔Accounting osmotic barrier from eroding. Unlike the other tests (which pin
 * money / parsing), this one statically scans the source graph and FAILS the
 * build the moment an import crosses a boundary it shouldn't. It's what makes
 * the barrier resilient: the rules in CLAUDE.md stop being a convention and
 * become enforced.
 *
 * Layers (low → high): lib (Model) → core (ViewModel/Model barrels) →
 * pages|components|pdf (View). Imports point DOWN only.
 *
 * Cores: the CRM core (core/quote, core/tracking, core/store) and the Accounting
 * core (core/accounting, lib/accounting) NEVER import each other — they meet
 * ONLY at core/bridge. And the app (src) and the Edge Functions
 * (supabase/functions) are separate dependency graphs: only data crosses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const FUNCTIONS = join(ROOT, 'supabase', 'functions');
const CODE = /\.(jsx?|tsx?)$/;

// Sanctioned exceptions, documented in CLAUDE.md.
const CORE_HOOK_VM = 'core/tracking/useContainerTracking.js'; // owns its effectful fetch
const LIB_UI_HOOKS = ['lib/useKeyboardShortcut.ts', 'lib/useExchangeRatePull.js'];

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (CODE.test(name)) out.push(p);
  }
  return out;
}

// Every import-like specifier in a file: `… from '…'`, dynamic `import('…')`,
// and bare side-effect `import '…'`.
function specifiers(file) {
  const src = readFileSync(file, 'utf8');
  const specs = new Set();
  let m;
  for (const re of [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
  ]) {
    while ((m = re.exec(src))) specs.add(m[1]);
  }
  return [...specs];
}

// Absolute path a relative specifier resolves to (null for bare/package specs).
function absTarget(file, spec) {
  return spec.startsWith('.') ? resolve(dirname(file), spec) : null;
}

// A relative specifier as a normalized, extension-less, src-relative path —
// or null when it isn't a file under src/.
function toSrcPath(file, spec) {
  const abs = absTarget(file, spec);
  if (!abs) return null;
  const rel = relative(SRC, abs).replace(/\\/g, '/');
  if (rel.startsWith('..')) return null;
  return rel.replace(/\.(jsx?|tsx?)$/, '').replace(/\/index$/, '');
}

const inDir = (p, dir) => p === dir || p.startsWith(dir + '/');
const within = (abs, base) => {
  const r = relative(base, abs);
  return r !== '' && !r.startsWith('..');
};

function layeringViolations() {
  const out = [];
  const add = (file, spec, rule) => out.push(`${relative(ROOT, file)}  →  ${spec}   [${rule}]`);

  for (const file of walk(SRC)) {
    const self = relative(SRC, file).replace(/\\/g, '/');
    for (const spec of specifiers(file)) {
      const t = toSrcPath(file, spec);
      const isReact = spec === 'react' || spec === 'react-dom';

      // Purity: a ViewModel/Model never reaches for React or the data layer.
      if (inDir(self, 'core') && self !== CORE_HOOK_VM) {
        if (isReact) add(file, spec, 'core (VM/Model) imports React');
        if (t && inDir(t, 'db')) add(file, spec, 'core (VM/Model) imports the data layer (db)');
      }
      if (inDir(self, 'lib') && !LIB_UI_HOOKS.includes(self) && isReact) {
        add(file, spec, 'Model (lib) imports React');
      }

      if (!t) continue; // only intra-src relative targets are layered

      // Imports point DOWN: Model/VM never import a View.
      if (inDir(self, 'core') && (inDir(t, 'pages') || inDir(t, 'components') || inDir(t, 'pdf'))) {
        add(file, spec, 'core imports a View (pages/components/pdf)');
      }
      if (inDir(self, 'lib') && (inDir(t, 'core') || inDir(t, 'pages') || inDir(t, 'components') || inDir(t, 'pdf'))) {
        add(file, spec, 'Model (lib) imports up into core/pages/components');
      }

      // The osmotic barrier: the two cores never import each other.
      if (inDir(self, 'core/accounting')
          && (inDir(t, 'core/quote') || inDir(t, 'core/tracking') || inDir(t, 'core/store'))) {
        add(file, spec, 'accounting core imports the CRM core — cross at core/bridge');
      }
      if ((inDir(self, 'core/quote') || inDir(self, 'core/tracking') || inDir(self, 'core/store'))
          && (inDir(t, 'core/accounting') || inDir(t, 'lib/accounting'))) {
        add(file, spec, 'CRM core imports accounting — cross at core/bridge');
      }
      // Accounting never prices/labels a CRM quote line itself; that USD→books
      // translation is the bridge's job (quoteToSale / quoteFloorSaleRows).
      if ((inDir(self, 'core/accounting') || inDir(self, 'lib/accounting'))
          && (t === 'lib/pricing' || t === 'lib/subtype')) {
        add(file, spec, 'accounting imports CRM pricing Model (lib/pricing|lib/subtype) — route via the bridge');
      }
    }
  }
  return out;
}

// The Deno↔Vite wall: app code (src) and Edge Functions (supabase/functions)
// are separate graphs. Neither may import the other — only data crosses.
function denoWallViolations() {
  const out = [];
  const add = (file, spec, msg) => out.push(`${relative(ROOT, file)}  →  ${spec}   [${msg}]`);
  for (const file of walk(SRC)) {
    for (const spec of specifiers(file)) {
      const abs = absTarget(file, spec);
      if (abs && within(abs, FUNCTIONS)) add(file, spec, 'app (src) imports an Edge Function');
    }
  }
  for (const file of walk(FUNCTIONS)) {
    for (const spec of specifiers(file)) {
      const abs = absTarget(file, spec);
      if (abs && within(abs, SRC)) add(file, spec, 'Edge Function imports app (src)');
    }
  }
  return out;
}

test('MVVM layering + CRM↔Accounting barrier hold across the source graph', () => {
  const v = layeringViolations();
  assert.equal(v.length, 0, v.length ? `\nArchitecture violations (${v.length}):\n  ${v.join('\n  ')}\n` : '');
});

test('the Deno↔Vite wall holds — no code crosses between app and Edge Functions', () => {
  const v = denoWallViolations();
  assert.equal(v.length, 0, v.length ? `\nDeno↔Vite wall violations (${v.length}):\n  ${v.join('\n  ')}\n` : '');
});
