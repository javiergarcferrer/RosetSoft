// ImageStudioCard — the OpenAI connection card for the image-generation pane
// (DALL·E 3 ads/artwork). The API key is saved through the dalle-image Edge
// Function's write-only `saveConfig` mode (never read back); only a "connected"
// timestamp surfaces here, mirrored into settings so the hub status reflects it.
import { useState } from 'react';
import { Check, Loader2, Lock, Sparkles } from 'lucide-react';
import { supabase } from '../../db/supabaseClient.js';
import { formatDateTime } from '../../lib/format.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import SettingsSection from './SettingsSection.jsx';
import CredentialInput from './CredentialInput.jsx';

export default function ImageStudioCard({ settings, saveSettings }) {
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState('idle'); // idle | saving | saved | error
  const [msg, setMsg] = useState('');
  // Credentials are LOCKED once a connection is saved: the input isn't rendered
  // at all (nothing for a password manager to autofill or overwrite) until the
  // dealer clicks "Editar credenciales". First-time setup shows the field.
  const [editing, setEditing] = useState(false);

  const connectedAt = settings?.openaiConnectedAt;
  const locked = !!connectedAt && !editing;

  async function save() {
    setStatus('saving');
    setMsg('');
    try {
      const { data, error } = await supabase.functions.invoke('dalle-image', {
        body: { mode: 'saveConfig', apiKey },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setApiKey('');
      setEditing(false); // re-lock the field
      // Mirror the connected-at into settings so the hub status pill + JARVIS
      // probe reflect it immediately.
      await saveSettings({ openaiConnectedAt: Date.now() });
      // Confirm the key actually reaches OpenAI before claiming success — a
      // rejected key is caught here, not later as a silent generation failure.
      const { data: test } = await supabase.functions.invoke('dalle-image', { body: { test: true } });
      if (test && test.configured !== false && test.ok === false) {
        setStatus('error');
        setMsg(test.error || 'Guardado, pero OpenAI rechazó la llave.');
      } else {
        setStatus('saved');
        setMsg('Llave guardada y verificada. ✓');
      }
      setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 4000);
    } catch (e) {
      setStatus('error');
      setMsg(userMessageFor(e));
    }
  }

  return (
    <SettingsSection title={<><Sparkles size={16} className="text-violet-600" aria-hidden /> OpenAI · Generación de imágenes</>}>
      <p className="text-xs text-ink-500 mb-4">
        Conecta tu llave de OpenAI para generar anuncios y artes con <strong>DALL·E 3</strong> desde el
        Studio. Obtén una llave en <strong>platform.openai.com → API keys</strong> (botón «Create new
        secret key»). Se guarda en modo solo-escritura: no se muestra ni se autocompleta nunca más.
      </p>

      {locked ? (
        <div className="rounded-lg border border-ink-100 bg-ink-50/60 px-4 py-3.5 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-ink-600 flex items-start gap-2 min-w-0">
            <Lock size={14} className="text-ink-400 shrink-0 mt-px" aria-hidden />
            <span>
              Llave guardada y <strong>bloqueada</strong>. No se muestra, no se autocompleta y no se
              puede modificar sin desbloquear.
            </span>
          </div>
          <button type="button" onClick={() => setEditing(true)} className="btn-ghost text-xs shrink-0">
            Editar credenciales
          </button>
        </div>
      ) : (
        <div>
          <label className="label" htmlFor="openai-api-key">Llave API de OpenAI</label>
          <CredentialInput secret id="openai-api-key" name="openai-api-key" value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={connectedAt ? '•••••••• (guardada)' : 'sk-…'} className="input mt-1" />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-3">
        {!locked && (
          <button type="button" onClick={save} disabled={status === 'saving' || !apiKey.trim()} className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
            {status === 'saving' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Guardar
          </button>
        )}
        {!locked && connectedAt ? (
          <button
            type="button"
            onClick={() => { setApiKey(''); setEditing(false); setMsg(''); setStatus('idle'); }}
            className="btn-ghost text-sm"
          >
            Cancelar
          </button>
        ) : null}
        {connectedAt ? <span className="text-[11px] text-ink-400 min-w-0 truncate">Conectado · {formatDateTime(connectedAt)}</span> : null}
      </div>
      {msg && <p className={`text-xs mt-2 ${status === 'error' ? 'text-rose-600' : 'text-ink-500'}`}>{msg}</p>}
    </SettingsSection>
  );
}
