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

/**
 * Sign one e-CF WITHOUT transmitting — local signature only, so it works before
 * the DGII connection is live. Resolves to { signedXml, securityCode, fechaFirma };
 * the security code + fecha de firma are what put the timbre (QR) on the printed
 * factura, and the signed XML is the set-de-pruebas deliverable.
 */
export async function signEcf({ payload, eNcf, profileId }) {
  const { data, error } = await supabase.functions.invoke('ecf-send', {
    body: { op: 'sign', payload, eNcf, profileId },
  });
  if (error || !data?.ok) {
    throw new Error(data?.error || error?.message || 'Error firmando el e-CF.');
  }
  return data;
}

/**
 * Sign an ARBITRARY XML — the DGII postulación form — with the team's stored
 * certificate, so the dealer signs it in-app instead of DGII's Windows-only
 * "App de Firma Digital". Resolves to the signed XML string (upload it back to
 * the OFV). The certificate must be the registered representante legal's.
 */
export async function signPostulacionXml({ xml, profileId }) {
  const { data, error } = await supabase.functions.invoke('ecf-send', {
    body: { op: 'sign-xml', xml, profileId },
  });
  if (error || !data?.ok) {
    throw new Error(data?.error || error?.message || 'Error firmando el archivo de postulación.');
  }
  return data.signedXml;
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
