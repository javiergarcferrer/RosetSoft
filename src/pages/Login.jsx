import { useState } from 'react';
import { Mail, Lock, LogIn, AlertCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { userMessageFor } from '../lib/errorMessages.js';

// Decorative terracotta bloom — absolutely positioned, pointer-events-none,
// so it sits behind the card and never captures clicks.
function BrandBloom() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 w-[min(520px,100vw)] h-[min(520px,100vw)] rounded-full opacity-[0.18]"
      style={{
        background: 'radial-gradient(circle, #c76b29 0%, transparent 70%)',
        filter: 'blur(60px)',
      }}
    />
  );
}

/**
 * Sign-in page. The app is invite-only: there is no signup form, no
 * "Registrarme" link, no path on this page that creates a new account.
 *
 * New employees join via /admin/users → "Invitar usuario", which sends
 * a Supabase invite email through the `invite-user` Edge Function. The
 * invitee clicks the link, sets a password, lands signed in. Random
 * visitors to /login see only "Iniciar sesión" with no door open to
 * sign-up — exactly the dealer's requirement: "no dejes que cualquiera
 * con el link pueda registrarse".
 *
 * Bootstrap-admin caveat: the very first admin can't be invited (no
 * other admin exists). Create that account once via the Supabase
 * Dashboard → Authentication → Users → Add user, with the email in
 * settings.admin_emails (seeded with javier@alcover.do). On first
 * sign-in here, ensureDefaultProfile() promotes them to admin
 * automatically. See supabase/functions/invite-user/README.md.
 */
// Google's multicolor "G" — Google brand guidelines require the official mark,
// not a recolored generic icon.
function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export default function Login() {
  const { signIn, signInWithGoogle, googleLoginError } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(userMessageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative h-full flex items-center justify-center bg-app-wash overflow-hidden">
      <BrandBloom />
      <div className="card-auth relative z-10">
        {/* Wordmark / brand header */}
        <div className="text-center mb-8">
          {/* Brand icon mark */}
          <div className="inline-flex items-center justify-center w-11 h-11 rounded-2xl bg-brand-grad shadow-soft mb-4">
            <span className="font-wordmark text-white text-lg leading-none select-none">R</span>
          </div>
          <div className="font-wordmark text-2xl tracking-wide text-ink-900 mb-1.5">ALCOVER</div>
          <h1 className="font-display text-sm font-semibold text-ink-700">Iniciar sesión</h1>
          <p className="text-xs text-ink-400 mt-1 leading-relaxed">
            Correo y contraseña de tu equipo.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label" htmlFor="login-email">Correo</label>
            <div className="relative mt-1.5">
              <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" aria-hidden />
              <input
                id="login-email"
                type="email"
                inputMode="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input pl-9 transition-shadow focus:shadow-focus"
                placeholder="tu@correo.com"
                autoComplete="email"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="next"
              />
            </div>
          </div>
          <div>
            <label className="label" htmlFor="login-password">Contraseña</label>
            <div className="relative mt-1.5">
              <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" aria-hidden />
              <input
                id="login-password"
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input pl-9 transition-shadow focus:shadow-focus"
                placeholder="••••••••"
                autoComplete="current-password"
                enterKeyHint="go"
              />
            </div>
          </div>

          {(error || googleLoginError) && (
            <div role="alert" className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5" aria-hidden />
              <span>{error || googleLoginError}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="btn-brand w-full justify-center mt-2 active:scale-[0.98] transition-transform disabled:opacity-60 disabled:cursor-wait"
          >
            {busy ? '…' : <><LogIn size={14} aria-hidden /> Entrar</>}
          </button>
        </form>

        {/* Divider */}
        <div className="flex items-center gap-3 my-5" aria-hidden>
          <div className="h-px flex-1 bg-ink-100" />
          <span className="text-[11px] uppercase tracking-wider text-ink-400">o</span>
          <div className="h-px flex-1 bg-ink-100" />
        </div>

        {/* Sign in with Google — for team members on the allowed domain. */}
        <button
          type="button"
          onClick={signInWithGoogle}
          className="w-full inline-flex items-center justify-center gap-2.5 rounded-xl border border-ink-200 bg-surface px-4 py-2.5 text-sm font-medium text-ink-700 shadow-soft hover:bg-ink-50 active:scale-[0.98] transition"
        >
          <GoogleMark />
          Continuar con Google
        </button>

        <p className="mt-7 text-center text-[11px] text-ink-400 max-w-xs mx-auto leading-relaxed">
          El acceso es solo por invitación de tu administrador.
        </p>
      </div>
    </div>
  );
}
