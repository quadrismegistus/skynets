import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clear, get, set } from 'idb-keyval'
import { ReadState } from './read.svelte'

const DID = 'did:plc:me'
const KEY = `skynets:dismissed:${DID}`

// Drive Date.now() rather than the timer queue: fake timers would wedge
// fake-indexeddb (its async never advances), so spy the clock alone.
function at(t: number) {
  vi.spyOn(Date, 'now').mockReturnValue(t)
}

beforeEach(async () => {
  await clear() // idb-keyval's default store is shared across instances
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('read store (#82 timestamped dismissals)', () => {
  it('stamps dismiss with Date.now() and keeps first-seen on a repeat', async () => {
    const r = new ReadState()
    await r.load(DID)

    at(1_000)
    await r.dismiss('at://a')
    expect(r.dismissed.get('at://a')).toBe(1_000)

    // A second dismiss of the same uri is a no-op — the original time stands.
    at(5_000)
    await r.dismiss('at://a')
    expect(r.dismissed.get('at://a')).toBe(1_000)
  })

  it('orders by dismissed-at so the view can list most-recent first', async () => {
    const r = new ReadState()
    await r.load(DID)

    at(100)
    await r.dismiss('at://old')
    at(200)
    await r.dismiss('at://mid')
    at(300)
    await r.dismiss('at://new')

    const recentFirst = [...r.dismissed.entries()].sort((a, b) => b[1] - a[1]).map(([uri]) => uri)
    expect(recentFirst).toEqual(['at://new', 'at://mid', 'at://old'])
  })

  it('dismissMany stamps every uri with one shared timestamp and skips dupes', async () => {
    const r = new ReadState()
    await r.load(DID)

    at(1_000)
    await r.dismiss('at://a')
    at(9_000)
    await r.dismissMany(['at://a', 'at://b', 'at://c'])

    expect(r.dismissed.get('at://a')).toBe(1_000) // already dismissed — untouched
    expect(r.dismissed.get('at://b')).toBe(9_000)
    expect(r.dismissed.get('at://c')).toBe(9_000)
    expect(r.dismissed.size).toBe(3)
  })

  it('isDismissed still answers via .has() (unchanged reader contract)', async () => {
    const r = new ReadState()
    await r.load(DID)
    await r.dismiss('at://a')
    expect(r.isDismissed('at://a')).toBe(true)
    expect(r.isDismissed('at://nope')).toBe(false)
  })

  it('restore removes an entry and persists the removal', async () => {
    const r = new ReadState()
    await r.load(DID)
    await r.dismiss('at://a')
    await r.restore('at://a')
    expect(r.dismissed.has('at://a')).toBe(false)

    // The removal is durable: a fresh load must not resurrect it.
    const reopened = new ReadState()
    await reopened.load(DID)
    expect(reopened.isDismissed('at://a')).toBe(false)
  })

  it('persists as [uri, t] pairs and round-trips across a reload', async () => {
    const r = new ReadState()
    await r.load(DID)
    at(4_242)
    await r.dismiss('at://a')

    // On-disk shape is [uri, number][], not a bare string[].
    expect(await get(KEY)).toEqual([['at://a', 4_242]])

    const reopened = new ReadState()
    await reopened.load(DID)
    expect(reopened.dismissed.get('at://a')).toBe(4_242)
  })

  it('migrates the legacy string[] shape to a Map with t=0 (sorts oldest)', async () => {
    // Pre-#82 persistence: a bare array of URIs, no timestamps.
    await set(KEY, ['at://legacy1', 'at://legacy2'])

    const r = new ReadState()
    await r.load(DID)
    expect(r.isDismissed('at://legacy1')).toBe(true)
    expect(r.dismissed.get('at://legacy1')).toBe(0)
    expect(r.dismissed.get('at://legacy2')).toBe(0)

    // A migrated (t=0) entry sorts oldest against a freshly stamped one.
    at(5_000)
    await r.dismiss('at://fresh')
    const recentFirst = [...r.dismissed.entries()].sort((a, b) => b[1] - a[1]).map(([uri]) => uri)
    expect(recentFirst[0]).toBe('at://fresh')
    expect(recentFirst).toContain('at://legacy1')

    // And it re-persists in the NEW shape, so the migration is one-way.
    expect(await get(KEY)).toContainEqual(['at://legacy1', 0])
    expect(await get(KEY)).toContainEqual(['at://fresh', 5_000])
  })

  it('is a no-op before a user is loaded (nothing to key persistence on)', async () => {
    const r = new ReadState()
    await r.dismiss('at://a')
    expect(r.isDismissed('at://a')).toBe(false)
  })

  it('purge deletes the on-disk key — a wiped device stays wiped after reload', async () => {
    const r = new ReadState()
    await r.load(DID)
    await r.dismiss('at://a')
    await r.purge()
    expect(r.isDismissed('at://a')).toBe(false)

    const reopened = new ReadState()
    await reopened.load(DID)
    expect(reopened.isDismissed('at://a')).toBe(false)
  })
})
