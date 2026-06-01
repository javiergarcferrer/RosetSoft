// Assign the next e-NCF from an authorized sequence (db-aware; the pure rules
// live in lib/accounting/ecf). Bumps next_seq BEFORE returning so a failed
// downstream insert leaves a GAP, never a reuse — duplicate e-NCF is a fiscal
// problem, a gap is fine.
import { db } from '../db/database.js';
import { formatENcf, pickSequence, sequenceState } from './accounting/ecf.js';

/**
 * @returns {Promise<{ eNcf, ecfType, expiresAt, sequenceId } | null>} null when
 *   no usable sequence exists for the type (caller falls back to a manual NCF).
 */
export async function assignNextENcf(profileId, ecfType) {
  const all = await db.ecfSequences.where('profileId').equals(profileId || 'team').toArray();
  const seq = pickSequence(all, ecfType);
  if (!seq || !sequenceState(seq).nextENcf) return null;
  const eNcf = formatENcf(seq.ecfType, seq.nextSeq);
  await db.ecfSequences.update(seq.id, { nextSeq: Number(seq.nextSeq) + 1 });
  return { eNcf, ecfType: seq.ecfType, expiresAt: seq.expiresAt || null, sequenceId: seq.id };
}
