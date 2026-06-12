import { useEffect, useState } from 'react';
import { Check, Loader2, AlertTriangle, MessageCircle, Send, ChevronDown, Copy } from 'lucide-react';
import { formatDateTime } from '../../lib/format.js';
import {
  saveWhatsappConfig, pingWhatsapp, sendWhatsappTemplate, waWebhookUrl,
} from '../../lib/whatsapp.js';

/**
 * WhatsApp Business (Cloud API) — connect the Meta app, register the webhook,
 * and validate end-to-end with a test send. Credentials are saved through a
 * write-only RPC (never read back); only the display number + connected-at
 * surface here. The collapsible guide walks the dealer through the Meta portal
 * (the values are easy to find but easy to confuse), including how to mint the
 * PERMANENT System-User token — the API Setup one expires in 24h.
 */
export default function WhatsAppCard({ settings, saveSettings }) {
  const [accessToken, setAccessToken] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [status, setStatus] = useState('idle'); // idle | saving | saved | error
  const [msg, setMsg] = useState('');

  const connectedAt = settings?.whatsappConnectedAt;
  const displayNumber = settings?.whatsappDisplayNumber;
  const verifiedName = settings?.whatsappVerifiedName;

  // Webhook delivery state. The ping ENSURES the app is subscribed to the
  // WABA (wa-send re-subscribes idempotently — without that subscription Meta
  // delivers no webhooks at all, even with the callback URL verified), so
  // pinging on open self-heals an install that registered the URL but was
  // never subscribed.
  const [webhook, setWebhook] = useState(null); // null | { subscribed, error }
  useEffect(() => {
    if (!connectedAt) return undefined;
    let alive = true;
    pingWhatsapp().then((res) => {
      if (alive && res?.ok) setWebhook({ subscribed: !!res.webhookSubscribed, error: res.webhookError || null });
    }).catch(() => {});
    return () => { alive = false; };
  }, [connectedAt]);

  async function save() {
    setStatus('saving');
    setMsg('');
    try {
      await saveWhatsappConfig({ accessToken, phoneNumberId, wabaId, appSecret, settings });
      setAccessToken('');
      setAppSecret('');
      // Verify against the Graph API before claiming success — a wrong ID or
      // an expired token is caught here, not later as a silent non-delivery.
      const ping = await pingWhatsapp();
      if (ping?.ok) {
        setStatus('saved');
        setWebhook({ subscribed: !!ping.webhookSubscribed, error: ping.webhookError || null });
        setMsg(`Conectado: ${ping.displayNumber || ''}${ping.verifiedName ? ` (${ping.verifiedName})` : ''}. ✓ Ahora registra el webhook (paso 3 de la guía).`);
      } else {
        setStatus('error');
        setMsg(ping?.error || 'Guardado, pero no se pudo verificar la conexión con Meta.');
      }
      setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 6000);
    } catch (e) {
      setStatus('error');
      setMsg(e?.message || 'No se pudo guardar.');
    }
  }

  return (
    <div className="card card-pad">
      <div className="card-header -mx-5 -mt-5 mb-4">
        <h2 className="font-semibold inline-flex items-center gap-2">
          <MessageCircle size={16} className="text-emerald-600" aria-hidden /> WhatsApp Business
        </h2>
      </div>
      <p className="text-xs text-ink-500 mb-4">
        Conecta tu app de WhatsApp Business (Cloud API) para enviar cotizaciones y chatear con
        clientes desde ALCOVER, con el número del negocio. Empieza con el <strong>número de prueba</strong> de
        Meta; cuando el flujo esté validado, migra tu número real (ojo: al conectarlo a la API, ese
        número se desconecta de la app WhatsApp Business del teléfono).
      </p>

      <SetupGuide settings={settings} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
        <div className="sm:col-span-2">
          <label className="label" htmlFor="wa-token">Token de acceso (permanente)</label>
          {/* autoComplete="new-password" — the only value browsers actually
              honor here. With "off", the password manager reads token+ID as a
              login form and autofills the user's saved email/password into
              them, which then gets SAVED as credentials (a real incident: the
              dealer's email landed in the WABA field and broke the webhook
              subscription). */}
          <input id="wa-token" name="wa-access-token" type="password" value={accessToken} onChange={(e) => setAccessToken(e.target.value)}
            placeholder={connectedAt ? '•••••••• (guardado)' : 'EAA…'} className="input mt-1" autoComplete="new-password" />
        </div>
        <div>
          <label className="label" htmlFor="wa-phone-id">Phone Number ID</label>
          <input id="wa-phone-id" name="wa-phone-number-id" value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)}
            placeholder={connectedAt ? '(guardado)' : 'p. ej. 123456789012345'} className="input mt-1" inputMode="numeric" autoComplete="off" />
        </div>
        <div>
          <label className="label" htmlFor="wa-waba-id">WhatsApp Business Account ID</label>
          <input id="wa-waba-id" name="wa-waba-account-id" value={wabaId} onChange={(e) => setWabaId(e.target.value)}
            placeholder={connectedAt ? '(guardado)' : 'p. ej. 109876543210987'} className="input mt-1" inputMode="numeric" autoComplete="off" />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="wa-secret">App Secret (para recibir mensajes)</label>
          <input id="wa-secret" name="wa-app-secret" type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)}
            placeholder={connectedAt ? '•••••••• (guardado)' : '32 caracteres hexadecimales'} className="input mt-1" autoComplete="new-password" />
          <p className="text-[11px] text-ink-500 mt-1">
            Meta → tu app → App settings → Basic → App Secret → Show. Firma los mensajes entrantes; sin él no se recibe nada.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" onClick={save} disabled={status === 'saving'} className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
          {status === 'saving' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Guardar conexión
        </button>
        {connectedAt ? (
          <span className="text-[11px] text-ink-400 min-w-0 truncate">
            Conectado{displayNumber ? ` · ${displayNumber}` : ''}{verifiedName ? ` (${verifiedName})` : ''} · {formatDateTime(connectedAt)}
          </span>
        ) : null}
      </div>
      {connectedAt && (
        <p className="text-[11px] text-ink-400 mt-1.5">
          La conexión queda guardada — los deploys no la tocan. Para cambiar un solo valor (p. ej. un token nuevo), pega solo ese campo: los vacíos conservan lo guardado.
        </p>
      )}
      {webhook && (
        webhook.subscribed ? (
          <p className="text-[11px] text-emerald-700 mt-1.5 flex items-start gap-1">
            <Check size={12} className="mt-px shrink-0" />
            Recepción activa: las respuestas del cliente y las confirmaciones de entrega llegan a la app.
          </p>
        ) : (
          <p className="text-[11px] text-amber-700 mt-1.5 flex items-start gap-1">
            <AlertTriangle size={12} className="mt-px shrink-0" />
            <span>Recepción inactiva — Meta no está entregando mensajes a la app. {webhook.error}</span>
          </p>
        )
      )}
      {msg && (
        <p className={`text-xs mt-2 ${status === 'error' ? 'text-rose-600' : 'text-ink-500'}`}>{msg}</p>
      )}

      {connectedAt ? (
        <>
          <WebhookRow settings={settings} />
          <TemplateRow settings={settings} saveSettings={saveSettings} />
          <TestSendRow />
        </>
      ) : null}
    </div>
  );
}

/** Where each Meta value lives — the "guide me" path, collapsed by default. */
function SetupGuide({ settings }) {
  return (
    <details className="group rounded-lg border border-ink-100 overflow-hidden">
      <summary className="flex items-center justify-between cursor-pointer select-none px-4 py-3 min-h-11 text-sm font-medium text-ink-700 hover:bg-ink-50/60 transition-colors list-none">
        <span>Guía: dónde encontrar cada valor en el portal de Meta</span>
        <ChevronDown size={14} className="disclosure-chevron text-ink-400" aria-hidden />
      </summary>
      <div className="px-4 pb-4 pt-1 border-t border-ink-100 bg-ink-50/40 text-xs text-ink-600 space-y-3">
        <div>
          <div className="font-semibold text-ink-800 mt-2">1 · Credenciales básicas</div>
          <p className="mt-1 leading-relaxed">
            En <strong>developers.facebook.com</strong> → tu app → <strong>WhatsApp → API Setup</strong>:
            ahí están el <strong>Phone Number ID</strong> y el <strong>WhatsApp Business Account ID</strong> (debajo
            del número de prueba), y un token temporal que expira en 24 h — sirve para probar hoy.
            El <strong>App Secret</strong> está en <strong>App settings → Basic</strong> (botón &ldquo;Show&rdquo;).
            No necesitas configurar &ldquo;Facebook Login for Business&rdquo; — esa URL de OAuth es para
            plataformas que conectan números de OTROS negocios.
          </p>
        </div>
        <div>
          <div className="font-semibold text-ink-800">2 · Token permanente (System User)</div>
          <p className="mt-1 leading-relaxed">
            En <strong>business.facebook.com → Business settings → Users → System users</strong>: crea un
            usuario de sistema (rol Admin) → <strong>Add assets</strong> → asígnale tu app y tu cuenta de
            WhatsApp → <strong>Generate token</strong> con los permisos
            <code className="mx-1">whatsapp_business_messaging</code> y
            <code>whatsapp_business_management</code>, expiración &ldquo;never&rdquo;. Ese token (EAA…) es el
            que pegas aquí.
          </p>
        </div>
        <div>
          <div className="font-semibold text-ink-800">3 · Webhook (recibir mensajes)</div>
          <p className="mt-1 leading-relaxed">
            Tras guardar la conexión, copia la <strong>Callback URL</strong> y el <strong>Verify token</strong> que
            aparecen abajo y pégalos en <strong>tu app → WhatsApp → Configuration → Webhook → Edit</strong>.
            Luego en &ldquo;Webhook fields&rdquo; suscríbete a <strong>messages</strong>.
          </p>
        </div>
        <div>
          <div className="font-semibold text-ink-800">4 · Número de prueba</div>
          <p className="mt-1 leading-relaxed">
            El número de prueba solo envía a una lista de hasta 5 destinatarios verificados
            (API Setup → campo &ldquo;To&rdquo; → Manage phone number list). Para iniciar conversación usa la
            plantilla <code>hello_world</code>; cuando el destinatario responda se abre la ventana de 24 h
            y el chat libre funciona.
            {settings?.whatsappConnectedAt ? '' : ' Guarda la conexión para habilitar la prueba de envío.'}
          </p>
        </div>
      </div>
    </details>
  );
}

/** Callback URL + verify token, ready to paste into the Meta portal. */
function WebhookRow({ settings }) {
  return (
    <div className="mt-4 rounded-lg border border-ink-100 bg-ink-50/70 px-4 py-3.5">
      <div className="font-medium text-sm text-ink-800 mb-2">Webhook (paso 3)</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <CopyField label="Callback URL" value={waWebhookUrl()} />
        <CopyField label="Verify token" value={settings?.whatsappVerifyToken || ''} />
      </div>
      <p className="text-[11px] text-ink-500 mt-2">
        Pégalos en Meta → tu app → WhatsApp → Configuration → Webhook, y suscríbete al campo <strong>messages</strong>.
      </p>
    </div>
  );
}

function CopyField({ label, value }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — the field is selectable as a fallback */ }
  }
  return (
    <div>
      <div className="label">{label}</div>
      <div className="flex items-center gap-2">
        <input className="input flex-1 min-w-0 font-mono text-xs text-ink-600" readOnly value={value} onFocus={(e) => e.target.select()} />
        <button type="button" onClick={copy} title="Copiar" aria-label={`Copiar ${label}`}
          className={`btn-ghost text-xs shrink-0 active:scale-[0.97] transition-all ${copied ? '!text-emerald-700 !border-emerald-200' : ''}`}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
    </div>
  );
}

/**
 * The approved template used to SEND A QUOTE outside the 24h window. Auto-saves
 * on blur (same rationale as StoreCard: page-level Guardar races the realtime
 * settings refresh).
 */
function TemplateRow({ settings, saveSettings }) {
  const [value, setValue] = useState(settings?.whatsappQuoteTemplate || '');
  const [state, setState] = useState('idle'); // idle | saving | saved | error
  useEffect(() => { setValue(settings?.whatsappQuoteTemplate || ''); }, [settings?.whatsappQuoteTemplate]);

  async function persist() {
    const next = value.trim();
    if (next === (settings?.whatsappQuoteTemplate || '')) return;
    setState('saving');
    try {
      await saveSettings({ whatsappQuoteTemplate: next });
      setState('saved');
      setTimeout(() => setState((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } catch {
      setState('error');
    }
  }

  return (
    <div className="mt-3">
      <div className="label inline-flex items-center gap-2">
        Plantilla para enviar cotizaciones
        {state === 'saving' && <span className="text-[11px] font-normal text-ink-400">Guardando…</span>}
        {state === 'saved' && <span className="text-[11px] font-normal text-emerald-700 inline-flex items-center gap-0.5"><Check size={11} /> Guardado</span>}
        {state === 'error' && <span className="text-[11px] font-normal text-red-600">No se pudo guardar</span>}
      </div>
      <input className="input sm:max-w-[320px]" value={value} placeholder="p. ej. cotizacion"
        onChange={(e) => setValue(e.target.value)} onBlur={persist}
        autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <p className="text-[11px] text-ink-500 mt-1.5">
        Nombre exacto de una plantilla aprobada en WhatsApp Manager con una variable
        {' '}<code>{'{{1}}'}</code> en el cuerpo (el enlace de la cotización). Vacío ⇒ la cotización se
        envía como texto libre, que solo llega si el cliente escribió en las últimas 24 h.
      </p>
    </div>
  );
}

/** End-to-end check: ship hello_world (pre-approved on test numbers). */
function TestSendRow() {
  const [to, setTo] = useState('');
  const [state, setState] = useState('idle'); // idle | sending | sent | error
  const [msg, setMsg] = useState('');

  async function send() {
    if (!to.trim() || state === 'sending') return;
    setState('sending');
    setMsg('');
    try {
      const res = await sendWhatsappTemplate({ to, template: 'hello_world', lang: 'en_US' });
      if (res?.ok) {
        setState('sent');
        setMsg('Enviado. Revisa el WhatsApp del destinatario (y responde para abrir la ventana de chat).');
      } else {
        setState('error');
        setMsg(res?.error || 'No se pudo enviar.');
      }
    } catch (e) {
      setState('error');
      setMsg(e?.message || 'No se pudo enviar.');
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-ink-100 px-4 py-3.5">
      <div className="font-medium text-sm text-ink-800 mb-2">Prueba de envío</div>
      <div className="flex flex-col gap-2 min-[480px]:flex-row min-[480px]:items-center">
        <input className="input min-[480px]:max-w-[240px]" type="tel" inputMode="tel" value={to}
          onChange={(e) => { setTo(e.target.value); setState('idle'); setMsg(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          placeholder="809 000 0000" aria-label="Número de prueba" />
        <button type="button" onClick={send} disabled={state === 'sending' || !to.trim()}
          className="btn-ghost text-sm inline-flex items-center gap-1.5 disabled:opacity-40 shrink-0">
          {state === 'sending' ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          Enviar hello_world
        </button>
      </div>
      {msg && (
        <p className={`text-xs mt-2 flex items-start gap-1.5 ${state === 'error' ? 'text-rose-600' : 'text-emerald-700'}`}>
          {state === 'error' ? <AlertTriangle size={13} className="mt-0.5 shrink-0" /> : <Check size={13} className="mt-0.5 shrink-0" />}
          <span className="min-w-0">{msg}</span>
        </p>
      )}
      <p className="text-[11px] text-ink-500 mt-2">
        Con el número de prueba, el destinatario debe estar en la lista de permitidos de Meta (máx. 5).
      </p>
    </div>
  );
}
