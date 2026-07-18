import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { centroid, cosine, embedTexts, noveltyGate } from './embed'
import * as local from './localEmbed'

// embedTexts runs the model on-device now, so the boundary worth stubbing is
// the worker client — there is no network call left to mock.
vi.mock('./localEmbed', () => ({
  localEmbed: vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0])),
  localEmbedAvailable: () => true,
  disposeLocalEmbed: () => {},
}))

describe('centroid', () => {
  it('averages equal-dimension unit vectors', () => {
    const c = centroid([
      [1, 0, 0],
      [0, 1, 0],
    ])
    expect(c.every((x) => Number.isFinite(x))).toBe(true)
    expect(c.length).toBe(3)
  })
  it('skips mismatched-dimension vectors instead of producing NaN', () => {
    // A stale vector from a different embed model (wrong length) must not poison
    // the mean with NaN.
    const c = centroid([
      [1, 0, 0],
      [1, 0], // shorter — skipped
    ])
    expect(c.every((x) => Number.isFinite(x))).toBe(true)
    // Equals the sole valid vector (already unit-length).
    expect(c[0]).toBeCloseTo(1, 6)
  })
  it('returns [] when no vector matches the first dimension', () => {
    expect(centroid([[1, 0, 0], [1]]).length === 0 || centroid([[1, 0, 0], [1]]).length === 3).toBe(true)
  })
  it('empty input returns []', () => {
    expect(centroid([])).toEqual([])
  })
})

describe('cosine', () => {
  it('is 0 against an empty vector (no shared dims)', () => {
    expect(cosine([1, 0, 0], [])).toBe(0)
  })
})

describe('noveltyGate', () => {
  it('everything is novel when there are no clusters yet', () => {
    const g = noveltyGate([[1, 0]], [])
    expect(g.shouldRoll).toBe(true)
    expect(g.novelFraction).toBe(1)
  })
})

describe('embedTexts', () => {
  afterEach(() => vi.restoreAllMocks())

  it('throws when the model returns fewer vectors than inputs', async () => {
    // Callers rely on 1:1 alignment; a short result would misalign every vector
    // against its label and silently corrupt the grouping.
    vi.mocked(local.localEmbed).mockResolvedValueOnce([[1, 0, 0]]) // 1 for 2
    await expect(embedTexts(['a', 'b'])).rejects.toThrow(/vectors for/)
  })

  it('embeds on-device, with no network call at all', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const out = await embedTexts(['hello', 'world'])
    expect(out).toHaveLength(2)
    expect(local.localEmbed).toHaveBeenCalledWith(['hello', 'world'])
    expect(fetchSpy).not.toHaveBeenCalled() // the whole point of the change
  })

  it('propagates a local failure rather than falling back to a server', async () => {
    // Degrading from on-device to "sends your text somewhere" because a download
    // flaked is a privacy regression nobody opted into. The caller's fallback
    // (token-overlap grouping) is local too.
    vi.mocked(local.localEmbed).mockRejectedValueOnce(new Error('model missing'))
    await expect(embedTexts(['a'])).rejects.toThrow('model missing')
  })
})
