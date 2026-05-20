import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { db, ensureDefaultProfile, getSettings, updateSettings, invalidate } from '../db/database.js';
import { supabase } from '../db/supabaseClient.js';
import { shouldPullDailyRate } from '../lib/exchangeRate.js';
import { useAuth } from './AuthContext.jsx';

const Ctx = createContext(null);

/**
 * App-level context. The team is still single-tenant (one shared 'team'
 * profile holds company-wide settings) but each signed-in user now has
 * a per-user profile row with role + commission. This context exposes:
 *
 *   profileId        — the shared 'team' id (kept stable; existing
 *                      `db.X.where('profileId').equals(profileId)` calls
 *                      across the app continue to work unchanged)
 *   profiles         — every profile row (team + each user); used by
 *                      the admin Users page
 *   currentProfile   — the *signed-in user's* profile row, with role,
 *                      commission_pct, active. Pages gate features off
 *                      this (admin-only routes, etc.)
 *   settings         — the team settings row
 *
 * The shared 'team' row carries `admin_emails` (jsonb array of lowercase
 * email strings). On first sign-in, any user whose email matches that
 * list is auto-promoted to role='admin' + active=true. Everyone else
 * starts inactive and must be approved by an admin via the Users page.
 */
export function AppProvider({ children }) {
  const { user } = useAuth();
  const [profileId, setProfileId] = useState(null);
  const [settings, setSettings] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [currentProfile, setCurrentProfile] = useState(null);
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

  // Re-read the signed-in user's profile from the list. Called after
  // any write that could change the current user's role/active state
  // (e.g. an admin demoting themselves — defensive, the UI blocks it
  // but the contract is "any write triggers a refresh").
  const refreshCurrentProfile = useCallback(async () => {
    if (!user?.id) {
      setCurrentProfile(null);
      return null;
    }
    const p = await db.profiles.get(user.id);
    setCurrentProfile(p || null);
    return p || null;
  }, [user?.id]);

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

        // First app load of the day (Santo Domingo time) refreshes the
        // BPD exchange rate, so the figure everyone quotes on stays
        // current with no cron and no manual step. Whoever opens the app
        // first that day triggers it; the Edge Function persists the rate
        // and we re-read it once it lands. Fire-and-forget — it must
        // never block app readiness or fail the boot if the bank is down.
        if (shouldPullDailyRate(s)) {
          supabase.functions
            .invoke('bpd-rate')
            .then(async ({ error }) => {
              if (error || cancelled) return;
              const fresh = await getSettings(pid);
              if (!cancelled) setSettings(fresh);
            })
            .catch(() => {});
        }

        const list = await refreshProfiles();
        if (cancelled) return;

        // Load the current user's profile from what we just fetched
        // (no extra round-trip).
        const me = user?.id ? list.find((p) => p.id === user.id) : null;
        if (!cancelled) setCurrentProfile(me || null);

        setReady(true);
      } catch (e) {
        console.error('AppContext init failed:', e);
        setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [refreshProfiles, user?.id]);

  // Realtime: subscribe to public.profiles so changes made in another
  // session land here without a manual refresh. Admin A deleting user
  // B from one browser tab now removes the row from admin C's open
  // /admin/users page within ~1 s — previously C would see a ghost
  // until a hard reload. Migration 20260518160000 adds the profiles
  // table to the supabase_realtime publication; without that, the
  // channel here subscribes successfully but never receives events.
  //
  // The handler re-runs every refresh path: profiles list, current
  // user's row, AND the global `invalidate()` bus that backs
  // useLiveQuery — so any page rendering profile-derived data
  // refetches together. We don't try to debounce or deduplicate
  // against local writes; a second refetch after a local mutation is
  // cheap and keeps the state machine simple.
  useEffect(() => {
    if (!user?.id) return undefined;
    const channel = supabase
      .channel('rt:public:profiles')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'profiles' },
        async () => {
          await refreshProfiles();
          await refreshCurrentProfile();
          invalidate();
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user?.id, refreshProfiles, refreshCurrentProfile]);

  // Realtime: the team settings row (exchange rate, company info) is
  // shared and changes from other sessions — the daily rate pull, the
  // "Actualizar ahora" button, or another admin editing settings. Without
  // a live channel an open session kept a stale cached rate until reload,
  // so a freshly pulled rate never reached quote panes already on screen.
  // Migration 20260520140000 adds settings to the supabase_realtime
  // publication; we re-read on any change so the rate (and everything
  // settings-derived) updates everywhere at once — one source of truth.
  useEffect(() => {
    if (!user?.id) return undefined;
    const channel = supabase
      .channel('rt:public:settings')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'settings' },
        async () => {
          await refreshSettings();
          invalidate();
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user?.id, refreshSettings]);

  const saveSettings = useCallback(async (patch) => {
    await updateSettings(profileId, patch);
    await refreshSettings();
  }, [profileId, refreshSettings]);

  const value = {
    ready,
    profileId,
    profiles,
    settings,
    currentProfile,
    isAdmin: currentProfile?.role === 'admin',
    isAccounting: currentProfile?.role === 'accounting',
    isActive: !!currentProfile?.active,
    refreshProfiles,
    refreshSettings,
    refreshCurrentProfile,
    saveSettings,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}
