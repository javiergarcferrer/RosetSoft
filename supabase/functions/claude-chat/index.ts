// claude-chat — the JARVIS uplink, live. Relays the dashboard console to the
// Claude API (Anthropic Messages API) and persists both sides of the
// conversation in claude_messages, so the console is a real-time AI channel
// instead of a queue waiting for a dev session.
//
// Why a function (not a direct browser call):
//   - The Anthropic API key is a secret (write-only claude_config table,
//     service-role read) and must never reach the browser bundle.
//   - The server owns the thread: it loads recent history, injects a live ops
//     snapshot (rate freshness, business counts), and writes both rows, so
//     every device sees the same conversation.
//
// Modes:
//   { test: true }        → verify the stored key against the Models API.
//   { message: string }   → one chat turn; returns the assistant reply.
//
// Code-change requests are out of this function's reach by design — the
// system prompt tells the assistant to flag them, and the engineering agent
// reads the same claude_messages channel.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import Anthropic from 'npm:@anthropic-ai/sdk';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

const DEFAULT_MODEL = 'claude-opus-4-8';
const HISTORY_TURNS = 20;
const MAX_MESSAGE_CHARS = 4000;

const SYSTEM_PROMPT = `You are JARVIS, the operations AI of AlcoverSoft — the quoting and back-office
app of Alcover (Ligne Roset dealer, Dominican Republic). You live inside the
JARVIS dashboard's uplink console.

What the app does: furniture quotes priced in USD and shown in DOP (Banco
Popular daily rate, locked when a quote is accepted), orders with container
tracking (Hapag-Lloyd), a CRM with WhatsApp (Meta Cloud API), Dominican
accounting (DGII 606/607, e-CF electronic invoicing), Shopify integrations
(alcover.do inventory mirror + LifestyleGarden catalog), and brand catalogs.

Your role:
- Answer questions about the business data snapshot you receive and about the
  app's integrations and workflows. Be concrete and useful.
- You CANNOT change the application's code or data yourself. When the user
  requests a code change or new feature, restate it crisply as a directive and
  tell them it stays logged in this channel for the engineering agent (Claude
  Code) to pick up — every message here is already persisted.
- Reply in the user's language (Spanish by default). Match the HUD: concise,
  precise, a little bit JARVIS. Short paragraphs, no filler, no markdown
  headers. Lead with the answer.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    return json({ error: 'Server misconfigured' }, 500);
  }

  // Require a logged-in team member so the API spend can't be drained by
  // anonymous traffic. verify_jwt is off at the gateway (CORS preflight);
  // we verify the token here, same as bpd-rate / wa-send.
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json({ error: 'Authorization header required' }, 401);
  }
  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ error: 'Invalid or expired session' }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let body: { test?: boolean; message?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body → handled below */
  }

  // The key lives in the write-only claude_config table; only this service-role
  // read ever sees it.
  const { data: config } = await admin
    .from('claude_config')
    .select('api_key, model')
    .eq('profile_id', 'team')
    .maybeSingle();
  if (!config?.api_key) {
    return json({ configured: false, error: 'Sin llave API de Anthropic' });
  }
  const model = config.model || DEFAULT_MODEL;
  const anthropic = new Anthropic({ apiKey: config.api_key });

  if (body.test) {
    try {
      const m = await anthropic.models.retrieve(model);
      return json({ configured: true, ok: true, model: m.id });
    } catch (e) {
      return json({ configured: true, ok: false, error: apiErrorMessage(e) });
    }
  }

  const message = String(body.message || '').trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) return json({ error: 'message requerido' }, 400);

  try {
    // Persist the user's turn first — even if the API call fails, the channel
    // keeps the record (and the engineering agent can still read it).
    const userRow = {
      id: rowId(),
      profile_id: 'team',
      role: 'user',
      kind: 'chat',
      content: message,
      status: 'done',
      meta: { by: userData.user.email || userData.user.id },
    };
    await admin.from('claude_messages').insert(userRow);

    const [history, snapshot] = await Promise.all([
      loadHistory(admin),
      opsSnapshot(admin),
    ]);

    // History already contains the user turn we just inserted; append the live
    // ops snapshot to that final user message so the model sees fresh state
    // while the system prompt stays byte-stable (cache-friendly).
    const messages = history.map((m, i) =>
      i === history.length - 1 && m.role === 'user'
        ? { role: 'user' as const, content: `${m.content}\n\n<ops_snapshot>\n${snapshot}\n</ops_snapshot>` }
        : m,
    );

    const response = await anthropic.messages.create({
      model,
      max_tokens: 16000,
      // Adaptive thinking on the models that take it; Haiku-class would 400.
      ...(model.includes('haiku') ? {} : { thinking: { type: 'adaptive' as const } }),
      system: SYSTEM_PROMPT,
      messages,
    });

    let reply = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (response.stop_reason === 'refusal' || !reply) {
      reply = reply || 'No puedo ayudar con esa solicitud por este canal.';
    }

    const replyRow = {
      id: rowId(),
      profile_id: 'team',
      role: 'claude',
      kind: 'reply',
      content: reply,
      status: 'done',
      meta: {
        model: response.model,
        stopReason: response.stop_reason,
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
      },
    };
    await admin.from('claude_messages').insert(replyRow);

    return json({ ok: true, reply: { id: replyRow.id, content: reply, model: response.model } });
  } catch (e) {
    return json({ ok: false, error: apiErrorMessage(e) }, 502);
  }
});

/** Recent conversation, oldest first, mapped to Messages-API turns. */
async function loadHistory(admin: ReturnType<typeof createClient>) {
  const { data } = await admin
    .from('claude_messages')
    .select('role, kind, content, created_at')
    .eq('profile_id', 'team')
    .in('kind', ['chat', 'directive', 'reply'])
    .order('created_at', { ascending: false })
    .limit(HISTORY_TURNS);
  const rows = (data || []).reverse();
  const turns = rows
    .filter((r) => (r.content || '').trim())
    .map((r) => ({
      role: r.role === 'claude' ? ('assistant' as const) : ('user' as const),
      content: String(r.content).slice(0, MAX_MESSAGE_CHARS),
    }));
  // First message must be from the user; drop any leading assistant turns
  // (e.g. the channel's seeded welcome transmission).
  while (turns.length && turns[0].role === 'assistant') turns.shift();
  return turns;
}

/** Live ops facts the assistant can ground its answers in. */
async function opsSnapshot(admin: ReturnType<typeof createClient>): Promise<string> {
  try {
    const [settingsRes, quotes, orders, customers] = await Promise.all([
      admin.from('settings').select(
        'exchange_rate, shopify_connected_at, shopify_lsg_connected_at, whatsapp_connected_at, ecf_cert_uploaded_at, ecf_environment',
      ).eq('profile_id', 'team').maybeSingle(),
      admin.from('quotes').select('id', { count: 'exact', head: true }),
      admin.from('orders').select('id', { count: 'exact', head: true }),
      admin.from('customers').select('id', { count: 'exact', head: true }),
    ]);
    const s = settingsRes.data || {};
    const rate = s.exchange_rate || {};
    return [
      `fecha: ${new Date().toISOString()}`,
      `tasa USD→DOP: compra ${rate.buy ?? '—'} / venta ${rate.sell ?? '—'} (actualizada ${rate.updatedAt ? new Date(rate.updatedAt).toISOString() : 'nunca'})`,
      `cotizaciones: ${quotes.count ?? '—'} · pedidos: ${orders.count ?? '—'} · clientes: ${customers.count ?? '—'}`,
      `shopify alcover conectado: ${s.shopify_connected_at || 'no'} · shopify LSG: ${s.shopify_lsg_connected_at || 'no'}`,
      `whatsapp conectado: ${s.whatsapp_connected_at || 'no'}`,
      `e-CF: ${s.ecf_cert_uploaded_at ? `certificado (entorno ${s.ecf_environment || 'dev'})` : 'sin certificado'}`,
    ].join('\n');
  } catch (e) {
    return `snapshot no disponible: ${String((e as Error)?.message || e)}`;
  }
}

function apiErrorMessage(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'Llave API de Anthropic inválida o revocada';
  if (e instanceof Anthropic.RateLimitError) return 'Límite de uso de la API alcanzado — intenta en un momento';
  if (e instanceof Anthropic.APIError) return `Claude API: ${e.status} ${e.message}`.slice(0, 300);
  return String((e as Error)?.message || e).slice(0, 300);
}

function rowId(): string {
  return `cm-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
