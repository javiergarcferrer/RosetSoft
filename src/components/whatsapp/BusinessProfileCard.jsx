import { useEffect, useState } from 'react';
import { Check, Loader2, AlertTriangle, Store, RefreshCw } from 'lucide-react';
import { userMessageFor } from '../../lib/errorMessages.js';
import { getWaBusinessProfile, saveWaBusinessProfile } from '../../lib/whatsapp.js';
import SettingsSection from '../settings/SettingsSection.jsx';

// WhatsApp's "Business profile" verticals (the industry tag a client sees). The
// API accepts these UPPER_SNAKE codes; UNDEFINED is "sin categoría".
const VERTICALS = [
  ['UNDEFINED', 'Sin categoría'],
  ['RETAIL', 'Tienda / Retail'],
  ['APPAREL', 'Ropa y accesorios'],
  ['HOME_GOODS', 'Hogar y decoración'],
  ['PROF_SERVICES', 'Servicios profesionales'],
  ['OTHER', 'Otro'],
];

/**
 * The number's PUBLIC WhatsApp Business profile — what a client sees when they
 * open the chat: the avatar (read-only here; set in WhatsApp Manager), a short
 * "about" line, a longer description, the address, email, website and the
 * industry vertical. Fetched live from Meta on first open of the section (no
 * Graph round-trip for dealers who never expand it), edited inline, and saved
 * back through the write-only wa-send path. Spanish UI, settings-card styling.
 *
 * Standalone card — mount it under the WhatsApp connection card in Settings.
 * `connected` gates the fetch/edit (no profile exists before WhatsApp is wired).
 */
export default function BusinessProfileCard({ connected = true }) {
  const [fetched, setFetched] = useState(false); // first-open fetch guard
  const [loading, setLoading] = useState(false);
  const [photo, setPhoto] = useState('');        // read-only avatar url
  const [about, setAbout] = useState('');
  const [description, setDescription] = useState('');
  const [address, setAddress] = useState('');
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [vertical, setVertical] = useState('UNDEFINED');
  const [state, setState] = useState('idle');    // idle | saving | saved | error
  const [msg, setMsg] = useState('');
  const [loadError, setLoadError] = useState('');

  async function load() {
    setLoading(true);
    setLoadError('');
    try {
      const res = await getWaBusinessProfile();
      if (res?.ok && res.profile) {
        const p = res.profile;
        setPhoto(p.profile_picture_url || '');
        setAbout(p.about || '');
        setDescription(p.description || '');
        setAddress(p.address || '');
        setEmail(p.email || '');
        setWebsite((p.websites || [])[0] || '');
        setVertical((p.vertical || 'UNDEFINED').toUpperCase());
      } else if (res && !res.ok) {
        setLoadError(res.error || 'No se pudo cargar el perfil del negocio.');
      }
    } catch (e) {
      setLoadError(userMessageFor(e));
    } finally {
      setLoading(false);
    }
  }

  // Fetch once, the first time the <details> is opened.
  async function loadOnFirstOpen(e) {
    if (!e.currentTarget.open || fetched || !connected) return;
    setFetched(true);
    await load();
  }

  async function save() {
    if (state === 'saving') return;
    setState('saving');
    setMsg('');
    try {
      const res = await saveWaBusinessProfile({
        about, address, description, email,
        vertical,
        websites: website.trim() ? [website.trim()] : [],
      });
      if (res?.ok) {
        setState('saved');
        setTimeout(() => setState((s) => (s === 'saved' ? 'idle' : s)), 2500);
      } else {
        setState('error');
        setMsg(res?.error || 'No se pudo guardar el perfil.');
      }
    } catch (e) {
      setState('error');
      setMsg(userMessageFor(e));
    }
  }

  return (
    <SettingsSection title={<><Store size={16} className="text-emerald-600" aria-hidden /> Perfil del negocio (WhatsApp)</>}>
      <details className="group rounded-lg border border-ink-100 overflow-hidden" onToggle={loadOnFirstOpen}>
        <summary className="flex items-center justify-between cursor-pointer select-none px-4 py-3 min-h-11 text-sm font-medium text-ink-700 hover:bg-ink-50/60 transition-colors list-none">
          <span>Lo que ve el cliente al abrir el chat</span>
          <span className="text-[11px] font-normal text-ink-400">{connected ? 'Abrir para editar' : 'Conecta WhatsApp primero'}</span>
        </summary>
        <div className="px-4 pb-4 pt-3 border-t border-ink-100 bg-ink-50/40">
          {!connected ? (
            <p className="text-xs text-ink-500">
              Conecta tu app de WhatsApp Business (arriba) para ver y editar el perfil público del número.
            </p>
          ) : loading ? (
            <p className="text-xs text-ink-400 inline-flex items-center gap-1.5">
              <Loader2 size={13} className="animate-spin" /> Cargando perfil…
            </p>
          ) : (
            <>
              <div className="flex items-start gap-3 mb-3">
                {photo ? (
                  <img src={photo} alt="Foto del perfil de WhatsApp" className="h-14 w-14 rounded-full object-cover border border-ink-100 shrink-0" />
                ) : (
                  <span className="h-14 w-14 rounded-full bg-ink-100 flex items-center justify-center text-ink-400 shrink-0">
                    <Store size={20} />
                  </span>
                )}
                <p className="text-[11px] text-ink-500 leading-relaxed">
                  La <strong>foto de perfil</strong> se cambia en Meta → WhatsApp Manager (no es editable
                  desde aquí). Lo demás se edita y guarda abajo.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="sm:col-span-2">
                  <label className="label" htmlFor="wabp-about">Descripción corta (about)</label>
                  <input id="wabp-about" className="input mt-1" value={about} maxLength={139}
                    onChange={(e) => setAbout(e.target.value)} placeholder="p. ej. Mobiliario Ligne Roset en RD" />
                </div>
                <div className="sm:col-span-2">
                  <label className="label" htmlFor="wabp-description">Descripción</label>
                  <textarea id="wabp-description" className="input mt-1" rows={3} value={description} maxLength={512}
                    onChange={(e) => setDescription(e.target.value)} />
                </div>
                <div>
                  <label className="label" htmlFor="wabp-address">Dirección</label>
                  <input id="wabp-address" className="input mt-1" value={address} maxLength={256}
                    onChange={(e) => setAddress(e.target.value)} />
                </div>
                <div>
                  <label className="label" htmlFor="wabp-email">Correo</label>
                  <input id="wabp-email" className="input mt-1" type="email" value={email} maxLength={128}
                    onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div>
                  <label className="label" htmlFor="wabp-website">Sitio web</label>
                  <input id="wabp-website" className="input mt-1" type="url" value={website} maxLength={256}
                    onChange={(e) => setWebsite(e.target.value)} placeholder="https://…" />
                </div>
                <div>
                  <label className="label" htmlFor="wabp-vertical">Categoría del negocio</label>
                  <select id="wabp-vertical" className="input mt-1" value={vertical}
                    onChange={(e) => setVertical(e.target.value)}>
                    {VERTICALS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 mt-3">
                <button type="button" onClick={save} disabled={state === 'saving'}
                  className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
                  {state === 'saving' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Guardar perfil
                </button>
                <button type="button" onClick={load} title="Recargar perfil" aria-label="Recargar perfil"
                  className="btn-ghost text-xs shrink-0">
                  <RefreshCw size={12} />
                </button>
                {state === 'saved' && (
                  <span className="text-[11px] text-emerald-700 inline-flex items-center gap-0.5"><Check size={11} /> Guardado</span>
                )}
                {state === 'error' && (
                  <span className="text-[11px] text-rose-600 inline-flex items-center gap-1">
                    <AlertTriangle size={11} /> {msg || 'No se pudo guardar.'}
                  </span>
                )}
              </div>
              {loadError && (
                <p className="text-[11px] text-rose-600 mt-2 flex items-start gap-1.5">
                  <AlertTriangle size={12} className="mt-px shrink-0" /> <span className="min-w-0 break-words">{loadError}</span>
                </p>
              )}
              <p className="text-[11px] text-ink-500 mt-3">
                Este perfil aparece cuando el cliente abre el chat del negocio en WhatsApp.
              </p>
            </>
          )}
        </div>
      </details>
    </SettingsSection>
  );
}
