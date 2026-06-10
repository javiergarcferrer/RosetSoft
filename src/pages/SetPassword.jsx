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
    <div className="relative h-full flex items-center justify-center bg-app-wash overflow-hidden">
      {/* Subtle terracotta bloom behind the card */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 w-[min(520px,100vw)] h-[min(520px,100vw)] rounded-full opacity-[0.15]"
        style={{ background: 'radial-gradient(circle, #c76b29 0%, transparent 70%)', filter: 'blur(60px)' }}
      />
      <div className="card-auth relative z-10">
        <div className="text-center mb-8">
          {/* Welcome icon — stacked: wordmark icon + success mark */}
          <div className="relative inline-flex items-center justify-center mb-4">
            <div className="inline-flex items-center justify-center w-11 h-11 rounded-2xl bg-brand-grad shadow-soft">
              <span className="font-wordmark text-white text-lg leading-none select-none">R</span>
            </div>
            <div className="absolute -bottom-1 -right-1 flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500 shadow-xs ring-2 ring-white">
              <CheckCircle2 size={11} className="text-white" aria-hidden />
            </div>
          </div>
          <div className="font-wordmark text-2xl tracking-wide text-ink-900 mb-1.5">Roset Soft</div>
          <h1 className="text-sm font-semibold text-ink-700">Crea tu contraseña</h1>
          <p className="text-xs text-ink-400 mt-2 leading-relaxed max-w-[260px] mx-auto">
            Bienvenido{currentProfile?.name ? `, ${currentProfile.name.split(' ')[0]}` : ''}.
            Elige una contraseña para terminar de configurar tu cuenta.
          </p>
          {user?.email && (
            <p className="text-[11px] text-ink-400 mt-2">
              Vinculada a <b className="text-ink-600 font-medium">{user.email}</b>
            </p>
          )}
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label" htmlFor="sp-password">Nueva contraseña</label>
            <div className="relative mt-1.5">
              <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" aria-hidden />
              <input
                id="sp-password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input pl-9 transition-shadow focus:shadow-focus"
                placeholder="Al menos 8 caracteres"
                autoComplete="new-password"
                enterKeyHint="next"
                autoFocus
              />
            </div>
          </div>
          <div>
            <label className="label" htmlFor="sp-confirm">Confirmar contraseña</label>
            <div className="relative mt-1.5">
              <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" aria-hidden />
              <input
                id="sp-confirm"
                type="password"
                required
                minLength={8}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="input pl-9 transition-shadow focus:shadow-focus"
                placeholder="Repítela"
                autoComplete="new-password"
                enterKeyHint="go"
              />
            </div>
          </div>

          {error && (
            <div role="alert" className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5" aria-hidden />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="btn-brand w-full justify-center mt-1 active:scale-[0.98] transition-transform disabled:opacity-60 disabled:cursor-wait"
          >
            {busy
              ? <><Loader2 size={14} className="animate-spin" aria-hidden /> Guardando…</>
              : 'Guardar contraseña y entrar'}
          </button>
        </form>

        <div className="text-center text-[11px] text-ink-400 mt-7">
          <button
            type="button"
            onClick={signOut}
            className="underline underline-offset-2 hover:text-ink-600 transition-colors"
          >
            ¿No eres tú? Cerrar sesión
          </button>
        </div>
      </div>
    </div>
  );
}
