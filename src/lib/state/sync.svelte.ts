import { del, get, set } from 'idb-keyval'
import { reactions } from './reactions.svelte'
import { read } from './read.svelte'
import { session } from './session.svelte'
import {
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
import { deleteSyncState, getSyncState, putSyncState } from '../api/syncpds'

/**
 * Cross-device sync (docs/sync-spec.md). The crypto + CRDT merges live in
 * ../api/sync (pure, tested); the atproto transport in ../api/syncpds. This
 * module glues them to the stores:
 *   Phase 0 — encrypted file export/import (buildDoc/applyDoc/export/import).
 *   Phase 1 — the encrypted doc in the user's PDS: pull-and-merge on login and a
 *             manual "Sync now" (pull-merge-push). The derived key is cached
 *             per-device (the local store already holds the plaintext, so this
 *             adds no exposure the server can see).
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

// ── Phase 1: PDS sync ────────────────────────────────────────────────────────

const kKey = (did: string) => `skynets:synckey:${did}`
const kSalt = (did: string) => `skynets:syncsalt:${did}`
const kIter = (did: string) => `skynets:synciter:${did}`
const kOn = (did: string) => `skynets:syncon:${did}`
const kLast = (did: string) => `skynets:synclast:${did}`

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

  /** On login: restore the cached key and, if sync is on, pull-and-merge. */
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
      this.pull().catch((e) => (this.error = msg(e))) // one-way pull-on-login
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
      const salt = remote ? envelopeSalt(remote) : randomSalt()
      const iter = remote?.iter ?? ITER
      const key = await deriveSyncKey(passphrase, salt, iter)
      if (remote) await decryptWithKey(remote, key) // wrong passphrase → throws here
      this.#key = key
      this.#salt = salt
      this.#iter = iter
      const raw = await exportRawKey(key)
      await Promise.all([
        set(kKey(this.#did), raw),
        set(kSalt(this.#did), salt),
        set(kIter(this.#did), iter),
        set(kOn(this.#did), true),
      ])
      this.enabled = true
      await this.syncNow()
    } catch (e) {
      this.error = msg(e)
      throw e
    } finally {
      this.busy = false
    }
  }

  /** Pull the remote doc and merge it in (no push). */
  async pull() {
    if (!this.#key) return
    const remote = await getSyncState()
    if (!remote) return
    const doc = await decryptWithKey(remote, this.#key)
    if (doc.account && this.#did && doc.account !== this.#did) return // wrong account — skip
    await applyDoc(doc)
    await this.#stamp()
  }

  /** Pull-merge, then push the merged local state. */
  async syncNow() {
    if (!this.#key || !this.#salt || !this.#did) return
    this.busy = true
    this.error = null
    try {
      await this.pull()
      await putSyncState(await encryptWithKey(buildDoc(), this.#key, this.#salt, this.#iter), this.#did)
      await this.#stamp()
    } catch (e) {
      this.error = msg(e)
    } finally {
      this.busy = false
    }
  }

  /** Turn sync off on this device; optionally delete the remote record. */
  async disable(alsoDeleteRemote = false) {
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
    this.enabled = false
    this.lastSynced = null
  }

  /** Drop in-memory state on logout (leaves persisted key/flag for next login). */
  reset() {
    this.#key = null
    this.#salt = null
    this.#did = undefined
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
