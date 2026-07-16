import { describe, expect, it } from 'vitest'
import { buildConversations, planView } from './conversations'
import { mkPost } from '../testing'

/** ISO timestamp `mins` minutes before a fixed reference (newer = larger). */
function ago(mins: number): string {
  return new Date(Date.parse('2026-07-16T12:00:00.000Z') - mins * 60_000).toISOString()
}

/** A reply item with declared root + parent refs. */
function mkReply(uri: string, opts: { root: string; parent: string; author?: string; likes?: number; minsAgo?: number }) {
  return mkPost({
    uri,
    text: `reply ${uri}`,
    author: opts.author,
    likes: opts.likes ?? 1,
    createdAt: ago(opts.minsAgo ?? 5),
    root: opts.root,
    parent: opts.parent,
  })
}

describe('buildConversations', () => {
  it('merges thread FRAGMENTS by declared root even with unloaded middles', () => {
    // Posts 2 and 40 of a mega-thread: parents unloaded, roots declared.
    const a = mkReply('at://t/2', { root: 'at://t/0', parent: 'at://t/1' })
    const b = mkReply('at://t/40', { root: 'at://t/0', parent: 'at://t/39' })
    const convos = buildConversations([a, b])
    expect(convos).toHaveLength(1)
    expect(convos[0].members).toHaveLength(2)
  })

  it('keeps unrelated conversations separate', () => {
    const a = mkPost({ uri: 'at://x/1', text: 'one' })
    const b = mkPost({ uri: 'at://y/1', text: 'two' })
    expect(buildConversations([a, b])).toHaveLength(2)
  })

  it('tracks the dominant author (the reply-flood signal)', () => {
    const items = [
      mkPost({ uri: 'at://t/0', text: 'op', author: 'op.bsky.social' }),
      mkReply('at://t/1', { root: 'at://t/0', parent: 'at://t/0', author: 'cat.bsky.social' }),
      mkReply('at://t/2', { root: 'at://t/0', parent: 'at://t/1', author: 'cat.bsky.social' }),
    ]
    const [c] = buildConversations(items)
    expect(c.dominantAuthor).toContain('cat')
  })
})

describe('planView', () => {
  it('a single-author mega-thread is a MONOLOGUE: one run, drawn whole, cost 1', () => {
    const mono = Array.from({ length: 60 }, (_, i) =>
      i === 0
        ? mkPost({ uri: 'at://mono/0', text: 'op', author: 'cat.bsky.social' })
        : mkReply(`at://mono/${i}`, { root: 'at://mono/0', parent: `at://mono/${i - 1}`, author: 'cat.bsky.social' }),
    )
    const [c] = buildConversations(mono)
    expect(c.displayCost).toBe(1)
    const [p] = planView([c], { budget: 5 })
    expect(p.level).toBe('full')
  })

  it('a multi-speaker mega-thread plans to its representative; small threads draw whole', () => {
    const mega = Array.from({ length: 60 }, (_, i) =>
      i === 0
        ? mkPost({ uri: 'at://mega/0', text: 'op', author: 'a0.test' })
        : mkReply(`at://mega/${i}`, { root: 'at://mega/0', parent: `at://mega/${i - 1}`, author: `a${i % 7}.test` }),
    )
    const small = [
      mkPost({ uri: 'at://s/0', text: 'op', likes: 50 }),
      mkReply('at://s/1', { root: 'at://s/0', parent: 'at://s/0' }),
    ]
    const plan = planView(buildConversations([...mega, ...small]), { budget: 20 })
    const megaPlan = plan.find((p) => p.convo.members.length === 60)!
    const smallPlan = plan.find((p) => p.convo.members.length === 2)!
    expect(megaPlan.level).toBe('rep')
    expect(megaPlan.nodes).toHaveLength(1)
    expect(smallPlan.level).toBe('full')
  })

  it('CAT FIX: one author scattering many separate conversations gets capped', () => {
    // The bot: 30 separate 2-post conversations, all fresher than everything else.
    const bot: ReturnType<typeof mkPost>[] = []
    for (let i = 0; i < 30; i++) {
      bot.push(mkPost({ uri: `at://other${i}/0`, text: 'someone', author: `person${i}.bsky.social`, createdAt: ago(200) }))
      bot.push(
        mkReply(`at://cat/${i}`, {
          root: `at://other${i}/0`,
          parent: `at://other${i}/0`,
          author: 'cat.bsky.social',
          minsAgo: 1,
        }),
      )
    }
    const others = Array.from({ length: 10 }, (_, i) =>
      mkPost({ uri: `at://human/${i}`, text: `human ${i}`, author: `human${i}.bsky.social`, likes: 5, createdAt: ago(30) }),
    )
    const plan = planView(buildConversations([...bot, ...others]), { budget: 30, perAuthorMax: 3 })
    const shown = plan.filter((p) => p.level !== 'hidden')
    const catConvos = shown.filter((p) => p.convo.dominantAuthor.includes('cat') && p.nodes.length > 0)
    const humanConvos = shown.filter((p) => p.convo.dominantAuthor.includes('human'))
    // The bot contributes at most its diversity allowance until humans are seated.
    expect(humanConvos.length).toBe(10) // every human conversation gets a slot
    expect(catConvos.length).toBeLessThanOrEqual(3 + Math.max(0, 30 - 10 - 3)) // allowance + leftovers only
    expect(catConvos.length).toBeLessThan(30)
  })

  it('budget bounds total planned nodes (manual maps excepted)', () => {
    const items = Array.from({ length: 50 }, (_, i) => mkPost({ uri: `at://p/${i}`, text: `${i}` }))
    const plan = planView(buildConversations(items), { budget: 12 })
    const drawn = plan.reduce((sum, p) => sum + p.nodes.length, 0)
    expect(drawn).toBeLessThanOrEqual(12)
    expect(plan.filter((p) => p.level === 'hidden').length).toBe(50 - 12)
  })

  it('manual maps always draw whole, outside the budget', () => {
    const mega = Array.from({ length: 20 }, (_, i) =>
      i === 0
        ? mkPost({ uri: 'at://m/0', text: 'op' })
        : mkReply(`at://m/${i}`, { root: 'at://m/0', parent: `at://m/${i - 1}` }),
    )
    const convos = buildConversations(mega)
    const plan = planView(convos, { budget: 5, forceFull: new Set([convos[0].id]) })
    expect(plan[0].level).toBe('full')
    expect(plan[0].nodes).toHaveLength(20)
  })
})
