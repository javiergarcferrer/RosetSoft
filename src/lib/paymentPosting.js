/**
 * post_payment RPC client — books a payment's asiento + lines + payments row in
 * ONE server-side transaction (numbers assigned there), or not at all. Mirrors
 * postSaleTx so a cobro/pago can never leave an orphan asiento with no payment
 * row (which would let the same bill be paid twice).
 */
import { supabase } from '../db/supabaseClient.js';
import { toRow } from '../db/rowMapping.js';

export async function postPaymentTx({ entry, lines, payment }) {
  const { error } = await supabase.rpc('post_payment', {
    p_entry: toRow(entry),
    p_lines: lines.map(toRow),
    p_payment: toRow(payment),
  });
  if (error) throw new Error(error.message || 'No se pudo registrar el pago.');
}
