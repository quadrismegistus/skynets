import { del, get, set } from 'idb-keyval'
import { reactions } from './reactions.svelte'
import { read } from './read.svelte'
import { session } from './session.svelte'
import {
  casPush,
  decryptDoc,
  decryptWithKey,
  deriveSyncKey,
  encryptDoc,
  encryptWithKey,
  envelopeSalt,
  exportRawKey,
  importRawKey,
  ITER,
  randomSalt,
  type SyncDoc,
  type SyncEnvelope,
} from '../api/sync'
import { deleteSyncState, getSyncState, isSwapConflict, putSyncState } from '../api/syncpds'

/**
 * Cross-device sync (docs/sync-spec.md). The crypto + CRDT merges live in
 * ../api/sync (pure, tested); the atproto transport in ../api/syncpds. This
 * module glues them to the stores:
 *   Phase 0 — encrypted file export/import (buildDoc/applyDoc/export/import).
 *   Phase 1 — the encrypted doc in the user's PDS: pull-and-merge on login and a
 *             manual "Sync now" (pull-merge-push). The derived key is cached
 *             per-device (the local store already holds the plaintext, so this
 *             adds no exposure the server can see).
 *   Phase 2 (#83) — the bidirectional AUTO loop: a debounced push whenever the
 *             stores change, a periodic + foreground pull, and `swapRecord` CAS
 *             so two devices pushing at once converge instead of clobbering.
 */

/** Snapshot the current account's syncable state. */
export function buildDoc(): SyncDoc {
  return {
    v: 1,
    account: session.did ?? '',
    exportedAt: Date.now(),
    reactions: [...reactions.byUri.values()],
    dismissed: [...read.dismissed],
  }
}

/** Merge a decrypted doc into the local stores (reactions LWW, dismissed union). */
export async function applyDoc(doc: SyncDoc): Promise<{ reactions: number; dismissed: number }> {
  await reactions.importRows(doc.reactions ?? [])
  await read.dismissMany(doc.dismissed ?? [])
  return { reactions: doc.reactions?.length ?? 0, dismissed: doc.dismissed?.length ?? 0 }
}

// ── Phase 0: encrypted file ──────────────────────────────────────────────────

export async function exportToFile(passphrase: string): Promise<void> {
  const env = await encryptDoc(buildDoc(), passphrase)
  const blob = new Blob([JSON.stringify(env)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `mothtrap-sync-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

export async function importFromFile(
  file: File,
  passphrase: string,
): Promise<{ reactions: number; dismissed: number }> {
  let env: SyncEnvelope
  try {
    env = JSON.parse(await file.text()) as SyncEnvelope
  } catch {
    throw new Error('That does not look like a Mothtrap sync file.')
  }
  const doc = await decryptDoc(env, passphrase) // throws on wrong passphrase
  if (!doc.account || doc.account !== session.did) {
    throw new Error('This file belongs to a different account — sign into that account to import it.')
  }
  return applyDoc(doc)
}

// ── Phase 1/2: PDS sync ──────────────────────────────────────────────────────

const kKey = (did: string) => `skynets:synckey:${did}`
const kSalt = (did: string) => `skynets:syncsalt:${did}`
const kIter = (did: string) => `skynets:synciter:${did}`
const kOn = (did: string) => `skynets:syncon:${did}`
const kLast = (did: string) => `skynets:synclast:${did}`

// Auto-loop cadence (#83). A change pushes DEBOUNCE_MS after activity goes quiet,
// but no later than MAX_WAIT_MS into a continuous streak; both shorter is better
// for bandwidth (each push re-uploads the whole doc) and leaks less activity
// cadence. Pull polls every POLL_MS; foreground pulls (focus/visible/online) are
// throttled so alt-tabbing doesn't spray getRecord calls. RETRY_MS backs off a
// failed push until a foreground event or the next change would retry it anyway.
const DEBOUNCE_MS = 10_000
const MAX_WAIT_MS = 60_000
const POLL_MS = 150_000
const FOREGROUND_THROTTLE_MS = 20_000
const RETRY_MS = 30_000
const MAX_RETRY_MS = 300_000 // ceiling for the failure backoff (5 min)

class SyncState {
  enabled = $state(false)
  busy = $state(false)
  lastSynced = $state<number | null>(null)
  error = $state<string | null>(null)
  #key: CryptoKey | null = null
  #salt: Uint8Array | null = null
  // The PBKDF2 iteration count the cached key was derived under — stamped into
  // every push so a JOINING device re-derives at the SAME cost (else the day ITER
  // ever changes, joins fail and misreport as a wrong passphrase).
  #iter: number = ITER
  #did: string | undefined
  // The CID of the record we last read/wrote — every push swaps against it, so a
  // device that raced ahead of us fails the swap and we re-pull before retrying.
  // Never persisted: starts null each load, so the first push asserts-absent (or
  // conflicts and pulls) rather than blind-overwriting a record it hasn't seen.
  #cid: string | null = null

  // Auto-loop machinery (browser only; guarded for the node test env).
  #dirty = false
  // Bumped on every local change. #push clears #dirty only if this hasn't moved
  // since the snapshot it pushed — so a change landing DURING an in-flight push
  // isn't lost (its bump keeps #dirty set for the next flush).
  #dirtyGen = 0
  // Serializes background pull vs push so a poll can't observe a half-applied
  // pull; a manual syncNow may still overlap, but CAS + cid-after-merge make that
  // safe (it re-merges on conflict).
  #syncing = false
  // Bumped on logout/disable to fence stale in-flight ops from mutating the next
  // account's stores/record (buildDoc/applyDoc read the live session).
  #epoch = 0
  // Consecutive push failures, for the backoff ceiling (reset on any success).
  #failures = 0
  #lastPull = 0
  #loopOn = false
  #pushTimer: ReturnType<typeof setTimeout> | null = null
  #maxTimer: ReturnType<typeof setTimeout> | null = null
  #pollTimer: ReturnType<typeof setInterval> | null = null
  #onVisibility: (() => void) | null = null
  #onFocus: (() => void) | null = null
  #onOnline: (() => void) | null = null
  #onBeforeUnload: (() => void) | null = null

  constructor() {
    // Any persisted change to either store schedules a debounced push. markDirty
    // no-ops unless sync is enabled, so this is safe to wire once, up front.
    reactions.onChange = () => this.markDirty()
    read.onChange = () => this.markDirty()
  }

  /** On login: restore the cached key and, if sync is on, start the loop. */
  async load(did: string) {
    this.#did = did
    const [rawKey, rawSalt, iter, on, last] = await Promise.all([
      get<Uint8Array>(kKey(did)),
      get<Uint8Array>(kSalt(did)),
      get<number>(kIter(did)),
      get<boolean>(kOn(did)),
      get<number>(kLast(did)),
    ])
    if (on && rawKey && rawSalt) {
      this.#key = await importRawKey(rawKey)
      this.#salt = rawSalt
      this.#iter = iter ?? ITER
      this.enabled = true
      this.lastSynced = last ?? null
      this.#startLoop(true) // pull-on-login + periodic/foreground pull + push-on-change
    }
  }

  /** Turn on sync for this account. Reuses the remote salt if a record already
   * exists (so every device with the passphrase derives the same key), and
   * verifies the passphrase against it. */
  async enable(passphrase: string) {
    if (!this.#did) throw new Error('Sign in first.')
    this.busy = true
    this.error = null
    try {
      const remote = await getSyncState()
      const salt = remote ? envelopeSalt(remote.env) : randomSalt()
      const iter = remote?.env.iter ?? ITER
      const key = await deriveSyncKey(passphrase, salt, iter)
      if (remote) await decryptWithKey(remote.env, key) // wrong passphrase → throws here
      this.#key = key
      this.#salt = salt
      this.#iter = iter
      this.#cid = remote?.cid ?? null // seed CAS with the record we just read
      const raw = await exportRawKey(key)
      await Promise.all([
        set(kKey(this.#did), raw),
        set(kSalt(this.#did), salt),
        set(kIter(this.#did), iter),
        set(kOn(this.#did), true),
      ])
      this.enabled = true
      this.#startLoop(false) // syncNow below does the initial pull; don't double it
      await this.syncNow()
    } catch (e) {
      this.error = msg(e)
      throw e
    } finally {
      this.busy = false
    }
  }

  /** Pull the remote doc and merge it in (no push). Refreshes the CAS CID only
   * AFTER the merge lands, so #cid never names a server state we haven't merged
   * (else a concurrent push would swap against it and drop the pulled change). */
  async pull() {
    const epoch = this.#epoch
    const key = this.#key
    if (!key) return
    const remote = await getSyncState()
    if (epoch !== this.#epoch) return // account switched during the fetch
    if (!remote) {
      this.#cid = null
      this.#lastPull = Date.now()
      return
    }
    const doc = await decryptWithKey(remote.env, key)
    if (epoch !== this.#epoch) return
    this.#lastPull = Date.now()
    if (doc.account && this.#did && doc.account !== this.#did) return // wrong account — skip
    await applyDoc(doc)
    if (epoch !== this.#epoch) return // switched while merging — don't advance #cid into it
    this.#cid = remote.cid
    this.error = null
    await this.#stamp()
  }

  /** Manual pull-merge, then push the merged local state. */
  async syncNow() {
    if (!this.#key || !this.#salt || !this.#did) return
    this.busy = true
    this.error = null
    try {
      await this.pull()
      await this.#push()
    } catch (e) {
      this.error = msg(e)
    } finally {
      this.busy = false
    }
  }

  /** Push the current local state, CAS-conditioned; on a lost race, pull + retry
   * (casPush rebuilds from the merged state each attempt). Clears #dirty only if
   * nothing changed since the snapshot it actually pushed. */
  async #push() {
    if (!this.#key || !this.#salt || !this.#did) return
    const epoch = this.#epoch
    const key = this.#key
    const salt = this.#salt
    const did = this.#did
    const iter = this.#iter
    let pushedGen = this.#dirtyGen
    const cid = await casPush({
      currentCid: () => this.#cid,
      buildEnv: () => {
        pushedGen = this.#dirtyGen // snapshot the generation this env represents
        return encryptWithKey(buildDoc(), key, salt, iter)
      },
      // Fence a write that a logout/switch has orphaned: it would otherwise land
      // in the NEW account's repo (putRecord uses the live agent).
      put: (env, swap) => {
        if (epoch !== this.#epoch) throw new Error('sync: account changed')
        return putSyncState(env, did, swap)
      },
      pull: () => this.pull(),
      isConflict: isSwapConflict,
    })
    if (epoch !== this.#epoch) return
    this.#cid = cid
    this.error = null
    if (this.#dirtyGen === pushedGen) this.#dirty = false // else a mid-push change stays queued
    await this.#stamp()
  }

  /** Note a local change; schedule a debounced push (browser only). */
  markDirty() {
    if (!this.enabled || !this.#key) return
    this.#dirty = true
    this.#dirtyGen++
    this.#arm()
  }

  /** Arm the debounce + max-wait flush timers (browser only). */
  #arm() {
    if (typeof window === 'undefined') return
    if (this.#pushTimer) clearTimeout(this.#pushTimer)
    this.#pushTimer = setTimeout(() => void this.#flush(), DEBOUNCE_MS)
    if (!this.#maxTimer) this.#maxTimer = setTimeout(() => void this.#flush(), MAX_WAIT_MS)
  }

  /** Fire a pending push now (debounce/max timer, or a foreground event). */
  async #flush() {
    if (this.#pushTimer) {
      clearTimeout(this.#pushTimer)
      this.#pushTimer = null
    }
    if (this.#maxTimer) {
      clearTimeout(this.#maxTimer)
      this.#maxTimer = null
    }
    if (!this.enabled || !this.#key || !this.#dirty) return
    if (this.#syncing) {
      this.#arm() // a pull/push is in flight; retry after it
      return
    }
    this.#syncing = true
    let failed = false
    try {
      await this.#push()
      this.#failures = 0
    } catch (e) {
      failed = true
      this.#failures++
      this.error = msg(e)
    } finally {
      this.#syncing = false
    }
    // Still dirty means the push failed or a change landed mid-push: re-arm so it
    // isn't stranded (foreground events also retry, but this covers an idle tab).
    // A mid-push change retries at the normal debounce; a failure backs off
    // (30s × consecutive failures, capped) so a permanently-failing push — e.g.
    // the doc outgrows the record limit — doesn't spin every 30s forever.
    if (this.#dirty && typeof window !== 'undefined') {
      const delay = failed ? Math.min(RETRY_MS * this.#failures, MAX_RETRY_MS) : DEBOUNCE_MS
      if (this.#pushTimer) clearTimeout(this.#pushTimer)
      this.#pushTimer = setTimeout(() => void this.#flush(), delay)
    }
  }

  /** Background pull (poll/focus/visible/online). Skips if one is in flight, and
   * throttles the chatty foreground triggers. */
  async #maybePull(reason: 'poll' | 'focus' | 'visible' | 'online' | 'start') {
    if (!this.enabled || !this.#key || this.#syncing) return
    if (
      (reason === 'focus' || reason === 'visible' || reason === 'online') &&
      this.#lastPull &&
      Date.now() - this.#lastPull < FOREGROUND_THROTTLE_MS
    )
      return
    this.#syncing = true
    try {
      await this.pull()
    } catch (e) {
      this.error = msg(e)
    } finally {
      this.#syncing = false
    }
  }

  #startLoop(initialPull: boolean) {
    if (this.#loopOn) return
    this.#loopOn = true
    if (initialPull) void this.#maybePull('start')
    if (typeof document === 'undefined' || typeof window === 'undefined') return // node/SSR: no timers/listeners
    this.#pollTimer = setInterval(() => void this.#maybePull('poll'), POLL_MS)
    this.#onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void this.#maybePull('visible')
        void this.#flush()
      } else {
        void this.#flush() // leaving the tab: push pending before we lose focus
      }
    }
    this.#onFocus = () => {
      void this.#maybePull('focus')
      void this.#flush()
    }
    this.#onOnline = () => {
      void this.#maybePull('online')
      void this.#flush() // reconnected: flush anything queued while offline
    }
    this.#onBeforeUnload = () => void this.#flush()
    document.addEventListener('visibilitychange', this.#onVisibility)
    window.addEventListener('focus', this.#onFocus)
    window.addEventListener('online', this.#onOnline)
    window.addEventListener('beforeunload', this.#onBeforeUnload)
  }

  #stopLoop() {
    this.#loopOn = false
    if (this.#pushTimer) {
      clearTimeout(this.#pushTimer)
      this.#pushTimer = null
    }
    if (this.#maxTimer) {
      clearTimeout(this.#maxTimer)
      this.#maxTimer = null
    }
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer)
      this.#pollTimer = null
    }
    if (typeof document !== 'undefined' && this.#onVisibility)
      document.removeEventListener('visibilitychange', this.#onVisibility)
    if (typeof window !== 'undefined') {
      if (this.#onFocus) window.removeEventListener('focus', this.#onFocus)
      if (this.#onOnline) window.removeEventListener('online', this.#onOnline)
      if (this.#onBeforeUnload) window.removeEventListener('beforeunload', this.#onBeforeUnload)
    }
    this.#onVisibility = this.#onFocus = this.#onOnline = this.#onBeforeUnload = null
    this.#dirty = false
    this.#syncing = false
    this.#failures = 0
  }

  /** Turn sync off on this device; optionally delete the remote record. */
  async disable(alsoDeleteRemote = false) {
    this.#epoch++ // fence any in-flight push/pull from writing after this
    this.#stopLoop()
    if (alsoDeleteRemote) await deleteSyncState().catch(() => {})
    if (this.#did)
      await Promise.all([
        del(kKey(this.#did)),
        del(kSalt(this.#did)),
        del(kIter(this.#did)),
        del(kOn(this.#did)),
        del(kLast(this.#did)),
      ])
    this.#key = null
    this.#salt = null
    this.#cid = null
    this.#lastPull = 0
    this.enabled = false
    this.lastSynced = null
  }

  /** Drop in-memory state on logout (leaves persisted key/flag for next login). */
  reset() {
    this.#epoch++ // fence in-flight ops from bleeding into the next account
    this.#stopLoop()
    this.#key = null
    this.#salt = null
    this.#cid = null
    this.#did = undefined
    this.#lastPull = 0
    this.enabled = false
    this.busy = false
    this.lastSynced = null
    this.error = null
  }

  async #stamp() {
    this.lastSynced = Date.now()
    if (this.#did) await set(kLast(this.#did), this.lastSynced)
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : 'Sync failed.'
}

export const sync = new SyncState()
export { SyncState }
