import { describe, expect, it } from 'vitest'
import { buildSubscribeUrl, isSyncCommit, JETSTREAM_ENDPOINT } from './firehose'
import { SYNC_COLLECTION } from './syncpds'

const DID = 'did:plc:me'

describe('firehose (#83 real-time trigger)', () => {
  describe('buildSubscribeUrl', () => {
    it('scopes the subscription to our collection and DID', () => {
      const url = new URL(buildSubscribeUrl(DID))
      expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(JETSTREAM_ENDPOINT)
      expect(url.searchParams.get('wantedCollections')).toBe(SYNC_COLLECTION)
      expect(url.searchParams.get('wantedDids')).toBe(DID)
    })

    it('percent-encodes the DID so the query is well-formed', () => {
      const url = buildSubscribeUrl('did:plc:abc 123', JETSTREAM_ENDPOINT)
      expect(url).not.toContain('abc 123') // a raw space would be invalid
      expect(new URL(url).searchParams.get('wantedDids')).toBe('did:plc:abc 123')
    })

    it('honours a custom endpoint (e.g. an alternate Jetstream host)', () => {
      const url = new URL(buildSubscribeUrl(DID, 'wss://jetstream1.us-west.bsky.network/subscribe'))
      expect(url.host).toBe('jetstream1.us-west.bsky.network')
      expect(url.searchParams.get('wantedDids')).toBe(DID)
    })
  })

  describe('isSyncCommit', () => {
    const commit = (over: Record<string, unknown> = {}) => ({
      did: DID,
      kind: 'commit',
      commit: { operation: 'update', collection: SYNC_COLLECTION, rkey: 'self' },
      ...over,
    })

    it('accepts a commit to our collection from our DID', () => {
      expect(isSyncCommit(commit(), DID)).toBe(true)
    })

    it('accepts any operation (create/update/delete all move the record)', () => {
      for (const operation of ['create', 'update', 'delete']) {
        expect(isSyncCommit(commit({ commit: { operation, collection: SYNC_COLLECTION } }), DID)).toBe(
          true,
        )
      }
    })

    it('rejects a commit to a different collection', () => {
      expect(isSyncCommit(commit({ commit: { collection: 'app.bsky.feed.like' } }), DID)).toBe(false)
    })

    it('rejects a commit from a different DID', () => {
      expect(isSyncCommit(commit({ did: 'did:plc:someone-else' }), DID)).toBe(false)
    })

    it('rejects non-commit events (identity/account)', () => {
      expect(isSyncCommit(commit({ kind: 'identity', commit: undefined }), DID)).toBe(false)
      expect(isSyncCommit(commit({ kind: 'account', commit: undefined }), DID)).toBe(false)
    })

    it('rejects malformed / non-object frames without throwing', () => {
      expect(isSyncCommit(null, DID)).toBe(false)
      expect(isSyncCommit(undefined, DID)).toBe(false)
      expect(isSyncCommit('not json', DID)).toBe(false)
      expect(isSyncCommit(42, DID)).toBe(false)
      expect(isSyncCommit({ kind: 'commit', did: DID }, DID)).toBe(false) // no commit body
      expect(isSyncCommit({ kind: 'commit', did: DID, commit: null }, DID)).toBe(false)
    })
  })
})
