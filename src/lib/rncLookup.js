// RNC / cédula lookup against the DGII-mirror registry, via the `rnc-lookup`
// Edge Function (the upstream sends no CORS, so it can't be called from the
// browser directly). Used to auto-fill the fiscal name on suppliers/customers.
import { supabase } from '../db/supabaseClient.js';

/** Digits only — strips dashes/spaces from a typed RNC/cédula. */
export function cleanRnc(value) {
  return String(value || '').replace(/\D/g, '');
}

/** RNC = 9 digits (empresa), cédula = 11 digits (persona física). */
export function isValidRncOrCedula(value) {
  const d = cleanRnc(value);
  return d.length === 9 || d.length === 11;
}

/** Tax personhood implied by the id length. */
export function rncKind(value) {
  return cleanRnc(value).length === 11 ? 'fisica' : 'juridica';
}

/**
 * Resolve a taxpayer's fiscal name from their RNC/cédula. Returns the
 * normalized shape from the function: `{ found, rnc, kind, name, commercialName,
 * status, regime, activity, eInvoicer, message }`. Never throws on "not found"
 * (returns `{ found:false }`); throws only on a transport/invoke error.
 */
export async function lookupRnc(value) {
  const rnc = cleanRnc(value);
  if (!isValidRncOrCedula(rnc)) {
    return { found: false, rnc, message: 'RNC (9 dígitos) o cédula (11 dígitos) inválido.' };
  }
  const { data, error } = await supabase.functions.invoke('rnc-lookup', { body: { rnc } });
  if (error) throw new Error(error.message || 'No se pudo consultar el RNC.');
  return data || { found: false, rnc, message: 'Sin respuesta del registro.' };
}
