// wa-send — outbound WhatsApp via the Meta Cloud API.
//
// Called by a signed-in team member (Settings connection test, the quote
// editor's "Enviar por WhatsApp", the CRM inbox composer). It reads the Meta
// credentials from the write-only whatsapp_config table via the service role
// (the access token never reaches the browser), calls the Graph API, and logs
// the outbound message into wa_messages so the inbox thread shows it.
//
// Body shapes:
//   { test: true }                                  → verify token + number id
//   { to, text, customerId?, professionalId?, quoteId? }            → free text
//   { to, template, params?, lang?, customerId?, … }                → template
//
// Free-form text only delivers inside Meta's 24h customer-service window;
// outside it the API answers re-engagement error 131047 — translated below to
// a message the dealer can act on (send a template instead).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const GRAPH = 'https://graph.facebook.com/v23.0';
const TEAM = 'team';

type SendBody = {
  test?: boolean;
  to?: string;
  text?: string;
  template?: string;
  params?: string[];
  lang?: string;
  customerId?: string | null;
  professionalId?: string | null;
  quoteId?: string | null;
};

/** Meta error code → dealer-readable Spanish. Falls back to Meta's message. */
function friendlyMetaError(code: number | undefined, message: string): string {
  switch (code) {
    case 190:
      return 'El token de acceso expiró o fue revocado. Genera un token PERMANENTE (System User en Business Manager) y pégalo de nuevo en Configuración.';
    case 131030:
      return 'Este número no está en la lista de destinatarios permitidos del número de PRUEBA. Agrégalo en Meta → WhatsApp → API Setup → "To" → Manage phone number list (máx. 5).';
    case 131047:
    case 131026:
      return 'Fuera de la ventana de 24 horas: WhatsApp solo permite iniciar conversación con una PLANTILLA aprobada. Envía la plantilla o espera a que el cliente escriba.';
    case 132001:
      return 'La plantilla no existe (o no en ese idioma) en tu cuenta de WhatsApp. Revisa el nombre exacto en Meta → WhatsApp Manager → Plantillas.';
    case 100:
      return `Meta rechazó la petición: ${message}. Revisa que el Phone Number ID sea el ID (no el número) y que el token tenga permiso whatsapp_business_messaging.`;
    default:
      return message;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: 'server not configured' }, 500);

  // The anon key passes the gateway's verify_jwt (it's a valid JWT) — require
  // a real signed-in team member before touching the Meta token.
  const authClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') || '', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: req.headers.get('Authorization') || '' } },
  });
  const { data: auth } = await authClient.auth.getUser();
  if (!auth?.user) return json({ error: 'No autorizado.' }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: cfg } = await admin
    .from('whatsapp_config').select('access_token, phone_number_id').eq('profile_id', TEAM).maybeSingle();
  const token = (cfg as { access_token?: string } | null)?.access_token;
  const phoneNumberId = (cfg as { phone_number_id?: string } | null)?.phone_number_id;
  if (!token || !phoneNumberId) return json({ configured: false, message: 'WhatsApp no conectado' });

  let body: SendBody = {};
  try { body = await req.json(); } catch { /* empty body falls through to validation */ }

  // Connection check — does the token reach the number? Also refreshes the
  // display number + verified name on settings so the UI labels itself.
  if (body.test === true) {
    const r = await fetch(`${GRAPH}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = (data as { error?: { code?: number; message?: string } }).error;
      return json({ configured: true, ok: false, error: friendlyMetaError(err?.code, err?.message || `HTTP ${r.status}`) }, 502);
    }
    const d = data as { display_phone_number?: string; verified_name?: string; quality_rating?: string };
    await admin.from('settings').update({
      whatsapp_display_number: d.display_phone_number || '',
      whatsapp_verified_name: d.verified_name || '',
    }).eq('profile_id', TEAM);
    return json({ configured: true, ok: true, displayNumber: d.display_phone_number, verifiedName: d.verified_name, quality: d.quality_rating });
  }

  const to = String(body.to || '').replace(/\D/g, '');
  if (!to) return json({ ok: false, error: 'Falta el número de destino.' }, 400);

  let payload: Record<string, unknown>;
  let logKind = 'text';
  let logBody = '';
  if (body.template) {
    logKind = 'template';
    logBody = Array.isArray(body.params) ? body.params.join(' · ') : '';
    payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: body.template,
        language: { code: body.lang || 'es' },
        ...(Array.isArray(body.params) && body.params.length
          ? { components: [{ type: 'body', parameters: body.params.map((p) => ({ type: 'text', text: String(p) })) }] }
          : {}),
      },
    };
  } else if (typeof body.text === 'string' && body.text.trim()) {
    logBody = body.text.trim();
    payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body: logBody, preview_url: true } };
  } else {
    return json({ ok: false, error: 'Falta el mensaje (text) o la plantilla (template).' }, 400);
  }

  const r = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  const waId = (data as { messages?: { id?: string }[] }).messages?.[0]?.id || null;
  const metaErr = (data as { error?: { code?: number; message?: string; error_data?: { details?: string } } }).error;
  const ok = r.ok && !!waId;
  const errorMsg = ok ? null
    : friendlyMetaError(metaErr?.code, metaErr?.error_data?.details || metaErr?.message || `HTTP ${r.status}`);

  // Log the attempt either way — a failed send is part of the conversation's
  // truth (the inbox shows it with the reason instead of silently dropping it).
  const row = {
    id: crypto.randomUUID(),
    profile_id: TEAM,
    direction: 'out',
    wa_id: waId,
    phone: to,
    customer_id: body.customerId || null,
    professional_id: body.professionalId || null,
    quote_id: body.quoteId || null,
    kind: logKind,
    body: logBody,
    template_name: body.template || null,
    status: ok ? 'accepted' : 'failed',
    error: errorMsg,
    created_at: new Date().toISOString(),
  };
  const { error: insErr } = await admin.from('wa_messages').insert(row);
  if (insErr) console.error('[wa-send] log insert failed:', insErr.message);

  if (!ok) return json({ ok: false, error: errorMsg }, 502);
  return json({ ok: true, id: waId });
});
