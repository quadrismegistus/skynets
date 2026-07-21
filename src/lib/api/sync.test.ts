import { describe, expect, it } from 'vitest'
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
  mergeDismissed,
  mergeReactions,
  randomSalt,
  type CasPushDeps,
  type SyncDoc,
  type SyncEnvelope,
} from './sync'
import type { Reaction } from '../state/reactions.svelte'

const r = (uri: string, reaction: 'up' | 'down', t: number): Reaction => ({
  uri,
  did: 'did:plc:a',
  reaction,
  t,
})

const doc = (): SyncDoc => ({
  v: 1,
  account: 'did:plc:me',
  exportedAt: 1000,
  reactions: [r('at://p/1', 'up', 5), r('at://p/2', 'down', 9)],
  dismissed: ['at://p/3', 'at://p/4'],
})

describe('sync crypto (#80 Phase 0)', () => {
  it('round-trips a doc through encrypt/decrypt with the passphrase', async () => {
    const env = await encryptDoc(doc(), 'correct horse battery staple')
    // Envelope is self-describing and carries only ciphertext.
    expect(env.cipher).toBe('AES-256-GCM')
    expect(env.salt).toBeTruthy()
    expect(env.iv).toBeTruthy()
    // The plaintext must not appear anywhere in the envelope.
    expect(JSON.stringify(env)).not.toContain('at://p/1')
    const back = await decryptDoc(env, 'correct horse battery staple')
    expect(back).toEqual(doc())
  })

  it('a wrong passphrase throws (GCM auth tag fails — no separate marker)', async () => {
    const env = await encryptDoc(doc(), 'right')
    await expect(decryptDoc(env, 'wrong')).rejects.toThrow(/passphrase|corrupt/i)
  })

  it('fresh salt + iv per encryption (ciphertext differs for the same doc/passphrase)', async () => {
    const a = await encryptDoc(doc(), 'pw')
    const b = await encryptDoc(doc(), 'pw')
    expect(a.ct).not.toBe(b.ct)
    expect(a.iv).not.toBe(b.iv)
    expect(a.salt).not.toBe(b.salt)
  })

  it('rejects an unknown format / out-of-range iter BEFORE deriving a key', async () => {
    const env = await encryptDoc(doc(), 'pw')
    await expect(decryptDoc({ ...env, cipher: 'rot13' as never }, 'pw')).rejects.toThrow(/format/i)
    await expect(decryptDoc({ ...env, iter: 999_999_999 }, 'pw')).rejects.toThrow(/cost/i)
  })

  it('a malformed envelope yields the friendly error, not a raw base64 exception', async () => {
    const env = await encryptDoc(doc(), 'pw')
    await expect(decryptDoc({ ...env, salt: 'not base64 !!' }, 'pw')).rejects.toThrow(/passphrase|corrupt/i)
  })
})

describe('sync key-based crypto (#80 Phase 1 — cacheable key)', () => {
  it('encrypt/decrypt with a derived key round-trips', async () => {
    const salt = randomSalt()
    const key = await deriveSyncKey('pw', salt)
    expect(await decryptWithKey(await encryptWithKey(doc(), key, salt), key)).toEqual(doc())
  })

  it('a key survives export→import (the on-device cache) and still decrypts', async () => {
    const salt = randomSalt()
    const key = await deriveSyncKey('pw', salt)
    const env = await encryptWithKey(doc(), key, salt)
    const cached = await importRawKey(await exportRawKey(key))
    expect(await decryptWithKey(env, cached)).toEqual(doc())
  })

  it('another device derives a compatible key from the same passphrase + the envelope salt', async () => {
    const salt = randomSalt()
    const env = await encryptWithKey(doc(), await deriveSyncKey('shared', salt), salt)
    const deviceB = await deriveSyncKey('shared', envelopeSalt(env))
    expect(await decryptWithKey(env, deviceB)).toEqual(doc())
  })

  it('a wrong-passphrase key fails to decrypt', async () => {
    const salt = randomSalt()
    const env = await encryptWithKey(doc(), await deriveSyncKey('right', salt), salt)
    await expect(decryptWithKey(env, await deriveSyncKey('wrong', salt))).rejects.toThrow(
      /passphrase|corrupt/i,
    )
  })

  it('stamps the given iter so a joining device re-derives at the SAME cost', async () => {
    const salt = randomSalt()
    const iter = 200_000 // non-default
    const env = await encryptWithKey(doc(), await deriveSyncKey('pw', salt, iter), salt, iter)
    expect(env.iter).toBe(iter)
    // deriving at the stamped iter works…
    expect(await decryptWithKey(env, await deriveSyncKey('pw', envelopeSalt(env), env.iter))).toEqual(doc())
    // …deriving at a different cost yields a different key → fails (the Finding-1 lockout).
    await expect(decryptWithKey(env, await deriveSyncKey('pw', salt, ITER))).rejects.toThrow()
  })
})

describe('sync merges (#80 Phase 0 CRDTs)', () => {
  it('reactions merge last-write-wins per uri by t', () => {
    const local = [r('at://p/1', 'up', 5), r('at://p/2', 'up', 10)]
    const incoming = [
      r('at://p/1', 'down', 8), // newer → wins
      r('at://p/2', 'down', 3), // older → local kept
      r('at://p/3', 'up', 1), // new uri → added
    ]
    const out = mergeReactions(local, incoming)
    const byUri = new Map(out.map((x) => [x.uri, x]))
    expect(byUri.get('at://p/1')).toMatchObject({ reaction: 'down', t: 8 })
    expect(byUri.get('at://p/2')).toMatchObject({ reaction: 'up', t: 10 })
    expect(byUri.get('at://p/3')).toMatchObject({ reaction: 'up', t: 1 })
    expect(out).toHaveLength(3)
  })

  it('dismissed merge is a union', () => {
    expect(mergeDismissed(['a', 'b'], ['b', 'c']).sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('casPush (#83 CAS retry)', () => {
  const stubEnv: SyncEnvelope = {
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iter: ITER,
    cipher: 'AES-256-GCM',
    salt: 's',
    iv: 'i',
    ct: 'c',
  }
  const conflict = () => Object.assign(new Error('lost race'), { error: 'InvalidSwap' })
  const isConflict = (e: unknown) => (e as { error?: string })?.error === 'InvalidSwap'

  it('writes once and returns the new CID when there is no conflict', async () => {
    const calls: (string | null)[] = []
    const deps: CasPushDeps = {
      currentCid: () => 'cidA',
      buildEnv: async () => stubEnv,
      put: async (_env, swap) => {
        calls.push(swap)
        return 'cidB'
      },
      pull: async () => {
        throw new Error('should not pull')
      },
      isConflict,
    }
    expect(await casPush(deps)).toBe('cidB')
    expect(calls).toEqual(['cidA']) // swapped against the CID we held
  })

  it('on a lost race: pulls, rebuilds against the fresh CID, and retries', async () => {
    let cid: string | null = 'stale'
    let built = 0
    const swaps: (string | null)[] = []
    const deps: CasPushDeps = {
      currentCid: () => cid,
      buildEnv: async () => {
        built++
        return stubEnv
      },
      put: async (_env, swap) => {
        swaps.push(swap)
        if (swap === 'stale') throw conflict() // first attempt loses
        return 'final'
      },
      pull: async () => {
        cid = 'fresh' // a pull refreshes the CID (and would have merged the winner)
      },
      isConflict,
    }
    expect(await casPush(deps, 3)).toBe('final')
    expect(swaps).toEqual(['stale', 'fresh']) // retried against the post-pull CID
    expect(built).toBe(2) // env rebuilt AFTER the pull — pushes the merged state
  })

  it('gives up after the retry budget and rethrows the conflict', async () => {
    let pulls = 0
    const deps: CasPushDeps = {
      currentCid: () => 'x',
      buildEnv: async () => stubEnv,
      put: async () => {
        throw conflict()
      },
      pull: async () => {
        pulls++
      },
      isConflict,
    }
    await expect(casPush(deps, 2)).rejects.toMatchObject({ error: 'InvalidSwap' })
    expect(pulls).toBe(2) // pulled on each of the 2 retries, then gave up
  })

  it('does not retry a non-conflict error', async () => {
    let pulls = 0
    const deps: CasPushDeps = {
      currentCid: () => null,
      buildEnv: async () => stubEnv,
      put: async () => {
        throw new Error('network down')
      },
      pull: async () => {
        pulls++
      },
      isConflict,
    }
    await expect(casPush(deps)).rejects.toThrow('network down')
    expect(pulls).toBe(0)
  })
})
