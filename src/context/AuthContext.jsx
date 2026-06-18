import { createContext, useContext, useEffect, useState } from 'react';
import { supabase, SUPABASE_URL } from '../db/supabaseClient.js';
import { userMessageFor } from '../lib/errorMessages.js';

const Ctx = createContext(null);

// The google-api login flow bounces back to the app with either a one-time
// magic-link token (?gl_login=…) to trade for a session, or an error
// (?gl_error=…). The param may ride the query string OR the hash query
// (depending on the redirect target), so look in both.
function readGoogleLoginParams() {
  if (typeof window === 'undefined') return {};
  const out = {};
  const grab = (qs) => {
    const p = new URLSearchParams(qs);
    if (p.get('gl_login')) out.token = p.get('gl_login');
    if (p.get('gl_error')) out.error = p.get('gl_error');
  };
  grab(window.location.search);
  const hash = window.location.hash || '';
  const qi = hash.indexOf('?');
  if (qi >= 0) grab(hash.slice(qi + 1));
  return out;
}
function cleanGoogleLoginUrl() {
  if (typeof window === 'undefined') return;
  const base = window.location.href.split('#')[0].split('?')[0];
  window.history.replaceState(null, '', `${base}#/`);
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  const initialGoogle = readGoogleLoginParams();
  const [googleLoginError, setGoogleLoginError] = useState(
    !initialGoogle.token && initialGoogle.error ? initialGoogle.error : null,
  );

  useEffect(() => {
    let active = true;
    // Stale-token escape hatch. On a normal cold boot, supabase.getSession()
    // returns near-instantly out of localStorage; if it hasn't returned in
    // ~12 s the stored token is probably from a different Supabase project
    // and the SDK is stuck on a request that never resolves. We drop the
    // tokens and proceed so the user lands on /login instead of staring at
    // a spinner.
    //
    // BUT — when supabase is mid-way through processing an auth callback
    // (invite / magic-link / recovery), init makes a network call to
    // validate the token. On a cold deploy or slow connection that can take
    // several seconds. If we'd hit the timeout we'd silently drop a
    // session that's about to land — exactly the symptom that broke the
    // invite flow for Teresa. So when we detect callback parameters in
    // the URL we extend the budget and skip the localStorage wipe.
    const google = readGoogleLoginParams();
    const inAuthCallback = typeof window !== 'undefined' &&
      (window.location.hash.includes('access_token=') ||
       window.location.hash.includes('error=') ||
       window.location.search.includes('code=') ||
       !!google.token);
    const fallbackMs = inAuthCallback ? 20000 : 3000;
    const fallback = setTimeout(() => {
      if (!active) return;
      if (!inAuthCallback) {
        try { localStorage && Object.keys(localStorage)
          .filter((k) => k.startsWith('sb-'))
          .forEach((k) => localStorage.removeItem(k)); } catch {}
      }
      setSession(null);
      setReady(true);
    }, fallbackMs);
    (async () => {
      try {
        // "Sign in with Google" came back with a one-time token → trade it for
        // a real session. onAuthStateChange below then sets the session.
        if (google.token) {
          const { error } = await supabase.auth.verifyOtp({ token_hash: google.token, type: 'magiclink' });
          if (!active) return;
          if (error) {
            console.warn('[auth] google verifyOtp error', error);
            setGoogleLoginError(userMessageFor(error));
          }
          cleanGoogleLoginUrl();
          clearTimeout(fallback);
          // Reflect whatever session verifyOtp established (if any).
          const { data } = await supabase.auth.getSession();
          if (!active) return;
          setSession(data.session || null);
          setReady(true);
          return;
        }
        const { data, error } = await supabase.auth.getSession();
        if (!active) return;
        clearTimeout(fallback);
        if (error) console.warn('[auth] getSession error', error);
        setSession(data.session || null);
        setReady(true);
      } catch (err) {
        if (!active) return;
        clearTimeout(fallback);
        console.warn('[auth] getSession threw', err);
        setSession(null);
        setReady(true);
      }
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s || null);
    });
    return () => {
      active = false;
      clearTimeout(fallback);
      sub?.subscription?.unsubscribe();
    };
  }, []);

  // If the login flow returned only an error (no token), strip it from the URL
  // once so a refresh doesn't re-show it.
  useEffect(() => {
    const g = readGoogleLoginParams();
    if (!g.token && g.error) cleanGoogleLoginUrl();
  }, []);

  async function signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }

  /** Kick off "Sign in with Google" — full-page redirect to the consent flow. */
  function signInWithGoogle() {
    setGoogleLoginError(null);
    const returnTo = `${window.location.origin}${window.location.pathname}`;
    const url = `${SUPABASE_URL}/functions/v1/google-api?login=start&returnTo=${encodeURIComponent(returnTo)}`;
    window.location.assign(url);
  }

  async function signUp(email, password) {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
    return data;
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  /**
   * Nuclear escape hatch when boot is stuck. Clears every sb-* localStorage
   * key (auth tokens) and hard-reloads. Used by the Loading screen when the
   * 3s session-fetch timeout has fired and the user is still staring at a
   * spinner — typically because the stored token is from a different Supabase
   * project (we switched env vars) and getSession is sitting on a network
   * request that never completes.
   */
  function forceReset() {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('sb-'))
        .forEach((k) => localStorage.removeItem(k));
    } catch {}
    window.location.reload();
  }

  const value = {
    ready,
    session,
    user: session?.user || null,
    signIn,
    signUp,
    signInWithGoogle,
    googleLoginError,
    clearGoogleLoginError: () => setGoogleLoginError(null),
    signOut,
    forceReset,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
