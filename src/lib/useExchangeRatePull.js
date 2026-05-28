import { useState, useCallback } from 'react';
import { supabase } from '../db/supabaseClient.js';
import { useApp } from '../context/AppContext.jsx';

/**
 * On-demand pull of Banco Popular's published USD→DOP rate. Invokes the
 * `bpd-rate` Edge Function (which persists settings.exchange_rate itself,
 * server-side, so the OAuth secret never reaches the browser) and then
 * re-reads team settings so the new figure shows immediately across every
 * surface — without waiting for the daily auto-pull or the realtime echo.
 *
 * Shared by Settings' "Actualizar ahora" and the quote workspace's rate
 * refresh so the invoke + error-surfacing logic lives in one place.
 *
 * Returns { pull, pulling, error }. `pull()` resolves to true on success
 * and false on failure (the message is also exposed via `error`).
 */
export function useExchangeRatePull() {
  const { refreshSettings } = useApp();
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState(null);

  const pull = useCallback(async () => {
    setPulling(true);
    setError(null);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('bpd-rate');
      if (invokeError) {
        let msg = invokeError.message || 'No se pudo obtener la tasa';
        try {
          // The function returns { error, status, detail } on upstream
          // failures (e.g. the bank's 401 on the OAuth token call). Surface
          // the status + detail so the cause is visible, not buried.
          const body = await invokeError.context?.json?.();
          if (body?.error) {
            msg = body.error;
            if (body.status) msg += ` (HTTP ${body.status})`;
            if (body.detail) msg += ` — ${String(body.detail).slice(0, 200)}`;
          }
        } catch { /* body already consumed / not JSON */ }
        throw new Error(msg);
      }
      if (!data?.usd || (!data.usd.compra && !data.usd.venta)) {
        throw new Error(data?.error || 'El banco no devolvió una tasa de USD.');
      }
      await refreshSettings();
      return true;
    } catch (e) {
      setError(e?.message || 'No se pudo obtener la tasa.');
      return false;
    } finally {
      setPulling(false);
    }
  }, [refreshSettings]);

  return { pull, pulling, error };
}
