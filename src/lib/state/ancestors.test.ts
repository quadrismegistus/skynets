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
