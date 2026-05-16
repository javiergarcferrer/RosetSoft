import { useState } from 'react';
import { Mail, Lock, LogIn, UserPlus, AlertCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { userMessageFor } from '../lib/errorMessages.js';

export default function Login() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState('signin'); // signin | signup
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === 'signin') {
        await signIn(email.trim(), password);
      } else {
        const r = await signUp(email.trim(), password);
        if (!r.session) {
          setInfo('Cuenta creada. Revisa tu correo para confirmar y vuelve a iniciar sesión.');
          setMode('signin');
        }
      }
    } catch (err) {
      setError(userMessageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full flex items-center justify-center bg-ink-50">
      <div className="w-full max-w-sm bg-white border border-ink-100 rounded-lg shadow-sm p-8">
        <div className="text-center mb-6">
          <div className="text-xs uppercase tracking-widest text-ink-500">Roset Soft</div>
          <h1 className="text-xl font-semibold mt-1">{mode === 'signin' ? 'Iniciar sesión' : 'Crear cuenta'}</h1>
          <p className="text-xs text-ink-500 mt-1">
            {mode === 'signin'
              ? 'Inicia sesión con el correo y contraseña de tu equipo.'
              : 'Crea una cuenta nueva para tu equipo.'}
          </p>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <div className="label">Correo</div>
            <div className="relative">
              <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input pl-9"
                placeholder="tu@correo.com"
                autoComplete="email"
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
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              />
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          {info && (
            <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">
              {info}
            </div>
          )}

          <button type="submit" disabled={busy} className="btn-primary w-full justify-center">
            {busy ? '…' : mode === 'signin' ? <><LogIn size={14} /> Entrar</> : <><UserPlus size={14} /> Crear cuenta</>}
          </button>
        </form>

        <div className="text-center text-xs text-ink-500 mt-5">
          {mode === 'signin' ? (
            <>¿Aún no tienes cuenta? <button type="button" onClick={() => { setMode('signup'); setError(null); setInfo(null); }} className="text-brand-600 hover:underline">Créala</button></>
          ) : (
            <>¿Ya tienes cuenta? <button type="button" onClick={() => { setMode('signin'); setError(null); setInfo(null); }} className="text-brand-600 hover:underline">Inicia sesión</button></>
          )}
        </div>
      </div>
    </div>
  );
}
