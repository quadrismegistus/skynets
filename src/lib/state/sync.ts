import { reactions } from './reactions.svelte'
import { read } from './read.svelte'
import { session } from './session.svelte'
import { decryptDoc, encryptDoc, type SyncDoc, type SyncEnvelope } from '../api/sync'

/**
 * Phase 0 cross-device sync (docs/sync-spec.md): manual encrypted export/import
 * of the on-device signal (reactions + dismissed). The store-glue layer — the
 * crypto and CRDT merges live in ../api/sync (pure, tested). No live sync yet;
 * this validates the doc format + flow before the atproto loop.
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

/** Encrypt the current state and download it as a file. */
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

/** Decrypt an exported file and merge it in. Refuses a file from another account
 * so you can't accidentally pour one person's judgments into another's. */
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
  // Strict: only ever merge into the exact account the file was made for (and
  // never when logged out). A missing/empty account is refused, not waved through.
  if (!doc.account || doc.account !== session.did) {
    throw new Error('This file belongs to a different account — sign into that account to import it.')
  }
  return applyDoc(doc)
}
