import { afterEach, describe, expect, it, vi } from 'vitest'
import { summarizeFeed, exemplars, contextFor, type Conversation } from './llm'
import { mkPost } from '../testing'

function apiResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] }),
    text: async () => '',
  } as Response
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('summarizeFeed', () => {
  it('maps post indices back to URIs and drops out-of-range ones', async () => {
    const a = mkPost({ uri: 'at://real/1', text: 'one' })
    const b = mkPost({ uri: 'at://real/2', text: 'two' })
    const fetchMock = vi.fn().mockResolvedValue(
      apiResponse({
        conversations: [
          { id: 'c1', label: 'Topic', summary: 's', status: 'steady', postIds: [0, 99, 1] },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const digest = await summarizeFeed([a, b], { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'm' })
    expect(digest.conversations).toHaveLength(1)
    expect(digest.conversations[0].postUris).toEqual(['at://real/1', 'at://real/2'])
  })

  it('drops a conversation whose indices are all out of range', async () => {
    const a = mkPost({ uri: 'at://real/1' })
    const fetchMock = vi.fn().mockResolvedValue(
      apiResponse({
        conversations: [
          { id: 'ghost', label: 'Ghost', summary: 's', status: 'heating', postIds: [5] },
          { id: 'real', label: 'Real', summary: 's', status: 'steady', postIds: [0] },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const digest = await summarizeFeed([a], { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'm' })
    expect(digest.conversations.map((c) => c.id)).toEqual(['real'])
  })

  it('coerces an invalid status to steady', async () => {
    const a = mkPost({ uri: 'at://real/1' })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        apiResponse({
          conversations: [{ id: 'c', label: 'L', summary: 's', status: 'nonsense', postIds: [0] }],
        }),
      ),
    )
    const digest = await summarizeFeed([a], { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'm' })
    expect(digest.conversations[0].status).toBe('steady')
  })

  it('surfaces a clean error when the model response is truncated', async () => {
    const a = mkPost({ uri: 'at://real/1' })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ content: [{ type: 'text', text: '{"conversations":[{"id":"c","postIds":[0,1,' }] }),
        text: async () => '',
      } as Response),
    )
    await expect(summarizeFeed([a], { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'm' })).rejects.toThrow(/cut off/)
  })

  it('throws with the API status on a non-ok response', async () => {
    const a = mkPost({ uri: 'at://real/1' })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'bad key',
      } as Response),
    )
    await expect(summarizeFeed([a], { provider: 'anthropic', apiKey: 'bad', model: 'm' })).rejects.toThrow(/401/)
  })

  it('returns a demo digest (no network) when no key is given', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const posts = [mkPost({ text: 'a map of the graph layout' }), mkPost({ text: 'dismissing a thread' })]
    const digest = await summarizeFeed(posts, { provider: 'anthropic', apiKey: '', model: 'm' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(digest.conversations.length).toBeGreaterThan(0)
  })

  it('calls the Ollama endpoint and maps its schema-constrained JSON', async () => {
    const a = mkPost({ uri: 'at://real/1', text: 'one' })
    const b = mkPost({ uri: 'at://real/2', text: 'two' })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        message: {
          content: JSON.stringify({
            conversations: [{ id: 'c', label: 'L', summary: 's', status: 'steady', postIds: [0, 1] }],
          }),
        },
      }),
      text: async () => '',
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const digest = await summarizeFeed([a, b], {
      provider: 'ollama',
      model: 'llama3.1:8b',
      ollamaUrl: 'http://localhost:11434/',
    })
    // Hits Ollama's chat endpoint (trailing slash normalized), not Anthropic.
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:11434/api/chat', expect.anything())
    // Thinking is disabled (latency) and context is lifted past the 2048 default.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.think).toBe(false)
    expect(body.options.num_ctx).toBeGreaterThan(2048)
    expect(digest.conversations[0].postUris).toEqual(['at://real/1', 'at://real/2'])
  })

  function ollamaResp(content: string) {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ message: { content } }),
      text: async () => '',
    } as Response
  }

  it('tolerates a markdown-fenced object (soft MLX schema)', async () => {
    const a = mkPost({ uri: 'at://real/1' })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ollamaResp('```json\n{"conversations":[{"id":"c","label":"L","summary":"s","status":"steady","postIds":[0]}]}\n```'),
      ),
    )
    const d = await summarizeFeed([a], { provider: 'ollama', model: 'm', ollamaUrl: 'http://x' })
    expect(d.conversations[0].postUris).toEqual(['at://real/1'])
  })

  it('tolerates a bare array without the conversations wrapper', async () => {
    const a = mkPost({ uri: 'at://real/1' })
    const b = mkPost({ uri: 'at://real/2' })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ollamaResp('[{"id":"c","label":"L","summary":"s","status":"heating","postIds":[0,1]}]'),
      ),
    )
    const d = await summarizeFeed([a, b], { provider: 'ollama', model: 'm', ollamaUrl: 'http://x' })
    expect(d.conversations).toHaveLength(1)
    expect(d.conversations[0].postUris).toEqual(['at://real/1', 'at://real/2'])
  })

  it('ignores trailing prose after the JSON value', async () => {
    const a = mkPost({ uri: 'at://real/1' })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ollamaResp('{"conversations":[{"id":"c","label":"L","summary":"s","status":"steady","postIds":[0]}]}\n\nHope that helps!'),
      ),
    )
    const d = await summarizeFeed([a], { provider: 'ollama', model: 'm', ollamaUrl: 'http://x' })
    expect(d.conversations).toHaveLength(1)
  })

  it('surfaces a friendly error when Ollama is unreachable', async () => {
    const a = mkPost({ uri: 'at://real/1' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(
      summarizeFeed([a], { provider: 'ollama', model: 'llama3.1:8b', ollamaUrl: 'http://localhost:11434' }),
    ).rejects.toThrow(/Could not reach Ollama/)
  })
})

describe('contextFor', () => {
  it('floors at 8192 for a small prompt', () => {
    expect(contextFor('sys', 'a few short posts')).toBe(8192)
  })

  it('grows past the floor and caps at 32768 for a large feed', () => {
    const huge = 'x'.repeat(200_000) // ~50k tokens of posts
    expect(contextFor('sys', huge)).toBe(32768)
  })

  it('rounds a mid-size prompt up to a 4k step above the estimate', () => {
    const mid = 'y'.repeat(40_000) // ~10k prompt tokens + headroom
    const ctx = contextFor('sys', mid)
    expect(ctx).toBeGreaterThan(8192)
    expect(ctx % 4096).toBe(0)
    expect(ctx).toBeGreaterThanOrEqual(10_000 + 1536)
  })
})

describe('exemplars', () => {
  it('ranks members by engagement velocity, loudest first', () => {
    const quiet = mkPost({ uri: 'at://q', likes: 1, createdAt: '2026-07-12T12:00:00.000Z' })
    const loud = mkPost({ uri: 'at://l', likes: 500, reposts: 200, replies: 80, createdAt: '2026-07-12T12:00:00.000Z' })
    const byUri = new Map([
      ['at://q', quiet],
      ['at://l', loud],
    ])
    const convo: Conversation = { id: 'c', label: 'L', summary: '', status: 'steady', postUris: ['at://q', 'at://l'] }
    expect(exemplars(convo, byUri).map((i) => i.post.uri)).toEqual(['at://l', 'at://q'])
  })
})
