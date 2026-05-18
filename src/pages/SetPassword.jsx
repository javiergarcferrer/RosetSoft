import { useState } from 'react';
import { Lock, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useApp } from '../context/AppContext.jsx';
import { supabase } from '../db/supabaseClient.js';
import { db } from '../db/database.js';
import { userMessageFor } from '../lib/errorMessages.js';

/**
 * Mandatory password-setup screen for invitees on their first
 * sign-in. Rendered by App.jsx's Gate component when:
 *
 *   - There's an active Supabase session (user clicked the magic
 *     link in their invitation email and is now signed in via the
 *     recovery-grant Supabase issues for invites), AND
 *   - profile.passwordSetAt is null (the dealer's profile record
 *     hasn't been stamped with a real password yet)
 *
 * Without this gate the invitee lands in the app via the magic link,
 * has no password, and is locked out the moment their recovery
 * session expires or they sign out. The dealer's pointed reaction:
 * "you can't tell me I'm doing bullshit until we fix it" — yes,
 * fixing.
 *
 * What this screen does
 * ---------------------
 *
 *   1. Takes two password inputs (new + confirm) with the standard
 *      "at least 8 characters" hint.
 *
 *   2. Calls supabase.auth.updateUser({ password }) — that's the
 *      Supabase API for setting a password on the current session.
 *      Works for recovery / invite sessions, which is the whole
 *      point here.
 *
 *   3. Stamps profile.passwordSetAt = now via a normal
 *      db.profiles.update(). The Gate re-reads currentProfile and
 *      flips to rendering the app.
 *
 *   4. Refreshes the profile from AppContext so the change shows up
 *      without a hard reload.
 *
 * If anything fails the form re-renders with the message in an
 * inline alert; the user can retry without leaving the page.
 */
export default function SetPassword() {
  const { user, signOut } = useAuth();
  const { currentProfile, refreshCurrentProfile } = useApp();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (password !== confirm) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    setBusy(true);
    try {
      // 1. Supabase Auth: persist the password on the auth.users row.
      const { error: authErr } = await supabase.auth.updateUser({ password });
      if (authErr) throw authErr;

      // 2. Our app DB: stamp the moment so the Gate stops showing
      //    this screen on the next render.
      if (currentProfile?.id) {
        await db.profiles.update(currentProfile.id, {
          passwordSetAt: Date.now(),
        });
      }

      // 3. Pull the updated profile so AppContext drops the
      //    null-passwordSetAt and the Gate falls through to the app.
      await refreshCurrentProfile();
    } catch (err) {
      setError(userMessageFor(err) || 'No se pudo guardar la contraseña.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full flex items-center justify-center bg-ink-50">
      <div className="w-full max-w-sm bg-white border border-ink-100 rounded-lg shadow-sm p-8">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-emerald-50 text-emerald-700 mb-3">
            <CheckCircle2 size={22} />
          </div>
          <div className="text-xs uppercase tracking-widest text-ink-500">Roset Soft</div>
          <h1 className="text-xl font-semibold mt-1">Crea tu contraseña</h1>
          <p className="text-xs text-ink-500 mt-2">
            Bienvenido{currentProfile?.name ? `, ${currentProfile.name.split(' ')[0]}` : ''}.
            Para terminar de configurar tu cuenta elige una contraseña.
            Después podrás iniciar sesión con tu correo y esta contraseña.
          </p>
          {user?.email && (
            <p className="text-[11px] text-ink-400 mt-2">
              Vinculada a <b className="text-ink-700">{user.email}</b>
            </p>
          )}
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <div className="label">Nueva contraseña</div>
            <div className="relative">
              <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input pl-9"
                placeholder="Al menos 8 caracteres"
                autoComplete="new-password"
                enterKeyHint="next"
                autoFocus
              />
            </div>
          </div>
          <div>
            <div className="label">Confirmar contraseña</div>
            <div className="relative">
              <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
              <input
                type="password"
                required
                minLength={8}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="input pl-9"
                placeholder="Repítela"
                autoComplete="new-password"
                enterKeyHint="go"
              />
            </div>
          </div>

          {error && (
            <div role="alert" className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button type="submit" disabled={busy} className="btn-primary w-full justify-center disabled:opacity-60 disabled:cursor-wait">
            {busy
              ? <><Loader2 size={14} className="animate-spin" /> Guardando…</>
              : 'Guardar contraseña y entrar'}
          </button>
        </form>

        <div className="text-center text-[11px] text-ink-400 mt-5">
          <button
            type="button"
            onClick={signOut}
            className="underline hover:text-ink-700"
          >
            ¿No eres tú? Cerrar sesión
          </button>
        </div>
      </div>
    </div>
  );
}
