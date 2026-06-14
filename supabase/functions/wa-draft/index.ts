// wa-draft — AI reply suggestions for the WhatsApp inbox. Relays a compact
// conversation transcript to Claude and returns a SUGGESTED reply for the
// dealer to review, edit, and send themselves. It never sends anything and
// never persists: human-in-the-loop by design (see root CLAUDE.md — "Never
// auto-send AI-drafted customer messages").
//
// Why a function (not a direct browser call): same as claude-chat — the
// Anthropic key is a write-only secret (claude_config, service-role read) and
// must never reach the bundle. The caller's JWT is verified here so anonymous
// traffic can't drain the API spend.
//
// Drafts use a fast, cheap model (Haiku) regardless of the configured chat
// model — a one-shot suggestion doesn't need a frontier model, and the dealer
// is waiting on it in the composer.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import Anthropic from 'npm:@anthropic-ai/sdk';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

const DRAFT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_TURNS = 24;
const MAX_TURN_CHARS = 800;

const SYSTEM_PROMPT = `Eres el asistente de redacción de Alcover, distribuidor de Ligne Roset en
República Dominicana, dentro de su CRM de WhatsApp. Tu tarea: redactar la
PRÓXIMA respuesta que la tienda enviará al cliente en esta conversación.

Reglas:
- Responde SOLO con el texto del mensaje sugerido, sin comillas, sin prefacios
  ("Aquí tienes…"), sin firmar.
- Escribe en el idioma del cliente (español por defecto), en tono cálido,
  profesional y cercano — el de una boutique de mobiliario de alta gama.
- Sé concreto y breve; resuelve o avanza la conversación. Si el cliente hizo
  una pregunta, respóndela; si falta un dato del negocio que no aparece en la
  conversación (precio exacto, fecha, disponibilidad), no lo inventes: ofrece
  confirmarlo en breve.
- No prometas descuentos, plazos ni precios que no estén en la conversación.
- Una o dos frases suelen bastar. Sin emojis salvo que el cliente los use.`;

const TRANSLATE_PROMPT = `Eres un traductor para el CRM de WhatsApp de Alcover.
Traduce el mensaje del usuario entre español e inglés: si está en español,
tradúcelo al inglés; si está en inglés, tradúcelo al español. Conserva el tono,
el significado y el formato. Responde SOLO con la traducción — sin comillas, sin
notas, sin prefacios.`;

const SUMMARY_PROMPT = `Resume esta conversación de WhatsApp entre la tienda
Alcover y un cliente para que un compañero la retome de un vistazo. Responde en
español con 2 a 4 viñetas breves: qué pide o pregunta el cliente, qué se acordó
u ofreció, y qué queda pendiente. Sin preámbulos ni despedidas.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    return json({ ok: false, error: 'Server misconfigured' }, 500);
  }

  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json({ ok: false, error: 'Authorization header required' }, 401);
  }
  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ ok: false, error: 'Invalid or expired session' }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let body: {
    turns?: Array<{ role?: string; text?: string }>;
    contactName?: string; contextNote?: string;
    mode?: string; text?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    /* handled below */
  }

  // suggest (default) drafts the next reply; translate flips a draft ES⇄EN;
  // summary condenses the thread for a hand-off. All three share the auth +
  // key path below and the same fast model.
  const mode = body.mode === 'translate' || body.mode === 'summary' ? body.mode : 'suggest';

  // The key lives in the write-only claude_config table; only this service-role
  // read ever sees it.
  const { data: config } = await admin
    .from('claude_config')
    .select('api_key')
    .eq('profile_id', 'team')
    .maybeSingle();
  if (!config?.api_key) {
    return json({ ok: false, configured: false, error: 'Sin llave API de Anthropic' });
  }
  const anthropic = new Anthropic({ apiKey: config.api_key });

  let system = SYSTEM_PROMPT;
  let userContent = '';
  if (mode === 'translate') {
    const text = String(body.text || '').trim().slice(0, 4000);
    if (!text) return json({ ok: false, error: 'No hay texto para traducir.' }, 400);
    system = TRANSLATE_PROMPT;
    userContent = text;
  } else if (mode === 'summary') {
    const transcript = formatTranscript(body.turns);
    if (!transcript) return json({ ok: false, error: 'No hay conversación para resumir.' }, 400);
    system = SUMMARY_PROMPT;
    userContent = `Conversación (más reciente al final):\n${transcript}`;
  } else {
    const transcript = formatTranscript(body.turns);
    if (!transcript) return json({ ok: false, error: 'No hay conversación para responder.' }, 400);
    const who = (body.contactName || '').trim();
    const note = (body.contextNote || '').trim().slice(0, 500);
    userContent = [
      who ? `Cliente: ${who}` : null,
      note ? `Contexto: ${note}` : null,
      'Conversación (más reciente al final):',
      transcript,
      '',
      'Redacta la próxima respuesta de la tienda.',
    ].filter(Boolean).join('\n');
  }

  try {
    const response = await anthropic.messages.create({
      model: DRAFT_MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: userContent }],
    });
    const out = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (response.stop_reason === 'refusal' || !out) {
      return json({ ok: false, error: 'El asistente no pudo completar la solicitud.' });
    }
    if (mode === 'summary') return json({ ok: true, summary: out, model: response.model });
    return json({ ok: true, draft: out, model: response.model });
  } catch (e) {
    return json({ ok: false, error: apiErrorMessage(e) }, 502);
  }
});

/** Render the client transcript into Cliente:/Tú: lines, capped + trimmed. */
function formatTranscript(turns: unknown): string {
  if (!Array.isArray(turns)) return '';
  const lines = turns
    .slice(-MAX_TURNS)
    .map((t) => {
      const text = String((t as { text?: unknown })?.text || '').trim().slice(0, MAX_TURN_CHARS);
      if (!text) return null;
      const who = (t as { role?: unknown })?.role === 'agent' ? 'Tú' : 'Cliente';
      return `${who}: ${text}`;
    })
    .filter((l): l is string => !!l);
  return lines.join('\n');
}

function apiErrorMessage(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'Llave API de Anthropic inválida o revocada';
  if (e instanceof Anthropic.RateLimitError) return 'Límite de uso de la API alcanzado — intenta en un momento';
  if (e instanceof Anthropic.APIError) return `Claude API: ${e.status} ${e.message}`.slice(0, 300);
  return String((e as Error)?.message || e).slice(0, 300);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
