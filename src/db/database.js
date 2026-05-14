import { supabase, publicImageUrl, IMAGES_BUCKET } from './supabaseClient.js';

/**
 * Roset Soft cloud data layer.
 *
 * Exposes a Dexie-shaped API (`db.<table>.where().equals().toArray()`, etc.)
 * backed by Supabase Postgres + Storage. The React pages continue to import
 * `db`, `newId`, and the image helpers from this module without knowing
 * they're talking to the cloud.
 *
 * Mutations call `invalidate()` so the `useLiveQuery` hook refetches.
 */

const TABLES = {
  profiles:        { db: 'profiles',         pk: 'id' },
  settings:        { db: 'settings',         pk: 'profileId' },
  categories:      { db: 'categories',       pk: 'id' },
  materials:       { db: 'materials',        pk: 'id' },
  materialColors:  { db: 'material_colors',  pk: 'id' },
  products:        { db: 'products',         pk: 'id' },
  productVariants: { db: 'product_variants', pk: 'id' },
  images:          { db: 'images',           pk: 'id' },
  customers:       { db: 'customers',        pk: 'id' },
  quotes:          { db: 'quotes',           pk: 'id' },
  quoteLines:      { db: 'quote_lines',      pk: 'id' },
};

function snake(name) {
  return name.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
}
function camel(name) {
  return name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
function isAtField(camelKey) {
  return /At$/.test(camelKey);
}
function toRow(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    let val = v;
    if (isAtField(k) && typeof v === 'number' && Number.isFinite(v)) {
      val = new Date(v).toISOString();
    }
    out[snake(k)] = val;
  }
  return out;
}
function fromRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const ck = camel(k);
    let val = v;
    if (isAtField(ck) && typeof v === 'string') {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) val = t;
    }
    out[ck] = val;
  }
  return out;
}
const fromRows = (rows) => (rows || []).map(fromRow);

/* ---------------------------------------------------------------------- */
/*  Invalidation bus (powers useLiveQuery)                                 */
/* ---------------------------------------------------------------------- */

const listeners = new Set();
export function subscribeInvalidate(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export function invalidate() {
  for (const cb of [...listeners]) {
    try { cb(); } catch (e) { console.error(e); }
  }
}

/* ---------------------------------------------------------------------- */
/*  Chainable Query — matches Dexie's where().equals().toArray()/sortBy() */
/* ---------------------------------------------------------------------- */

class Query {
  constructor(table) {
    this.t = table;
    this.filters = [];
    this.pending = null;
    this.orderField = null;
    this.sortField = null;
    this.reversed = false;
    this.predicate = null;
    this._limit = null;
  }
  where(field)   { this.pending = field; return this; }
  equals(value)  {
    if (this.pending == null) throw new Error('equals() called without where()');
    this.filters.push({ field: this.pending, value });
    this.pending = null;
    return this;
  }
  orderBy(field) { this.orderField = field; return this; }
  reverse()      { this.reversed = true; return this; }
  filter(fn)     { this.predicate = fn; return this; }
  limit(n)       { this._limit = n; return this; }

  async _execute() {
    let q = supabase.from(this.t.db).select('*');
    for (const f of this.filters) q = q.eq(snake(f.field), f.value);
    if (this.orderField) {
      q = q.order(snake(this.orderField), { ascending: !this.reversed });
    }
    if (this._limit) q = q.limit(this._limit);
    const { data, error } = await q;
    if (error) throw error;
    let rows = fromRows(data);
    if (this.predicate) rows = rows.filter(this.predicate);
    if (this.sortField) {
      const f = this.sortField;
      rows.sort((a, b) => {
        const av = a[f], bv = b[f];
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

  async toArray()      { return this._execute(); }
  async sortBy(field)  { this.sortField = field; return this._execute(); }
  async first() {
    this._limit = 1;
    const rows = await this._execute();
    return rows[0] || null;
  }
  async count() {
    let q = supabase.from(this.t.db).select('*', { count: 'exact', head: !this.predicate });
    for (const f of this.filters) q = q.eq(snake(f.field), f.value);
    if (this.predicate) {
      const { data, error } = await q;
      if (error) throw error;
      return fromRows(data).filter(this.predicate).length;
    }
    const { count, error } = await q;
    if (error) throw error;
    return count || 0;
  }

  // Thenable, so `await db.X.where(...).equals(...).reverse().sortBy(...)` works.
  then(onF, onR) { return this._execute().then(onF, onR); }
}

class Table {
  constructor(jsName) {
    this.jsName = jsName;
    this.t = TABLES[jsName];
  }
  where(field)   { return new Query(this.t).where(field); }
  orderBy(field) { return new Query(this.t).orderBy(field); }
  toArray()      { return new Query(this.t).toArray(); }
  count()        { return new Query(this.t).count(); }

  async get(id) {
    if (id == null) return null;
    const pkCol = snake(this.t.pk);
    const { data, error } = await supabase
      .from(this.t.db).select('*').eq(pkCol, id).limit(1).maybeSingle();
    if (error) throw error;
    return fromRow(data);
  }

  async put(record) {
    const row = toRow(record);
    const { error } = await supabase
      .from(this.t.db).upsert(row, { onConflict: snake(this.t.pk) });
    if (error) throw error;
    invalidate();
    return record[this.t.pk];
  }

  async update(id, patch) {
    const pkCol = snake(this.t.pk);
    const { error } = await supabase
      .from(this.t.db).update(toRow(patch)).eq(pkCol, id);
    if (error) throw error;
    invalidate();
  }

  async delete(id) {
    const pkCol = snake(this.t.pk);
    const { error } = await supabase.from(this.t.db).delete().eq(pkCol, id);
    if (error) throw error;
    invalidate();
  }

  async bulkDelete(ids) {
    if (!ids?.length) return;
    const pkCol = snake(this.t.pk);
    const { error } = await supabase.from(this.t.db).delete().in(pkCol, ids);
    if (error) throw error;
    invalidate();
  }
}

export const db = Object.fromEntries(
  Object.keys(TABLES).map((k) => [k, new Table(k)]),
);

/* ---------------------------------------------------------------------- */
/*  IDs                                                                    */
/* ---------------------------------------------------------------------- */

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------------------------------------------------------------------- */
/*  Images — backed by the `images` Storage bucket + `images` table       */
/* ---------------------------------------------------------------------- */

export async function fileToBlob(file) {
  if (file instanceof Blob) return file;
  const buf = await file.arrayBuffer();
  return new Blob([buf], { type: file.type || 'application/octet-stream' });
}

function extensionForType(type) {
  if (!type) return 'bin';
  const m = type.match(/^image\/([a-z0-9]+)/i);
  if (!m) return 'bin';
  return m[1].toLowerCase().replace('jpeg', 'jpg');
}

export async function saveImage({ kind, ownerId, file, label = '' }) {
  const blob = await fileToBlob(file);
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

export async function imageObjectUrl(id) {
  if (!id) return null;
  const rec = await db.images.get(id);
  if (!rec?.storagePath) return null;
  return publicImageUrl(rec.storagePath);
}

export async function deleteImage(id) {
  if (!id) return;
  const rec = await db.images.get(id);
  if (rec?.storagePath) {
    await supabase.storage.from(IMAGES_BUCKET).remove([rec.storagePath]).catch(() => {});
  }
  await db.images.delete(id);
}

/** Fetch raw image bytes — used by the PDF generator to embed images. */
export async function downloadImageBytes(id) {
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

export async function ensureDefaultProfile() {
  // Make sure the team profile + settings row exist (the SQL schema bootstraps
  // these, but we tolerate empty databases too).
  await db.profiles.put({ id: TEAM_PROFILE_ID, name: 'Team' }).catch(() => {});
  const cur = await db.settings.get(TEAM_PROFILE_ID);
  if (!cur) await db.settings.put({ profileId: TEAM_PROFILE_ID }).catch(() => {});

  // Record the current Supabase user as a team member (for audit / display).
  const { data } = await supabase.auth.getUser();
  const u = data?.user;
  if (u) {
    await db.profiles.put({
      id: u.id,
      name: (u.user_metadata && u.user_metadata.name) || (u.email?.split('@')[0]) || 'Member',
      email: u.email || null,
    }).catch(() => {});
  }
  return TEAM_PROFILE_ID;
}

export async function getSettings(profileId) {
  return db.settings.get(profileId);
}

export async function updateSettings(profileId, patch) {
  const cur = (await db.settings.get(profileId)) || { profileId };
  await db.settings.put({ ...cur, ...patch, profileId });
}
