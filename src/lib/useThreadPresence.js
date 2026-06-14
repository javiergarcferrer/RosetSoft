import { useEffect, useState } from 'react';
import { supabase } from '../db/supabaseClient.js';

/**
 * Collision detection for the WhatsApp inbox — reports which OTHER team members
 * are viewing the same thread right now, so two agents don't reply at once.
 *
 * Best-effort over Supabase Realtime presence: each viewer joins a per-thread
 * channel keyed on their profile id and tracks their name; the hook returns the
 * names of everyone present EXCEPT the caller. If Realtime is unavailable it
 * simply reports nobody — it never throws into the UI. Pass `key = null` to
 * disable (e.g. the embedded quote-pane chat, where presence is meaningless).
 */
export function useThreadPresence(key, me) {
  const [others, setOthers] = useState([]);
  const meId = me?.id || null;
  const meName = me?.name || null;
  useEffect(() => {
    if (!key || !meId) { setOthers([]); return undefined; }
    let channel;
    try {
      channel = supabase.channel(`wa-thread-${key}`, { config: { presence: { key: meId } } });
      const sync = () => {
        const state = channel.presenceState();
        const names = [];
        for (const [id, metas] of Object.entries(state)) {
          if (id === meId) continue;
          const meta = Array.isArray(metas) ? metas[0] : null;
          names.push(meta?.name || 'Otro agente');
        }
        setOthers(names);
      };
      channel
        .on('presence', { event: 'sync' }, sync)
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') channel.track({ name: meName, at: Date.now() });
        });
    } catch {
      setOthers([]);
    }
    return () => {
      try { channel?.untrack(); supabase.removeChannel(channel); } catch { /* noop */ }
      setOthers([]);
    };
  }, [key, meId, meName]);
  return others;
}
