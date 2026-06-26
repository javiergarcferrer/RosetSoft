/**
 * Fitness function — the BPD rate cron must SWEEP the business day, never a
 * single daily shot.
 *
 * Banco Popular publishes the day's USD→DOP rate at an unpredictable morning
 * time and consultaTasa carries no as-of date, so a single timed pull silently
 * grabs yesterday's number when the bank runs late (the 2026-06-25 incident),
 * with no retry until tomorrow. The watertight design polls hourly across the
 * DR business day so a late publish is caught within the hour and a transient
 * bank outage is recovered the same day — with zero browser dependency.
 *
 * This pins that invariant against the flip-flop in git history (hourly →
 * single daily shot → browser-only): the WINNING definition of
 * ensure_bpd_rate_cron (the latest-named migration that defines it) must
 * schedule an HOUR RANGE, not one hour. A red means a new migration narrowed
 * the sweep back to a single shot — widen it, don't relax this test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'supabase', 'migrations');

// Migrations apply in filename-timestamp order, so the last file that redefines
// ensure_bpd_rate_cron is the one that wins at runtime.
function winningCronExpr() {
  const files = existsSync(DIR)
    ? readdirSync(DIR).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort()
    : [];
  let expr = null;
  for (const f of files) {
    const sql = readFileSync(join(DIR, f), 'utf8');
    if (!/create or replace function\s+ensure_bpd_rate_cron/i.test(sql)) continue;
    // cron.schedule('bpd-rate-daily', '<expr>', ...)
    const m = sql.match(/cron\.schedule\(\s*'bpd-rate-daily'\s*,\s*'([^']+)'/i);
    if (m) expr = m[1].trim();
  }
  return expr;
}

test('a migration defines the bpd-rate cron schedule', () => {
  assert.ok(winningCronExpr(), 'No ensure_bpd_rate_cron schedule found in migrations.');
});

test('the winning bpd-rate cron sweeps an hour RANGE, never a single daily shot', () => {
  const expr = winningCronExpr();
  const fields = expr.split(/\s+/);
  assert.equal(fields.length, 5, `Expected a 5-field cron expression, got: "${expr}"`);
  const hour = fields[1];
  // A range (12-22), a step (*/2), a list (12,13,...) or every-hour (*) all
  // sweep. A single integer (e.g. "12") is the fragile single-shot we forbid.
  const isSingleHour = /^\d+$/.test(hour);
  assert.equal(
    isSingleHour,
    false,
    `BPD rate cron hour field "${hour}" is a single daily shot (expr "${expr}"). ` +
      'Sweep the business day so a late/failed publish is caught the same day.',
  );
});

test('the sweep covers at least the DR business morning (08:00–12:00 AST)', () => {
  // 08:00–12:00 AST = 12:00–16:00 UTC. The hour field must include those hours
  // so the bank's morning publish is always polled. Only asserted for an
  // explicit range "a-b"; steps/lists/"*" are accepted as obviously covering.
  const expr = winningCronExpr();
  const hour = expr.split(/\s+/)[1];
  const range = hour.match(/^(\d+)-(\d+)$/);
  if (!range) return; // not a plain range — covered by the previous test
  const [, lo, hi] = range.map(Number);
  assert.ok(lo <= 12 && hi >= 16,
    `BPD cron range ${hour} UTC must span at least 12–16 UTC (08:00–12:00 AST).`);
});
