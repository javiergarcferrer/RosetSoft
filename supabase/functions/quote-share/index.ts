// quote-share — backs the public, interactive client quote link (#/q/<token>).
//
//   GET  ?token=…  → a whitelisted, CLIENT-FACING bundle for the viewer.
//   POST ?token=…  → applies the recipient's picks DIRECTLY to the quote and
//                    returns the fresh bundle. The owner chose ONE version over
//                    a separate copy ("always on the same page"), so fabrics,
//                    optionals, and alternatives edit the real quote_lines in
//                    place rather than living in a side channel.
//
// Why a function: the share link is used logged-OUT, but the DB is behind RLS
// (`to authenticated`). This runs with the service role and gates on the secret
// share token, so the public never gets raw table access — only this whitelist.
//
// CRITICAL — no margin/cost leakage: the bundle bakes BOTH line- and quote-level
// margin into each unit price and zeroes the margin fields, so the client sees
// the real quoted prices but the markup never leaves the server. Costs, internal
// notes, commission, etc. are simply never copied into the bundle.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

type Admin = ReturnType<typeof createClient>;
type Row = Record<string, unknown>;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Pick a subset of an object's keys (shallow; for camelCase JSONB components).
function pick<T extends Record<string, unknown>>(obj: T | null | undefined, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!obj) return out;
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

const COMPONENT_KEYS = [
  'id', 'name', 'reference', 'subtype', 'dimensions', 'description',
  'imageId', 'swatchImageId', 'qty', 'unitPrice', 'isOptional', 'optionalOffered', 'materialOptions',
];

// 8-digit family root of an upholstered SKU ("15420000G" -> "15420000").
function rootOf(ref: unknown): string | null {
  const m = /^(\d{8})[A-Za-z]$/.exec(String(ref || '').trim());
  return m ? m[1] : null;
}

// Grade taxonomy + canonical subtype composer, mirrored from src/lib/subtype.ts
// so a material switch writes the SAME "Grade X — Fabric" string the editor would
// (T/Y/Z are intentionally absent from the price list).
const ALPHA_GRADES = new Set(
  'A B C D E F G H I J K L M N O P Q R S U V W X'.split(' '),
);
function composeSubtype(grade: string, fabric: string): string {
  const g = (grade || '').trim();
  const f = (fabric || '').trim();
  if (!g && !f) return '';
  if (!g) return f;
  const gradeStr = ALPHA_GRADES.has(g.toUpperCase()) ? `Grade ${g.toUpperCase()}` : g;
  return f ? `${gradeStr} — ${f}` : gradeStr;
}

// Enrich a line/component's materialOptions with a per-option `delta`: the
// list-price difference between that grade's SKU and the base grade's SKU,
// scaled by the SAME margin factor baked into the unit price — so the client
// sees a real, margin-consistent +/- and the markup never leaks. Graceful:
// no catalog row / no resolved base or grade price -> that option keeps no
// delta and renders label-only.
function withDeltas(
  mo: Record<string, unknown> | null | undefined,
  reference: unknown,
  marginFactor: number,
  priceByRootGrade: Map<string, Map<string, number>>,
): Record<string, unknown> | null {
  if (!mo) return null;
  const options = Array.isArray(mo.options) ? mo.options as Record<string, unknown>[] : [];
  if (!options.length) return mo;
  const grades = priceByRootGrade.get(rootOf(reference) || '');
  if (!grades) return mo;
  const basePrice = grades.get(String(mo.baseGrade || '').toUpperCase());
  if (typeof basePrice !== 'number') return mo;
  const pricedOptions = options.map((o) => {
    const p = grades.get(String(o.grade || '').toUpperCase());
    if (typeof p !== 'number') return o;
    return { ...o, delta: (p - basePrice) * marginFactor };
  });
  return { ...mo, options: pricedOptions };
}

// Map a raw snake_case quote_lines row to the client-facing camelCase shape,
// baking `marginFactor` into every price so margin is invisible downstream.
function clientLine(
  row: Row,
  marginFactor: number,
  priceByRootGrade: Map<string, Map<string, number>>,
): Record<string, unknown> {
  const rawComponents = Array.isArray(row.components) ? row.components as Row[] : [];
  const components = rawComponents.map((c) => {
    const safe = pick(c, COMPONENT_KEYS);
    safe.unitPrice = num(c.unitPrice) * marginFactor;
    // Component price RANGE (material-less sub-piece) — margin baked into BOTH
    // ends like unitPrice, so the client link shows "min – max" with no markup.
    if (c.priceMin != null) safe.priceMin = num(c.priceMin) * marginFactor;
    if (c.priceMax != null) safe.priceMax = num(c.priceMax) * marginFactor;
    safe.materialOptions = withDeltas(
      c.materialOptions as Row | null, c.reference, marginFactor, priceByRootGrade,
    );
    return safe;
  });
  return {
    id: row.id,
    kind: row.kind,
    sortOrder: row.sort_order,
    family: row.family,
    reference: row.reference,
    name: row.name,
    subtype: row.subtype,
    dimensions: row.dimensions,
    description: row.description,
    imageId: row.image_id,
    swatchImageId: row.swatch_image_id,
    qty: row.qty,
    // Margin baked in; the margin field is zeroed so the viewer reproduces the
    // same total without ever seeing the markup.
    unitPrice: num(row.unit_price) * marginFactor,
    // Price RANGE for a material-less line — margin baked into both ends so the
    // client link widens to "min – max" with the markup still invisible.
    priceMin: row.price_min != null ? num(row.price_min) * marginFactor : null,
    priceMax: row.price_max != null ? num(row.price_max) * marginFactor : null,
    lineMarginPct: 0,
    lineDiscountPct: row.line_discount_pct,
    materialOptions: withDeltas(
      row.material_options as Row | null, row.reference, marginFactor, priceByRootGrade,
    ),
    components,
    isOptional: row.is_optional ?? false,
    // The dealer-designated "client may toggle this optional in/out" marker.
    // Lets the viewer turn an add-on ON and back OFF (a real toggle) — without
    // it, clearing is_optional on include would erase the fact it was optional.
    optionalOffered: row.optional_offered ?? false,
    alternativeGroup: row.alternative_group ?? null,
    isSelectedAlternative: row.is_selected_alternative ?? false,
    setGroup: row.set_group ?? null,
  };
}

// Catalog list price (+ wholesale cost) per root→grade, for the given roots.
// Scoped to the roots actually in play, which also dodges PostgREST's default
// 1000-row cap silently truncating a large price list.
interface GradeInfo { price: number; cost: number }
async function priceMapForRoots(
  admin: Admin,
  profileId: unknown,
  roots: Set<string>,
): Promise<Map<string, Map<string, GradeInfo>>> {
  const map = new Map<string, Map<string, GradeInfo>>();
  if (!roots.size) return map;
  const orFilter = [...roots].map((r) => `reference.like.${r}*`).join(',');
  const { data: prods } = await admin
    .from('products')
    .select('reference, price_usd, cost')
    .eq('profile_id', profileId)
    .or(orFilter);
  for (const p of (prods || []) as Row[]) {
    const m = /^(\d{8})([A-Za-z])$/.exec(String(p.reference || '').trim());
    if (!m) continue;
    const root = m[1];
    const grade = m[2].toUpperCase();
    if (!map.has(root)) map.set(root, new Map());
    map.get(root)!.set(grade, { price: num(p.price_usd), cost: num(p.cost) });
  }
  return map;
}

// Just the list-price view of a root→grade map, for delta computation.
function priceOnly(full: Map<string, Map<string, GradeInfo>>): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const [root, grades] of full) {
    const m = new Map<string, number>();
    for (const [g, info] of grades) m.set(g, info.price);
    out.set(root, m);
  }
  return out;
}

// Re-anchor a materialOptions blob so `pickedGrade` becomes the base (the
// chosen material). The old base is demoted into the options list carrying the
// entity's CURRENT swatch, so switching back later keeps that swatch. Returns
// null when the grade isn't offered (a stale/invalid pick — leave untouched).
function reanchor(
  mo: { baseGrade?: unknown; baseLabel?: unknown; options?: unknown[] } | null | undefined,
  pickedGrade: string,
  currentSwatchId: unknown,
): { newMo: Record<string, unknown>; label: string; newSwatchId: unknown } | null {
  if (!mo) return null;
  const options = Array.isArray(mo.options) ? mo.options as Record<string, unknown>[] : [];
  if (String(mo.baseGrade) === pickedGrade) {
    return { newMo: mo as Record<string, unknown>, label: String(mo.baseLabel ?? ''), newSwatchId: currentSwatchId ?? null };
  }
  const picked = options.find((o) => String(o.grade) === pickedGrade);
  if (!picked) return null;
  const oldBase = { grade: mo.baseGrade, label: mo.baseLabel ?? '', code: null, swatchImageId: currentSwatchId ?? null };
  const newOptions = options.filter((o) => String(o.grade) !== pickedGrade).concat([oldBase]);
  return {
    newMo: { baseGrade: picked.grade, baseLabel: picked.label ?? '', options: newOptions },
    label: String(picked.label ?? ''),
    newSwatchId: picked.swatchImageId ?? null,
  };
}

// snake_case patch to switch a LINE's own material to `grade`.
function lineMaterialPatch(
  line: Row,
  grade: string,
  priceMap: Map<string, Map<string, GradeInfo>>,
): Row | null {
  const r = reanchor(line.material_options as Row, grade, line.swatch_image_id);
  if (!r) return null;
  const root = rootOf(line.reference);
  const info = root ? priceMap.get(root)?.get(grade.toUpperCase()) : null;
  const patch: Row = {
    material_options: r.newMo,
    swatch_image_id: r.newSwatchId,
    subtype: composeSubtype(grade, r.label),
    // Picking a material resolves a material-less RANGE — drop it (the price is
    // now pinned), mirroring the editor's GradeFabricRow.commit.
    price_min: null,
    price_max: null,
  };
  if (root) patch.reference = root + grade.toUpperCase();
  if (info) { patch.unit_price = info.price; patch.unit_cost = info.cost; }
  return patch;
}

// Return a NEW component object with its material switched to `grade`.
function switchComponentMaterial(
  comp: Row,
  grade: string,
  priceMap: Map<string, Map<string, GradeInfo>>,
): Row {
  const r = reanchor(comp.materialOptions as Row, grade, comp.swatchImageId);
  if (!r) return comp;
  const root = rootOf(comp.reference);
  const info = root ? priceMap.get(root)?.get(grade.toUpperCase()) : null;
  // Picking a material resolves a material-less RANGE — drop it (price pinned).
  const next: Row = { ...comp, materialOptions: r.newMo, swatchImageId: r.newSwatchId, subtype: composeSubtype(grade, r.label), priceMin: null, priceMax: null };
  if (root) next.reference = root + grade.toUpperCase();
  if (info) next.unitPrice = info.price;
  return next;
}

// Build the whole client-facing bundle for a resolved quote row. Re-reads the
// (possibly just-mutated) lines, so GET and the POST response share one path.
async function buildBundle(admin: Admin, quote: Row): Promise<Record<string, unknown>> {
  const quoteMargin = num(quote.margin_pct);
  const baseFactor = 1 + quoteMargin / 100;

  const { data: lineRows } = await admin
    .from('quote_lines')
    .select('*')
    .eq('quote_id', quote.id)
    .order('sort_order', { ascending: true });

  // Catalog prices for every material option's grade → per-option delta.
  const roots = new Set<string>();
  for (const row of (lineRows || []) as Row[]) {
    const mo = row.material_options as { options?: unknown[] } | null;
    if (mo?.options?.length) { const r = rootOf(row.reference); if (r) roots.add(r); }
    const comps = Array.isArray(row.components) ? row.components as Row[] : [];
    for (const c of comps) {
      const cmo = c.materialOptions as { options?: unknown[] } | null;
      if (cmo?.options?.length) { const r = rootOf(c.reference); if (r) roots.add(r); }
    }
  }
  const priceByRootGrade = priceOnly(await priceMapForRoots(admin, quote.profile_id, roots));

  const lines = ((lineRows || []) as Row[]).map((row) =>
    clientLine(row, baseFactor * (1 + num(row.line_margin_pct) / 100), priceByRootGrade),
  );

  const fetchOne = async (table: string, id: unknown) => {
    if (!id) return null;
    const { data } = await admin.from(table).select('*').eq('id', id).maybeSingle();
    return (data as Row) || null;
  };
  const [customerRow, professionalRow, sellerRow, settingsRow, containerRows] = await Promise.all([
    fetchOne('customers', quote.customer_id),
    fetchOne('professionals', quote.professional_id),
    fetchOne('profiles', quote.created_by_user_id),
    admin.from('settings').select('*').eq('profile_id', quote.profile_id).maybeSingle().then((r) => (r.data as Row) || null),
    // The attached order's containers, so the link can track the shipment. Only
    // the number (a label) and the ISO 6346 code leave the server — the client
    // tracks via the keyless hl-track function; no order/cost data is exposed.
    quote.order_id
      ? admin.from('containers').select('number, code').eq('order_id', quote.order_id).then((r) => (r.data as Row[]) || [])
      : Promise.resolve([] as Row[]),
  ]);

  const customer = customerRow ? {
    name: customerRow.name, company: customerRow.company, address: customerRow.address,
    city: customerRow.city, state: customerRow.state, zip: customerRow.zip,
    country: customerRow.country, email: customerRow.email, phone: customerRow.phone,
  } : null;
  const professional = professionalRow ? { name: professionalRow.name, company: professionalRow.company } : null;
  const seller = sellerRow ? { name: sellerRow.name } : null;
  const settings = settingsRow ? {
    companyName: settingsRow.company_name, logoImageId: settingsRow.logo_image_id,
    rateLogoImageId: settingsRow.rate_logo_image_id,
    quoteFooter: settingsRow.quote_footer,
  } : {};

  // Containers with a real code only (label + code); the client validates the
  // ISO 6346 number and renders one tracking panel each.
  const containers = (containerRows as Row[])
    .filter((c) => String(c.code || '').trim())
    .map((c) => ({ number: c.number, code: c.code }));

  return {
    quote: {
      id: quote.id,
      number: quote.number,
      status: quote.status,
      currencyCode: quote.currency_code,
      rates: quote.rates,
      terms: quote.terms,
      marginPct: 0,
      discountPct: quote.discount_pct,
      shipping: quote.shipping,
    },
    lines,
    customer,
    professional,
    seller,
    settings,
    containers,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json({ error: 'server not configured' }, 500);
  }
  const token = (new URL(req.url).searchParams.get('token') || '').trim();
  if (!token) return json({ error: 'missing token' }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Resolve the quote by its secret token; a disabled link reads as 404 so a
  // revoked link is indistinguishable from a bad one.
  const { data: quoteData, error: qErr } = await admin
    .from('quotes')
    .select('*')
    .eq('share_token', token)
    .eq('share_enabled', true)
    .maybeSingle();
  if (qErr) return json({ error: 'lookup failed' }, 500);
  if (!quoteData) return json({ error: 'not found' }, 404);
  const quote = quoteData as Row;

  // ---- POST: apply the recipient's picks to the REAL quote_lines ----------
  if (req.method === 'POST') {
    let body: {
      alternatives?: Record<string, unknown>;
      optionals?: Record<string, unknown>;
      materials?: Record<string, unknown>;
    } = {};
    try { body = await req.json(); } catch { /* empty body ok */ }

    const { data: lineRowsData } = await admin
      .from('quote_lines')
      .select('*')
      .eq('quote_id', quote.id);
    const lineRows = (lineRowsData || []) as Row[];

    // Indexes for validation + lookup.
    const lineById = new Map<string, Row>();
    const groupMembers = new Map<string, Set<string>>();
    // Lines the dealer OFFERED as toggleable optionals — gated on
    // optional_offered (the stable designation), NOT is_optional (the current
    // include state), so a toggled-in optional can be toggled back OUT.
    const optionalIds = new Set<string>();
    // Components the dealer OFFERED as toggleable optionals — same role as
    // optionalIds, one level down (gated on the component's optionalOffered).
    const componentOptionalOffered = new Set<string>();
    const materialGrades = new Map<string, Set<string>>();     // line OR component id → valid grades
    const componentIndex = new Map<string, { lineId: string }>(); // component id → its line
    const addMaterialTarget = (id: unknown, mo: { baseGrade?: unknown; options?: unknown[] } | null | undefined) => {
      if (!id || !mo || !Array.isArray(mo.options) || !mo.options.length) return;
      const set = new Set<string>();
      if (mo.baseGrade != null) set.add(String(mo.baseGrade));
      for (const o of mo.options) { const g = (o as { grade?: unknown })?.grade; if (g != null) set.add(String(g)); }
      if (set.size) materialGrades.set(String(id), set);
    };
    for (const l of lineRows) {
      const id = String(l.id);
      lineById.set(id, l);
      if (l.alternative_group) {
        const g = String(l.alternative_group);
        if (!groupMembers.has(g)) groupMembers.set(g, new Set());
        groupMembers.get(g)!.add(id);
      }
      if (l.optional_offered) optionalIds.add(id);
      addMaterialTarget(l.id, l.material_options as { baseGrade?: unknown; options?: unknown[] } | null);
      const comps = Array.isArray(l.components) ? l.components as Row[] : [];
      for (const c of comps) {
        if (c?.id != null) componentIndex.set(String(c.id), { lineId: id });
        if (c?.optionalOffered) componentOptionalOffered.add(String(c.id));
        addMaterialTarget(c?.id, c?.materialOptions as { baseGrade?: unknown; options?: unknown[] } | null);
      }
    }

    // Catalog prices for the roots touched by material picks (line + component).
    const matRoots = new Set<string>();
    for (const [id, grade] of Object.entries(body.materials || {})) {
      const key = String(id);
      if (!materialGrades.get(key)?.has(String(grade))) continue;
      if (lineById.has(key)) { const r = rootOf(lineById.get(key)!.reference); if (r) matRoots.add(r); }
      else if (componentIndex.has(key)) {
        const line = lineById.get(componentIndex.get(key)!.lineId);
        const comp = (line?.components as Row[] | undefined)?.find((c) => String(c.id) === key);
        const r = rootOf(comp?.reference); if (r) matRoots.add(r);
      }
    }
    const priceMap = await priceMapForRoots(admin, quote.profile_id, matRoots);

    // Accumulate one patch per line, then write each once. Component edits
    // build on a working copy of the line's components so several picks on the
    // same compound line compose.
    const patches = new Map<string, Row>();
    const workingComps = new Map<string, Row[]>();
    const merge = (id: string, p: Row) => patches.set(id, { ...(patches.get(id) || {}), ...p });
    const compsOf = (lineId: string): Row[] => {
      if (!workingComps.has(lineId)) {
        const comps = lineById.get(lineId)?.components;
        workingComps.set(lineId, (Array.isArray(comps) ? comps as Row[] : []).map((c) => ({ ...c })));
      }
      return workingComps.get(lineId)!;
    };

    // Alternatives — only the chosen member of a group stays selected.
    for (const [group, lineId] of Object.entries(body.alternatives || {})) {
      const members = groupMembers.get(group);
      if (!members || !members.has(String(lineId))) continue;
      for (const memberId of members) merge(memberId, { is_selected_alternative: memberId === String(lineId) });
    }

    // Optionals — a TOGGLE: on=true folds the add-on into the quote
    // (is_optional=false), on=false takes it back out (is_optional=true).
    // The id is either a LINE the dealer offered (optional_offered) or a
    // COMPONENT the dealer offered (its optionalOffered, one level down). A
    // component toggle flips isOptional on its own entry within the line's
    // working components copy, so it composes with a material pick on the same
    // line — same pattern as the material branch below.
    for (const [id, on] of Object.entries(body.optionals || {})) {
      const key = String(id);
      if (optionalIds.has(key)) { merge(key, { is_optional: !on }); continue; }
      if (componentOptionalOffered.has(key) && componentIndex.has(key)) {
        const lineId = componentIndex.get(key)!.lineId;
        const comps = compsOf(lineId);
        const idx = comps.findIndex((c) => String(c.id) === key);
        if (idx >= 0) {
          comps[idx] = { ...comps[idx], isOptional: !on };
          merge(lineId, { components: comps });
        }
      }
    }

    // Materials — re-anchor the line (or component) to the chosen grade.
    for (const [id, gradeRaw] of Object.entries(body.materials || {})) {
      const key = String(id);
      const grade = String(gradeRaw);
      if (!materialGrades.get(key)?.has(grade)) continue;
      if (lineById.has(key)) {
        const p = lineMaterialPatch(lineById.get(key)!, grade, priceMap);
        if (p) merge(key, p);
      } else if (componentIndex.has(key)) {
        const lineId = componentIndex.get(key)!.lineId;
        const comps = compsOf(lineId);
        const idx = comps.findIndex((c) => String(c.id) === key);
        if (idx >= 0) {
          comps[idx] = switchComponentMaterial(comps[idx], grade, priceMap);
          merge(lineId, { components: comps });
        }
      }
    }

    // Persist — one UPDATE per touched line, scoped to this quote.
    for (const [id, patch] of patches) {
      const { error } = await admin.from('quote_lines').update(patch).eq('id', id).eq('quote_id', quote.id);
      if (error) return json({ error: 'save failed' }, 500);
    }
    // Touch the quote so the dealer's list reflects recent activity.
    await admin.from('quotes').update({ updated_at: new Date().toISOString() }).eq('id', quote.id);

    return json(await buildBundle(admin, quote));
  }

  // ---- GET: build the client-facing bundle --------------------------------
  return json(await buildBundle(admin, quote));
});
