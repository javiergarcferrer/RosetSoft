/**
 * post_sale RPC client — books a sale's asiento + lines + posting in ONE
 * server-side transaction (numbers assigned there), or not at all. The lone
 * money-posting RPC, wrapped so no page calls `supabase.rpc` raw.
 */
import { supabase } from '../db/supabaseClient.js';
import { toRow } from '../db/rowMapping.js';

export async function postSaleTx({ entry, lines, posting }) {
  const { error } = await supabase.rpc('post_sale', {
    p_entry: toRow(entry),
    p_lines: lines.map(toRow),
    p_posting: toRow(posting),
  });
  if (error) throw new Error(error.message || 'No se pudo registrar la venta.');
}

/**
 * void_sale RPC client — anula a factura by posting its reversing asiento +
 * lines AND flagging the posting (voided_at) in ONE server transaction. Mirrors
 * postSaleTx so an anulación can never leave a reversal asiento without the
 * posting being marked (which a retry would then double-reverse). The RPC also
 * enforces the guards (already-voided, transmitted e-CF, nota de crédito,
 * cobros applied) authoritatively.
 */
export async function voidSaleTx({ postingId, reason, entry, lines }) {
  const { error } = await supabase.rpc('void_sale', {
    p_posting_id: postingId,
    p_reason: reason || '',
    p_entry: toRow(entry),
    p_lines: lines.map(toRow),
  });
  if (error) throw new Error(error.message || 'No se pudo anular la factura.');
}
