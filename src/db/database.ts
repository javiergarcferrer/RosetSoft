import { supabase, publicImageUrl, IMAGES_BUCKET } from './supabaseClient.js';
import { snake, toRow, fromRow, fromRows, type Row } from './rowMapping.js';
import type {
  Profile,
  Settings,
  Customer,
  Professional,
  Order,
  Quote,
  QuoteLine,
  Container,
  ImageRecord,
  Material,
  ModelFabrics,
  QuoteGroup,
  Product,
  Account,
  JournalEntry,
  JournalLine,
  Supplier,
  Expense,
  SalePosting,
  InventoryItem,
  InventoryMovement,
  Purchase,
} from '../types/domain.ts';

/**
 * Roset Soft cloud data layer.
 *
 * Exposes a Dexie-shaped API (`db.<table>.where().equals().toArray()`, etc.)
 * backed by Supabase Postgres + Storage. The React pages continue to import
 * `db`, `newId`, and the image helpers from this module without knowing
 * they're talking to the cloud.
 *
 * Row-name conversion (camelCase ↔ snake_case + timestamp coercion) lives
 * in `./rowMapping.js` so the contract can be tested without a Supabase
 * mock.
 *
 * Mutations call `invalidate()` so the `useLiveQuery` hook refetches.
 */

/* ---------------------------------------------------------------------- */
/*  Table catalog                                                          */
/* ---------------------------------------------------------------------- */

interface TableDef {
  /** Postgres relation name (snake_case). */
  db: string;
  /** Primary-key property as seen from JS code (camelCase). */
  pk: string;
}

/**
 * Map of JS-side table names → their Postgres relation + PK metadata.
 * The shape of `TABLES` is the source of truth for `TableName` and the
 * `db` typed object below.
 */
const TABLES = {
  profiles:      { db: 'profiles',      pk: 'id' },
  settings:      { db: 'settings',      pk: 'profileId' },
  images:        { db: 'images',        pk: 'id' },
  customers:     { db: 'customers',     pk: 'id' },
  professionals: { db: 'professionals', pk: 'id' },
  orders:        { db: 'orders',        pk: 'id' },
  quotes:        { db: 'quotes',        pk: 'id' },
  quoteLines:    { db: 'quote_lines',   pk: 'id' },
  quoteGroups:   { db: 'quote_groups',  pk: 'id' },
  containers:    { db: 'containers',    pk: 'id' },
  materials:     { db: 'materials',     pk: 'id' },
  products:      { db: 'products',      pk: 'id' },
  modelFabrics:  { db: 'model_fabrics', pk: 'id' },
  accounts:      { db: 'accounts',        pk: 'code' },
  journalEntries:{ db: 'journal_entries', pk: 'id' },
  journalLines:  { db: 'journal_lines',   pk: 'id' },
  suppliers:     { db: 'suppliers',       pk: 'id' },
  expenses:      { db: 'expenses',        pk: 'id' },
  salesPostings: { db: 'sales_postings',  pk: 'id' },
  inventoryItems:     { db: 'inventory_items',     pk: 'id' },
  inventoryMovements: { db: 'inventory_movements', pk: 'id' },
  purchases:          { db: 'purchases',           pk: 'id' },
} as const satisfies Record<string, TableDef>;

export type TableName = keyof typeof TABLES;

/**
 * JS table name → domain row type. Every entry maps to the camelCased
 * shape `fromRow` produces; the snake-case Postgres column names never
 * escape this file.
 */
export interface TableRowMap {
  profiles: Profile;
  settings: Settings;
  images: ImageRecord;
  customers: Customer;
  professionals: Professional;
  orders: Order;
  quotes: Quote;
  quoteLines: QuoteLine;
  quoteGroups: QuoteGroup;
  containers: Container;
  materials: Material;
  products: Product;
  modelFabrics: ModelFabrics;
  accounts: Account;
  journalEntries: JournalEntry;
  journalLines: JournalLine;
  suppliers: Supplier;
  expenses: Expense;
  salesPostings: SalePosting;
  inventoryItems: InventoryItem;
  inventoryMovements: InventoryMovement;
  purchases: Purchase;
}

// Row mapping (snake_case ↔ camelCase + *At timestamp coercion) is in
// `./rowMapping.js` so the conversion contract can be unit-tested
// without standing up @supabase/supabase-js. The bug the test suite
// over there catches: reading `profile.commission_pct` on an object
// that's already been camelCased through fromRow returns undefined.

/* ---------------------------------------------------------------------- */
/*  Invalidation bus (powers useLiveQuery)                                 */
/* ---------------------------------------------------------------------- */

type InvalidateCallback = () => void;

const listeners = new Set<InvalidateCallback>();
export function subscribeInvalidate(cb: InvalidateCallback): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
export function invalidate(): void {
  for (const cb of [...listeners]) {
    try { cb(); } catch (e) { console.error(e); }
  }
}

/* ---------------------------------------------------------------------- */
/*  Chainable Query — matches Dexie's where().equals().toArray()/sortBy() */
/* ---------------------------------------------------------------------- */

interface Filter {
  field: string;
  value: unknown;
}

/**
 * `Query<T>` is the chainable builder returned by `Table<T>.where()` /
 * `Table<T>.orderBy()`. Each chain step returns `this` so call sites
 * can fluently compose: `db.X.where(...).equals(...).reverse().sortBy(...)`.
 *
 * `T` is the camelCased domain row type (`Quote`, `Order`, etc.). The
 * terminal methods (`toArray`, `sortBy`, `first`) all resolve to that
 * row shape; `count` resolves to `number`.
 */
export class Query<T> implements PromiseLike<T[]> {
  private t: TableDef;
  private filters: Filter[] = [];
  private pending: string | null = null;
  private orderField: string | null = null;
  private sortField: string | null = null;
  private reversed = false;
  private predicate: ((row: T) => boolean) | null = null;
  private _limit: number | null = null;

  constructor(table: TableDef) {
    this.t = table;
  }

  where(field: (keyof T & string) | string): this {
    // A trailing where() without a matching equals() would silently
    // swallow the filter and return the whole table. Fail-fast at
    // the next call instead of returning corrupt data.
    if (typeof field !== 'string' || !field) {
      throw new Error('where() requires a non-empty field name');
    }
    if (this.pending != null) {
      throw new Error(`where('${field}') called twice without an equals() between them`);
    }
    this.pending = field;
    return this;
  }
  equals(value: unknown): this {
    if (this.pending == null) throw new Error('equals() called without where()');
    this.filters.push({ field: this.pending, value });
    this.pending = null;
    return this;
  }
  orderBy(field: (keyof T & string) | string): this {
    if (typeof field !== 'string' || !field) {
      throw new Error('orderBy() requires a non-empty field name');
    }
    this.orderField = field;
    return this;
  }
  reverse(): this { this.reversed = true; return this; }
  filter(fn: (row: T) => boolean): this {
    if (typeof fn !== 'function') {
      throw new Error('filter() requires a predicate function');
    }
    this.predicate = fn;
    return this;
  }
  limit(n: number): this {
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      throw new Error(`limit() requires a positive integer (got ${n})`);
    }
    this._limit = n;
    return this;
  }

  private async _execute(): Promise<T[]> {
    // Catch the "trailing where() without equals()" shape at execution
    // time too. The where() guard above prevents back-to-back
    // where()s, but a single .where('x').toArray() falls through here.
    if (this.pending != null) {
      throw new Error(`Incomplete query: .where('${this.pending}') has no matching .equals()`);
    }
    const build = () => {
      let q = supabase.from(this.t.db).select('*');
      for (const f of this.filters) q = q.eq(snake(f.field), f.value);
      if (this.orderField) {
        q = q.order(snake(this.orderField), { ascending: !this.reversed });
      }
      return q;
    };

    let raw: unknown[];
    if (this._limit) {
      const { data, error } = await build().limit(this._limit);
      if (error) throw error;
      raw = (data as unknown[]) || [];
    } else {
      // No explicit limit → return ALL rows, paging past Supabase's default
      // 1000-row API cap (Settings → API → Max Rows). Without this a large
      // table (the catalog is thousands of SKUs) silently truncates at 1000.
      // Paging needs a stable order; add the primary key when the caller
      // didn't request one so pages don't overlap or skip rows.
      const PAGE = 1000;
      raw = [];
      for (let from = 0; ; from += PAGE) {
        let q = build();
        if (!this.orderField) q = q.order(snake(this.t.pk), { ascending: true });
        const { data, error } = await q.range(from, from + PAGE - 1);
        if (error) throw error;
        const page = (data as unknown[]) || [];
        raw = from === 0 ? page : raw.concat(page);
        if (page.length < PAGE) break;
      }
    }
    let rows = fromRows<T>(raw);
    if (this.predicate) rows = rows.filter(this.predicate);
    if (this.sortField) {
      const f = this.sortField as keyof T;
      rows.sort((a, b) => {
        const av = a[f] as unknown;
        const bv = b[f] as unknown;
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === 'number' && typeof bv === 'number') return av - bv;
        return String(av).localeCompare(String(bv));
      });
      if (this.reversed) rows.reverse();
    }
    return rows;
  }

  async toArray(): Promise<T[]>     { return this._execute(); }
  async sortBy(field: (keyof T & string) | string): Promise<T[]> {
    this.sortField = field;
    return this._execute();
  }
  async first(): Promise<T | null> {
    this._limit = 1;
    const rows = await this._execute();
    return rows[0] || null;
  }
  async count(): Promise<number> {
    let q = supabase.from(this.t.db).select('*', { count: 'exact', head: !this.predicate });
    for (const f of this.filters) q = q.eq(snake(f.field), f.value);
    if (this.predicate) {
      const { data, error } = await q;
      if (error) throw error;
      return fromRows<T>(data as unknown[] | null | undefined).filter(this.predicate).length;
    }
    const { count, error } = await q;
    if (error) throw error;
    return count || 0;
  }

  // Thenable, so `await db.X.where(...).equals(...).reverse().sortBy(...)` works.
  then<TResult1 = T[], TResult2 = never>(
    onF?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onR?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
  ): PromiseLike<TResult1 | TResult2> {
    return this._execute().then(onF, onR);
  }
}

/** Options for `Table.bulkPut`. */
export interface BulkPutOptions {
  chunkSize?: number;
  retries?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * `Table<T>` is the Dexie-shaped facade for a single Postgres relation.
 * The `T` generic parameter is the camelCased domain row type, which
 * makes `await db.quotes.toArray()` return `Promise<Quote[]>` and
 * `await db.profiles.get(id)` return `Promise<Profile | null>` without
 * a manual cast at the call site.
 */
export class Table<T> {
  readonly jsName: TableName;
  private t: TableDef;

  constructor(jsName: TableName) {
    this.jsName = jsName;
    this.t = TABLES[jsName];
  }
  where(field: (keyof T & string) | string): Query<T>   { return new Query<T>(this.t).where(field); }
  orderBy(field: (keyof T & string) | string): Query<T> { return new Query<T>(this.t).orderBy(field); }
  toArray(): Promise<T[]>     { return new Query<T>(this.t).toArray(); }
  count(): Promise<number>    { return new Query<T>(this.t).count(); }

  async get(id: string | null | undefined): Promise<T | null> {
    if (id == null) return null;
    const pkCol = snake(this.t.pk);
    const { data, error } = await supabase
      .from(this.t.db).select('*').eq(pkCol, id).limit(1).maybeSingle();
    if (error) throw error;
    return (fromRow<T>(data) as T | null) ?? null;
  }

  async put(record: T): Promise<T[keyof T] | undefined> {
    const row = toRow(record as unknown as Row);
    const { error } = await supabase
      .from(this.t.db).upsert(row, { onConflict: snake(this.t.pk) });
    if (error) throw error;
    invalidate();
    return (record as Record<string, unknown>)[this.t.pk] as T[keyof T] | undefined;
  }

  /**
   * Batched upsert with retry. Use for bulk imports — one Supabase round-trip
   * per chunk instead of one per row. The catalog import script can land a
   * ~7500-row variant table in ~15 requests this way.
   *
   *   chunkSize  rows per request (500 is the community-validated sweet spot
   *              for PostgREST upserts; the 1000-row default is the SELECT
   *              return cap, not a write cap, but we stay well under it to
   *              keep payload + transaction time bounded)
   *   retries    extra attempts per batch after the initial try (3 → 4 total)
   *   onProgress (done, total) called after each successful batch
   */
  async bulkPut(records: T[], { chunkSize = 500, retries = 3, onProgress }: BulkPutOptions = {}): Promise<number> {
    if (!Array.isArray(records)) {
      throw new Error('bulkPut: records must be an array');
    }
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
      throw new Error(`bulkPut: chunkSize must be a positive integer (got ${chunkSize})`);
    }
    if (!Number.isInteger(retries) || retries < 0) {
      throw new Error(`bulkPut: retries must be a non-negative integer (got ${retries})`);
    }
    const rows = records.map((r) => toRow(r as unknown as Row));
    if (!rows.length) return 0;
    const conflictKey = snake(this.t.pk);
    let done = 0;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      let lastErr: { message?: string } | null = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const { error } = await supabase
          .from(this.t.db)
          .upsert(chunk, { onConflict: conflictKey });
        if (!error) { lastErr = null; break; }
        lastErr = error;
        if (attempt < retries) {
          const delay = 600 * Math.pow(2, attempt) + Math.random() * 250;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      if (lastErr) {
        throw new Error(
          `bulkPut ${this.t.db}: failed batch ${i}-${i + chunk.length} after ${retries + 1} attempts: ${lastErr.message || lastErr}`
        );
      }
      done += chunk.length;
      onProgress?.(done, rows.length);
    }
    invalidate();
    return done;
  }

  async update(id: string, patch: Partial<T>): Promise<void> {
    const pkCol = snake(this.t.pk);
    const { error } = await supabase
      .from(this.t.db).update(toRow(patch as unknown as Row)).eq(pkCol, id);
    if (error) throw error;
    invalidate();
  }

  async delete(id: string): Promise<void> {
    const pkCol = snake(this.t.pk);
    const { error } = await supabase.from(this.t.db).delete().eq(pkCol, id);
    if (error) throw error;
    invalidate();
  }

  async bulkDelete(ids: string[] | null | undefined): Promise<void> {
    if (!ids?.length) return;
    const pkCol = snake(this.t.pk);
    const { error } = await supabase.from(this.t.db).delete().in(pkCol, ids);
    if (error) throw error;
    invalidate();
  }
}

/**
 * The typed `db` object — `{ profiles: Table<Profile>, settings:
 * Table<Settings>, ... }`. Each entry is a `Table<T>` where `T` is
 * the matching domain row type from `TableRowMap`.
 */
export type Db = { [K in TableName]: Table<TableRowMap[K]> };

export const db: Db = Object.fromEntries(
  (Object.keys(TABLES) as TableName[]).map((k) => [k, new Table(k)]),
) as Db;

/**
 * Server-side catalog search. The product catalog is tens of thousands of SKUs
 * — far past Supabase's default 1000-row API cap — so list pages and the
 * quote-builder picker must NOT load the whole table client-side (that was a
 * multi-second hang + a false "empty" flash). This filters in Postgres: an OR
 * of case-insensitive substring matches across the fields a dealer searches by
 * (reference / name / family), ordered by name and capped at `limit`. An empty
 * term returns the first `limit` rows by name — a bounded browse set. Names are
 * whitespace-normalized at import (priceListCsv.squish) so a single-space query
 * matches a double-spaced source name.
 */
export async function searchProducts(profileId: string, term: string, limit = 400): Promise<Product[]> {
  let q = supabase.from('products').select('*').eq('profile_id', profileId);
  const needle = term.trim();
  if (needle) {
    // PostgREST or() is a comma-separated list and ilike treats % as the
    // wildcard; strip the characters that would break that filter grammar, and
    // collapse whitespace runs so a single-spaced query matches regardless of
    // how the term was typed (the catalog data is normalized to single spaces).
    const safe = needle.replace(/[%,()*]/g, ' ').replace(/\s+/g, ' ').trim();
    if (safe) {
      q = q.or(`reference.ilike.%${safe}%,name.ilike.%${safe}%,family.ilike.%${safe}%`);
    }
  }
  const { data, error } = await q.order('name').limit(limit);
  if (error) throw error;
  return fromRows<Product>(data as unknown[] | null | undefined);
}

/** A catalog category bucket — the category label + how many SKUs it holds. */
export interface CatalogCategory {
  category: string;
  count: number;
}

/**
 * The distinct product categories for a profile, each with its SKU count, in
 * ONE round-trip. The catalog browser lists every category up-front (collapsed)
 * and only loads a category's products when it's opened, so it must never pull
 * the whole (tens-of-thousands-row) table just to learn the category names.
 *
 * Fast path: the `catalog_categories` SQL function (a server-side GROUP BY,
 * which PostgREST can't express over its REST grammar). Fallback — used when
 * that function isn't deployed yet or errors — pages the lightweight `category`
 * column and dedupes client-side: slower, but it works under the existing
 * team-read RLS so the page degrades gracefully instead of breaking.
 */
export async function catalogCategories(profileId: string): Promise<CatalogCategory[]> {
  const { data, error } = await supabase.rpc('catalog_categories', { p_profile_id: profileId });
  if (!error && Array.isArray(data)) {
    return (data as Array<{ category?: string | null; sku_count?: number | string }>).map((r) => ({
      category: (r.category || '').trim(),
      count: Number(r.sku_count) || 0,
    }));
  }
  if (error) console.warn('[catalog] catalog_categories RPC unavailable, falling back:', error.message);
  return catalogCategoriesFallback(profileId);
}

async function catalogCategoriesFallback(profileId: string): Promise<CatalogCategory[]> {
  const PAGE = 1000;
  const counts = new Map<string, number>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('products')
      .select('category')
      .eq('profile_id', profileId)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data as Array<{ category?: string | null }>) || [];
    for (const r of page) {
      const key = (r.category || '').trim();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    if (page.length < PAGE) break;
  }
  return [...counts.entries()].map(([category, count]) => ({ category, count }));
}

/**
 * Every product in one category, ordered by name — the lazy payload behind a
 * catalog category card. Pages past Supabase's 1000-row API cap so a large
 * category (Upholstery) comes back whole; an empty `category` matches the
 * null/blank bucket. The caller groups these into models via `groupFamilies`.
 */
export async function productsByCategory(profileId: string, category: string): Promise<Product[]> {
  const PAGE = 1000;
  let out: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from('products').select('*').eq('profile_id', profileId);
    q = category ? q.eq('category', category) : q.or('category.is.null,category.eq.');
    const { data, error } = await q.order('name').order('id').range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data as unknown[]) || [];
    out = from === 0 ? page : out.concat(page);
    if (page.length < PAGE) break;
  }
  return fromRows<Product>(out);
}

/* ---------------------------------------------------------------------- */
/*  Sequential numbering                                                   */
/* ---------------------------------------------------------------------- */

/**
 * Assign the next sequential `number` for a per-profile collection
 * (quotes, orders, containers). The rule is:
 *
 *     next = max(existing number) + 1, or `start` if no rows exist.
 *
 * The dealer's mental model — and the reason the previous
 * persisted-counter approach was wrong — is that the *current numeric
 * top* is the source of truth, not a counter that only ratchets up:
 *
 *   • Delete the highest-numbered row (the most recent one) and that
 *     number is *reused* by the next create. Counters never gave that
 *     back; they kept advancing past holes.
 *
 *   • Delete a non-highest row (a middle one) and the hole stays. The
 *     next create still goes above the current top. The dealer's words:
 *     "si borro la #3 y voy por la #5, la siguiente no puede tener el
 *     número 3". Chronology beats hole-filling.
 *
 *   • A counter persisted in `settings` was also fragile: the previous
 *     code did `put(quote with number=N)` then `settings.put({counter:
 *     N})` as two separate writes. If the second one failed (network
 *     blip, page close), the next create would re-issue N. Computing
 *     from the table itself removes that desync entirely.
 *
 * Concurrency: with multiple dealers active in the team, the read
 * here can race against another browser's read+write. Migration
 * 20260519160000 added `UNIQUE(profile_id, number)` constraints on
 * the three numbered tables, so a duplicate INSERT now errors with
 * Postgres `23505` (unique_violation) instead of silently double-
 * issuing. Callers that need to be safe under that race should use
 * `assignSequenceNumber()` below, which wraps the read + insert in a
 * retry loop. Direct `nextSequenceNumber` callers continue to work
 * but will see a save error on the (rare) collision.
 *
 *   tableName  one of TABLES keys ('quotes', 'orders', 'containers').
 *   profileId  scopes the query (numbers don't collide across profiles
 *              even though right now there's only the 'team' profile).
 *   start      the value to use when no rows exist yet. Picked so the
 *              first issued number isn't #1 — dealers prefer
 *              #1001/#101 since "Cotización #1" looks rookie. Defaults:
 *              quotes 1001, orders 101, containers 101.
 */
export async function nextSequenceNumber(
  tableName: TableName,
  profileId: string,
  start: number,
): Promise<number> {
  const tbl = TABLES[tableName];
  if (!tbl) throw new Error(`Unknown table ${tableName}`);
  const { data, error } = await supabase
    .from(tbl.db)
    .select('number')
    .eq('profile_id', profileId)
    .not('number', 'is', null)
    .order('number', { ascending: false })
    .limit(1);
  if (error) throw error;
  const rows = data as Array<{ number?: number | string | null }> | null;
  return computeNextSequenceNumber(rows?.[0]?.number ?? null, start);
}

/** Arguments to `assignSequenceNumber`. The `build` lambda receives the
 *  freshly-computed `number` and returns the full row to insert. */
export interface AssignSequenceNumberArgs<T> {
  table: TableName;
  profileId: string;
  start: number;
  build: (number: number) => T;
  maxAttempts?: number;
}

/**
 * Race-safe assign-and-insert: compute the next sequence number,
 * build the record with that number, and insert. Retries on
 * unique-violation (another browser tab won the race) up to
 * `maxAttempts` times before giving up — by that point we're past
 * "concurrent click" and into "something else is wrong".
 *
 * Callers pass a `build(number)` lambda that returns the row to
 * insert; the helper takes care of the read → write loop.
 *
 *   const id = newId();
 *   await assignSequenceNumber({
 *     table: 'quotes',
 *     profileId,
 *     start: 1001,
 *     build: (number) => ({ id, profileId, number, ... }),
 *   });
 */
export async function assignSequenceNumber<T>({
  table, profileId, start, build, maxAttempts = 5,
}: AssignSequenceNumberArgs<T>): Promise<T> {
  // Fail-fast at the boundary so a typo'd table name doesn't burn
  // five round-trips before surfacing.
  const tbl = db[table as TableName] as unknown as Table<T> | undefined;
  if (!tbl) throw new Error(`assignSequenceNumber: unknown table '${table}'`);
  if (typeof profileId !== 'string' || !profileId) {
    throw new Error('assignSequenceNumber: profileId must be a non-empty string');
  }
  if (!Number.isInteger(start) || start < 0) {
    throw new Error(`assignSequenceNumber: start must be a non-negative integer (got ${start})`);
  }
  if (typeof build !== 'function') {
    throw new Error('assignSequenceNumber: build must be a function');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`assignSequenceNumber: maxAttempts must be a positive integer (got ${maxAttempts})`);
  }

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const number = await nextSequenceNumber(table, profileId, start);
    const record = build(number);
    if (!record || typeof record !== 'object') {
      throw new Error('assignSequenceNumber: build() must return a record object');
    }
    try {
      await tbl.put(record);
      return record;
    } catch (err) {
      lastErr = err;
      // Postgres unique_violation. Another browser took our slot; loop
      // back and recompute against the new max. Anything else is a
      // real failure — surface immediately rather than burn the retry
      // budget on an error that won't resolve itself (FK violation,
      // RLS, network).
      if ((err as { code?: string } | null)?.code !== '23505') throw err;
    }
  }
  throw lastErr;
}

/**
 * Pure-function core of nextSequenceNumber, extracted so the rule can be
 * unit-tested without a Supabase round-trip.
 *
 *   computeNextSequenceNumber(null,   1001) === 1001    // empty table
 *   computeNextSequenceNumber(1003,   1001) === 1004    // top + 1
 *   computeNextSequenceNumber('1003', 1001) === 1004    // coerces strings
 *
 * The string-coerce branch handles Supabase returning bigints as strings
 * for some PostgREST configurations — without `Number()` we'd land on
 * "10031" instead of 1004.
 */
export function computeNextSequenceNumber(
  currentMax: number | string | null | undefined,
  start: number,
): number {
  if (currentMax == null) return start;
  return Number(currentMax) + 1;
}

/* ---------------------------------------------------------------------- */
/*  IDs                                                                    */
/* ---------------------------------------------------------------------- */

/**
 * Generate a unique id for a new row.
 *
 * crypto.randomUUID() is the source of truth — 122 bits of entropy
 * gives effectively-zero collision probability even at high write
 * concurrency, which the previous `Date.now() + 6 base36 chars`
 * scheme couldn't guarantee (~26 bits of randomness; two clients
 * writing in the same millisecond could collide, and Supabase would
 * silently overwrite one of the rows on upsert).
 *
 * The fallback covers older browser engines that predate
 * crypto.randomUUID (Safari < 15.4, etc.) and any non-secure-context
 * test environment where the API isn't exposed. It's the legacy
 * scheme — good enough for the rare environments that need it, since
 * the production app runs on a secure context.
 *
 * Existing rows in the DB keep their old-shape ids; both shapes live
 * side-by-side in TEXT primary-key columns without issue.
 */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------------------------------------------------------------------- */
/*  Images — backed by the `images` Storage bucket + `images` table       */
/* ---------------------------------------------------------------------- */

export async function fileToBlob(file: Blob | File): Promise<Blob> {
  if (file instanceof Blob) return file;
  const buf = await (file as File).arrayBuffer();
  return new Blob([buf], { type: (file as File).type || 'application/octet-stream' });
}

function extensionForType(type: string | null | undefined): string {
  if (!type) return 'bin';
  const m = type.match(/^image\/([a-z0-9]+)/i);
  if (!m) return 'bin';
  return m[1].toLowerCase().replace('jpeg', 'jpg');
}

// Per-call defaults for image upload validation. The dealer's photos
// (line items, logos) are JPEGs and PNGs from phone cameras — usually
// ~1–3 MB after the browser's HEIC → JPEG conversion. 10 MB is
// generous headroom; SVG logos are tiny. Anything larger is almost
// certainly an unintentional upload (a 12 MP raw photo, a screen
// recording) and should fail fast at the boundary instead of stuck
// in a slow upload that times out the dealer's flaky LTE.
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;     // 10 MB
const IMAGE_ALLOWED_MIME = /^image\/(png|jpe?g|webp|gif|svg\+xml|avif|heic|heif)$/i;

/** Arguments to `saveImage`. `kind` is the owning entity ('quoteLine',
 *  'professional', 'settings-logo', ...); `ownerId` is the owning row's
 *  primary key. */
export interface SaveImageArgs {
  kind: string;
  ownerId?: string | null;
  file: Blob | File;
  label?: string;
}

/**
 * Upload a file to the images bucket and write the corresponding
 * `images` table row. Returns the new image id.
 *
 * Throws (rejects) at the boundary on:
 *   • zero-byte file (the dealer dragged a corrupted preview)
 *   • non-image MIME type (someone dropped a PDF / docx into ImageDrop)
 *   • file larger than IMAGE_MAX_BYTES (a stray raw photo)
 *
 * The thrown Error message is surfaced inline by ImageDrop — keep it
 * short and dealer-readable rather than the underlying Supabase
 * error.
 */
export async function saveImage({ kind, ownerId, file, label = '' }: SaveImageArgs): Promise<string> {
  if (!file) throw new Error('No se recibió ningún archivo.');
  const blob = await fileToBlob(file);

  if (!blob.size || blob.size <= 0) {
    throw new Error('El archivo está vacío.');
  }
  if (blob.size > IMAGE_MAX_BYTES) {
    const mb = (blob.size / 1024 / 1024).toFixed(1);
    throw new Error(`Imagen demasiado grande (${mb} MB). Máximo ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)} MB.`);
  }
  const mime = blob.type || '';
  if (!IMAGE_ALLOWED_MIME.test(mime)) {
    throw new Error(`Formato no soportado: ${mime || 'desconocido'}. Usa PNG, JPG, WEBP, GIF, SVG, AVIF o HEIC.`);
  }

  const id = newId();
  const ext = extensionForType(blob.type);
  const storagePath = `${id}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from(IMAGES_BUCKET)
    .upload(storagePath, blob, {
      contentType: blob.type || 'application/octet-stream',
      cacheControl: '31536000',
      upsert: false,
    });
  if (upErr) throw upErr;
  await db.images.put({
    id,
    kind,
    ownerId,
    label,
    contentType: blob.type || 'application/octet-stream',
    size: blob.size,
    storagePath,
  });
  return id;
}

export async function deleteImage(id: string | null | undefined): Promise<void> {
  if (!id) return;
  const rec = await db.images.get(id);
  if (rec?.storagePath) {
    await supabase.storage.from(IMAGES_BUCKET).remove([rec.storagePath]).catch(() => {});
  }
  await db.images.delete(id);
}

/** Fetch raw image bytes — used by the PDF generator to embed images. */
export async function downloadImageBytes(
  id: string | null | undefined,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!id) return null;
  const rec = await db.images.get(id);
  if (!rec?.storagePath) return null;
  const { data, error } = await supabase.storage.from(IMAGES_BUCKET).download(rec.storagePath);
  if (error || !data) return null;
  const buf = await data.arrayBuffer();
  return { bytes: new Uint8Array(buf), contentType: rec.contentType || data.type };
}

/* ---------------------------------------------------------------------- */
/*  Profiles + Settings                                                    */
/* ---------------------------------------------------------------------- */

// Single-tenant: every authenticated team member operates on the shared
// 'team' profile. Customers and quotes are scoped to this single profile
// id so all team members see the same data.
export const TEAM_PROFILE_ID = 'team';

/**
 * Delete duplicate profile rows that share an email (case-insensitive).
 *
 * Two profile rows with the same email is always a bug — Supabase Auth
 * enforces uniqueness on `auth.users.email`, so any duplicate in
 * `public.profiles` means at least one row is an orphan (its auth.users
 * counterpart is gone) or a leftover from a previous failed delete.
 *
 * The dealer keeps hitting this state in production because (a) the
 * unique-email index that would block it lives in migration
 * 20260518150000, which hasn't propagated yet, and (b) the older
 * `delete-user` Edge Function was failing on its post-delete UPDATE
 * (the missing `updated_at` column), leaving auth gone but profile
 * alive — so the next invite would create a second profile for the
 * same email.
 *
 * We pick a "winner" per email group:
 *   1. active=true beats active=false
 *   2. then most recent (lastSignInAt > updatedAt > createdAt)
 * and DELETE every other row. The deletes hit `public.profiles` over
 * the Supabase REST API under the caller's RLS — no edge function,
 * no service-role key, no local-only state. The Users page's live
 * query refetches because `bulkDelete` calls `invalidate()`, so the
 * list reflects Postgres truth on the next render.
 *
 * Returns the list of deleted ids so callers can log/notify.
 * Idempotent: a second call on a clean dataset deletes nothing.
 */
export async function dedupeProfilesByEmail(): Promise<string[]> {
  const all = await db.profiles.toArray();
  const byEmail = new Map<string, Profile[]>();
  for (const p of all) {
    if (!p.email || p.id === TEAM_PROFILE_ID) continue;
    const key = String(p.email).toLowerCase().trim();
    if (!key) continue;
    if (!byEmail.has(key)) byEmail.set(key, []);
    byEmail.get(key)!.push(p);
  }
  const toDelete: string[] = [];
  for (const rows of byEmail.values()) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => {
      // Active wins over inactive.
      if (!!a.active !== !!b.active) return a.active ? -1 : 1;
      // Then most recent signal wins. `lastSignInAt` is the strongest
      // proof of life; fall back through updatedAt and createdAt so a
      // freshly-invited row (lastSignInAt null) still has a comparable
      // timestamp.
      const ta = a.lastSignInAt || a.updatedAt || a.createdAt || 0;
      const tb = b.lastSignInAt || b.updatedAt || b.createdAt || 0;
      return tb - ta;
    });
    for (let i = 1; i < rows.length; i++) {
      toDelete.push(rows[i].id);
    }
  }
  if (toDelete.length) {
    await db.profiles.bulkDelete(toDelete);
  }
  return toDelete;
}

export async function ensureDefaultProfile(): Promise<string> {
  // Make sure the team profile + settings row exist (the SQL schema bootstraps
  // these, but we tolerate empty databases too). The 'team' row is special:
  // it holds shared company settings, not a real user, so its `role` is
  // 'team' rather than 'admin' / 'employee'.
  await db.profiles.put({ id: TEAM_PROFILE_ID, name: 'Team', role: 'team', active: true }).catch(() => {});
  const cur = await db.settings.get(TEAM_PROFILE_ID);
  if (!cur) await db.settings.put({ profileId: TEAM_PROFILE_ID, adminEmails: [] }).catch(() => {});

  // Bootstrap-admin promotion. The team settings row carries an
  // `adminEmails` list (lowercase email strings). On first sign-in,
  // any user whose email matches gets role='admin' + active=true; the
  // very first auth event for `javier@alcover.do` self-bootstraps the
  // org. Every other new user lands inactive and waits for an admin to
  // approve them via the Users page.
  const { data } = await supabase.auth.getUser();
  const u = data?.user;
  if (u) {
    const settings = await db.settings.get(TEAM_PROFILE_ID).catch(() => null);
    const adminEmails = Array.isArray(settings?.adminEmails) ? settings!.adminEmails! : [];
    const email = (u.email || '').toLowerCase().trim();
    const isAllowlistedAdmin = !!email && adminEmails.map((e) => String(e).toLowerCase().trim()).includes(email);

    const existing = await db.profiles.get(u.id).catch(() => null);
    const now = Date.now();
    if (!existing) {
      // First time we've seen this user. Create their profile row.
      // Allowlisted admins land already-activated; everyone else
      // starts pending. `lastSignInAt` is stamped now because this
      // codepath only runs when a real auth session exists — i.e.
      // the user is signing in right now.
      await db.profiles.put({
        id: u.id,
        name: (u.user_metadata && (u.user_metadata as { name?: string }).name) || (u.email?.split('@')[0]) || 'Member',
        email: u.email || null,
        role: isAllowlistedAdmin ? 'admin' : 'employee',
        active: isAllowlistedAdmin,
        commissionPct: 0,
        lastSignInAt: now,
        // Bootstrap-admin code path: this user typed a password into
        // the Supabase dashboard's Add User screen, so they already
        // have one. Stamping password_set_at on creation skips the
        // SetPassword gate for them. Every other path (the edge
        // function invitation flow) leaves this field null on the
        // initial profile row so the invitee gets routed through the
        // password-setup screen on their first sign-in.
        passwordSetAt: isAllowlistedAdmin ? now : null,
      }).catch(() => {});
    } else {
      // Update lastSignInAt on every sign-in. Two extra behaviors
      // depend on what the existing row looks like:
      //
      //   1. Invitation acceptance — if the row was created by the
      //      invite-user edge function (active=false, lastSignInAt=
      //      null), this is the moment the invitee clicks the magic
      //      link for the first time. Flip them to active=true. From
      //      then on they're a working employee.
      //
      //   2. Bootstrap-admin promotion — if the user's email is in
      //      settings.admin_emails but they aren't currently an
      //      active admin, promote them. This keeps the dealer from
      //      ever locking themselves out by allowing the allowlist
      //      to be edited after the first signup.
      //
      // The two patches compose: an invited user whose email is in
      // the admin allowlist arrives as active=true + role=admin in
      // one round-trip.
      const patch: Partial<Profile> = { lastSignInAt: now };
      const isFirstAcceptance = !existing.active && !existing.lastSignInAt;
      if (isFirstAcceptance) {
        patch.active = true;
      }
      if (isAllowlistedAdmin && (!existing.active || existing.role !== 'admin')) {
        patch.role = 'admin';
        patch.active = true;
      }
      // Surface the failure rather than swallow it — the silent
      // `.catch(() => {})` here previously hid the trigger error
      // ('42501 No puedes cambiar tu propio estado activo') that
      // was breaking the invitation acceptance flow. With the
      // first-acceptance carve-out in migration 20260519220000
      // this update should now succeed; a console.warn keeps the
      // boot non-fatal but at least gives a future maintainer a
      // breadcrumb if the trigger changes again.
      try {
        await db.profiles.update(u.id, patch);
      } catch (e) {
        console.warn('[ensureDefaultProfile] profile-activation update failed:', e);
      }
    }

    // Self-heal: if a previous failed-delete cycle left an orphan
    // profile row with the same email as this user, blow it away
    // now so the admin Users page doesn't show two rows for one
    // person on the next render. Runs on every sign-in / app
    // boot — once Postgres has a clean dataset this is a no-op,
    // and the unique-email index from migration 20260518150000
    // makes it structurally impossible afterwards.
    await dedupeProfilesByEmail().catch((e) => {
      console.warn('[profiles] dedupe failed:', e);
    });
  }
  return TEAM_PROFILE_ID;
}

export async function getSettings(profileId: string): Promise<Settings | null> {
  return db.settings.get(profileId);
}

export async function updateSettings(profileId: string, patch: Partial<Settings>): Promise<void> {
  const cur = (await db.settings.get(profileId)) || { profileId } as Settings;
  await db.settings.put({ ...cur, ...patch, profileId });
}
