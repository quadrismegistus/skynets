import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkPost } from '../testing'
import type { FeedItem } from '../api/timeline'

vi.mock('../api/timeline', () => ({ getTimeline: vi.fn() }))
import { getTimeline } from '../api/timeline'
import { archive } from './archive'
import { backfill } from './backfill'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Serve these pages in order, ignoring the cursor (the mock is the sequence). */
function serve(pgs: { items: FeedItem[]; cursor?: string }[]) {
  let i = 0
  vi.mocked(getTimeline).mockImplementation(async () => pgs[i++] ?? { items: [], cursor: undefined })
}

afterEach(() => vi.clearAllMocks())

describe('backfill', () => {
  it('imports pages until the timeline runs out (fresh archive)', async () => {
    await archive.open('bf-fresh')
    serve([
      { items: [mkPost({ uri: 'at://a/1' }), mkPost({ uri: 'at://a/2' })], cursor: 'c1' },
      { items: [mkPost({ uri: 'at://a/3' }), mkPost({ uri: 'at://a/4' })], cursor: 'c2' },
      { items: [mkPost({ uri: 'at://a/5' })], cursor: undefined }, // no cursor → end
    ])
    const r = await backfill(Date.now(), { throttleMs: 0 })
    expect(r.pages).toBe(3)
    expect(r.imported).toBe(5)
    expect(r.hitCap).toBe(false)
  })

  it('stops at the page cap and reports hitCap', async () => {
    await archive.open('bf-cap')
    serve([
      { items: [mkPost({ uri: 'at://b/1' })], cursor: 'c1' },
      { items: [mkPost({ uri: 'at://b/2' })], cursor: 'c2' },
      { items: [mkPost({ uri: 'at://b/3' })], cursor: 'c3' }, // more available, but capped
    ])
    const r = await backfill(Date.now(), { throttleMs: 0, maxPages: 2 })
    expect(r.pages).toBe(2)
    expect(r.hitCap).toBe(true)
  })

  it('stops when it pages back into already-archived history', async () => {
    await archive.open('bf-overlap')
    const seen = [mkPost({ uri: 'at://s/1' }), mkPost({ uri: 'at://s/2' })]
    await archive.record(seen) // prior session
    await delay(12)
    const mount = Date.now() // this session starts after the prior posts were archived
    await delay(12)
    serve([
      { items: [mkPost({ uri: 'at://n/1' }), mkPost({ uri: 'at://n/2' })], cursor: 'c1' }, // new
      { items: seen, cursor: 'c2' }, // all prior → known streak 1
      { items: seen, cursor: 'c3' }, // all prior → known streak 2 → stop
      { items: [mkPost({ uri: 'at://n/3' })], cursor: 'c4' }, // should NOT be reached
    ])
    const r = await backfill(mount, { throttleMs: 0 })
    expect(r.pages).toBe(3)
    expect(vi.mocked(getTimeline)).toHaveBeenCalledTimes(3)
  })

  it('gives up gracefully on repeated fetch errors', async () => {
    await archive.open('bf-err')
    vi.mocked(getTimeline).mockRejectedValue(new Error('429 rate limited'))
    const r = await backfill(Date.now(), { throttleMs: 0, backoffMs: 0 })
    expect(r.pages).toBe(0) // never got a page; returned without throwing
  })
})
