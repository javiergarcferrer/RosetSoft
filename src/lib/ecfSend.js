/**
 * ecf-send Edge Function client — the ONE place that knows the invoke bodies
 * for DGII e-CF operations (sign+transmit, async status check), so pages never
 * hand-roll `supabase.functions.invoke` for it. Sibling of ecfSequence/ecfCert
 * in the lib effects tier; throws a user-displayable Error on failure.
 */
import { supabase } from '../db/supabaseClient.js';

/** Sign + transmit one e-CF. Resolves to { trackId, securityCode, fechaFirma, status }. */
export async function sendEcf({ payload, eNcf, profileId }) {
  const { data, error } = await supabase.functions.invoke('ecf-send', {
    body: { payload, eNcf, profileId },
  });
  if (error || !data?.ok) {
    throw new Error(data?.error || error?.message || 'Error transmitiendo el e-CF.');
  }
  return data;
}

/** Ask the DGII what became of a transmitted e-CF. Resolves to { estado }. */
export async function checkEcfStatus({ trackId, profileId }) {
  const { data, error } = await supabase.functions.invoke('ecf-send', {
    body: { op: 'status', trackId, profileId },
  });
  if (error || !data?.ok) {
    throw new Error(data?.error || error?.message || 'Error consultando el estado.');
  }
  return data;
}

/**
 * Sign + transmit a commercial approval/rejection (ACECF) for an e-CF we
 * received. `payload` is the `buildCommercialApproval` result; `eNcf` is the
 * approved document's e-NCF. Resolves to { estado }.
 */
export async function sendCommercialApproval({ payload, eNcf, profileId }) {
  const { data, error } = await supabase.functions.invoke('ecf-send', {
    body: { op: 'approve', payload, eNcf, profileId },
  });
  if (error || !data?.ok) {
    throw new Error(data?.error || error?.message || 'Error transmitiendo la aprobación comercial.');
  }
  return data;
}
