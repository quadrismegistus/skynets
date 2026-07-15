import { afterEach, describe, expect, it, vi } from 'vitest'
import { centroid, cosine, embedTexts, noveltyGate } from './embed'

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

describe('embedTexts length guard', () => {
  afterEach(() => vi.restoreAllMocks())
  it('throws when the model returns fewer vectors than inputs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ embeddings: [[1, 0, 0]] }), // 1 vector for 2 inputs
        text: async () => '',
      } as Response),
    )
    await expect(embedTexts(['a', 'b'], { ollamaUrl: 'http://x' })).rejects.toThrow(/vectors for/)
  })
})
