import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../db/supabaseClient.js';

const Ctx = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);

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
    const inAuthCallback = typeof window !== 'undefined' &&
      (window.location.hash.includes('access_token=') ||
       window.location.hash.includes('error=') ||
       window.location.search.includes('code='));
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

  async function signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
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
