import { describe, expect, it } from 'vitest'
import { migrateV1, DEFAULTS } from './settings.svelte'

describe('settings migrateV1', () => {
  it('drops v1 fields equal to their OLD defaults (auto-persisted, not chosen)', () => {
    // A typical v1 blob: every field written wholesale with the old defaults.
    const p = migrateV1({
      nodeLimit: 20,
      selectMode: 'mix',
      autoCycle: false,
      cycleInterval: 4,
      livePoll: true,
      connectReplies: true,
      replyChains: false,
      cohesion: 0,
      curvedEdges: true,
      showReposts: true,
      followsOnly: false,
      debugMode: false,
    })
    expect(p).toEqual({}) // nothing survives → today's defaults apply
  })

  it('keeps v1 values the user genuinely changed', () => {
    const p = migrateV1({
      nodeLimit: 35, // user-tuned
      curvedEdges: true, // old default — dropped
      replyChains: true, // user turned ON (old default off) — kept
      followsOnly: true, // user changed — kept
    })
    expect(p).toEqual({ nodeLimit: 35, replyChains: true, followsOnly: true })
  })

  it('leaves v2 blobs alone', () => {
    const p = migrateV1({ v: 2, curvedEdges: false, replyChains: false })
    expect(p).toEqual({ v: 2, curvedEdges: false, replyChains: false })
  })

  it('new defaults are what we shipped: chains on, curves off', () => {
    expect(DEFAULTS.replyChains).toBe(true)
    expect(DEFAULTS.curvedEdges).toBe(false)
  })
})
