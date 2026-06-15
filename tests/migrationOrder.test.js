/**
 * Migration-ordering fitness function — "never back-date a migration."
 *
 * The deploy applies supabase/migrations/*.sql in filename-timestamp order and
 * REFUSES an out-of-order file: one back-dated name jams `db push` and aborts
 * the whole pending chain (the table/column silently never appears — the
 * 20260710 incident, repaired in 88afb63, froze every migration behind it).
 *
 * The invariant: a migration ADDED later (per git history) must carry a
 * filename timestamp >= every migration added before it. Working-tree files
 * not yet committed count as "added now" and must out-date the entire chain.
 * A red here means RENAME your new file later than the current maximum —
 * never relax the rule and never join the grandfathered list.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'supabase', 'migrations');

// The one historical incident: a renamed-but-already-applied file restored
// under its original (older) name to unjam prod. Frozen — fix filenames, do
// not grow this list.
const GRANDFATHERED = new Set([
  '20260710090000_whatsapp_quote_template_meta.sql',
]);

const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.sql')) : [];

test('migration filenames carry a 14-digit timestamp prefix', () => {
  const bad = files.filter((f) => !/^\d{14}_.+\.sql$/.test(f));
  assert.equal(bad.length, 0, `Unparseable migration names:\n  ${bad.join('\n  ')}`);
});

test('no two migrations share a version (14-digit) prefix', () => {
  // Supabase tracks applied migrations by VERSION (the timestamp prefix), not by
  // filename — `schema_migrations` keys on it. Two files with the SAME prefix
  // collide: once one claims the version, the deploy treats the version as
  // already applied and SILENTLY SKIPS the other, so its DDL never runs and the
  // column/table never appears (the 20260722080000 incident: contact_rnc_status
  // ran, settings_company_discount was skipped → company_discount_pct missing).
  // Filename-ordering (the test below) can't catch this — the suffixes differ —
  // so it's a separate guard. A red means RENAME one file to a unique later
  // version, never just reorder the suffix.
  const byVersion = new Map();
  for (const f of files) {
    const v = f.slice(0, 14);
    if (!byVersion.has(v)) byVersion.set(v, []);
    byVersion.get(v).push(f);
  }
  const dups = [...byVersion.values()].filter((g) => g.length > 1);
  assert.equal(dups.length, 0, `\nDuplicate migration versions:\n  ${dups.map((g) => g.join('  ==  ')).join('\n  ')}\n`);
});

test('no migration is back-dated relative to the chain that existed when it was added', () => {
  // Latest git addition per file (newest-first log → first sighting wins);
  // files with no committed addition are working-tree-new → added "now".
  // --no-renames: a renamed migration must register as an ADD of the new name
  // (that's the moment its timestamp re-enters the chain).
  const out = execFileSync('git', [
    'log', '--no-renames', '--diff-filter=A', '--name-only', '--format=COMMIT:%ct', '--', 'supabase/migrations',
  ], { cwd: ROOT, encoding: 'utf8' });
  const addedAt = new Map();
  let ts = 0;
  for (const line of out.split('\n')) {
    const m = line.match(/^COMMIT:(\d+)$/);
    if (m) { ts = Number(m[1]); continue; }
    const f = line.trim();
    if (f.startsWith('supabase/migrations/') && f.endsWith('.sql')) {
      const name = f.slice('supabase/migrations/'.length);
      if (!addedAt.has(name)) addedAt.set(name, ts);
    }
  }
  const NOW = Number.MAX_SAFE_INTEGER;
  const ordered = files
    .map((name) => ({ name, at: addedAt.get(name) ?? NOW }))
    .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));

  const violations = [];
  let maxName = '';
  for (const { name } of ordered) {
    if (name < maxName && !GRANDFATHERED.has(name)) {
      violations.push(`${name}  (added after ${maxName} but named earlier — rename it later than the chain max)`);
    }
    if (name > maxName) maxName = name;
  }
  assert.equal(violations.length, 0, `\nBack-dated migrations (${violations.length}):\n  ${violations.join('\n  ')}\n`);
});
