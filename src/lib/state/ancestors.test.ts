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

  it('settles even when the fetch REJECTS — a failed fetch must still release the gate', async () => {
    vi.mocked(thread.fetchAncestors).mockRejectedValueOnce(new Error('offline'))
    await expect(ancestors.ensure(['bad'])).rejects.toThrow('offline')
    expect(ancestors.settledUris.has('bad')).toBe(true)
  })

  it('reset clears settled state', async () => {
    await ancestors.ensure(['r'])
    ancestors.reset()
    expect(ancestors.settledUris.has('r')).toBe(false)
  })
})
