/**
 * Pure row-mapping helpers shared by every Supabase round-trip.
 *
 * The app code uses camelCase property names (`commissionPct`,
 * `createdAt`, `lineDiscountPct`); Postgres uses snake_case
 * (`commission_pct`, `created_at`, `line_discount_pct`). These two
 * converters bridge the layers in both directions so the rest of the
 * codebase never thinks about it.
 *
 * `*At` fields (created_at, updated_at, last_sign_in_at,
 * password_set_at, deposit_received_at, etc.) are additionally
 * coerced between ISO-8601 strings (Postgres `timestamptz` shape) and
 * JS timestamps (`Date.now()`-shaped numbers). Storing timestamps as
 * numbers in JS lets the UI do plain math (`Date.now() - x`); the
 * round-trip into Postgres requires the ISO string Postgres expects.
 *
 * Lifted out of database.js so the conversion contract can be unit-
 * tested without touching @supabase/supabase-js. The commission-pct
 * bug we shipped earlier was exactly the kind of regression a
 * contract test on fromRow would have caught — reading
 * `profile.commission_pct` on an object that had just been
 * camelCased through here.
 *
 * TOP-LEVEL ONLY (load-bearing contract): both converters walk ONLY the
 * own enumerable keys of the object handed in — they do NOT recurse into
 * nested objects/arrays. A value stored as `jsonb` (a `settings` blob, an
 * `exchangeRate` snapshot, a `components[]` array) is passed through
 * verbatim: its inner keys keep whatever casing the app uses (camelCase),
 * and a nested `*At` field is NOT coerced (it stays a number on the way
 * in and out). This is deliberate — jsonb columns round-trip their own
 * shape through Postgres unchanged, so recursing here would silently
 * rename keys inside a dealer's settings blob and break reads. Blind
 * recursion is the risky path; keep the contract flat and let jsonb own
 * its interior. (Pinned by tests/rowMapping.test.js.)
 */

/** Generic dictionary type — what Supabase returns / accepts in JSON. */
export type Row = Record<string, unknown>;

export function snake(name: string): string {
  return name.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
}

export function camel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Field-name convention: anything ending in `At` is a timestamp. */
export function isAtField(camelKey: string): boolean {
  return /At$/.test(camelKey);
}

/**
 * Camel → snake. Coerces *At numeric timestamps to ISO-8601 strings so
 * Postgres timestamptz columns accept them.
 */
export function toRow(obj: Row | null | undefined): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(obj || {})) {
    let val: unknown = v;
    if (isAtField(k) && typeof v === 'number' && Number.isFinite(v)) {
      val = new Date(v).toISOString();
    }
    out[snake(k)] = val;
  }
  return out;
}

/**
 * Snake → camel. Coerces *At ISO-8601 strings back to JS millisecond
 * timestamps. Non-object inputs (null, primitives) pass through
 * unchanged — callers occasionally hand us `.maybeSingle()` results
 * that come back as `null` and we don't want to wrap them in an
 * empty object.
 */
export function fromRow<T = Row>(row: unknown): T | null | undefined {
  if (row === null) return null;
  if (row === undefined) return undefined;
  if (typeof row !== 'object') return row as T;
  const out: Row = {};
  for (const [k, v] of Object.entries(row as Row)) {
    const ck = camel(k);
    let val: unknown = v;
    if (isAtField(ck) && typeof v === 'string') {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) val = t;
    }
    out[ck] = val;
  }
  return out as T;
}

export const fromRows = <T = Row>(rows: unknown[] | null | undefined): T[] =>
  (rows || []).map((r) => fromRow<T>(r) as T);
