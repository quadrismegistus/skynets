import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/thread', () => ({ fetchAncestors: vi.fn(async () => []) }))

import { ancestors } from './ancestors.svelte'
import * as thread from '../api/thread'

beforeEach(() => {
  ancestors.reset()
  vi.clearAllMocks()
})

describe('ancestors settled tracking (#46 admissibility gate)', () => {
  it('marks a reply settled once its ancestry fetch resolves', async () => {
    expect(ancestors.settledUris.has('r')).toBe(false)
    await ancestors.ensure(['r'])
    expect(ancestors.settledUris.has('r')).toBe(true)
  })

  it('a failed fetch settles the reply WITHOUT rejecting ensure (deleted parent → 400)', async () => {
    // A deleted/blocked parent 400s; ensure must swallow it (no uncaught
    // rejection into the caller's effect) and still release the gate.
    vi.mocked(thread.fetchAncestors).mockRejectedValueOnce(new Error('Post not found'))
    await expect(ancestors.ensure(['bad'])).resolves.toBeUndefined()
    expect(ancestors.settledUris.has('bad')).toBe(true)
  })

  it('one bad ancestor in a batch does not discard the good chains', async () => {
    const good = [{ post: { uri: 'at://p/parent' } }] as any
    vi.mocked(thread.fetchAncestors).mockImplementation(async (u: string) => {
      if (u === 'bad') throw new Error('Post not found')
      return good
    })
    await expect(ancestors.ensure(['bad', 'good'])).resolves.toBeUndefined()
    // The good chain survived the batch...
    expect(ancestors.posts.some((p) => p.post.uri === 'at://p/parent')).toBe(true)
    // ...and BOTH replies settled.
    expect(ancestors.settledUris.has('bad')).toBe(true)
    expect(ancestors.settledUris.has('good')).toBe(true)
  })

  it('reset clears settled state', async () => {
    await ancestors.ensure(['r'])
    ancestors.reset()
    expect(ancestors.settledUris.has('r')).toBe(false)
  })
})

describe('ancestors in-flight dedup (#64)', () => {
  it('coalesces a reply uri repeated within one batch into a single fetch', async () => {
    let release!: (chain: any[]) => void
    // A still-pending fetch keeps the uri in-flight while the batch maps over it.
    vi.mocked(thread.fetchAncestors).mockReturnValueOnce(
      new Promise<any[]>((res) => (release = res)),
    )
    const done = ancestors.ensure(['dup', 'dup'])
    // Both occurrences share the one outstanding request — no duplicate call.
    expect(thread.fetchAncestors).toHaveBeenCalledTimes(1)
    release([{ post: { uri: 'at://p/parent' } }])
    await done
    // The shared chain merges once (posts already dedup by uri anyway).
    expect(ancestors.posts.filter((p) => p.post.uri === 'at://p/parent')).toHaveLength(1)
  })

  it('does not cache a rejection: the in-flight entry clears once it settles', async () => {
    vi.mocked(thread.fetchAncestors).mockRejectedValueOnce(new Error('Post not found'))
    await ancestors.ensure(['gone'])
    // With #inflight cleared on settle, a fresh uri fetches normally afterwards
    // (a stuck entry would be keyed by uri, so this mainly guards the map hygiene
    // that lets a re-requestable uri retry rather than hang on a dead promise).
    vi.mocked(thread.fetchAncestors).mockResolvedValueOnce([{ post: { uri: 'at://p/ok' } }] as any)
    await ancestors.ensure(['other'])
    expect(ancestors.posts.some((p) => p.post.uri === 'at://p/ok')).toBe(true)
  })
})
