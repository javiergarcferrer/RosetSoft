import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { db, ensureDefaultProfile, getSettings, updateSettings } from '../db/database.js';
import { fetchMarketRate, effectiveDopRate } from '../lib/exchangeRate.js';

const Ctx = createContext(null);

/**
 * Single-tenant team context: `profileId` is always the shared 'team' profile.
 * `profiles` lists team members (rows in the profiles table) for display.
 */
export function AppProvider({ children }) {
  const [profileId, setProfileId] = useState(null);
  const [settings, setSettings] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [ready, setReady] = useState(false);

  const refreshProfiles = useCallback(async () => {
    const list = await db.profiles.toArray();
    setProfiles(list);
    return list;
  }, []);

  const refreshSettings = useCallback(async (pid) => {
    const target = pid || profileId;
    if (!target) return null;
    const s = await getSettings(target);
    setSettings(s);
    return s;
  }, [profileId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pid = await ensureDefaultProfile();
        if (cancelled) return;
        setProfileId(pid);
        const s = await getSettings(pid);
        if (cancelled) return;
        setSettings(s);
        await refreshProfiles();
        setReady(true);

        // Auto-refresh market rate once a day in the background.
        const lastFetch = s?.market?.fetchedAt || 0;
        const oneDay = 24 * 60 * 60 * 1000;
        if (!lastFetch || Date.now() - lastFetch > oneDay) {
          const result = await fetchMarketRate();
          if (result && !cancelled) {
            const merged = { ...s, market: { ...result, fetchedAt: Date.now() } };
            merged.currencyRates = { ...(s?.currencyRates || {}), USD: 1, DOP: effectiveDopRate(merged) };
            await updateSettings(pid, merged);
            setSettings(merged);
          }
        }
      } catch (e) {
        console.error('AppContext init failed:', e);
        setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [refreshProfiles]);

  const saveSettings = useCallback(async (patch) => {
    await updateSettings(profileId, patch);
    await refreshSettings();
  }, [profileId, refreshSettings]);

  const value = {
    ready,
    profileId,
    profiles,
    settings,
    refreshProfiles,
    refreshSettings,
    saveSettings,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}
