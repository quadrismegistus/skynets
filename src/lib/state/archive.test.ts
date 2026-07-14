import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { Archive } from './archive'
import { mkPost } from '../testing'

let n = 0
async function fresh(): Promise<Archive> {
  const a = new Archive()
  await a.open(`test-${n++}`)
  return a
}

describe('Archive', () => {
  it('records posts and resolves them by URI', async () => {
    const a = await fresh()
    await a.record([mkPost({ uri: 'at://p/1', text: 'one' }), mkPost({ uri: 'at://p/2', text: 'two' })])
    const got = await a.getPosts(['at://p/1', 'at://p/2', 'at://missing'])
    expect(got.size).toBe(2)
    expect(got.get('at://p/1')?.post.uri).toBe('at://p/1')
  })

  it('dedups appearances per (uri,kind) but bumps lastSeen', async () => {
    const a = await fresh()
    const p = mkPost({ uri: 'at://p/1' })
    await a.record([p])
    await a.record([p]) // same post surfaced again
    const s = await a.stats()
    expect(s.posts).toBe(1)
    expect(s.appearances).toBe(1) // not duplicated
  })

  it('records a distinct appearance for a repost of the same post', async () => {
    const a = await fresh()
    await a.record([mkPost({ uri: 'at://p/1' })]) // timeline
    await a.record([mkPost({ uri: 'at://p/1', repostBy: 'did:plc:booster' })]) // repost
    const s = await a.stats()
    expect(s.appearances).toBe(2)
  })

  it('samples counts only when engagement changes', async () => {
    const a = await fresh()
    await a.record([mkPost({ uri: 'at://p/1', likes: 5 })])
    await a.record([mkPost({ uri: 'at://p/1', likes: 5 })]) // unchanged → no new sample
    await a.record([mkPost({ uri: 'at://p/1', likes: 9 })]) // changed → new sample
    const s = await a.stats()
    expect(s.counts).toBe(2)
  })

  it('records a follows snapshot only when the set changes', async () => {
    const a = await fresh()
    await a.recordFollows(['did:a', 'did:b'])
    await a.recordFollows(['did:b', 'did:a']) // same set, different order → no new snapshot
    await a.recordFollows(['did:a', 'did:b', 'did:c']) // changed → new snapshot
    expect((await a.stats()).follows).toBe(2)
  })

  it('round-trips the digest cluster state and vectors', async () => {
    const a = await fresh()
    await a.putDigest([{ id: 'ice', label: 'ICE', summary: 's', status: 'heating', uris: ['at://p/1'] }])
    expect((await a.getDigest())[0].label).toBe('ICE')
    await a.putVectors([{ uri: 'at://p/1', vec: [0.1, 0.2, 0.3] }])
    expect((await a.getVectors(['at://p/1'])).get('at://p/1')).toEqual([0.1, 0.2, 0.3])
  })

  it('exports the corpus as JSON', async () => {
    const a = await fresh()
    await a.record([mkPost({ uri: 'at://p/1', text: 'hello' })])
    const dump = JSON.parse(await a.exportJSON())
    expect(dump.posts).toHaveLength(1)
    expect(dump.posts[0].post.uri).toBe('at://p/1')
  })
})
