import { describe, expect, it } from 'vitest'
import { buildConversations, planView } from './conversations'
import { mkPost } from '../testing'

function ago(mins: number): string {
  return new Date(Date.parse('2026-07-16T12:00:00.000Z') - mins * 60_000).toISOString()
}

describe('author diversity: realistic scattershot (parents are context)', () => {
  it('diversity must key on who EARNED the seat, not the earliest member', () => {
    const items = []
    const primaryUris = new Set<string>()
    for (let i = 0; i < 30; i++) {
      // The human's OP: fetched as ancestor CONTEXT (not primary), older.
      items.push(mkPost({ uri: `at://other${i}/0`, text: 'human op', author: `person${i}.test`, createdAt: ago(300) }))
      // The bot's reply: the PRIMARY timeline post, fresh.
      const uri = `at://cat/${i}`
      items.push(mkPost({ uri, text: 'meow', author: 'cat.test', createdAt: ago(1), root: `at://other${i}/0`, parent: `at://other${i}/0` }))
      primaryUris.add(uri)
    }
    for (let i = 0; i < 10; i++) {
      const uri = `at://human/${i}`
      items.push(mkPost({ uri, text: `human ${i}`, author: `h${i}.test`, likes: 5, createdAt: ago(30) }))
      primaryUris.add(uri)
    }
    const convos = buildConversations(items, primaryUris)
    const catDominated = convos.filter((c) => c.dominantAuthor.includes('cat'))
    // Budget under contention: 10 human convos + the cat's 3-convo allowance
    // exactly fill it. The invariant: humans are NEVER displaced; the cat only
    // ever fills seats nobody else wanted (with spare budget, overflow cats
    // showing is fine — the sin was displacement, not existence).
    const plan = planView(convos.filter((c) => c.hasPrimary), { budget: 16, perAuthorMax: 3 })
    const shown = plan.filter((p) => p.level !== 'hidden')
    const shownCatNodes = shown.flatMap((p) => p.nodes).filter((n) => n.post.author.did.includes('cat'))
    const shownHumans = shown.filter((p) => p.convo.dominantAuthor.includes('h'))
    expect(catDominated.length).toBe(30) // diversity can SEE the cat…
    expect(shownHumans.length).toBe(10) // …every human keeps their seat…
    expect(shownCatNodes.length).toBeLessThanOrEqual(6) // …cat capped to its allowance
  })
})
