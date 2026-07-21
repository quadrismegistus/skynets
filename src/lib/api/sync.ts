import type { Reaction } from '../state/reactions.svelte'

/**
 * Phase 0 cross-device sync (docs/sync-spec.md): the pure, testable core —
 * the sync document, its AES-GCM + PBKDF2 envelope, and the CRDT merges. No
 * store or DOM access here, so it runs the same in a test and the browser.
 */
export interface SyncDoc {
  v: 1
  /** The session DID this doc belongs to — merge only into the same account. */
  account: string
  exportedAt: number
  /** Merged LWW by `t` on import (last write per uri wins). */
  reactions: Reaction[]
  /** Merged by union on import (dismissals are add-mostly; Phase 0 has no tombstones). */
  dismissed: string[]
}

export interface SyncEnvelope {
  v: 1
  kdf: 'PBKDF2-SHA256'
  iter: number
  cipher: 'AES-256-GCM'
  salt: string // base64
  iv: string // base64
  ct: string // base64
}

export const ITER = 600_000
const SALT_LEN = 16
const IV_LEN = 12

export function randomSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_LEN))
}

// base64 <-> bytes. btoa/atob exist in the browser and in Node's global scope;
// the loops avoid spreading big arrays onto the call stack.
function toB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}
function fromB64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** Derive the AES key from a passphrase + salt. `extractable` is true only when
 * the key will be cached on-device for live PDS sync (so it can be exported to
 * idb) — for one-shot file ops it stays non-extractable. */
async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iter: number,
  extractable: boolean,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase) as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: iter, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt'],
  )
}

/** Derive an EXTRACTABLE key for caching (live PDS sync). All devices sharing the
 * passphrase + salt derive the same key. */
export function deriveSyncKey(passphrase: string, salt: Uint8Array, iter = ITER): Promise<CryptoKey> {
  return deriveKey(passphrase, salt, iter, true)
}
export async function exportRawKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key))
}
export function importRawKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, true, [
    'encrypt',
    'decrypt',
  ])
}

/** The salt bytes from an envelope — so a joining device can re-derive the key. */
export function envelopeSalt(env: SyncEnvelope): Uint8Array {
  return fromB64(env.salt)
}

function validateEnvelope(env: SyncEnvelope): void {
  if (env?.cipher !== 'AES-256-GCM' || env?.kdf !== 'PBKDF2-SHA256') {
    throw new Error('Unrecognised sync data format.')
  }
  if (typeof env.iter !== 'number' || env.iter < 100_000 || env.iter > 2_000_000) {
    throw new Error('Sync data has an unsupported key-derivation cost.')
  }
}

/** Encrypt with an already-derived key + given salt (the salt lets other devices
 * re-derive the key from the shared passphrase). Fresh IV per call. */
export async function encryptWithKey(
  doc: SyncDoc,
  key: CryptoKey,
  salt: Uint8Array,
  iter = ITER,
): Promise<SyncEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN))
  const pt = new TextEncoder().encode(JSON.stringify(doc))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, pt as BufferSource),
  )
  return {
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iter,
    cipher: 'AES-256-GCM',
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(ct),
  }
}

/** Decrypt with an already-derived key. Throws the friendly error on a wrong key
 * / tamper (GCM tag) or a malformed envelope. */
export async function decryptWithKey(env: SyncEnvelope, key: CryptoKey): Promise<SyncDoc> {
  validateEnvelope(env)
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(env.iv) as BufferSource },
      key,
      fromB64(env.ct) as BufferSource,
    )
    return JSON.parse(new TextDecoder().decode(pt)) as SyncDoc
  } catch {
    throw new Error('Wrong passphrase, or the data is corrupt.')
  }
}

/** Encrypt a doc under a passphrase (fresh salt) — the one-shot file path. */
export async function encryptDoc(doc: SyncDoc, passphrase: string): Promise<SyncEnvelope> {
  const salt = randomSalt()
  const key = await deriveKey(passphrase, salt, ITER, false)
  return encryptWithKey(doc, key, salt, ITER)
}

/** Decrypt an envelope with a passphrase. Header validated up front (so a hostile
 * `iter` can't burn CPU); all parsing inside the catch → friendly message. */
export async function decryptDoc(env: SyncEnvelope, passphrase: string): Promise<SyncDoc> {
  validateEnvelope(env)
  let key: CryptoKey
  try {
    key = await deriveKey(passphrase, fromB64(env.salt), env.iter, false)
  } catch {
    throw new Error('Wrong passphrase, or the file is corrupt.')
  }
  return decryptWithKey(env, key)
}

/** Last-write-wins per uri: the entry with the greater `t` survives. */
export function mergeReactions(local: Reaction[], incoming: Reaction[]): Reaction[] {
  const by = new Map(local.map((r) => [r.uri, r]))
  for (const r of incoming) {
    const cur = by.get(r.uri)
    if (!cur || r.t > cur.t) by.set(r.uri, r)
  }
  return [...by.values()]
}

/** Union — dismissals only add in Phase 0 (no un-dismiss tombstone yet). */
export function mergeDismissed(local: string[], incoming: string[]): string[] {
  return [...new Set([...local, ...incoming])]
}
