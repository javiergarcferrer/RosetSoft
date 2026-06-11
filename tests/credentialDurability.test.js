// Credential-durability fitness function — "a deploy never erases what the
// dealer pasted into Configuración."
//
// The credential stores (shopify_config, whatsapp_config, ecf_credentials)
// are written ONLY from the app, through their SECURITY DEFINER save_* RPCs.
// History shows how this erodes without a guard: three shopify domain "fixes"
// rewrote the saved connection (each breaking it for the other store), and
// the Dev-Dashboard cutover DELETEd every legacy row — from the dealer's
// chair, "every deploy wipes my tokens". Those one-time mutations are
// grandfathered below; any NEW migration that UPDATEs / DELETEs / TRUNCATEs /
// DROPs a credential table fails this test. Schema evolution stays open
// (CREATE / ALTER / function bodies are fine — the save_* writers legitimately
// upsert inside dollar-quoted bodies, which are stripped before scanning).
//
// Need to migrate credential DATA? Don't. Add a column / new shape and let the
// dealer's next save fill it — or, if truly unavoidable, make the case for
// extending the grandfather list in the same PR that adds the migration.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');

const CREDENTIAL_TABLES = ['shopify_config', 'whatsapp_config', 'ecf_credentials'];

// One-time historical mutations, shipped before this guard existed.
const GRANDFATHERED = new Set([
  '20260704130000_fix_shopify_domain.sql',
  '20260704140000_shopify_domain_alcoversrl.sql',
  '20260704150000_shopify_two_stores.sql',
  '20260705140000_shopify_dev_dashboard_only.sql',
]);

/** SQL with comments and dollar-quoted bodies (function definitions) removed —
 *  what's left is the migration's top-level statements. */
function topLevelSql(src) {
  return src
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' ')  // $$…$$ / $tag$…$tag$ bodies
    .replace(/--[^\n]*/g, ' ')                        // line comments
    .replace(/\/\*[\s\S]*?\*\//g, ' ');               // block comments
}

const MUTATION = new RegExp(
  String.raw`\b(update|delete\s+from|truncate(\s+table)?|drop\s+table(\s+if\s+exists)?)\s+(only\s+)?(public\.)?(${CREDENTIAL_TABLES.join('|')})\b`,
  'gi',
);

test('migrations never mutate saved credentials (shopify/whatsapp/ecf config rows)', () => {
  const violations = [];
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    if (GRANDFATHERED.has(name)) continue;
    const sql = topLevelSql(readFileSync(join(MIGRATIONS, name), 'utf8'));
    for (const m of sql.matchAll(MUTATION)) {
      violations.push(`${name}: ${m[0].replace(/\s+/g, ' ')}`);
    }
  }
  assert.equal(
    violations.length,
    0,
    violations.length
      ? `\nCredential-store mutations in migrations (${violations.length}) — a deploy must never erase pasted credentials; evolve the schema additively instead:\n  ${violations.join('\n  ')}\n`
      : '',
  );
});

test('the guard itself sees through dollar-quoted writer bodies', () => {
  // The save_* RPCs upsert inside $$…$$ — that must NOT trip the rule…
  const fnBody = `create function public.save_whatsapp_config() returns void language plpgsql as $$
    begin update public.whatsapp_config set updated_at = now(); end; $$;`;
  assert.equal([...topLevelSql(fnBody).matchAll(MUTATION)].length, 0);
  // …while a bare top-level mutation does.
  assert.equal([...topLevelSql('delete from public.shopify_config;').matchAll(MUTATION)].length, 1);
  assert.equal([...topLevelSql('UPDATE whatsapp_config SET access_token = NULL;').matchAll(MUTATION)].length, 1);
});
