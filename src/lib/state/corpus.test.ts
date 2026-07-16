import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { Corpus } from './corpus.svelte'
import { archive } from './archive'
import { reposterProfile } from '../api/post'
import { mkPost } from '../testing'

// The mirror updates synchronously regardless of the archive (the write-through
// is fire-and-forget and no-ops when the DB is closed), so most tests assert on
// a fresh Corpus without opening a DB. The rehydrate test seeds the shared
// archive singleton (which corpus.rehydrate reads) under a unique name.

describe('Corpus mirror', () => {
  it('dedups by uri and exposes items in first-seen order', () => {
    const c = new Corpus()
    c.record([mkPost({ uri: 'at://p/1', text: 'a' }), mkPost({ uri: 'at://p/2' })])
    c.record([mkPost({ uri: 'at://p/1', text: 'a again' })]) // same uri, not re-added
    expect(c.items.map((i) => i.post.uri)).toEqual(['at://p/1', 'at://p/2'])
    expect(c.size).toBe(2)
  })

  it('tracks provenance: a context post upgrades to primary when it surfaces in-feed', () => {
    const c = new Corpus()
    c.record([mkPost({ uri: 'at://ctx/1' })], 'context')
    expect(c.isPrimary('at://ctx/1')).toBe(false)
    c.record([mkPost({ uri: 'at://ctx/1' })]) // inferred timeline
    expect(c.isPrimary('at://ctx/1')).toBe(true)
    expect(c.kindOf('at://ctx/1')).toBe('timeline')
  })

  it('context never DEMOTES a post already seen as primary', () => {
    const c = new Corpus()
    c.record([mkPost({ uri: 'at://p/1' })]) // timeline
    c.record([mkPost({ uri: 'at://p/1' })], 'context') // pulled in later to complete a chain
    expect(c.isPrimary('at://p/1')).toBe(true)
  })

  it('keeps the repost copy so reposter attribution survives a plain sighting', () => {
    const c = new Corpus()
    c.record([mkPost({ uri: 'at://p/1' })]) // plain, no reason
    c.record([mkPost({ uri: 'at://p/1', repostBy: 'booster' })]) // repost carries a reason
    const stored = c.items.find((i) => i.post.uri === 'at://p/1')!
    expect(reposterProfile(stored)?.did).toBe('did:plc:booster')
  })

  it('record returns only the newly-added posts (the delta)', () => {
    const c = new Corpus()
    expect(c.record([mkPost({ uri: 'at://p/1' }), mkPost({ uri: 'at://p/2' })])).toHaveLength(2)
    const second = c.record([mkPost({ uri: 'at://p/1' }), mkPost({ uri: 'at://p/3' })])
    expect(second.map((i) => i.post.uri)).toEqual(['at://p/3'])
  })

  it('contextItems = every post that ever served as context (independent of provenance)', () => {
    const c = new Corpus()
    c.record([mkPost({ uri: 'at://feed/1' })]) // primary only
    c.record([mkPost({ uri: 'at://ctx/1' })], 'context') // context only
    // A hidden-repost that's ALSO a needed ancestor: primary provenance, but a
    // context role — it must still appear in contextItems so the chain completes.
    c.record([mkPost({ uri: 'at://both/1', repostBy: 'booster' })]) // primary (repost)
    c.record([mkPost({ uri: 'at://both/1' })], 'context') // later pulled in as an ancestor
    const ctxUris = c.contextItems.map((i) => i.post.uri).sort()
    expect(ctxUris).toEqual(['at://both/1', 'at://ctx/1'])
    expect(c.isPrimary('at://both/1')).toBe(true) // still primary…
    expect(c.hasContext('at://both/1')).toBe(true) // …and still context
  })

  it('flushToArchive persists mirrored posts under each role they hold', async () => {
    await archive.open('corpus-flush-test')
    const c = new Corpus()
    c.record([mkPost({ uri: 'at://f/1' })]) // timeline (write-through lands too, but flush is idempotent)
    c.record([mkPost({ uri: 'at://c/1' })], 'context')
    await c.flushToArchive()
    const provenance = await archive.getProvenance()
    expect(provenance.get('at://f/1')).toBe('timeline')
    expect(provenance.get('at://c/1')).toBe('context')
  })

  it('rehydrates posts + provenance from the archive on reload', async () => {
    await archive.open('corpus-rehydrate-test')
    await archive.record([mkPost({ uri: 'at://feed/1' })]) // timeline
    await archive.record([mkPost({ uri: 'at://ctx/1' })], 'context')
    const c = new Corpus()
    await c.rehydrate()
    expect(c.has('at://feed/1')).toBe(true)
    expect(c.has('at://ctx/1')).toBe(true)
    expect(c.isPrimary('at://feed/1')).toBe(true)
    expect(c.isPrimary('at://ctx/1')).toBe(false)
  })
})
