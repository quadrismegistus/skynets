import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncEnvelope } from './sync'

// In-memory fake PDS. vi.hoisted so the mock factory can reach it.
const h = vi.hoisted(() => ({ store: {} as Record<string, unknown> }))

vi.mock('./agent', () => ({
  getAgent: () => ({
    assertDid: 'did:plc:me',
    com: {
      atproto: {
        repo: {
          putRecord: async ({ collection, rkey, record }: { collection: string; rkey: string; record: unknown }) => {
            h.store[`${collection}/${rkey}`] = record
            return {}
          },
          getRecord: async ({ collection, rkey }: { collection: string; rkey: string }) => {
            const v = h.store[`${collection}/${rkey}`]
            if (!v) throw new Error('Could not locate record')
            return { data: { value: v } }
          },
          deleteRecord: async ({ collection, rkey }: { collection: string; rkey: string }) => {
            delete h.store[`${collection}/${rkey}`]
            return {}
          },
        },
      },
    },
  }),
}))

import { deleteSyncState, getSyncState, putSyncState } from './syncpds'

const env: SyncEnvelope = {
  v: 1,
  kdf: 'PBKDF2-SHA256',
  iter: 600_000,
  cipher: 'AES-256-GCM',
  salt: 'c2FsdA==',
  iv: 'aXY=',
  ct: 'Y3Q=',
}

beforeEach(() => {
  h.store = {}
})

describe('syncpds (#80 Phase 1 transport)', () => {
  it('returns null when no record exists yet', async () => {
    expect(await getSyncState()).toBeNull()
  })

  it('put then get round-trips the envelope (with account/updatedAt metadata)', async () => {
    await putSyncState(env, 'did:plc:me')
    const got = await getSyncState()
    expect(got).toMatchObject(env) // envelope fields preserved
    expect((got as unknown as { account: string }).account).toBe('did:plc:me')
  })

  it('delete removes it', async () => {
    await putSyncState(env, 'did:plc:me')
    await deleteSyncState()
    expect(await getSyncState()).toBeNull()
  })
})
