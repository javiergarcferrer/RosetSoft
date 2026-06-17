import { userMessageFor } from '../../lib/errorMessages.js';
import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, AlertTriangle, MessageCircle, Send, ChevronDown, Copy, Lock, RefreshCw, QrCode, Zap, Plus, Pencil, Trash2, X } from 'lucide-react';
import { db, newId } from '../../db/database.js';
import { formatDateTime } from '../../lib/format.js';
import {
  saveWhatsappConfig, pingWhatsapp, sendWhatsappTemplate, waWebhookUrl,
  listWaTemplates, listWaCatalog, completeWaOnboarding,
  getConversationalAutomation, saveConversationalAutomation,
  listWaQrCodes, createWaQrCode, deleteWaQrCode,
} from '../../lib/whatsapp.js';
import { runCoexistenceSignup } from '../../lib/waEmbeddedSignup.js';
import { resolveWaHealth } from '../../core/crm/index.js';
import SettingsSection from './SettingsSection.jsx';
import CredentialInput from './CredentialInput.jsx';

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
  // Credentials are LOCKED while a connection is saved: the inputs aren't
  // rendered at all (nothing in the DOM for a password manager to autofill,
  // nothing to overwrite by accident) until the dealer explicitly clicks
  // "Editar credenciales". First-time setup (nothing saved yet) shows them.
  const [editing, setEditing] = useState(false);

  const connectedAt = settings?.whatsappConnectedAt;
  const locked = !!connectedAt && !editing;
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

  // Re-run the mount ping on demand (the coexistence flow just persisted a
  // connection server-side — surface the webhook state without a reload).
  async function refreshWebhook() {
    try {
      const res = await pingWhatsapp();
      if (res?.ok) setWebhook({ subscribed: !!res.webhookSubscribed, error: res.webhookError || null });
    } catch { /* the next mount ping retries */ }
  }

  async function save() {
    setStatus('saving');
    setMsg('');
    try {
      await saveWhatsappConfig({ accessToken, phoneNumberId, wabaId, appSecret, settings });
      setAccessToken('');
      setAppSecret('');
      setPhoneNumberId('');
      setWabaId('');
      setEditing(false); // re-lock the fields
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
      setMsg(userMessageFor(e));
    }
  }

  return (
    <SettingsSection title={<><MessageCircle size={16} className="text-emerald-600" aria-hidden /> WhatsApp Business</>}>
      <StatusHeader connectedAt={connectedAt} displayNumber={displayNumber} verifiedName={verifiedName} settings={settings} webhook={webhook} />

      {/* ── Conexión — credentials + the number link ──────────────────────── */}
      <Section title="Conexión" hint="credenciales y vínculo del número" defaultOpen={!connectedAt}>
        <p className="text-xs text-ink-500 mb-4">
          Conecta tu app de WhatsApp Business (Cloud API) para enviar cotizaciones y chatear con
          clientes desde ALCOVER, con el número del negocio. Empieza con el <strong>número de prueba</strong> de
          Meta; cuando el flujo esté validado, migra tu número real (ojo: al conectarlo a la API, ese
          número se desconecta de la app WhatsApp Business del teléfono).
        </p>

        <SetupGuide settings={settings} />

        <CoexistenceRow settings={settings} saveSettings={saveSettings} onConnected={refreshWebhook} />

        {locked ? (
          <div className="mt-4 rounded-lg border border-ink-100 bg-ink-50/60 px-4 py-3.5 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-ink-600 flex items-start gap-2 min-w-0">
              <Lock size={14} className="text-ink-400 shrink-0 mt-px" aria-hidden />
              <span>
                Credenciales guardadas y <strong>bloqueadas</strong> — token, Phone Number ID, WABA ID y App Secret.
                No se muestran, no se autocompletan y no se pueden modificar sin desbloquear.
              </span>
            </div>
            <button type="button" onClick={() => setEditing(true)} className="btn-ghost text-xs shrink-0">
              Editar credenciales
            </button>
          </div>
        ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="wa-token">Token de acceso (permanente)</label>
            {/* Credential fields render through CredentialInput — the anti-autofill
                measures (and the incident that motivated them) are documented there. */}
            <CredentialInput secret id="wa-token" name="wa-access-token" value={accessToken} onChange={(e) => setAccessToken(e.target.value)}
              placeholder={connectedAt ? '•••••••• (guardado)' : 'EAA…'} className="input mt-1" />
          </div>
          <div>
            <label className="label" htmlFor="wa-phone-id">Phone Number ID</label>
            <CredentialInput id="wa-phone-id" name="wa-phone-number-id" value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)}
              placeholder={connectedAt ? '(guardado)' : 'p. ej. 123456789012345'} className="input mt-1" inputMode="numeric" />
          </div>
          <div>
            <label className="label" htmlFor="wa-waba-id">WhatsApp Business Account ID</label>
            <CredentialInput id="wa-waba-id" name="wa-waba-account-id" value={wabaId} onChange={(e) => setWabaId(e.target.value)}
              placeholder={connectedAt ? '(guardado)' : 'p. ej. 109876543210987'} className="input mt-1" inputMode="numeric" />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="wa-secret">App Secret (para recibir mensajes)</label>
            <CredentialInput secret id="wa-secret" name="wa-app-secret" value={appSecret} onChange={(e) => setAppSecret(e.target.value)}
              placeholder={connectedAt ? '•••••••• (guardado)' : '32 caracteres hexadecimales'} className="input mt-1" />
            <p className="text-[11px] text-ink-500 mt-1">
              Meta → tu app → App settings → Basic → App Secret → Show. Firma los mensajes entrantes; sin él no se recibe nada.
            </p>
          </div>
        </div>
        )}

        <div className="flex flex-wrap items-center gap-2 mt-3">
          {!locked && (
            <button type="button" onClick={save} disabled={status === 'saving'} className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
              {status === 'saving' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Guardar conexión
            </button>
          )}
          {!locked && connectedAt ? (
            <button
              type="button"
              onClick={() => { setAccessToken(''); setPhoneNumberId(''); setWabaId(''); setAppSecret(''); setEditing(false); setMsg(''); setStatus('idle'); }}
              className="btn-ghost text-sm"
            >
              Cancelar
            </button>
          ) : null}
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
        {msg && (
          <p className={`text-xs mt-2 ${status === 'error' ? 'text-rose-600' : 'text-ink-500'}`}>{msg}</p>
        )}
      </Section>

      {connectedAt ? (
        <>
          {/* ── Recepción — webhook + reception health/self-test ────────────── */}
          <Section title="Recepción" hint="recibir mensajes">
            <WebhookRow settings={settings} />
            <ReceptionHealth />
          </Section>

          {/* ── Envío — quote template, catalog, test send ──────────────────── */}
          <Section title="Envío" hint="enviar cotizaciones y catálogo">
            <TemplateRow settings={settings} saveSettings={saveSettings} />
            <CatalogRow settings={settings} saveSettings={saveSettings} />
            <TestSendRow />
          </Section>

          {/* ── Automatización — quick replies, start menu, QR codes ────────── */}
          <Section title="Automatización" hint="respuestas, menú y códigos QR">
            <QuickRepliesRow settings={settings} saveSettings={saveSettings} />
            <ConversationalRow />
            <QrCodesRow />
          </Section>
        </>
      ) : null}
    </SettingsSection>
  );
}

/** A collapsible section in the WhatsApp config menu — the grouping primitive
 *  for Conexión / Recepción / Envío / Automatización. */
function Section({ title, hint, defaultOpen = false, children }) {
  return (
    <details className="group mt-3 rounded-lg border border-ink-100 overflow-hidden" open={defaultOpen}>
      <summary className="flex items-center justify-between cursor-pointer select-none px-4 py-3 min-h-11 text-sm font-semibold text-ink-800 hover:bg-ink-50/60 transition-colors list-none">
        <span className="inline-flex items-baseline gap-2">{title}{hint && <span className="text-[11px] font-normal text-ink-400">{hint}</span>}</span>
        <ChevronDown size={14} className="disclosure-chevron text-ink-400" aria-hidden />
      </summary>
      <div className="px-4 pb-4 pt-3 border-t border-ink-100">{children}</div>
    </details>
  );
}

/** Connection status header — the at-a-glance state above the sections:
 *  connected/not, number, Meta quality rating, and webhook reception. */
function StatusHeader({ connectedAt, displayNumber, verifiedName, settings, webhook }) {
  return (
    <div className="mb-1 rounded-lg border border-ink-100 bg-ink-50/40 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {connectedAt ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700">
            <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden /> Conectado
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-500">
            <span className="h-2 w-2 rounded-full bg-ink-300" aria-hidden /> No conectado
          </span>
        )}
        {connectedAt && (displayNumber || verifiedName) && (
          <span className="text-sm text-ink-600 min-w-0 truncate">
            {displayNumber || ''}{verifiedName ? ` · ${verifiedName}` : ''}
          </span>
        )}
        {connectedAt && webhook && (
          webhook.subscribed ? (
            <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-emerald-700"><Check size={12} /> Recepción activa</span>
          ) : (
            <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-amber-700"><AlertTriangle size={12} /> Recepción inactiva</span>
          )
        )}
      </div>
      {connectedAt && <NumberHealth settings={settings} />}
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

/**
 * Coexistence Embedded Signup — link the number to the Cloud API while the
 * phone's WhatsApp Business app keeps working. The browser launches Meta's
 * hosted dialog (QR scan from the phone) with two NON-secret launch ids saved
 * here; the one-time code it returns is exchanged server-side by wa-send's
 * `onboard` action, so no credential ever rides through this component.
 */
function CoexistenceRow({ settings, saveSettings, onConnected }) {
  const [appId, setAppId] = useState(settings?.whatsappAppId || '');
  const [configId, setConfigId] = useState(settings?.whatsappConfigId || '');
  const [appIdState, setAppIdState] = useState('idle'); // idle | saving | saved | error
  const [configIdState, setConfigIdState] = useState('idle');
  const [pin, setPin] = useState(''); // local only — never persisted
  const [state, setState] = useState('idle'); // idle | connecting | done | error
  const [msg, setMsg] = useState('');
  const [registerError, setRegisterError] = useState('');
  // Re-sync to the persisted values when they change elsewhere / after a save.
  useEffect(() => { setAppId(settings?.whatsappAppId || ''); }, [settings?.whatsappAppId]);
  useEffect(() => { setConfigId(settings?.whatsappConfigId || ''); }, [settings?.whatsappConfigId]);

  async function persist(field, value, setFieldState) {
    const v = value.trim();
    if (v === (settings?.[field] || '')) return; // unchanged — no write
    setFieldState('saving');
    try {
      await saveSettings({ [field]: v });
      setFieldState('saved');
      setTimeout(() => setFieldState((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } catch {
      setFieldState('error');
    }
  }

  async function connect() {
    if (state === 'connecting') return;
    setState('connecting');
    setMsg('');
    setRegisterError('');
    try {
      const launch = { appId: appId.trim(), configId: configId.trim() };
      const { code, phoneNumberId, wabaId } = await runCoexistenceSignup(launch);
      const res = await completeWaOnboarding({ code, appId: launch.appId, phoneNumberId, wabaId, pin: pin.trim() });
      if (res?.ok) {
        setState('done');
        setMsg('Número vinculado en coexistencia ✓ — la app del teléfono sigue funcionando.');
        if (res.registered === false) {
          setRegisterError(`No se pudo registrar el número para enviar: ${res.registerError || 'Meta rechazó el registro.'} Vuelve a intentar con el PIN correcto de verificación en dos pasos.`);
        }
        onConnected?.();
      } else {
        setState('error');
        setMsg(res?.error || 'No se pudo completar la conexión con Meta.');
      }
    } catch (e) {
      setState('error');
      setMsg(userMessageFor(e));
    }
  }

  return (
    <details className="group mt-4 rounded-lg border border-ink-100 overflow-hidden">
      <summary className="flex items-center justify-between cursor-pointer select-none px-4 py-3 min-h-11 text-sm font-medium text-ink-700 hover:bg-ink-50/60 transition-colors list-none">
        <span>Conectar con coexistencia — mantén la app del teléfono</span>
        <ChevronDown size={14} className="disclosure-chevron text-ink-400" aria-hidden />
      </summary>
      <div className="px-4 pb-4 pt-3 border-t border-ink-100 bg-ink-50/40">
        <p className="text-xs text-ink-600 leading-relaxed">
          La coexistencia vincula el número a la API <strong>sin desconectar</strong> la app WhatsApp
          Business del teléfono: las llamadas y los grupos siguen funcionando ahí, lo que el equipo
          envía desde el teléfono aparece en este CRM, y al conectar se sincronizan hasta ~6 meses de
          historial de chats. Requisitos: la app de Meta necesita &ldquo;Facebook Login for Business&rdquo;
          configurado y la Verificación del negocio, y el número debe estar activo en la app WhatsApp
          Business (versión reciente).
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
          <LaunchIdField id="wa-coex-app-id" label="App ID" placeholder="p. ej. 1234567890123456"
            value={appId} state={appIdState}
            onChange={(e) => setAppId(e.target.value)}
            onBlur={() => persist('whatsappAppId', appId, setAppIdState)} />
          <LaunchIdField id="wa-coex-config-id" label="Configuration ID" placeholder="p. ej. 9876543210987654"
            value={configId} state={configIdState}
            onChange={(e) => setConfigId(e.target.value)}
            onBlur={() => persist('whatsappConfigId', configId, setConfigIdState)} />
        </div>
        <p className="text-[11px] text-ink-500 mt-1.5">
          App ID: Meta → tu app → App settings → Basic → App ID. Configuration ID: Facebook Login for
          Business → Configurations → ID de la configuración. No son secretos — solo lanzan el diálogo.
        </p>
        <div className="mt-3">
          <label className="label" htmlFor="wa-coex-pin">PIN de verificación (si el número tiene uno)</label>
          <input id="wa-coex-pin" className="input mt-1 sm:max-w-[200px]" value={pin} inputMode="numeric"
            autoComplete="off" maxLength={6} placeholder="6 dígitos"
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} />
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <button type="button" onClick={connect} disabled={state === 'connecting'}
            className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
            {state === 'connecting' ? <Loader2 size={15} className="animate-spin" /> : <QrCode size={15} />}
            Conectar con Meta (escanear QR)
          </button>
        </div>
        {msg && (
          <p className={`text-xs mt-2 flex items-start gap-1.5 ${state === 'error' ? 'text-rose-600' : 'text-emerald-700'}`}>
            {state === 'error' ? <AlertTriangle size={13} className="mt-0.5 shrink-0" /> : <Check size={13} className="mt-0.5 shrink-0" />}
            <span className="min-w-0">{msg}</span>
          </p>
        )}
        {registerError && (
          <p className="text-xs text-amber-700 mt-1.5 flex items-start gap-1.5">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span className="min-w-0">{registerError}</span>
          </p>
        )}
      </div>
    </details>
  );
}

/** A coexistence launch id input with the inline auto-save badge (TemplateRow pattern). */
function LaunchIdField({ id, label, placeholder, value, state, onChange, onBlur }) {
  return (
    <div>
      <label className="label inline-flex items-center gap-2" htmlFor={id}>
        {label}
        {state === 'saving' && <span className="text-[11px] font-normal text-ink-400">Guardando…</span>}
        {state === 'saved' && <span className="text-[11px] font-normal text-emerald-700 inline-flex items-center gap-0.5"><Check size={11} /> Guardado</span>}
        {state === 'error' && <span className="text-[11px] font-normal text-red-600">No se pudo guardar</span>}
      </label>
      <input id={id} className="input mt-1" value={value} onChange={onChange} onBlur={onBlur}
        placeholder={placeholder} autoComplete="off" inputMode="numeric" />
    </div>
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
 * The approved template used to SEND A QUOTE outside the 24h window. A picker
 * over the WABA's live template list (no more typing the exact name): choosing
 * one persists the template's name + language + variable count + URL-button
 * flag in ONE settings write, so sendQuoteLink knows whether the link rides a
 * body {{1}} or the button's URL suffix. Auto-saves on change (same rationale
 * as StoreCard: page-level Guardar races the realtime settings refresh).
 */
function TemplateRow({ settings, saveSettings }) {
  const [value, setValue] = useState(settings?.whatsappQuoteTemplate || '');
  const [templates, setTemplates] = useState(null); // null = loading
  const [loadError, setLoadError] = useState('');
  const [state, setState] = useState('idle'); // idle | saving | saved | error
  // Re-sync to the persisted value when it changes elsewhere / after a save.
  useEffect(() => { setValue(settings?.whatsappQuoteTemplate || ''); }, [settings?.whatsappQuoteTemplate]);

  async function load() {
    setTemplates(null);
    setLoadError('');
    try {
      const res = await listWaTemplates();
      if (res?.ok) {
        setTemplates((res.templates || []).filter((t) => t.status === 'APPROVED'));
      } else {
        setTemplates([]);
        setLoadError(res?.error || 'No se pudieron cargar las plantillas.');
      }
    } catch (e) {
      setTemplates([]);
      setLoadError(userMessageFor(e));
    }
  }
  useEffect(() => { load(); }, []);

  async function pick(name) {
    const t = (templates || []).find((x) => x.name === name) || null;
    setValue(name); // optimistic — the select reflects the choice now
    setState('saving');
    try {
      // One write — the four fields travel together so sendQuoteLink never
      // sees a half-updated template descriptor.
      await saveSettings(t ? {
        whatsappQuoteTemplate: t.name,
        whatsappQuoteTemplateLang: t.language || '',
        whatsappQuoteTemplateVars: Number(t.varCount) || 0,
        whatsappQuoteTemplateButton: !!t.buttonUrlVar,
      } : {
        whatsappQuoteTemplate: '',
        whatsappQuoteTemplateLang: '',
        whatsappQuoteTemplateVars: null,
        whatsappQuoteTemplateButton: false,
      });
      setState('saved');
      setTimeout(() => setState((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } catch {
      setState('error');
    }
  }

  const selected = (templates || []).find((t) => t.name === value) || null;
  // The saved template may have vanished from the approved list (deleted or
  // un-approved in Meta) — keep it visible instead of silently snapping the
  // select to "free text".
  const savedMissing = !!value && templates !== null && !selected;

  // Proactive health: wa-webhook records the latest status/quality per template
  // (Meta can PAUSE/DISABLE an approved one for complaints). Surface the ones
  // Meta is throttling so the dealer fixes them before sends fail silently.
  const BAD_STATUS = ['PAUSED', 'DISABLED', 'REJECTED', 'FLAGGED', 'PENDING_DELETION'];
  const BAD_QUALITY = ['RED', 'LOW'];
  const statusMap = settings?.whatsappTemplateStatus || {};
  const alerts = Object.entries(statusMap)
    .map(([name, s]) => ({ name, ...(s || {}) }))
    .filter((a) => BAD_STATUS.includes((a.status || '').toUpperCase()) || BAD_QUALITY.includes((a.quality || '').toUpperCase()));

  return (
    <div className="mt-3">
      <div className="label inline-flex items-center gap-2">
        Plantilla para enviar cotizaciones
        {state === 'saving' && <span className="text-[11px] font-normal text-ink-400">Guardando…</span>}
        {state === 'saved' && <span className="text-[11px] font-normal text-emerald-700 inline-flex items-center gap-0.5"><Check size={11} /> Guardado</span>}
        {state === 'error' && <span className="text-[11px] font-normal text-red-600">No se pudo guardar</span>}
      </div>
      {alerts.length > 0 && (
        <div className="mb-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-[11px] text-amber-800">
          <div className="font-semibold inline-flex items-center gap-1"><AlertTriangle size={12} /> Plantillas con problemas</div>
          <ul className="mt-1 space-y-0.5">
            {alerts.map((a) => (
              <li key={a.name}>
                <span className="font-mono">{a.name}</span> — {BAD_STATUS.includes((a.status || '').toUpperCase()) ? a.status : `calidad ${a.quality}`}
                {a.reason ? ` · ${a.reason}` : ''}
                {a.name === value ? <strong> (es tu plantilla de cotización)</strong> : ''}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-amber-700">Meta las limita o bloquea. Revísalas en WhatsApp Manager; mientras tanto, los envíos con ellas pueden fallar.</p>
        </div>
      )}
      {templates === null ? (
        <p className="text-xs text-ink-400 inline-flex items-center gap-1.5">
          <Loader2 size={13} className="animate-spin" /> Cargando plantillas…
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <select className="input sm:max-w-[320px]" value={value} onChange={(e) => pick(e.target.value)}
            aria-label="Plantilla para enviar cotizaciones">
            <option value="">— texto libre (solo ventana de 24 h) —</option>
            {savedMissing && <option value={value}>{value} (no encontrada)</option>}
            {templates.map((t) => (
              <option key={`${t.name}:${t.language}`} value={t.name}>
                {t.name} · {t.language}{t.buttonUrlVar ? ' · botón' : ''}
              </option>
            ))}
          </select>
          <button type="button" onClick={load} title="Recargar plantillas" aria-label="Recargar plantillas"
            className="btn-ghost text-xs shrink-0">
            <RefreshCw size={12} />
          </button>
        </div>
      )}
      {loadError && <p className="text-[11px] text-rose-600 mt-1.5">{loadError}</p>}
      {selected?.buttonUrlVar ? (
        <p className="text-[11px] text-ink-500 mt-1.5">
          El enlace viaja en el botón «{selected.buttonText || 'Ver cotización'}»; llega aunque el cliente no haya escrito.
        </p>
      ) : selected ? (
        <p className="text-[11px] text-ink-500 mt-1.5">
          El enlace de la cotización viaja en la variable <code>{'{{1}}'}</code> del cuerpo; llega
          aunque el cliente no haya escrito.
        </p>
      ) : (
        <p className="text-[11px] text-ink-500 mt-1.5">
          Sin plantilla, la cotización se envía como texto libre — solo llega si el cliente
          escribió en las últimas 24 h.
        </p>
      )}
    </div>
  );
}

/**
 * Commerce catalog — the product catalog the chat's product picker browses
 * and sends from. Normally wa-send auto-discovers it from the token (WABA
 * edge, the number's commerce settings, the token's scopes, the business'
 * catalogs); when Meta hides the catalog from the token, the optional ID
 * field pins it directly (Commerce Manager → your catalog — the number in
 * the URL). "Probar catálogo" runs the same listCatalog the chat uses and
 * surfaces wa-send's precise diagnosis (which Meta grant is missing), so the
 * whole fix loop happens here instead of failing later mid-conversation.
 */
function CatalogRow({ settings, saveSettings }) {
  const [value, setValue] = useState(settings?.whatsappCatalogId || '');
  const [state, setState] = useState('idle'); // idle | saving | saved
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null); // null | { ok, msg }
  useEffect(() => { setValue(settings?.whatsappCatalogId || ''); }, [settings?.whatsappCatalogId]);

  const dirty = (value || '').trim() !== (settings?.whatsappCatalogId || '');

  async function saveId() {
    setState('saving');
    try {
      await saveSettings({ whatsappCatalogId: value.replace(/\D/g, '') });
      setState('saved');
      setTimeout(() => setState((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } catch {
      setState('idle');
    }
  }

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      const res = await listWaCatalog({});
      if (res?.ok) {
        const n = (res.products || []).length;
        setResult({
          ok: true,
          msg: n
            ? `Catálogo conectado — ${n}${res.after ? '+' : ''} producto(s) visibles para el chat.`
            : 'Catálogo conectado, pero aún sin productos visibles.',
        });
      } else {
        setResult({ ok: false, msg: res?.error || 'No se pudo ver el catálogo.' });
      }
    } catch (e) {
      setResult({ ok: false, msg: e?.message || 'No se pudo ver el catálogo.' });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="mt-3">
      <div className="label">Catálogo de productos (chat)</div>
      <p className="text-[11px] text-ink-500 mb-2">
        El selector de productos del chat usa el catálogo conectado a tu WhatsApp. Se detecta solo;
        si Meta no se lo muestra al token, pega aquí el <strong>ID del catálogo</strong> (Commerce
        Manager → tu catálogo — el número de la URL). Vacío = detección automática.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="(automático)"
          className="input max-w-56"
          aria-label="ID del catálogo de productos"
        />
        {dirty && (
          <button type="button" onClick={saveId} disabled={state === 'saving'} className="btn-ghost text-xs inline-flex items-center gap-1 disabled:opacity-40">
            {state === 'saving' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Guardar
          </button>
        )}
        {state === 'saved' && <span className="text-[11px] text-emerald-700">Guardado.</span>}
        <button type="button" onClick={test} disabled={testing} className="btn-ghost text-xs inline-flex items-center gap-1 disabled:opacity-40">
          {testing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Probar catálogo
        </button>
      </div>
      {result && (
        <p className={`text-[11px] mt-2 flex items-start gap-1.5 ${result.ok ? 'text-emerald-700' : 'text-amber-700'}`}>
          {result.ok
            ? <Check size={12} className="mt-px shrink-0" />
            : <AlertTriangle size={12} className="mt-px shrink-0" />}
          <span className="min-w-0 break-words whitespace-pre-line">{result.msg}</span>
        </p>
      )}
    </div>
  );
}

/**
 * The number's PUBLIC business profile (what the client sees when opening the
 * chat). Collapsed by default like SetupGuide; the profile is fetched from
 * Meta on first open only — no Graph round-trip for dealers who never expand
 * it. The profile photo can't be set through this API surface, hence the
 * WhatsApp Manager pointer.
 */
/**
 * Quick replies (canned responses) — the small team-shared library the chat
 * composer inserts with one tap. Each entry is { id, label, text }; the text
 * may carry {{nombre}} (the contact) and {{negocio}} (the business name),
 * filled at insert time. The whole array persists on each add / edit / delete
 * through saveSettings (one settings column, replaced wholesale), so the
 * composer button surfaces them the moment they're saved.
 */
function QuickRepliesRow({ settings, saveSettings }) {
  const items = Array.isArray(settings?.whatsappQuickReplies) ? settings.whatsappQuickReplies : [];
  const [editingId, setEditingId] = useState(null); // entry id | 'new' | null
  const [label, setLabel] = useState('');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const negocio = settings?.companyName || 'tu negocio';

  function startAdd() { setEditingId('new'); setLabel(''); setText(''); }
  function startEdit(qr) { setEditingId(qr.id); setLabel(qr.label || ''); setText(qr.text || ''); }
  function cancel() { setEditingId(null); setLabel(''); setText(''); }

  async function persist(next) {
    setSaving(true);
    try {
      await saveSettings({ whatsappQuickReplies: next });
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    const l = label.trim();
    const t = text.trim();
    if (!l || !t) return;
    const next = editingId === 'new'
      ? [...items, { id: newId(), label: l, text: t }]
      : items.map((q) => (q.id === editingId ? { ...q, label: l, text: t } : q));
    await persist(next);
    cancel();
  }

  async function remove(id) {
    await persist(items.filter((q) => q.id !== id));
    if (editingId === id) cancel();
  }

  return (
    <div className="mt-3">
      <div className="label inline-flex items-center gap-1.5"><Zap size={12} className="text-brand-600" /> Respuestas rápidas</div>
      <p className="text-[11px] text-ink-500 mb-2">
        Frases reutilizables que insertas en el chat con un toque. Usa <code>{'{{nombre}}'}</code> (el cliente) y{' '}
        <code>{'{{negocio}}'}</code> ({negocio}) y se completan al insertarlas.
      </p>

      {items.length > 0 && (
        <ul className="space-y-1.5 mb-2">
          {items.map((qr) => (
            <li key={qr.id}>
              {editingId === qr.id ? (
                <QuickReplyForm
                  label={label} text={text} setLabel={setLabel} setText={setText}
                  onSave={save} onCancel={cancel} saving={saving}
                />
              ) : (
                <div className="flex items-start gap-2 rounded-lg border border-ink-200 bg-white px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-ink-800 truncate">{qr.label}</div>
                    <div className="text-[11px] text-ink-500 line-clamp-2 whitespace-pre-wrap">{qr.text}</div>
                  </div>
                  <button type="button" onClick={() => startEdit(qr)} disabled={saving} className="p-1.5 rounded text-ink-400 hover:text-ink-700 hover:bg-ink-50 disabled:opacity-40 shrink-0" title="Editar" aria-label="Editar respuesta">
                    <Pencil size={13} />
                  </button>
                  <button type="button" onClick={() => remove(qr.id)} disabled={saving} className="p-1.5 rounded text-ink-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-40 shrink-0" title="Eliminar" aria-label="Eliminar respuesta">
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {editingId === 'new' ? (
        <QuickReplyForm
          label={label} text={text} setLabel={setLabel} setText={setText}
          onSave={save} onCancel={cancel} saving={saving}
        />
      ) : (
        <button type="button" onClick={startAdd} className="btn-ghost text-xs inline-flex items-center gap-1">
          <Plus size={13} /> Añadir respuesta
        </button>
      )}
    </div>
  );
}

/** The add/edit form shared by a new entry and an inline edit. */
function QuickReplyForm({ label, text, setLabel, setText, onSave, onCancel, saving }) {
  const valid = label.trim() && text.trim();
  return (
    <div className="rounded-lg border border-brand-200 bg-brand-50/40 p-2.5 space-y-2">
      <input
        type="text"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Título (p. ej. Saludo)"
        className="input text-sm"
        aria-label="Título de la respuesta rápida"
        maxLength={40}
      />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Hola {{nombre}}, gracias por escribir a {{negocio}}…"
        className="input text-sm min-h-[72px] resize-y"
        aria-label="Texto de la respuesta rápida"
      />
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn-ghost text-xs inline-flex items-center gap-1">
          <X size={13} /> Cancelar
        </button>
        <button type="button" onClick={onSave} disabled={!valid || saving} className="btn-primary text-xs inline-flex items-center gap-1 disabled:opacity-40">
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Guardar
        </button>
      </div>
    </div>
  );
}

/**
 * Conversational components — the first-contact menu Meta shows a NEW chatter:
 * ice breakers (≤4 tappable prompts before they type) and slash-commands (the
 * "/" autocomplete). Loaded from the number on first open and saved as a whole
 * (the API replaces the set). A furniture dealer points the breakers at the
 * common first asks — "Ver catálogo", "Cotizar", "Horario y ubicación".
 */
function ConversationalRow() {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [prompts, setPrompts] = useState([]);       // string[]
  const [commands, setCommands] = useState([]);      // { name, description }[]
  const [state, setState] = useState('idle');        // idle | saving | saved | error
  const [msg, setMsg] = useState('');

  async function load() {
    setLoading(true);
    setMsg('');
    try {
      const res = await getConversationalAutomation();
      if (res?.ok) {
        setPrompts(Array.isArray(res.prompts) ? res.prompts : []);
        setCommands(Array.isArray(res.commands) ? res.commands : []);
        setLoaded(true);
      } else {
        setMsg(res?.error || 'No se pudo leer el menú de inicio.');
      }
    } catch (e) {
      setMsg(e?.message || 'No se pudo leer el menú de inicio.');
    } finally {
      setLoading(false);
    }
  }
  function expand() { setOpen(true); if (!loaded && !loading) load(); }

  async function save() {
    setState('saving');
    setMsg('');
    try {
      const res = await saveConversationalAutomation({
        prompts: prompts.map((p) => p.trim()).filter(Boolean),
        commands: commands.map((c) => ({ name: c.name.trim(), description: c.description.trim() })).filter((c) => c.name && c.description),
      });
      if (res?.ok) {
        setState('saved');
        setTimeout(() => setState((s) => (s === 'saved' ? 'idle' : s)), 2000);
      } else {
        setState('error');
        setMsg(res?.error || 'No se pudo guardar.');
      }
    } catch (e) {
      setState('error');
      setMsg(e?.message || 'No se pudo guardar.');
    }
  }

  if (!open) {
    return (
      <div className="mt-3">
        <button type="button" onClick={expand} className="btn-ghost text-xs inline-flex items-center gap-1.5">
          <MessageCircle size={13} /> Menú de inicio (atajos y bienvenida)
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-ink-100 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="label inline-flex items-center gap-1.5 mb-0"><MessageCircle size={12} className="text-emerald-600" /> Menú de inicio</div>
        <button type="button" onClick={() => setOpen(false)} className="p-1 -m-1 rounded text-ink-400 hover:text-ink-700 hover:bg-ink-50 shrink-0" aria-label="Cerrar"><X size={14} /></button>
      </div>
      <p className="text-[11px] text-ink-500 mb-2.5">
        Lo que ve un cliente nuevo al abrir el chat: <strong>botones de inicio</strong> (máx. 4) y{' '}
        <strong>comandos «/»</strong>. Se guardan en el número de WhatsApp.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-ink-400 py-3"><Loader2 size={14} className="animate-spin" /> Cargando…</div>
      ) : (
        <>
          {/* Ice breakers */}
          <div className="space-y-1.5">
            <div className="text-[11px] font-semibold text-ink-600">Botones de inicio</div>
            {prompts.map((p, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={p}
                  maxLength={80}
                  onChange={(e) => setPrompts((arr) => arr.map((x, j) => (j === i ? e.target.value : x)))}
                  placeholder="p. ej. Ver catálogo"
                  className="input text-sm"
                  aria-label={`Botón de inicio ${i + 1}`}
                />
                <button type="button" onClick={() => setPrompts((arr) => arr.filter((_, j) => j !== i))} className="p-1.5 rounded text-ink-400 hover:text-red-600 hover:bg-red-50 shrink-0" aria-label="Quitar botón">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {prompts.length < 4 && (
              <button type="button" onClick={() => setPrompts((arr) => [...arr, ''])} className="btn-ghost text-xs inline-flex items-center gap-1">
                <Plus size={12} /> Añadir botón
              </button>
            )}
          </div>

          {/* Commands */}
          <div className="space-y-1.5 mt-3">
            <div className="text-[11px] font-semibold text-ink-600">Comandos «/»</div>
            {commands.map((c, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <span className="text-ink-400 text-sm">/</span>
                <input
                  type="text"
                  value={c.name}
                  maxLength={32}
                  onChange={(e) => setCommands((arr) => arr.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                  placeholder="cotizar"
                  className="input text-sm w-28 shrink-0"
                  aria-label={`Comando ${i + 1}`}
                />
                <input
                  type="text"
                  value={c.description}
                  maxLength={256}
                  onChange={(e) => setCommands((arr) => arr.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                  placeholder="Solicitar una cotización"
                  className="input text-sm"
                  aria-label={`Descripción del comando ${i + 1}`}
                />
                <button type="button" onClick={() => setCommands((arr) => arr.filter((_, j) => j !== i))} className="p-1.5 rounded text-ink-400 hover:text-red-600 hover:bg-red-50 shrink-0" aria-label="Quitar comando">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {commands.length < 30 && (
              <button type="button" onClick={() => setCommands((arr) => [...arr, { name: '', description: '' }])} className="btn-ghost text-xs inline-flex items-center gap-1">
                <Plus size={12} /> Añadir comando
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 mt-3">
            <button type="button" onClick={save} disabled={state === 'saving'} className="btn-primary text-xs inline-flex items-center gap-1 disabled:opacity-40">
              {state === 'saving' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Guardar menú
            </button>
            {state === 'saved' && <span className="text-[11px] text-emerald-700">Guardado en WhatsApp.</span>}
          </div>
        </>
      )}
      {msg && (
        <p className={`text-[11px] mt-2 flex items-start gap-1.5 ${state === 'error' ? 'text-rose-600' : 'text-amber-700'}`}>
          <AlertTriangle size={12} className="mt-px shrink-0" /> <span className="min-w-0 break-words">{msg}</span>
        </p>
      )}
    </div>
  );
}

/**
 * Managed click-to-chat QR links — a dealer prints these on catalogs, invoices
 * and the storefront so a scan opens WhatsApp to the business number with a
 * message pre-typed ("Hola, quiero una cotización"). Each is a stable code +
 * a wa.me/message/<code> deep link + a Meta-hosted QR image. Loaded on first
 * open; create/delete round-trip straight to Meta.
 */
function QrCodesRow() {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [codes, setCodes] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState('');

  async function load() {
    setLoading(true);
    setMsg('');
    try {
      const res = await listWaQrCodes();
      if (res?.ok) { setCodes(res.codes || []); setLoaded(true); }
      else setMsg(res?.error || 'No se pudieron cargar los códigos.');
    } catch (e) {
      setMsg(e?.message || 'No se pudieron cargar los códigos.');
    } finally {
      setLoading(false);
    }
  }
  function expand() { setOpen(true); if (!loaded && !loading) load(); }

  async function create() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await createWaQrCode({ prefilledMessage: text });
      if (res?.ok && res.code) { setCodes((c) => [res.code, ...c]); setDraft(''); }
      else setMsg(res?.error || 'No se pudo crear el código.');
    } catch (e) {
      setMsg(e?.message || 'No se pudo crear el código.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(code) {
    setBusy(true);
    setMsg('');
    try {
      const res = await deleteWaQrCode(code);
      if (res?.ok) setCodes((c) => c.filter((x) => x.code !== code));
      else setMsg(res?.error || 'No se pudo eliminar.');
    } catch (e) {
      setMsg(e?.message || 'No se pudo eliminar.');
    } finally {
      setBusy(false);
    }
  }

  async function copy(link) {
    try { await navigator.clipboard.writeText(link); setCopied(link); setTimeout(() => setCopied((c) => (c === link ? '' : c)), 1500); } catch { /* clipboard blocked */ }
  }

  if (!open) {
    return (
      <div className="mt-3">
        <button type="button" onClick={expand} className="btn-ghost text-xs inline-flex items-center gap-1.5">
          <QrCode size={13} /> Códigos QR / enlaces de chat
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-ink-100 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="label inline-flex items-center gap-1.5 mb-0"><QrCode size={12} className="text-emerald-600" /> Códigos QR / enlaces de chat</div>
        <button type="button" onClick={() => setOpen(false)} className="p-1 -m-1 rounded text-ink-400 hover:text-ink-700 hover:bg-ink-50 shrink-0" aria-label="Cerrar"><X size={14} /></button>
      </div>
      <p className="text-[11px] text-ink-500 mb-2.5">
        Imprime un código en catálogos, facturas o la tienda: al escanearlo, el cliente abre WhatsApp
        con un mensaje ya escrito hacia tu número.
      </p>

      <div className="flex items-end gap-2 mb-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Hola, quiero una cotización de Ligne Roset."
          className="input text-sm flex-1 min-h-[44px] resize-y"
          aria-label="Mensaje del código QR"
        />
        <button type="button" onClick={create} disabled={busy || !draft.trim()} className="btn-primary text-xs inline-flex items-center gap-1 disabled:opacity-40 shrink-0">
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Crear
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-ink-400 py-3"><Loader2 size={14} className="animate-spin" /> Cargando…</div>
      ) : codes.length ? (
        <ul className="space-y-2">
          {codes.map((c) => (
            <li key={c.code} className="flex items-start gap-3 rounded-lg border border-ink-200 bg-white p-2.5">
              {c.imageUrl && <img src={c.imageUrl} alt={`QR ${c.code}`} className="h-16 w-16 shrink-0 rounded border border-ink-100" />}
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ink-800 truncate">{c.prefilledMessage || '(sin mensaje)'}</div>
                {c.deepLink && (
                  <button type="button" onClick={() => copy(c.deepLink)} className="mt-1 inline-flex items-center gap-1 text-[11px] text-emerald-700 hover:text-emerald-800" title="Copiar enlace">
                    <Copy size={11} /> {copied === c.deepLink ? 'Copiado' : c.deepLink}
                  </button>
                )}
              </div>
              <button type="button" onClick={() => remove(c.code)} disabled={busy} className="p-1.5 rounded text-ink-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-40 shrink-0" aria-label="Eliminar código">
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-ink-400">Aún no hay códigos. Crea el primero arriba.</p>
      )}

      {msg && (
        <p className="text-[11px] mt-2 text-rose-600 flex items-start gap-1.5">
          <AlertTriangle size={12} className="mt-px shrink-0" /> <span className="min-w-0 break-words">{msg}</span>
        </p>
      )}
    </div>
  );
}

/**
 * Number health — the WhatsApp quality rating (GREEN/YELLOW/RED) and current
 * messaging-limit tier, mirrored onto settings by the connection test and the
 * phone_number_quality_update webhook. A degraded number is throttled or
 * blocked by Meta, so surfacing it lets the dealer act before campaigns fail.
 */
function NumberHealth({ settings }) {
  const rating = (settings?.whatsappQualityRating || '').toUpperCase();
  const limit = settings?.whatsappMessagingLimit || '';
  if (!rating && !limit) return null;
  const tone = rating === 'GREEN'
    ? { dot: 'bg-emerald-500', text: 'text-emerald-700', label: 'Alta' }
    : rating === 'YELLOW'
      ? { dot: 'bg-amber-500', text: 'text-amber-700', label: 'Media' }
      : rating === 'RED'
        ? { dot: 'bg-red-500', text: 'text-red-700', label: 'Baja' }
        : { dot: 'bg-ink-300', text: 'text-ink-500', label: rating || '—' };
  const LIMITS = { TIER_50: '50/día', TIER_250: '250/día', TIER_1K: '1.000/día', TIER_10K: '10.000/día', TIER_100K: '100.000/día', TIER_UNLIMITED: 'Sin límite' };
  const limitLabel = LIMITS[String(limit).toUpperCase()] || '';
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
      {rating && (
        <span className={`inline-flex items-center gap-1.5 ${tone.text}`} title="Calidad del número según Meta">
          <span className={`h-2 w-2 rounded-full ${tone.dot}`} aria-hidden /> Calidad: {tone.label}
        </span>
      )}
      {limitLabel && (
        <span className="inline-flex items-center gap-1 text-ink-500" title="Límite de clientes nuevos por 24 h">
          <Send size={11} /> Límite: {limitLabel}
        </span>
      )}
      {rating === 'RED' && (
        <span className="text-red-700">Meta está limitando este número — revisa la calidad en WhatsApp Manager.</span>
      )}
    </div>
  );
}

/**
 * Reception health + end-to-end self-test — "how do I know I'm not missing
 * messages?". Passive: surfaces any VERIFIED delivery wa-webhook failed to store
 * (wa_webhook_events with processed=false → Meta is redelivering it) and when the
 * last inbound landed. Active: "Probar recepción" watches the inbound count and
 * confirms when a real message arrives — proving Meta → webhook → DB end to end,
 * the one check that catches a wrong App Secret or an unsubscribed `messages`
 * field (which leave nothing to count passively).
 */
function ReceptionHealth() {
  const [health, setHealth] = useState(null);
  const [probe, setProbe] = useState('idle'); // idle | waiting | ok | timeout | error
  const baseline = useRef(0);
  const timer = useRef(null);

  async function loadHealth() {
    try {
      const failedEvents = await db.waWebhookEvents.where('processed').equals(false).toArray();
      const last = await db.waMessages.where('direction').equals('in').orderBy('createdAt').reverse().first();
      setHealth(resolveWaHealth({ failedEvents, lastInboundAt: last?.createdAt ?? null }));
    } catch {
      // Table not migrated yet / transient read — hide the passive row, keep the test.
      setHealth(null);
    }
  }
  useEffect(() => {
    loadHealth();
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);

  async function startProbe() {
    if (probe === 'waiting') return;
    setProbe('waiting');
    try {
      baseline.current = await db.waMessages.where('direction').equals('in').count();
    } catch {
      setProbe('error');
      return;
    }
    const startedAt = Date.now();
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(async () => {
      try {
        const n = await db.waMessages.where('direction').equals('in').count();
        if (n > baseline.current) {
          clearInterval(timer.current); timer.current = null;
          setProbe('ok');
          loadHealth();
        } else if (Date.now() - startedAt > 120_000) {
          clearInterval(timer.current); timer.current = null;
          setProbe('timeout');
        }
      } catch { /* transient read — keep polling until the timeout */ }
    }, 4000);
  }

  const down = health?.status === 'down';
  return (
    <div className="mt-4 rounded-lg border border-ink-100 px-4 py-3.5">
      <div className="font-medium text-sm text-ink-800 mb-2 inline-flex items-center gap-1.5">
        <MessageCircle size={14} className="text-emerald-600" aria-hidden /> Recepción de mensajes
      </div>

      {down ? (
        <div className="rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-[11px] text-rose-800">
          <div className="font-semibold inline-flex items-center gap-1">
            <AlertTriangle size={12} /> {health.failedCount} entrega(s) no se pudieron guardar
          </div>
          <p className="mt-1">
            Meta las está reintentando automáticamente
            {health.oldestFailedAt ? ` (la más antigua: ${formatDateTime(health.oldestFailedAt)})` : ''}.
            Si persiste, revisa los registros de la función wa-webhook.
          </p>
          {health.errorSample && <p className="mt-1 font-mono break-words text-rose-700">{health.errorSample}</p>}
        </div>
      ) : health ? (
        <p className="text-[11px] text-ink-500 inline-flex items-start gap-1.5">
          <Check size={12} className="text-emerald-600 shrink-0 mt-px" aria-hidden />
          {health.lastInboundAt
            ? `Sin entregas fallidas. Último mensaje recibido ${health.hoursSinceInbound === 0 ? 'hace menos de 1 h' : `hace ${health.hoursSinceInbound} h`}.`
            : 'Sin entregas fallidas. Aún no se ha recibido ningún mensaje.'}
        </p>
      ) : null}

      <div className="mt-2.5">
        <button type="button" onClick={startProbe} disabled={probe === 'waiting'}
          className="btn-ghost text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
          {probe === 'waiting' ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          Probar recepción
        </button>
        {probe === 'waiting' && (
          <p className="text-[11px] text-ink-500 mt-2">
            Envía un WhatsApp a tu número <strong>desde otro teléfono</strong> ahora — esperando a que llegue (hasta 2 min)…
          </p>
        )}
        {probe === 'ok' && (
          <p className="text-[11px] text-emerald-700 mt-2 flex items-start gap-1.5">
            <Check size={13} className="mt-px shrink-0" /> Mensaje recibido — la recepción funciona de extremo a extremo.
          </p>
        )}
        {probe === 'timeout' && (
          <p className="text-[11px] text-amber-700 mt-2 flex items-start gap-1.5">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>
              No llegó ningún mensaje en 2 min. Revisa: (1) el campo <strong>messages</strong> está suscrito en
              Meta → WhatsApp → Configuration; (2) el <strong>App Secret</strong> guardado es correcto;
              (3) la Callback URL está verificada.
            </span>
          </p>
        )}
        {probe === 'error' && (
          <p className="text-[11px] text-rose-600 mt-2">No se pudo iniciar la prueba. Inténtalo de nuevo.</p>
        )}
        <p className="text-[11px] text-ink-400 mt-2">
          Comprueba de extremo a extremo que los mensajes entrantes llegan a la app. Cualquier mensaje nuevo de un cliente confirma la prueba.
        </p>
      </div>
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
      setMsg(userMessageFor(e));
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
