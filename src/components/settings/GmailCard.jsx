// Gmail connection card — Gmail + Drive ride ONE Google OAuth account.
//
// Flow: paste the Google Cloud OAuth client's Client ID + Secret (stored
// write-only server-side by the google-api function), then "Conectar Google"
// launches Google's consent dialog with offline access. Google redirects back
// to the google-api function, which mints the refresh token and bounces here
// with ?google=connected. Tokens never touch the browser. This single grant
// also powers the Google Drive card.
import { useCallback, useEffect, useState } from 'react';
import { Mail, RefreshCw, Check, Copy, ExternalLink, Sparkles } from 'lucide-react';
import SettingsSection from './SettingsSection.jsx';
import CredentialInput from './CredentialInput.jsx';
import { useApp } from '../../context/AppContext.jsx';
import { SUPABASE_URL } from '../../db/supabaseClient.js';
import { saveGoogleConfig, connectGoogle, disconnectGoogle, saveGoogleLoginDomain } from '../../lib/google.js';
import { sanitizeSignatureHtml, defaultSignatureHtml } from '../../lib/gmail.js';
import { userMessageFor } from '../../lib/errorMessages.js';

// The OAuth redirect URI the admin must register in the Google Cloud OAuth
// client. Derived from the project URL — matches what the Edge Function uses.
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/google-api`;

export default function GmailCard() {
  const { settings, currentProfile, refreshSettings, saveSettings, isAdmin } = useApp();
  const connected = !!settings?.googleConnectedAt;
  const email = settings?.googleEmail || '';
  const appConfigured = !!settings?.googleClientId;

  const [clientId, setClientId] = useState(settings?.googleClientId || '');
  const [clientSecret, setClientSecret] = useState('');
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved | error
  const [state, setState] = useState('idle'); // idle | connecting
  const [msg, setMsg] = useState(null); // { ok, text }
  const [copied, setCopied] = useState(false);
  // "Sign in with Google" allowed domain. Empty ⇒ falls back to the connected
  // account's domain server-side; the placeholder shows that fallback.
  const [loginDomain, setLoginDomain] = useState(settings?.googleLoginDomain || '');
  const [domainState, setDomainState] = useState('idle'); // idle | saving | saved
  const fallbackDomain = (email.split('@')[1] || '').toLowerCase();
  // Reply signatures — plain text seeded into the inbox reply composer. The
  // dealer keeps a Spanish and an English one and picks per reply.
  const [signature, setSignature] = useState(settings?.gmailSignature || '');
  const [signatureEn, setSignatureEn] = useState(settings?.gmailSignatureEn || '');
  const [sigState, setSigState] = useState('idle'); // idle | saving | saved | importing

  useEffect(() => { setClientId(settings?.googleClientId || ''); }, [settings?.googleClientId]);
  useEffect(() => { setLoginDomain(settings?.googleLoginDomain || ''); }, [settings?.googleLoginDomain]);
  useEffect(() => { setSignature(settings?.gmailSignature || ''); }, [settings?.gmailSignature]);
  useEffect(() => { setSignatureEn(settings?.gmailSignatureEn || ''); }, [settings?.gmailSignatureEn]);

  const saveSignature = useCallback(async () => {
    setSigState('saving');
    setMsg(null);
    try {
      await saveSettings?.({ gmailSignature: signature, gmailSignatureEn: signatureEn });
      setSigState('saved');
      setTimeout(() => setSigState((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } catch (e) {
      setSigState('idle');
      setMsg({ ok: false, text: userMessageFor(e) });
    }
  }, [signature, signatureEn, saveSettings]);

  // Seed a language slot with the branded starter signature, pre-filled from the
  // company's real letterhead (Configuración → Empresa) + the signed-in user's
  // name, so it lands as the dealer's actual signature ready to edit.
  const company = settings?.companyName || 'ALCOVER';
  const useTemplate = useCallback((lang) => {
    const html = defaultSignatureHtml(lang, {
      company,
      name: currentProfile?.name || '',
      rnc: settings?.companyRnc || '',
      address: settings?.companyAddress || '',
      phone: settings?.companyPhone || '',
      website: (settings?.companyEmail || '').split('@')[1] || '',
    });
    if (lang === 'en') setSignatureEn(html); else setSignature(html);
  }, [company, currentProfile?.name, settings?.companyRnc, settings?.companyAddress, settings?.companyPhone, settings?.companyEmail]);

  const saveLoginDomain = useCallback(async () => {
    setDomainState('saving');
    setMsg(null);
    try {
      await saveGoogleLoginDomain(loginDomain.trim().replace(/^@/, ''));
      setDomainState('saved');
      await refreshSettings?.();
      setTimeout(() => setDomainState((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } catch (e) {
      setDomainState('idle');
      setMsg({ ok: false, text: userMessageFor(e) });
    }
  }, [loginDomain, refreshSettings]);

  // Read the OAuth round-trip result the function appended to the hash
  // (#/integraciones?google=connected | ?google_error=…), surface it, clean URL.
  useEffect(() => {
    const hash = window.location.hash || '';
    const qIndex = hash.indexOf('?');
    if (qIndex === -1) return;
    const params = new URLSearchParams(hash.slice(qIndex + 1));
    const ok = params.get('google');
    const err = params.get('google_error');
    if (!ok && !err) return;
    if (ok === 'connected') { setMsg({ ok: true, text: 'Google conectado ✓' }); refreshSettings?.(); }
    else if (err) setMsg({ ok: false, text: `No se pudo conectar: ${decodeURIComponent(err)}` });
    const clean = `${window.location.href.split('#')[0]}#/integraciones`;
    window.history.replaceState(null, '', clean);
  }, [refreshSettings]);

  const saveApp = useCallback(async () => {
    const id = clientId.trim();
    if (!id) { setMsg({ ok: false, text: 'Escribe el Client ID de Google.' }); return; }
    if (!appConfigured && !clientSecret.trim()) { setMsg({ ok: false, text: 'Escribe también el Client Secret la primera vez.' }); return; }
    setSaveState('saving');
    setMsg(null);
    try {
      await saveGoogleConfig({ clientId: id, clientSecret: clientSecret.trim() });
      setSaveState('saved');
      setClientSecret('');
      await refreshSettings?.();
      setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } catch (e) {
      setSaveState('error');
      setMsg({ ok: false, text: userMessageFor(e) });
    }
  }, [clientId, clientSecret, appConfigured, refreshSettings]);

  const connect = useCallback(async () => {
    if (state === 'connecting') return;
    setState('connecting');
    setMsg(null);
    try {
      const returnTo = `${window.location.origin}${window.location.pathname}#/integraciones`;
      const url = await connectGoogle({ returnTo });
      window.location.assign(url); // full-page redirect to Google's consent dialog
    } catch (e) {
      setState('idle');
      setMsg({ ok: false, text: userMessageFor(e) });
    }
  }, [state]);

  const disconnect = useCallback(async () => {
    setMsg(null);
    try {
      await disconnectGoogle();
      await refreshSettings?.();
      setMsg({ ok: true, text: 'Google desconectado.' });
    } catch (e) {
      setMsg({ ok: false, text: userMessageFor(e) });
    }
  }, [refreshSettings]);

  const copyRedirect = useCallback(() => {
    navigator.clipboard?.writeText(REDIRECT_URI).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, []);

  if (!isAdmin) return null;

  return (
    <SettingsSection title="Gmail">
      <div className="space-y-4">
        <p className="text-xs text-ink-600 leading-relaxed">
          Conecta una cuenta de <strong>Google</strong> para enviar cotizaciones y archivos por correo y
          para guardar documentos en Google Drive —una sola conexión cubre ambos. Crea un cliente OAuth en
          <strong> Google Cloud Console</strong> (tipo “Aplicación web”) con los permisos de Gmail enviar
          y Drive, y pega aquí su Client ID y Client Secret.
        </p>

        {connected && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-200 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-200">
            <Mail size={15} />
            <span>Conectado{email ? ` como ${email}` : ''}.</span>
          </div>
        )}

        {/* App credentials */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="google-client-id">Client ID</label>
            <CredentialInput
              id="google-client-id" name="google-client-id" className="input mt-1"
              placeholder="p. ej. 1234-abc.apps.googleusercontent.com"
              value={clientId} onChange={(e) => setClientId(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="google-client-secret">Client Secret</label>
            <CredentialInput
              secret id="google-client-secret" name="google-client-secret" className="input mt-1"
              placeholder={appConfigured ? '•••••• (guardado — deja vacío para conservarlo)' : 'Client Secret de Google'}
              value={clientSecret} onChange={(e) => setClientSecret(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-ghost min-h-[44px]" onClick={saveApp} disabled={saveState === 'saving'}>
            {saveState === 'saving' ? <RefreshCw size={14} className="animate-spin" /> : saveState === 'saved' ? <Check size={14} /> : null}
            {saveState === 'saved' ? 'Guardado' : 'Guardar credenciales'}
          </button>
          <button type="button" className="btn-brand min-h-[44px]" onClick={connect} disabled={state === 'connecting' || !appConfigured}>
            {state === 'connecting' ? <RefreshCw size={14} className="animate-spin" /> : <Mail size={14} />}
            {connected ? 'Reconectar Google' : 'Conectar Google'}
          </button>
          {connected && (
            <button type="button" className="btn-ghost min-h-[44px]" onClick={disconnect}>Desconectar</button>
          )}
        </div>

        {/* Reply signatures — rich HTML seeded into the inbox reply composer;
            the dealer keeps one per language and picks when replying. Edit the
            HTML and see it rendered live; "Plantilla" drops in a branded
            starter. Paste your existing email signature's HTML to match it. */}
        {connected && (
          <div className="rounded-lg border border-ink-100 bg-ink-50/40 p-3">
            <div className="text-[11px] uppercase tracking-wider text-ink-400 mb-1">Firmas de respuestas</div>
            <p className="text-xs text-ink-500 mb-3">
              Al responder desde la bandeja eliges cuál usar. Edita el HTML (o pega tu firma actual) y velo
              renderizado abajo; deja una vacía para no ofrecerla.
            </p>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <SignatureField label="Español" value={signature} onChange={setSignature} onTemplate={() => useTemplate('es')} />
              <SignatureField label="English" value={signatureEn} onChange={setSignatureEn} onTemplate={() => useTemplate('en')} />
            </div>
            <div className="mt-3 flex justify-end">
              <button type="button" className="btn-ghost min-h-[44px]" onClick={saveSignature} disabled={sigState === 'saving'}>
                {sigState === 'saving' ? <RefreshCw size={14} className="animate-spin" /> : sigState === 'saved' ? <Check size={14} /> : null}
                {sigState === 'saved' ? 'Guardadas' : 'Guardar firmas'}
              </button>
            </div>
          </div>
        )}

        {/* Sign in with Google — domain allow-list */}
        <div className="rounded-lg border border-ink-100 bg-ink-50/40 p-3">
          <label className="text-[11px] uppercase tracking-wider text-ink-400 mb-1 block" htmlFor="google-login-domain">Acceso con Google (login)</label>
          <p className="text-xs text-ink-500 mb-2">
            Habilita el botón “Continuar con Google” en la pantalla de inicio para tu equipo. Solo entran
            las cuentas de Google de este dominio; en su primer acceso quedan <em>pendientes de aprobación</em>.
            Déjalo vacío para usar el dominio de la cuenta conectada{fallbackDomain ? <> (<code>{fallbackDomain}</code>)</> : null}.
          </p>
          <div className="flex items-center gap-2">
            <input
              id="google-login-domain"
              type="text"
              className="input flex-1"
              placeholder={fallbackDomain || 'p. ej. alcover.do'}
              value={loginDomain}
              onChange={(e) => setLoginDomain(e.target.value)}
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
            />
            <button type="button" className="btn-ghost shrink-0 min-h-[44px]" onClick={saveLoginDomain} disabled={domainState === 'saving'}>
              {domainState === 'saving' ? <RefreshCw size={14} className="animate-spin" /> : domainState === 'saved' ? <Check size={14} /> : null}
              {domainState === 'saved' ? 'Guardado' : 'Guardar'}
            </button>
          </div>
        </div>

        {/* Redirect URI to register in Google Cloud */}
        <div className="rounded-lg border border-ink-100 bg-ink-50/40 p-3">
          <div className="text-[11px] uppercase tracking-wider text-ink-400 mb-1">URI de redirección OAuth</div>
          <p className="text-xs text-ink-500 mb-2">
            Agrega esta URL exacta en tu cliente OAuth de Google Cloud →
            <em> Authorized redirect URIs</em> antes de conectar.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-surface border border-ink-100 px-2 py-1.5 text-xs text-ink-700">{REDIRECT_URI}</code>
            <button type="button" className="btn-ghost shrink-0 min-h-[44px]" onClick={copyRedirect} title="Copiar">
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank" rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-xs text-brand-700 hover:underline"
          >
            <ExternalLink size={12} /> Abrir Google Cloud · Credenciales
          </a>
        </div>

        {msg && <div className={`text-sm ${msg.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{msg.text}</div>}
      </div>
    </SettingsSection>
  );
}

/** One language's signature: an HTML source box + a live rendered preview. */
function SignatureField({ label, value, onChange, onTemplate }) {
  const preview = sanitizeSignatureHtml(value);
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-ink-600">{label}</span>
        <button type="button" className="inline-flex items-center gap-1 text-[11px] text-brand-700 hover:underline" onClick={onTemplate}>
          <Sparkles size={11} /> Plantilla
        </button>
      </div>
      <textarea
        className="input w-full min-h-[120px] resize-y font-mono text-[11px] leading-relaxed"
        placeholder="<div>Tu firma… (HTML)</div>"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      <div className="mt-1.5 text-[10px] uppercase tracking-wider text-ink-400">Vista previa</div>
      {/* White "paper" on purpose (like the Gmail message it will ride in) —
          signature HTML carries its own fixed colors, so it must not sit on a
          dark surface in dark mode. */}
      <div className="mt-1 min-h-[60px] rounded-lg border border-ink-100 bg-white text-stone-900 p-3 overflow-auto">
        {preview
          ? <div dangerouslySetInnerHTML={{ __html: preview }} />
          : <span className="text-xs text-ink-300">Sin firma</span>}
      </div>
    </div>
  );
}
