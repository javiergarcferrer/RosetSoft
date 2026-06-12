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
