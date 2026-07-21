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

const ITER = 600_000

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

async function deriveKey(passphrase: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
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
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Encrypt a doc under a passphrase into a self-describing envelope. */
export async function encryptDoc(doc: SyncDoc, passphrase: string): Promise<SyncEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt, ITER)
  const pt = new TextEncoder().encode(JSON.stringify(doc))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, pt as BufferSource),
  )
  return {
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iter: ITER,
    cipher: 'AES-256-GCM',
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(ct),
  }
}

/** Decrypt an envelope. Throws on a wrong passphrase — the GCM auth tag fails,
 * so there's no separate marker to check. The header is validated up front (so a
 * hostile `iter` can't burn CPU before any check, and unknown formats fail
 * clearly), and ALL parsing sits inside the catch so a malformed file yields the
 * friendly message rather than a raw base64/DOMException. */
export async function decryptDoc(env: SyncEnvelope, passphrase: string): Promise<SyncDoc> {
  if (env?.cipher !== 'AES-256-GCM' || env?.kdf !== 'PBKDF2-SHA256') {
    throw new Error('Unrecognised sync file format.')
  }
  if (typeof env.iter !== 'number' || env.iter < 100_000 || env.iter > 2_000_000) {
    throw new Error('Sync file has an unsupported key-derivation cost.')
  }
  try {
    const key = await deriveKey(passphrase, fromB64(env.salt), env.iter)
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(env.iv) as BufferSource },
      key,
      fromB64(env.ct) as BufferSource,
    )
    return JSON.parse(new TextDecoder().decode(pt)) as SyncDoc
  } catch {
    throw new Error('Wrong passphrase, or the file is corrupt.')
  }
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
