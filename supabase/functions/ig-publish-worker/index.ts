// ig-publish-worker — the Instagram scheduling engine's worker.
//
// IG has no native scheduling, so a `scheduled_posts` row is queued by the
// client and published HERE at fire time. pg_cron pings this function every
// minute (registered idempotently by the `ensureCron` action below, which the
// scheduler UI calls once). Each tick claims due rows one at a time
// (claim_due_scheduled_post = FOR UPDATE SKIP LOCKED, so overlapping ticks
// never double-publish) and publishes by calling meta-social's `publish` mode
// server-to-server with the service-role key (x-internal-secret).
//
// Two entrypoints:
//   { ensureCron: true }  → (admin/UI) register the per-minute cron job.
//   { cron: true }        → (cron) drain due posts. Auth = Bearer service key.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

const MAX_ATTEMPTS = 3;
const BATCH = 5; // posts published per tick (well under IG's 50/24h)

Deno.serve(async (req) => {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: 'Server misconfigured' }, 500);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  let body: { ensureCron?: boolean; cron?: boolean } = {};
  try { body = await req.json(); } catch { /* empty */ }

  // ── ensureCron: (re)register the per-minute cron job. The worker knows its
  // own URL + key from its env, so no project URL is ever hardcoded. ────────
  if (body.ensureCron) {
    const authHeader = req.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) return json({ ok: false, error: 'Authorization requerida' }, 401);
    const caller = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') || '', {
      global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData } = await caller.auth.getUser();
    if (!userData?.user) return json({ ok: false, error: 'Sesión inválida' }, 401);
    const { data: prof } = await caller.from('profiles').select('role, active').eq('id', userData.user.id).maybeSingle();
    if (!prof || prof.role !== 'admin' || !prof.active) return json({ ok: false, error: 'Solo un administrador.' }, 403);

    const workerUrl = `${SUPABASE_URL}/functions/v1/ig-publish-worker`;
    const { error } = await admin.rpc('ensure_ig_publish_cron', { p_url: workerUrl, p_secret: SERVICE_ROLE_KEY });
    if (error) return json({ ok: false, error: error.message });
    return json({ ok: true });
  }

  // ── cron drain: only the cron job (Bearer service key) may run this. ──────
  const auth = req.headers.get('Authorization') || '';
  if (auth !== `Bearer ${SERVICE_ROLE_KEY}`) return json({ error: 'forbidden' }, 403);

  const results: Array<{ id: string; status: string }> = [];
  for (let i = 0; i < BATCH; i++) {
    const { data: row } = await admin.rpc('claim_due_scheduled_post');
    if (!row || !row.id) break;
    try {
      // A row already part-published (video still processing) → finish it.
      const reqBody = row.ig_creation_id
        ? { finishPublish: { creationId: row.ig_creation_id } }
        : { publish: row.payload };
      const res = await fetch(`${SUPABASE_URL}/functions/v1/meta-social`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify(reqBody),
      });
      let data: Record<string, unknown> | null = null;
      try { data = await res.json(); } catch { data = null; }
      const ig = (row.ig_creation_id ? data : ((data as any)?.results?.instagram || {})) as any;

      if (ig?.ok) {
        await admin.from('scheduled_posts').update({
          status: 'published', ig_media_id: String(ig.id || ''), last_error: null, updated_at: new Date().toISOString(),
        }).eq('id', row.id);
        results.push({ id: row.id, status: 'published' });
      } else if (ig?.pending && ig?.creationId) {
        // Video still processing — keep the container id, requeue for the next
        // tick, and GIVE BACK the attempt the claim charged: a pending re-poll
        // is not a failure, and charging it would burn the whole retry budget
        // on a normal 3-minute video encode. A container stuck beyond 45 min
        // is declared failed instead of polling forever.
        const stuck = row.scheduled_at && (Date.now() - Date.parse(row.scheduled_at)) > 45 * 60_000;
        await admin.from('scheduled_posts').update(stuck ? {
          status: 'failed', last_error: 'El video sigue procesándose en Instagram tras 45 min.', updated_at: new Date().toISOString(),
        } : {
          status: 'queued', ig_creation_id: String(ig.creationId),
          attempts: Math.max(0, (row.attempts || 1) - 1), updated_at: new Date().toISOString(),
        }).eq('id', row.id);
        results.push({ id: row.id, status: stuck ? 'failed' : 'pending' });
      } else if (data != null) {
        // meta-social ANSWERED with a definite error — the publish did not go
        // through, so retrying is safe.
        const err = String(ig?.error || (data as any)?.error || 'Fallo al publicar').slice(0, 300);
        const failed = (row.attempts || 0) >= MAX_ATTEMPTS;
        await admin.from('scheduled_posts').update({
          status: failed ? 'failed' : 'queued', last_error: err, updated_at: new Date().toISOString(),
        }).eq('id', row.id);
        results.push({ id: row.id, status: failed ? 'failed' : 'retry' });
      } else {
        // NO parseable answer — the outcome is UNKNOWN: the post may already be
        // live on Instagram. Blindly requeueing a fresh publish would create a
        // DUPLICATE post, so a first-publish row fails closed for the dealer to
        // check; a finishPublish row (existing container) is safe to re-poll.
        if (row.ig_creation_id) {
          await admin.from('scheduled_posts').update({
            status: 'queued', attempts: Math.max(0, (row.attempts || 1) - 1), updated_at: new Date().toISOString(),
          }).eq('id', row.id);
          results.push({ id: row.id, status: 'retry' });
        } else {
          await admin.from('scheduled_posts').update({
            status: 'failed',
            last_error: 'Resultado desconocido (sin respuesta) — verifica en Instagram si la publicación salió antes de reintentar.',
            updated_at: new Date().toISOString(),
          }).eq('id', row.id);
          results.push({ id: row.id, status: 'failed' });
        }
      }
    } catch (e) {
      // Same unknown-outcome policy as above: the request may have reached
      // meta-social and published before the failure — never auto-repeat a
      // first publish; only container re-polls are safe to retry.
      const msg = String((e as Error)?.message || e).slice(0, 260);
      if (row.ig_creation_id) {
        await admin.from('scheduled_posts').update({
          status: 'queued', attempts: Math.max(0, (row.attempts || 1) - 1),
          last_error: msg, updated_at: new Date().toISOString(),
        }).eq('id', row.id);
        results.push({ id: row.id, status: 'retry' });
      } else {
        await admin.from('scheduled_posts').update({
          status: 'failed',
          last_error: `Resultado desconocido (${msg}) — verifica en Instagram antes de reintentar.`,
          updated_at: new Date().toISOString(),
        }).eq('id', row.id);
        results.push({ id: row.id, status: 'failed' });
      }
    }
  }

  return json({ ok: true, processed: results });
});
