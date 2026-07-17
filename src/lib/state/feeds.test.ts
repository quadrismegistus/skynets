import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/demo', () => ({ isDemo: () => false }))
const getPreferences = vi.fn()
const getFeedGenerators = vi.fn()
vi.mock('../api/agent', () => ({
  getAgent: () => ({ getPreferences, app: { bsky: { feed: { getFeedGenerators } } } }),
}))

import { feeds } from './feeds.svelte'

describe('feeds store', () => {
  // Reset the singleton to its initial (Following-only) state between tests — a
  // failed load deliberately KEEPS the last-known tabs, so without this a later
  // test would see the prior test's feeds.
  beforeEach(() => {
    feeds.list = [{ key: 'following', name: 'Following' }]
    feeds.loaded = false
  })

  it('builds the tab list: Following first, then pinned feed generators, with resolved names', async () => {
    getPreferences.mockResolvedValue({
      savedFeeds: [
        { id: '1', type: 'timeline', value: 'following', pinned: true },
        { id: '2', type: 'feed', value: 'at://did:plc:x/app.bsky.feed.generator/cats', pinned: true },
        { id: '3', type: 'feed', value: 'at://did:plc:y/app.bsky.feed.generator/news', pinned: false }, // not pinned → skip
        { id: '4', type: 'list', value: 'at://did:plc:z/app.bsky.graph.list/mine', pinned: true }, // list → omitted for now
      ],
    })
    getFeedGenerators.mockResolvedValue({
      data: { feeds: [{ uri: 'at://did:plc:x/app.bsky.feed.generator/cats', displayName: 'Cats 🐱' }] },
    })
    await feeds.load()
    expect(feeds.list.map((f) => f.name)).toEqual(['Following', 'Cats 🐱'])
    expect(feeds.list.map((f) => f.key)).toEqual(['following', 'at://did:plc:x/app.bsky.feed.generator/cats'])
  })

  it('keeps the short-name fallback when the generator lookup fails', async () => {
    getPreferences.mockResolvedValue({
      savedFeeds: [{ id: '2', type: 'feed', value: 'at://did:plc:x/app.bsky.feed.generator/cats', pinned: true }],
    })
    getFeedGenerators.mockRejectedValue(new Error('offline'))
    await feeds.load()
    expect(feeds.list.map((f) => f.name)).toEqual(['Following', 'cats']) // last uri segment
  })

  it('falls back to Following-only when preferences are unavailable', async () => {
    getPreferences.mockRejectedValue(new Error('offline'))
    await feeds.load()
    expect(feeds.list.map((f) => f.name)).toEqual(['Following'])
    expect(feeds.loaded).toBe(true)
  })
})
