import { getAgent } from './agent'
import type { SyncEnvelope } from './sync'

/**
 * Sync transport (docs/sync-spec.md §4): the encrypted envelope stored as a
 * single record in the user's OWN atproto repo. The record is public (on the
 * firehose) but holds only ciphertext — that's the whole point, and it means we
 * don't need atproto's (immature) private storage.
 *
 * Phase 1 inlined the ciphertext (small: a few KB of judgments) and overwrote
 * blindly. Phase 2 (#83) adds `swapRecord` CAS: every write is conditioned on
 * the CID we last read, so two devices pushing near-simultaneously can't clobber
 * each other — a stale write fails with `InvalidSwap`, the caller re-pulls
 * (merging the other device's change) and retries. So `getSyncState` now also
 * returns the CID, and `putSyncState` takes the expected-CID to swap against.
 */
export const SYNC_COLLECTION = 'blue.mothtrap.sync.state'
const RKEY = 'self'

/** The stored envelope plus the record CID it was read at (for CAS). */
export interface RemoteState {
  env: SyncEnvelope
  cid: string
}

/**
 * Write (overwrite) the sync record for the current account, always CAS-
 * conditioned via atproto `swapRecord`:
 *   - a CID → the record must still be at that CID (normal update);
 *   - `null` → the record must NOT exist (first write / when no CID is known).
 * We never omit swapRecord — a blind overwrite is exactly the clobber CAS exists
 * to prevent. Asserting-absent when we don't hold a CID means a first write that
 * races another device (or a push before this session's first pull) fails the
 * swap and re-pulls to converge, instead of stomping a record it hasn't seen.
 * Returns the new record's CID so the caller can swap against it next time.
 */
export async function putSyncState(
  env: SyncEnvelope,
  account: string,
  swapCid: string | null,
): Promise<string> {
  const agent = getAgent()
  const res = await agent.com.atproto.repo.putRecord({
    repo: agent.assertDid,
    collection: SYNC_COLLECTION,
    rkey: RKEY,
    record: { $type: SYNC_COLLECTION, account, updatedAt: new Date().toISOString(), ...env },
    swapRecord: swapCid, // string = match; null = assert-absent (never omitted)
  })
  return res.data.cid
}

/** Read the sync record + its CID, or null if there isn't one yet. Real errors
 * rethrow. A record with no CID is refused rather than cast away: pushing with an
 * unknown CID would drop back to a blind overwrite, the very thing CAS prevents. */
export async function getSyncState(): Promise<RemoteState | null> {
  const agent = getAgent()
  try {
    const res = await agent.com.atproto.repo.getRecord({
      repo: agent.assertDid,
      collection: SYNC_COLLECTION,
      rkey: RKEY,
    })
    if (!res.data.cid) throw new Error('Sync record returned without a CID.')
    return { env: res.data.value as unknown as SyncEnvelope, cid: res.data.cid }
  } catch (e) {
    if (isNotFound(e)) return null
    throw e
  }
}

/** Delete the sync record (turning off sync, if the user asks to wipe remote). */
export async function deleteSyncState(): Promise<void> {
  const agent = getAgent()
  try {
    await agent.com.atproto.repo.deleteRecord({
      repo: agent.assertDid,
      collection: SYNC_COLLECTION,
      rkey: RKEY,
    })
  } catch (e) {
    if (!isNotFound(e)) throw e
  }
}

/** True ONLY for a genuinely-absent record. Keys off atproto's structured
 * `error: 'RecordNotFound'` (XRPCError), with the specific message as a narrow
 * fallback — NOT a broad `/not found/`, so a transient/proxy 404 rethrows and
 * surfaces instead of being masked as "no record" (which would let enable() mint
 * a fresh salt and clobber the real record, locking out other devices). */
function isNotFound(e: unknown): boolean {
  if (e && typeof e === 'object' && (e as { error?: string }).error === 'RecordNotFound') return true
  const m = e instanceof Error ? e.message : String(e)
  return /could not locate record/i.test(m)
}

/** True when a CAS write lost the race: the record moved off the CID we swapped
 * against (another device wrote first). atproto surfaces this as the structured
 * `InvalidSwap` error; the message is the narrow fallback. The caller's contract
 * on true is to re-pull (merging the winner's change) and retry — NOT to treat
 * it as a hard failure, or a concurrent edit would be dropped. */
export function isSwapConflict(e: unknown): boolean {
  if (e && typeof e === 'object' && (e as { error?: string }).error === 'InvalidSwap') return true
  // Fallback for when the structured error field is stripped (e.g. a proxy): the
  // PDS message for a lost putRecord swap is "Record was at a different CID".
  const m = e instanceof Error ? e.message : String(e)
  return /invalidswap|different cid/i.test(m)
}
