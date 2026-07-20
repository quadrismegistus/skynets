import { describe, expect, it } from 'vitest'
import { relationshipOf } from './follows.svelte'

describe('relationshipOf (#69 reactions panel buckets)', () => {
  it('classifies the 2×2 of follow directions into MECE buckets', () => {
    expect(relationshipOf(true, true)).toBe('mutual')
    expect(relationshipOf(true, false)).toBe('following') // one-way outbound
    expect(relationshipOf(false, true)).toBe('follower') // one-way inbound
    expect(relationshipOf(false, false)).toBe('neither') // a stranger you reacted to
  })

  it('a mutual is never mis-counted as following (order: mutual checked first)', () => {
    // Guards the tally: the panel counts `following` only via this helper, so a
    // both-directions author must land in mutual, not following.
    expect(relationshipOf(true, true)).not.toBe('following')
  })
})
