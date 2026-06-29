// Instagram connection card — "Instagram API with Instagram Login".
//
// The dealer connects their Instagram professional account DIRECTLY (no
// Facebook Page). Flow: paste the Instagram app's App ID + App Secret (stored
// write-only server-side by the meta-social function), then "Conectar
// Instagram" launches Meta's consent dialog (the OAuth authorization flow).
// Instagram redirects back to the meta-social function, which mints the
// long-lived token and bounces here with ?ig=connected. Tokens never touch the
// browser.
import { useCallback, useEffect, useState } from 'react';
import { Instagram, RefreshCw, Check, Copy, ExternalLink } from 'lucide-react';
import SettingsSection from './SettingsSection.jsx';
import CredentialInput from './CredentialInput.jsx';
import { useApp } from '../../context/AppContext.jsx';
import { supabase, SUPABASE_URL } from '../../db/supabaseClient.js';
import { userMessageFor } from '../../lib/errorMessages.js';

// The OAuth redirect URI the admin must register in the Instagram app's
// "Business login settings". Derived from the project URL — matches what the
// Edge Function uses for the token exchange.
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/meta-social`;

export default function InstagramCard() {
  const { settings, refreshSettings, isAdmin } = useApp();
  const connected = !!settings?.metaSocialConnectedAt;
  const igUsername = settings?.metaSocialIgUsername || '';
  const appConfigured = !!settings?.metaSocialIgAppId;

  const [appId, setAppId] = useState(settings?.metaSocialIgAppId || '');
  const [appSecret, setAppSecret] = useState('');
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved | error
  const [state, setState] = useState('idle'); // idle | connecting
  const [msg, setMsg] = useState(null); // { ok, text }
  const [copied, setCopied] = useState(false);

  useEffect(() => { setAppId(settings?.metaSocialIgAppId || ''); }, [settings?.metaSocialIgAppId]);

  // Read the OAuth round-trip result the function appended to the hash
  // (#/integraciones?ig=connected | ?ig_error=…), surface it, then clean the URL.
  useEffect(() => {
    const hash = window.location.hash || '';
    const qIndex = hash.indexOf('?');
    if (qIndex === -1) return;
    const params = new URLSearchParams(hash.slice(qIndex + 1));
    const ok = params.get('ig');
    const err = params.get('ig_error');
    if (!ok && !err) return;
    if (ok === 'connected') { setMsg({ ok: true, text: 'Instagram conectado ✓' }); refreshSettings?.(); }
    else if (err) setMsg({ ok: false, text: `No se pudo conectar: ${decodeURIComponent(err)}` });
    const clean = `${window.location.href.split('#')[0]}#/integraciones`;
    window.history.replaceState(null, '', clean);
  }, [refreshSettings]);

  const saveApp = useCallback(async () => {
    const id = appId.trim();
    if (!id) { setMsg({ ok: false, text: 'Escribe el App ID de Instagram.' }); return; }
    if (!appConfigured && !appSecret.trim()) { setMsg({ ok: false, text: 'Escribe también el App Secret la primera vez.' }); return; }
    setSaveState('saving');
    setMsg(null);
    try {
      const { data, error } = await supabase.functions.invoke('meta-social', {
        body: { saveApp: { appId: id, appSecret: appSecret.trim() } },
      });
      if (error) throw new Error(error.message || 'sin respuesta');
      if (!data?.ok) throw new Error(data?.error || 'No se pudo guardar');
      setSaveState('saved');
      setAppSecret('');
      await refreshSettings?.();
      setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } catch (e) {
      setSaveState('error');
      setMsg({ ok: false, text: userMessageFor(e) });
    }
  }, [appId, appSecret, appConfigured, refreshSettings]);

  const connect = useCallback(async () => {
    if (state === 'connecting') return;
    setState('connecting');
    setMsg(null);
    try {
      const returnTo = `${window.location.origin}${window.location.pathname}#/integraciones`;
      const { data, error } = await supabase.functions.invoke('meta-social', {
        body: { authorize: { returnTo } },
      });
      if (error) throw new Error(error.message || 'sin respuesta');
      if (!data?.ok || !data?.url) throw new Error(data?.error || 'No se pudo iniciar la conexión');
      // Full-page redirect to Meta's consent dialog (the OAuth flow).
      window.location.assign(data.url);
    } catch (e) {
      setState('idle');
      setMsg({ ok: false, text: userMessageFor(e) });
    }
  }, [state]);

  const copyRedirect = useCallback(() => {
    navigator.clipboard?.writeText(REDIRECT_URI).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, []);

  if (!isAdmin) return null;

  return (
    <SettingsSection title="Instagram">
      <div className="space-y-4">
        <p className="text-xs text-ink-600 leading-relaxed">
          Conecta tu cuenta de Instagram <strong>profesional</strong> (Empresa o Creador) directamente
          —sin página de Facebook— para publicar, ver estadísticas y moderar comentarios desde Marketing
          e Instagram Studio. Necesitas una app de Meta con <strong>“Instagram API setup with Instagram
          login”</strong>; pega su App ID y App Secret aquí.
        </p>

        {connected && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            <Instagram size={15} />
            <span>Conectado{igUsername ? ` como @${igUsername}` : ''}.</span>
          </div>
        )}

        {/* App credentials */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="ig-app-id">App ID</label>
            <CredentialInput
              id="ig-app-id" name="ig-app-id" className="input mt-1"
              placeholder="p. ej. 1234567890123456"
              value={appId} onChange={(e) => setAppId(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="ig-app-secret">App Secret</label>
            <CredentialInput
              secret id="ig-app-secret" name="ig-app-secret" className="input mt-1"
              placeholder={appConfigured ? '•••••• (guardado — deja vacío para conservarlo)' : 'App Secret de Instagram'}
              value={appSecret} onChange={(e) => setAppSecret(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-ghost min-h-[44px]" onClick={saveApp} disabled={saveState === 'saving'}>
            {saveState === 'saving' ? <RefreshCw size={14} className="animate-spin" /> : saveState === 'saved' ? <Check size={14} /> : null}
            {saveState === 'saved' ? 'Guardado' : 'Guardar credenciales'}
          </button>
          <button type="button" className="btn-brand min-h-[44px]" onClick={connect} disabled={state === 'connecting' || !appConfigured}>
            {state === 'connecting' ? <RefreshCw size={14} className="animate-spin" /> : <Instagram size={14} />}
            {connected ? 'Reconectar Instagram' : 'Conectar Instagram'}
          </button>
        </div>

        {/* Redirect URI to register in Meta */}
        <div className="rounded-lg border border-ink-100 bg-ink-50/40 p-3">
          <div className="text-[11px] uppercase tracking-wider text-ink-400 mb-1">URI de redirección OAuth</div>
          <p className="text-xs text-ink-500 mb-2">
            Agrega esta URL exacta en tu app de Meta → Instagram → <em>Business login settings</em> →
            <em> OAuth redirect URIs</em> antes de conectar.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-surface border border-ink-100 px-2 py-1.5 text-xs text-ink-700">{REDIRECT_URI}</code>
            <button type="button" className="btn-ghost shrink-0 min-h-[44px]" onClick={copyRedirect} title="Copiar">
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
          <a
            href="https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login"
            target="_blank" rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-xs text-brand-700 hover:underline"
          >
            <ExternalLink size={12} /> Guía de Instagram API con Instagram Login
          </a>
        </div>

        {msg && <div className={`text-sm ${msg.ok ? 'text-emerald-700' : 'text-red-600'}`}>{msg.text}</div>}
      </div>
    </SettingsSection>
  );
}
