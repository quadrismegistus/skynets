import { describe, it, expect } from 'vitest'
import { groupByLabel, groupByEmbedding } from './labelGroup'
import { norm } from './embed'
import { cleanLabel } from './llm'

describe('groupByLabel', () => {
  it('groups identical labels into one conversation', () => {
    const d = groupByLabel([
      { uri: 'a', label: 'Trump tariffs' },
      { uri: 'b', label: 'Trump tariffs' },
      { uri: 'c', label: 'MF DOOM demo' },
    ])
    expect(d.conversations).toHaveLength(2)
    const tariffs = d.conversations.find((c) => c.label === 'Trump tariffs')!
    expect(tariffs.postUris.sort()).toEqual(['a', 'b'])
  })

  it('merges related labels (subset / singular-plural) under one canonical', () => {
    const d = groupByLabel([
      { uri: 'a', label: 'Trump tariffs' },
      { uri: 'b', label: 'Trump tariff threats' },
      { uri: 'c', label: 'Tariffs' },
    ])
    expect(d.conversations).toHaveLength(1)
    // Canonical = most common wording; here all distinct, so shortest wins ties
    // among count-1 — but "Trump tariffs" and "Tariffs" and "Trump tariff
    // threats" are all count 1, shortest is "Tariffs".
    expect(d.conversations[0].postUris.sort()).toEqual(['a', 'b', 'c'])
  })

  it('keeps unrelated labels apart', () => {
    const d = groupByLabel([
      { uri: 'a', label: 'Climate policy' },
      { uri: 'b', label: 'Baseball trades' },
    ])
    expect(d.conversations).toHaveLength(2)
  })

  it('does not over-merge via an absorbing group vocabulary', () => {
    // "Trump tariffs" + "Trump Gaza aid" chain a group to {trump, tariff, gaza,
    // aid} if the vocabulary grows; a later "Gaza" must NOT then join the Trump
    // group. Groups match against their SEED tokens only.
    const d = groupByLabel([
      { uri: 'a', label: 'Trump tariffs' },
      { uri: 'b', label: 'Trump tariff hike' },
      { uri: 'c', label: 'Gaza ceasefire' },
      { uri: 'd', label: 'Gaza' },
    ])
    const trump = d.conversations.find((c) => c.postUris.includes('a'))!
    expect(trump.postUris).not.toContain('c')
    expect(trump.postUris).not.toContain('d')
    // "Gaza" joins the Gaza-ceasefire group (subset), not the Trump one.
    const gaza = d.conversations.find((c) => c.postUris.includes('c'))!
    expect(gaza.postUris.sort()).toEqual(['c', 'd'])
  })

  it('keeps singletons as one-post conversations', () => {
    const d = groupByLabel([{ uri: 'a', label: 'A lone thought' }])
    expect(d.conversations).toHaveLength(1)
    expect(d.conversations[0].postUris).toEqual(['a'])
  })

  it('picks the most common wording as canonical', () => {
    const d = groupByLabel([
      { uri: 'a', label: 'ICE raids' },
      { uri: 'b', label: 'ICE raids' },
      { uri: 'c', label: 'ICE raid Los Angeles' },
    ])
    expect(d.conversations).toHaveLength(1)
    expect(d.conversations[0].label).toBe('ICE raids')
  })

  it('drops empty labels', () => {
    const d = groupByLabel([
      { uri: 'a', label: '' },
      { uri: 'b', label: 'Real topic' },
    ])
    expect(d.conversations).toHaveLength(1)
    expect(d.conversations[0].postUris).toEqual(['b'])
  })
})

describe('groupByEmbedding', () => {
  // Hand-built unit vectors: A/A' are near each other, B is orthogonal.
  const vA = norm([1, 0.05, 0])
  const vA2 = norm([0.95, 0.1, 0]) // ~cos 0.99 with vA
  const vB = norm([0, 0, 1]) // orthogonal to both
  const vecs = new Map<string, number[]>([
    ['Gaza ceasefire', vA],
    ['Israel truce', vA2],
    ['Baseball trades', vB],
  ])

  it('merges labels whose embeddings are close, though they share no token', () => {
    const d = groupByEmbedding(
      [
        { uri: 'a', label: 'Gaza ceasefire' },
        { uri: 'b', label: 'Israel truce' },
        { uri: 'c', label: 'Baseball trades' },
      ],
      vecs,
      0.7,
    )
    expect(d.conversations).toHaveLength(2)
    const merged = d.conversations.find((c) => c.postUris.includes('a'))!
    expect(merged.postUris.sort()).toEqual(['a', 'b'])
  })

  it('keeps them apart when the threshold is above their similarity', () => {
    const d = groupByEmbedding(
      [
        { uri: 'a', label: 'Gaza ceasefire' },
        { uri: 'b', label: 'Israel truce' },
      ],
      vecs,
      0.999, // stricter than cos(vA, vA2)
    )
    expect(d.conversations).toHaveLength(2)
  })

  it('gives a label with no vector its own cluster', () => {
    const d = groupByEmbedding(
      [
        { uri: 'a', label: 'Gaza ceasefire' },
        { uri: 'b', label: 'Unknown topic' },
      ],
      vecs,
      0.5,
    )
    expect(d.conversations).toHaveLength(2)
  })

  it('picks the most common wording as canonical across merged labels', () => {
    const d = groupByEmbedding(
      [
        { uri: 'a', label: 'Israel truce' },
        { uri: 'b', label: 'Israel truce' },
        { uri: 'c', label: 'Gaza ceasefire' },
      ],
      vecs,
      0.7,
    )
    expect(d.conversations).toHaveLength(1)
    expect(d.conversations[0].label).toBe('Israel truce')
  })
})

describe('cleanLabel', () => {
  it('strips quotes, prefixes, and trailing punctuation', () => {
    expect(cleanLabel('"Trump tariffs"')).toBe('Trump tariffs')
    expect(cleanLabel('Label: ICE raids')).toBe('ICE raids')
    expect(cleanLabel('Topic: climate.')).toBe('Climate')
    expect(cleanLabel('**bold topic**')).toBe('Bold topic')
  })
  it('takes the first non-empty line and caps length', () => {
    expect(cleanLabel('\n\nFirst topic\nSecond line')).toBe('First topic')
    expect(cleanLabel('one two three four five six seven')).toBe('One two three four five')
  })
  it('sentence-cases the first letter but leaves the rest (acronyms/proper nouns)', () => {
    expect(cleanLabel('phonology')).toBe('Phonology')
    expect(cleanLabel('ICE raids')).toBe('ICE raids')
    expect(cleanLabel('MF DOOM demo')).toBe('MF DOOM demo')
    expect(cleanLabel('iOS 19')).toBe('iOS 19') // mixed-case first word left as-is
  })
})
