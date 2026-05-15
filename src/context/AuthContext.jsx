import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../db/supabaseClient.js';

const Ctx = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    // Hard timeout: if getSession hasn't returned in 3s the stored token is
    // probably stale from a different Supabase project. Drop it and proceed
    // — the user will land on /login and can re-auth against the current
    // project instead of staring at a loading spinner forever.
    const fallback = setTimeout(() => {
      if (!active) return;
      try { localStorage && Object.keys(localStorage)
        .filter((k) => k.startsWith('sb-'))
        .forEach((k) => localStorage.removeItem(k)); } catch {}
      setSession(null);
      setReady(true);
    }, 3000);
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!active) return;
        clearTimeout(fallback);
        setSession(data.session || null);
        setReady(true);
      } catch {
        if (!active) return;
        clearTimeout(fallback);
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

  const value = {
    ready,
    session,
    user: session?.user || null,
    signIn,
    signUp,
    signOut,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
