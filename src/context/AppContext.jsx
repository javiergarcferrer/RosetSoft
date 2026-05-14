import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { db, ensureDefaultProfile, getSettings, updateSettings } from '../db/database.js';
import { fetchMarketRate, effectiveDopRate } from '../lib/exchangeRate.js';

const Ctx = createContext(null);

export function AppProvider({ children }) {
  const [profileId, setProfileId] = useState(null);
  const [settings, setSettings] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [ready, setReady] = useState(false);

  const refreshProfiles = useCallback(async () => {
    const list = await db.profiles.orderBy('createdAt').toArray();
    setProfiles(list);
    return list;
  }, []);

  const refreshSettings = useCallback(async (pid = profileId) => {
    if (!pid) return null;
    const s = await getSettings(pid);
    setSettings(s);
    return s;
  }, [profileId]);

  useEffect(() => {
    (async () => {
      const pid = await ensureDefaultProfile();
      const stored = localStorage.getItem('rs.activeProfile');
      const list = await refreshProfiles();
      const active = stored && list.some((p) => p.id === stored) ? stored : pid;
      setProfileId(active);
      const s = await getSettings(active);
      setSettings(s);
      setReady(true);

      // Auto-refresh market rate once a day in the background
      const lastFetch = s?.market?.fetchedAt || 0;
      const oneDay = 24 * 60 * 60 * 1000;
      if (!lastFetch || Date.now() - lastFetch > oneDay) {
        const result = await fetchMarketRate();
        if (result) {
          const merged = { ...s, market: { ...result, fetchedAt: Date.now() } };
          // Keep currencyRates.DOP in sync with effective rate
          merged.currencyRates = { ...(s?.currencyRates || {}), USD: 1, DOP: effectiveDopRate(merged) };
          await updateSettings(active, merged);
          setSettings(merged);
        }
      }
    })();
  }, [refreshProfiles]);

  const switchProfile = useCallback(async (pid) => {
    setProfileId(pid);
    localStorage.setItem('rs.activeProfile', pid);
    const s = await getSettings(pid);
    setSettings(s);
  }, []);

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
    switchProfile,
    saveSettings,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}
