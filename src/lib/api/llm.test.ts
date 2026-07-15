import { afterEach, describe, expect, it, vi } from 'vitest'
import { summarizeFeed, exemplars, contextFor, extractJson, type Conversation } from './llm'
import { mkPost } from '../testing'

describe('extractJson', () => {
  it('parses clean JSON', () => {
    expect(extractJson('{"clusters":[]}')).toEqual({ clusters: [] })
  })
  it('strips a ```json fence', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })
  it('skips prose braces and finds the real JSON that follows', () => {
    // The first `{` is prose; the real object comes later — must not fail on it.
    expect(extractJson('Sure, {here} is the breakdown: {"clusters":[1,2]}')).toEqual({
      clusters: [1, 2],
    })
  })
  it('accepts a bare array (soft-schema MLX drops the wrapper)', () => {
    expect(extractJson('[{"label":"x"}]')).toEqual([{ label: 'x' }])
  })
  it('reports truncation when a bracket never closes', () => {
    expect(() => extractJson('{"clusters":[{"label":"x"')).toThrow(/cut off/)
  })
  it('throws when there is no JSON at all', () => {
    expect(() => extractJson('no json here')).toThrow(/No JSON/)
  })
})

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

  it('inlines a quoted post so the classifier sees what a quote-post is about', async () => {
    const a = mkPost({ uri: 'at://real/1', text: 'this 👇', author: 'quoter.test' })
    // Attach a quote embed (a viewRecord of another post).
    ;(a.post as unknown as { embed: unknown }).embed = {
      $type: 'app.bsky.embed.record#view',
      record: {
        $type: 'app.bsky.embed.record#viewRecord',
        uri: 'at://quoted/1',
        cid: 'cid-q',
        author: { did: 'did:plc:bob', handle: 'bob.test' },
        value: { $type: 'app.bsky.feed.post', text: 'the original insight', createdAt: '2026-07-12T12:00:00.000Z' },
        indexedAt: '2026-07-12T12:00:00.000Z',
      },
    }
    const fetchMock = vi.fn().mockResolvedValue(
      apiResponse({ conversations: [{ id: 'c', label: 'L', summary: 's', status: 'steady', postIds: [0] }] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await summarizeFeed([a], { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'm' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    const content = body.messages[0].content as string
    expect(content).toContain('quoting @bob.test')
    expect(content).toContain('the original insight')
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

  it('derives status from recency when the model gives an invalid one', async () => {
    const a = mkPost({ uri: 'at://real/1', createdAt: new Date().toISOString() })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        apiResponse({
          conversations: [{ id: 'c', label: 'L', summary: 's', status: 'nonsense', postIds: [0] }],
        }),
      ),
    )
    const digest = await summarizeFeed([a], { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'm' })
    // 'nonsense' isn't a valid status, so it's derived — a fresh post is heating.
    expect(digest.conversations[0].status).toBe('heating')
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

  it('maps the lean {clusters:[{label,postIds}]} shape and derives status/id', async () => {
    const a = mkPost({ uri: 'at://real/1', text: 'one', createdAt: new Date().toISOString() })
    const b = mkPost({ uri: 'at://real/2', text: 'two', createdAt: new Date().toISOString() })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        message: { content: JSON.stringify({ clusters: [{ label: 'Big News', postIds: [0, 1] }] }) },
      }),
      text: async () => '',
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const digest = await summarizeFeed([a, b], {
      provider: 'ollama',
      model: 'qwen3.5:4b-mlx',
      ollamaUrl: 'http://localhost:11434/',
    })
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:11434/api/chat', expect.anything())
    // Lean schema (clusters/label/postIds), think off, scaled context.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.think).toBe(false)
    expect(body.options.num_ctx).toBeGreaterThan(2048)
    expect(body.format.properties.clusters.items.required).toEqual(['label', 'postIds'])
    const c = digest.conversations[0]
    expect(c.postUris).toEqual(['at://real/1', 'at://real/2'])
    expect(c.id).toBe('big-news') // slug derived from label
    expect(c.status).toBe('heating') // derived: fresh posts
  })

  it('derives cooling status for a cluster of old posts', async () => {
    const old = new Date(Date.now() - 24 * 3_600_000).toISOString()
    const a = mkPost({ uri: 'at://old/1', createdAt: old })
    const b = mkPost({ uri: 'at://old/2', createdAt: old })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ message: { content: JSON.stringify({ clusters: [{ label: 'Old', postIds: [0, 1] }] }) } }),
        text: async () => '',
      } as Response),
    )
    const digest = await summarizeFeed([a, b], { provider: 'ollama', model: 'm', ollamaUrl: 'http://x' })
    expect(digest.conversations[0].status).toBe('cooling')
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

  it('inlines a reply parent text into the prompt (classifier context)', async () => {
    const parent = mkPost({ uri: 'at://p/parent', author: 'alice.test', text: 'the original claim' })
    const reply = mkPost({ uri: 'at://p/reply', text: 'exactly this', parent: 'at://p/parent', root: 'at://p/parent' })
    const fetchMock = vi.fn().mockResolvedValue(ollamaResp('{"clusters":[]}'))
    vi.stubGlobal('fetch', fetchMock)
    await summarizeFeed([reply], {
      provider: 'ollama',
      model: 'm',
      ollamaUrl: 'http://x',
      postByUri: new Map([['at://p/parent', parent]]),
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    const userMsg = body.messages.find((m: { role: string }) => m.role === 'user').content
    expect(userMsg).toContain('re @alice.test')
    expect(userMsg).toContain('the original claim') // parent text is present
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
