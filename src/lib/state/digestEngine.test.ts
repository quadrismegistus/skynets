import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkPost } from '../testing'

// Mock embeddings (control similarity) but keep the REAL gate/centroid/cosine.
vi.mock('../api/embed', async (orig) => {
  const actual = (await orig()) as object
  return { ...actual, embedTexts: vi.fn() }
})
// Mock the LLM calls so we control establish/roll outputs.
vi.mock('../api/llm', async (orig) => {
  const actual = (await orig()) as object
  return { ...actual, summarizeFeed: vi.fn(), rollFeed: vi.fn() }
})

import { embedTexts } from '../api/embed'
import { summarizeFeed, rollFeed } from '../api/llm'
import { DigestEngine } from './digestEngine.svelte'

const OPTS = { provider: 'ollama' as const, model: 'm', ollamaUrl: 'http://x' }

// Encode a "topic" into a one-hot unit vector by the text's leading tag.
function vecFor(text: string): number[] {
  const axis = text.startsWith('ice') ? 0 : text.startsWith('tech') ? 1 : 2
  const v = [0, 0, 0]
  v[axis] = 1
  return v
}
function post(uri: string, text: string) {
  return mkPost({ uri, text, createdAt: new Date().toISOString() })
}

beforeEach(() => {
  vi.mocked(embedTexts).mockImplementation(async (texts: string[]) => texts.map(vecFor))
})
afterEach(() => vi.clearAllMocks())

describe('DigestEngine', () => {
  it('establishes clusters on the first batch (no clusters yet)', async () => {
    vi.mocked(summarizeFeed).mockResolvedValue({
      conversations: [{ id: 'ice', label: 'ICE', summary: '', status: 'steady', postUris: ['at://ice/1', 'at://ice/2'] }],
    })
    const e = new DigestEngine()
    await e.ingest([post('at://ice/1', 'ice one'), post('at://ice/2', 'ice two')], OPTS)
    expect(summarizeFeed).toHaveBeenCalledOnce()
    expect(e.clusters.map((c) => c.label)).toEqual(['ICE'])
  })

  it('SKIPS the LLM and buffers when the batch is near existing clusters', async () => {
    vi.mocked(summarizeFeed).mockResolvedValue({
      conversations: [{ id: 'ice', label: 'ICE', summary: '', status: 'steady', postUris: ['at://ice/1', 'at://ice/2'] }],
    })
    const e = new DigestEngine()
    await e.ingest([post('at://ice/1', 'ice one'), post('at://ice/2', 'ice two')], OPTS)
    // More ice posts — same topic vector as the centroid → not novel → skip.
    await e.ingest([post('at://ice/3', 'ice three'), post('at://ice/4', 'ice four')], OPTS)
    expect(rollFeed).not.toHaveBeenCalled()
    expect(e.phase).toBe('skipped')
    expect(e.bufferedCount).toBe(2)
    expect(e.lastGate?.shouldRoll).toBe(false)
  })

  it('ROLLS when the batch is genuinely novel, adding a new cluster', async () => {
    vi.mocked(summarizeFeed).mockResolvedValue({
      conversations: [{ id: 'ice', label: 'ICE', summary: '', status: 'steady', postUris: ['at://ice/1', 'at://ice/2'] }],
    })
    vi.mocked(rollFeed).mockResolvedValue([{ label: 'Tech', isNew: true, uris: ['at://tech/1', 'at://tech/2'] }])
    const e = new DigestEngine()
    await e.ingest([post('at://ice/1', 'ice one'), post('at://ice/2', 'ice two')], OPTS)
    // Tech posts — orthogonal vector, far from the ICE centroid → novel → roll.
    await e.ingest([post('at://tech/1', 'tech one'), post('at://tech/2', 'tech two')], OPTS)
    expect(rollFeed).toHaveBeenCalledOnce()
    expect(e.lastGate?.shouldRoll).toBe(true)
    expect(e.clusters.map((c) => c.label).sort()).toEqual(['ICE', 'Tech'])
  })

  it('DEDUPS a "new" cluster whose centroid matches an existing one', async () => {
    vi.mocked(summarizeFeed).mockResolvedValue({
      conversations: [{ id: 'ice', label: 'ICE', summary: '', status: 'steady', postUris: ['at://ice/1', 'at://ice/2'] }],
    })
    // The roll returns a differently-labelled cluster made of more ICE-topic
    // posts (same vector as the ICE centroid) → should merge, not duplicate.
    vi.mocked(rollFeed).mockResolvedValue([{ label: 'ICE Crackdown', isNew: true, uris: ['at://ice/3', 'at://ice/4'] }])
    const e = new DigestEngine()
    await e.ingest([post('at://ice/1', 'ice one'), post('at://ice/2', 'ice two')], OPTS)
    // Batch with enough novel (tech) posts to force a roll, plus the ice/3,4
    // posts the roll will reference (so they're embedded, near the ICE centroid).
    await e.ingest(
      [
        post('at://tech/1', 'tech one'),
        post('at://tech/2', 'tech two'),
        post('at://ice/3', 'ice three'),
        post('at://ice/4', 'ice four'),
      ],
      OPTS,
    )
    expect(e.clusters.map((c) => c.label)).toEqual(['ICE']) // merged, not a 2nd cluster
    expect(e.clusters[0].uris).toEqual(expect.arrayContaining(['at://ice/1', 'at://ice/3', 'at://ice/4']))
  })

  it('does not re-ingest posts it has already seen', async () => {
    vi.mocked(summarizeFeed).mockResolvedValue({
      conversations: [{ id: 'ice', label: 'ICE', summary: '', status: 'steady', postUris: ['at://ice/1'] }],
    })
    const e = new DigestEngine()
    await e.ingest([post('at://ice/1', 'ice one')], OPTS)
    await e.ingest([post('at://ice/1', 'ice one')], OPTS) // same uri → ignored
    expect(embedTexts).toHaveBeenCalledOnce()
  })

  it('re-ingests posts after an LLM failure instead of dropping them', async () => {
    // First establish throws — the posts must NOT be marked seen, or they'd be
    // permanently excluded from the digest even though the feed moved on.
    vi.mocked(summarizeFeed).mockRejectedValueOnce(new Error('ollama down'))
    const e = new DigestEngine()
    await e.ingest([post('at://ice/1', 'ice one'), post('at://ice/2', 'ice two')], OPTS)
    expect(e.phase).toBe('error')
    expect(e.clusters).toHaveLength(0)
    // Retry: the same posts are re-embedded and this time establish succeeds.
    vi.mocked(summarizeFeed).mockResolvedValueOnce({
      conversations: [{ id: 'ice', label: 'ICE', summary: '', status: 'steady', postUris: ['at://ice/1', 'at://ice/2'] }],
    })
    await e.ingest([post('at://ice/1', 'ice one'), post('at://ice/2', 'ice two')], OPTS)
    expect(e.clusters.map((c) => c.label)).toEqual(['ICE'])
  })

  it('gives colliding-slug labels distinct cluster ids', async () => {
    // "AI!" and "AI?" both slug to "ai" — the ids must not collide (breaks keyed
    // {#each}). Both are ICE-topic vectors here; distinct labels, same slug.
    vi.mocked(summarizeFeed).mockResolvedValue({
      conversations: [
        { id: 'ai', label: 'AI!', summary: '', status: 'steady', postUris: ['at://ice/1'] },
        { id: 'ai', label: 'AI?', summary: '', status: 'steady', postUris: ['at://ice/2'] },
      ],
    })
    const e = new DigestEngine()
    await e.ingest([post('at://ice/1', 'ice one'), post('at://ice/2', 'ice two')], OPTS)
    const ids = e.clusters.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length) // all unique
  })
})
