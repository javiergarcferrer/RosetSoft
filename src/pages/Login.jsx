import { useState } from 'react';
import { Mail, Lock, LogIn, AlertCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { userMessageFor } from '../lib/errorMessages.js';

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
export default function Login() {
  const { signIn } = useAuth();
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
    <div className="h-full flex items-center justify-center bg-ink-50">
      <div className="card-auth">
        <div className="text-center mb-6">
          <div className="eyebrow">Roset Soft</div>
          <h1 className="text-xl font-semibold mt-1">Iniciar sesión</h1>
          <p className="text-xs text-ink-500 mt-1">
            Inicia sesión con el correo y contraseña de tu equipo.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <div className="label">Correo</div>
            <div className="relative">
              <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
              <input
                type="email"
                inputMode="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input pl-9"
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
            <div className="label">Contraseña</div>
            <div className="relative">
              <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
              <input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input pl-9"
                placeholder="••••••••"
                autoComplete="current-password"
                enterKeyHint="go"
              />
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button type="submit" disabled={busy} className="btn-primary w-full justify-center">
            {busy ? '…' : <><LogIn size={14} /> Entrar</>}
          </button>
        </form>

        <p className="mt-5 text-center text-[11px] text-ink-500 max-w-xs mx-auto">
          ¿No tienes cuenta? El acceso es solo por invitación de tu administrador.
        </p>
      </div>
    </div>
  );
}
