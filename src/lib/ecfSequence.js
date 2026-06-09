// Assign the next e-NCF from an authorized sequence. The pick + bump happens
// ATOMICALLY in the `assign_next_encf` RPC (pick the usable range, lock the
// row, increment next_seq) so two concurrent invoices can never be issued the
// same e-NCF. A failed downstream insert leaves a GAP, never a reuse —
// duplicate e-NCF is a fiscal problem, a gap is fine. The pure sequence rules
// (state, formatting) live in lib/accounting/ecf for the UI.
import { supabase } from '../db/supabaseClient.js';

/**
 * @returns {Promise<{ eNcf, ecfType, expiresAt, sequenceId } | null>} null when
 *   no usable sequence exists for the type (caller falls back to a manual NCF).
 */
export async function assignNextENcf(profileId, ecfType) {
  const { data, error } = await supabase.rpc('assign_next_encf', {
    p_profile_id: profileId || 'team',
    p_ecf_type: ecfType,
  });
  if (error) throw new Error(error.message || 'No se pudo asignar el e-NCF.');
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.e_ncf) return null;
  return {
    eNcf: row.e_ncf,
    ecfType,
    expiresAt: row.seq_expires_at ? new Date(row.seq_expires_at).getTime() : null,
    sequenceId: row.sequence_id,
  };
}
