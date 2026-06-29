/**
 * In-app error log — a device-local ring buffer the admin can open from any
 * screen to read what actually failed, WITH the full request + response, when
 * there's no browser devtools (i.e. on the phone).
 *
 * Capture funnels (wired elsewhere, zero churn at call sites):
 *   • userMessageFor()  — every handled error that becomes a toast passes
 *     through it, so we log the RAW error there (with its Response context).
 *   • window 'error' + 'unhandledrejection' (main.jsx) — the unhandled ones.
 *   • ErrorBoundary — React render crashes.
 *
 * Storage: localStorage ring buffer (newest first, capped). No backend, no
 * schema; it's a developer aid, visible to admins only. Per the owner's call we
 * keep FULL bodies (only obvious password fields are masked) — it's their own
 * screen.
 */
const KEY = 'rs.errorlog.v1';
const CAP = 120;
const DEDUP_MS = 1500;

let buffer = load();
const subs = new Set();
let seq = 0;

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') || []; } catch { return []; }
}
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(buffer.slice(0, CAP))); } catch { /* quota / private mode */ }
}
function emit() {
  for (const cb of subs) { try { cb(buffer); } catch { /* a bad subscriber never breaks logging */ } }
}

export function getErrors() { return buffer; }
export function subscribe(cb) { subs.add(cb); return () => subs.delete(cb); }
export function clearErrors() { buffer = []; persist(); emit(); }

/** Truncate any value to a readable string (objects → pretty JSON). */
function clip(v, max = 6000) {
  if (v == null || v === '') return '';
  let s;
  if (typeof v === 'string') s = v;
  else { try { s = JSON.stringify(v, maskKey, 2); } catch { s = String(v); } }
  return s.length > max ? `${s.slice(0, max)}\n…(+${s.length - max} caracteres)` : s;
}
/** Light mask — only obvious password fields; tokens are kept (owner's screen). */
function maskKey(k, val) {
  return /password|passwd|pwd/i.test(k) ? '«oculto»' : val;
}

let last = null; // { message, type, at, id } for dedup
function nextId() { return `${Date.now().toString(36)}-${(seq++).toString(36)}`; }

/** Append a structured entry. Returns its id (so async enrichment can target it). */
export function logError(partial) {
  const at = Date.now();
  const message = String(partial.message || 'Error').slice(0, 2000);
  const type = partial.type || 'error';
  // Collapse a burst of the identical error (e.g. a retry loop) into one row.
  if (last && last.message === message && last.type === type && at - last.at < DEDUP_MS) {
    last.at = at;
    return last.id;
  }
  const entry = {
    id: nextId(),
    at,
    type,
    source: partial.source || '',
    fn: partial.fn || '',
    table: partial.table || '',
    message,
    name: partial.name || '',
    status: partial.status === 0 ? 0 : (partial.status || ''),
    request: clip(partial.request),
    response: clip(partial.response),
    stack: typeof partial.stack === 'string' ? partial.stack.slice(0, 6000) : '',
    url: partial.url || (typeof location !== 'undefined' ? (location.hash || location.href) : ''),
  };
  buffer = [entry, ...buffer].slice(0, CAP);
  last = { message, type, at, id: entry.id };
  persist();
  emit();
  return entry.id;
}

/** Merge fields into an existing entry (used to fill in an async response body). */
export function updateError(id, patch) {
  let changed = false;
  buffer = buffer.map((e) => {
    if (e.id !== id) return e;
    changed = true;
    return { ...e, ...patch, response: patch.response !== undefined ? clip(patch.response) : e.response };
  });
  if (changed) { persist(); emit(); }
}

/** Read a Response body without disturbing the original (clone when possible). */
async function readResponseBody(resp) {
  try {
    const r = typeof resp.clone === 'function' ? resp.clone() : resp;
    const text = await r.text();
    let body = text;
    try { body = JSON.stringify(JSON.parse(text), maskKey, 2); } catch { /* not JSON — keep text */ }
    return { status: r.status, body };
  } catch (e) {
    return { status: resp?.status, body: `‹no se pudo leer el cuerpo: ${e?.message || e}›` };
  }
}

/**
 * Capture an error (Error / Supabase error / string) with optional context
 * (fn name, request body, table). If it's a Supabase FunctionsHttpError its
 * `context` is the raw Response — we read the FULL body asynchronously and
 * patch it onto the entry. Never throws.
 */
export function captureError(err, ctx = {}) {
  try {
    const e = (err && typeof err === 'object') ? err : { message: String(err) };
    const id = logError({
      type: ctx.type || 'error',
      source: ctx.source || '',
      fn: ctx.fn || '',
      table: ctx.table || '',
      message: e.message || e.error_description || e.error || String(err) || 'Error',
      name: e.name || '',
      status: e.status ?? e.code ?? ctx.status ?? '',
      request: ctx.request,
      response: ctx.response,
      stack: e.stack,
    });
    const resp = e.context; // supabase-js attaches the Response here on non-2xx
    if (resp && typeof resp.text === 'function') {
      readResponseBody(resp).then((r) => updateError(id, { status: r.status, response: r.body })).catch(() => {});
    }
    return id;
  } catch {
    return null;
  }
}
