import { beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import type { SyncEnvelope } from './sync'

// In-memory fake PDS with CID tracking + swapRecord CAS. vi.hoisted so the mock
// factory can reach it. `omitCid` simulates a getRecord response missing its CID.
const h = vi.hoisted(() => ({
  store: {} as Record<string, { record: unknown; cid: string }>,
  seq: 0,
  omitCid: false,
}))

vi.mock('./agent', () => ({
  getAgent: () => ({
    assertDid: 'did:plc:me',
    com: {
      atproto: {
        repo: {
          putRecord: async ({
            collection,
            rkey,
            record,
            swapRecord,
          }: {
            collection: string
            rkey: string
            record: unknown
            swapRecord?: string | null
          }) => {
            const path = `${collection}/${rkey}`
            const cur = h.store[path]
            if (swapRecord === null) {
              // assert-absent: the record must NOT already exist
              if (cur) throw Object.assign(new Error('Record already exists'), { error: 'InvalidSwap' })
            } else if (swapRecord !== undefined) {
              // CAS: the record must still be at this CID
              if (cur?.cid !== swapRecord)
                throw Object.assign(new Error('Record was at a different CID'), { error: 'InvalidSwap' })
            }
            const cid = `cid${++h.seq}`
            h.store[path] = { record, cid }
            return { data: { cid, uri: `at://did:plc:me/${path}` } }
          },
          getRecord: async ({ collection, rkey }: { collection: string; rkey: string }) => {
            const v = h.store[`${collection}/${rkey}`]
            if (!v) throw new Error('Could not locate record')
            return { data: { value: v.record, cid: h.omitCid ? undefined : v.cid } }
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

import { deleteSyncState, getSyncState, isSwapConflict, putSyncState } from './syncpds'

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
  h.seq = 0
  h.omitCid = false
})

describe('syncpds (#80/#83 transport)', () => {
  it('returns null when no record exists yet', async () => {
    expect(await getSyncState()).toBeNull()
  })

  it('a first write (null swap = assert-absent) creates, and get round-trips it', async () => {
    const cid = await putSyncState(env, 'did:plc:me', null)
    expect(cid).toBe('cid1')
    const got = await getSyncState()
    expect(got?.cid).toBe('cid1')
    expect(got?.env).toMatchObject(env) // envelope fields preserved
    expect((got?.env as unknown as { account: string }).account).toBe('did:plc:me')
  })

  it('delete removes it', async () => {
    await putSyncState(env, 'did:plc:me', null)
    await deleteSyncState()
    expect(await getSyncState()).toBeNull()
  })

  it('assert-absent (null swap) fails once a record exists — the concurrent-first-write guard', async () => {
    await putSyncState(env, 'did:plc:me', null) // device A creates it
    const err = await putSyncState(env, 'did:plc:me', null).catch((e) => e) // device B, same instant
    expect(isSwapConflict(err)).toBe(true) // B is forced to pull + converge, not clobber A
  })

  it('a swapCid matching the current CID succeeds and returns the new CID', async () => {
    const c1 = await putSyncState(env, 'did:plc:me', null) // cid1
    const c2 = await putSyncState(env, 'did:plc:me', c1) // swap ok
    expect(c2).toBe('cid2')
  })

  it('a swapCid that lost the race throws an InvalidSwap conflict', async () => {
    const c1 = await putSyncState(env, 'did:plc:me', null) // cid1
    await putSyncState(env, 'did:plc:me', c1) // someone (us) advanced it to cid2
    const err = await putSyncState(env, 'did:plc:me', c1).catch((e) => e) // stale writer
    expect(isSwapConflict(err)).toBe(true)
  })

  it('refuses a record returned without a CID (would silently disable CAS)', async () => {
    await putSyncState(env, 'did:plc:me', null)
    h.omitCid = true
    await expect(getSyncState()).rejects.toThrow(/without a CID/i)
  })

  it('isSwapConflict is true only for a lost CAS race, not other errors', () => {
    expect(isSwapConflict({ error: 'InvalidSwap' })).toBe(true)
    expect(isSwapConflict(new Error('Record was at a different CID'))).toBe(true)
    expect(isSwapConflict({ error: 'RecordNotFound' })).toBe(false)
    expect(isSwapConflict(new Error('network down'))).toBe(false)
  })
})
