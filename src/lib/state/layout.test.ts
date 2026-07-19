import { describe, expect, it } from 'vitest'
import { Layout, type Target } from './layout'

/**
 * The layout engine had no tests at all, which is how a run of defects reached
 * a pull request: a clamp whose arithmetic cancelled itself out so the
 * reservoir never existed, a bleed that had no effect on the vertical axis, and
 * group passes that undid each other. Every case here is one of those, written
 * so the next one fails a test instead of a screenshot.
 *
 * The solver is synchronous — update() returns with positions final — so
 * there are no settle loops and no fake clocks. What the tests see is exactly
 * what the app paints.
 */

const PILL = { hw: 106, hh: 28 }
const GAP = { x: 34, y: 32 }
const W = 1200
const H = 800

function node(id: string, tx: number, ty: number, group?: string): Target {
  return { id, tx, ty, r: 33, ...PILL, group }
}

/** A layout with pill-shaped nodes and a reservoir, as pill mode configures it. */
function pillLayout(bleedX = 170, bleedY = 62) {
  const l = new Layout(() => {})
  l.setCollision(GAP)
  l.setBounds(W, H, 18, 52, bleedX, bleedY)
  return l
}

const at = (l: Layout, id: string) => l.positions().get(id)!

describe('collision', () => {
  it('separates pills by the configured gap rather than a circle around them', () => {
    // A circle circumscribing a 212x56 pill reserves about four times the area
    // the pill occupies, which read as a scatter of islands.
    const l = pillLayout()
    l.update([node('a', 600, 400), node('b', 640, 410)])
    const a = at(l, 'a')
    const b = at(l, 'b')
    const gapX = Math.abs(a.x - b.x) - 2 * PILL.hw
    const gapY = Math.abs(a.y - b.y) - 2 * PILL.hh
    // Resolved on one axis or the other, never overlapping on both.
    expect(gapX >= -1 || gapY >= -1).toBe(true)
  })

  it('does not let the final clamp stack pills it just separated', () => {
    // The pipeline once ran relax→clamp for a FIXED two rounds. The last
    // clamp pulled every straddling pill onto the same resting line — six
    // fully visible overlapping pairs at 25 nodes of ordinary density, up to
    // 56px of interpenetration — and nothing ran after it. The solve now
    // iterates relax↔clamp to a fixed point, benching groups the frame has
    // no room for. The invariant is scoped to what the reader can see: no
    // overlap involving a VISIBLE pill. Hidden pills compressed together at
    // the reservoir's world floor are invisible, and re-solve on entry.
    const l = pillLayout()
    l.update(Array.from({ length: 25 }, (_, i) => node(`m${i}`, 400 + i * 30, 300 + i * 15)))
    const ids = Array.from({ length: 25 }, (_, i) => `m${i}`)
    const visible = (p: { x: number; y: number }) =>
      p.x + PILL.hw > 0 && p.x - PILL.hw < W && p.y + PILL.hh > 0 && p.y - PILL.hh < H
    expect(ids.map((id) => at(l, id)).filter(visible).length).toBeGreaterThan(10)
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = at(l, ids[i])
        const b = at(l, ids[j])
        if (!visible(a) && !visible(b)) continue
        const gapX = Math.abs(a.x - b.x) - 2 * PILL.hw
        const gapY = Math.abs(a.y - b.y) - 2 * PILL.hh
        expect(gapX >= -1 || gapY >= -1).toBe(true)
      }
    }
  })

  it('escapes the trap between two pinned pills instead of ping-ponging', () => {
    // A free pill ranked between two pinned ones oscillated for the whole
    // relaxation budget: each neighbour pushed it fully back across the
    // other, and the least-penetration rule kept choosing the one axis that
    // cannot be satisfied. On a stall the solver now resolves along the other
    // axis — the row-change escape — and the pill settles clear of both.
    const l = pillLayout()
    l.update([node('A', 400, 400), node('C', 850, 400)])
    l.update([node('A', 400, 400), node('C', 850, 400), node('B', 625, 400)], new Set(['A', 'C']))
    const b = at(l, 'B')
    for (const id of ['A', 'C']) {
      const p = at(l, id)
      const gapX = Math.abs(p.x - b.x) - 2 * PILL.hw
      const gapY = Math.abs(p.y - b.y) - 2 * PILL.hh
      expect(gapX >= -1 || gapY >= -1).toBe(true)
    }
  })

  it('contains a non-finite target instead of letting NaN spread to every node', () => {
    // NaN defeats each comparison on its way to the y-push, so one bad
    // coordinate poisoned the y of the entire graph.
    const l = pillLayout()
    l.update([node('bad', 620, Number.NaN), node('ok1', 600, 400), node('ok2', 700, 500)])
    for (const id of ['bad', 'ok1', 'ok2']) {
      expect(Number.isFinite(at(l, id).x)).toBe(true)
      expect(Number.isFinite(at(l, id).y)).toBe(true)
    }
  })

  it('resolves a dense cluster within the iteration budget', () => {
    // Eight pills seeded almost on top of each other: the relaxation has to
    // propagate corrections through chains of neighbours, which is what the
    // fixed-point iteration exists for. Every pair must end clear on at least
    // one axis.
    const l = pillLayout()
    l.update(Array.from({ length: 8 }, (_, i) => node(`n${i}`, 600 + i * 5, 400 + i * 3)))
    const ids = Array.from({ length: 8 }, (_, i) => `n${i}`)
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = at(l, ids[i])
        const b = at(l, ids[j])
        const gapX = Math.abs(a.x - b.x) - 2 * PILL.hw
        const gapY = Math.abs(a.y - b.y) - 2 * PILL.hh
        expect(gapX >= -1 || gapY >= -1).toBe(true)
      }
    }
  })
})

describe('the reservoir', () => {
  it('lets a node park with its CENTRE beyond the frame', () => {
    // The first version clamped to `hw + edge - bleedX`. With bleedX == hw that
    // cancels to a positive inset, so every centre stayed inside the frame and
    // the reservoir silently did not exist. Nothing about the graph looked
    // wrong; there was simply never anything parked.
    const l = pillLayout()
    l.update([node('far', -160, 400)])
    expect(at(l, 'far').x).toBeLessThan(0)
  })

  it('applies a vertical bleed at all', () => {
    // bleedY was a no-op for the same reason, one axis over: the range it
    // allowed sat entirely inside the band the edge resolution then rewrote.
    const shallow = pillLayout(170, 0)
    shallow.update([node('n', 600, -400)])
    const withoutBleed = at(shallow, 'n').y

    const deep = pillLayout(170, 400)
    deep.update([node('n', 600, -400)])
    expect(at(deep, 'n').y).toBeLessThan(withoutBleed)
  })
})

describe('the frame edge', () => {
  it('never leaves a node sliced by it', () => {
    const l = pillLayout()
    // Straddling the right edge: half in, half out.
    l.update([node('n', W - 10, 400)])
    const { x } = at(l, 'n')
    const wholly = x + PILL.hw <= W + 1 || x - PILL.hw >= W - 1
    expect(wholly).toBe(true)
  })

  it('keeps a node clear of the bottom chrome', () => {
    // `bottom` was passed to setBounds and then ignored: the edge resolution
    // used 0 and h, so the last stripe of a bottom-row pill came to rest behind
    // the Digest bar.
    const l = pillLayout()
    l.update([node('n', 600, H)])
    const { y } = at(l, 'n')
    const insideVisible = y + PILL.hh <= H - 52 + 1
    const parkedBelow = y - PILL.hh >= H - 52 - 1
    expect(insideVisible || parkedBelow).toBe(true)
  })

  it('never parks a conversation straddling the WINDOW bottom', () => {
    // Found live: a reply tree pushed "out" past the content edge (H - the
    // chrome keep-out) came to rest in the visible margin band with its body
    // run off the bottom of the screen — out of the layout's frame, sliced on
    // the reader's. Out has to mean past the window edge, not past the chrome.
    const l = pillLayout()
    l.update([node('g-a', 600, 810, 'g'), node('g-b', 600, 890, 'g')])
    const ys = ['g-a', 'g-b'].map((id) => at(l, id).y)
    const allClearOfChrome = ys.every((y) => y + PILL.hh <= H - 52 + 1)
    const allOffWindow = ys.every((y) => y - PILL.hh >= H - 1)
    expect(allClearOfChrome || allOffWindow).toBe(true)
  })

  it('leaves a node alone on a canvas too narrow to satisfy both edges', () => {
    // Below 2x the half-extent the two resolutions contradict; resolving anyway
    // pushed a node off the left edge in order to clear the right.
    const narrow = new Layout(() => {})
    narrow.setCollision(GAP)
    narrow.setBounds(250, H, 18, 52, 170, 62)
    narrow.update([node('n', 125, 400)])
    expect(Number.isFinite(at(narrow, 'n').x)).toBe(true)
  })
})

describe('conversations move as one', () => {
  // Siblings 260px apart: clear of the 246px minimum separation (two half-
  // widths plus the gap), so collision has nothing to correct and the shape
  // assertions can be exact.
  const tree = (group: string, x: number, y: number): Target[] => [
    node(`${group}-root`, x, y, group),
    node(`${group}-a`, x - 130, y + 90, group),
    node(`${group}-b`, x + 130, y + 90, group),
  ]

  it('keeps a parked tree in shape instead of squashing it flat', () => {
    // Clamping members independently collapsed a parked thread onto a single
    // coordinate: the rows all landed on the same pixel, destroying the tidy
    // shape the group passes exist to preserve.
    const l = pillLayout()
    l.update(tree('t', 600, -500))
    const ys = ['t-root', 't-a', 't-b'].map((id) => at(l, id).y)
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(40)
  })

  it('does not split a conversation across the frame edge', () => {
    const l = pillLayout()
    l.update(tree('t', W - 40, 400))
    const xs = ['t-root', 't-a', 't-b'].map((id) => at(l, id).x)
    const allIn = xs.every((x) => x + PILL.hw <= W + 1)
    const allOut = xs.every((x) => x - PILL.hw >= W - 1)
    expect(allIn || allOut).toBe(true)
  })

  it('preserves the tree shape while resolving the edge', () => {
    // The simulation-era code unstraddled each member's target independently,
    // which sent members on either side of the edge to OPPOSITE sides — the
    // tree survived as "all in or all out" only because the group pass then
    // dragged the strays back, with the internal geometry mangled. The solver
    // resolves grouped targets only as a group, so relative positions survive.
    const l = pillLayout()
    l.update(tree('t', W - 40, 400))
    const root = at(l, 't-root')
    const a = at(l, 't-a')
    const b = at(l, 't-b')
    expect(a.x - root.x).toBeCloseTo(-130, 0)
    expect(b.x - root.x).toBeCloseTo(130, 0)
    expect(a.y - root.y).toBeCloseTo(90, 0)
  })

  it('holds two conversations apart', () => {
    const l = pillLayout()
    l.update([...tree('a', 560, 400), ...tree('b', 640, 420)])
    const box = (g: string) => {
      const xs = [`${g}-root`, `${g}-a`, `${g}-b`].map((id) => at(l, id))
      return {
        l: Math.min(...xs.map((p) => p.x)) - PILL.hw,
        r: Math.max(...xs.map((p) => p.x)) + PILL.hw,
        t: Math.min(...xs.map((p) => p.y)) - PILL.hh,
        b: Math.max(...xs.map((p) => p.y)) + PILL.hh,
      }
    }
    const A = box('a')
    const B = box('b')
    const overlapX = Math.min(A.r, B.r) - Math.max(A.l, B.l)
    const overlapY = Math.min(A.b, B.b) - Math.max(A.t, B.t)
    expect(overlapX <= 1 || overlapY <= 1).toBe(true)
  })
})

describe('determinism', () => {
  const tree = (group: string, x: number, y: number): Target[] => [
    node(`${group}-root`, x, y, group),
    node(`${group}-a`, x - 120, y + 90, group),
    node(`${group}-b`, x + 120, y + 90, group),
  ]
  const targets = [...tree('a', 560, 400), ...tree('b', 640, 420)]

  it('solves to the same place from the same targets, in a fresh instance', () => {
    // The simulation-era passes once measured where nodes had DRIFTED, so the
    // result depended on history: separation found nothing to do, the target
    // pull dragged the groups back together, and the next arrival shoved them
    // apart again.
    const first = pillLayout()
    first.update(targets)
    const second = pillLayout()
    second.update(targets)
    for (const id of ['a-root', 'b-root']) {
      expect(at(second, id).x).toBe(at(first, id).x)
      expect(at(second, id).y).toBe(at(first, id).y)
    }
  })

  it('is idempotent: re-solving the same targets moves nothing', () => {
    // Free nodes carry no history between updates. If they did, every poll
    // cycle would jostle the layout even with nothing changed — which is
    // exactly the "friction with new posts" the solver exists to remove.
    const l = pillLayout()
    l.update(targets)
    const before = new Map([...l.positions()].map(([id, p]) => [id, { ...p }]))
    l.update(targets)
    for (const [id, p] of l.positions()) {
      expect(p.x).toBe(before.get(id)!.x)
      expect(p.y).toBe(before.get(id)!.y)
    }
  })
})

describe('holding nodes in place', () => {
  it('keeps a dragged node where the clamp put it, not where the pointer went', () => {
    const l = pillLayout()
    l.update([node('n', 600, 400)])
    l.dragTo('n', 600, H + 500) // far below the canvas
    const held = at(l, 'n')
    // The world floor wins over the pointer: the node comes to rest at the
    // bottom of the reservoir — its centre no deeper than the window edge (H)
    // plus the bleed (62) — not at y=1300.
    expect(held.y).toBeLessThanOrEqual(H + 62 + 1)
    // A data update mid-drag (live poll) must not snatch the node back.
    l.update([node('n', 600, 400)])
    expect(at(l, 'n').y).toBeCloseTo(held.y, 0)
  })

  it('leaves a released node at its drop point until the next update moves on', () => {
    // Releasing does NOT re-solve: the simulation's near-cold alpha left a
    // dropped node in place, and re-solving on release sent it home in the
    // ~200ms between a drop and the pin click that follows it.
    const l = pillLayout()
    l.update([node('n', 600, 400)])
    l.dragTo('n', 300, 200)
    l.dragEnd('n')
    expect(at(l, 'n').x).toBeCloseTo(300, 0)
    // The next data update returns an unpinned node to its semantic spot...
    l.update([node('n', 600, 400)])
    expect(at(l, 'n').x).toBeCloseTo(600, 0)
    expect(at(l, 'n').y).toBeCloseTo(400, 0)
  })

  it('lets a pin arriving after the drop capture the DROP point', () => {
    // The user drags a node somewhere, releases, and clicks to pin it there.
    // The pin lands in a later update; it must freeze the drop position, not
    // the semantic target the node would otherwise return to.
    const l = pillLayout()
    l.update([node('n', 600, 400)])
    l.dragTo('n', 300, 200)
    l.dragEnd('n')
    l.update([node('n', 600, 400)], new Set(['n']))
    expect(at(l, 'n').x).toBeCloseTo(300, 0)
    expect(at(l, 'n').y).toBeCloseTo(200, 0)
  })

  it('arranges a conversation around its pinned member, not at its semantic spot', () => {
    // Revealing a topic pill pins it where it was clicked, then hands the
    // solver tidy-tree targets at the conversation's SEMANTIC position —
    // which can be the far side of the canvas. Unanchored, the pinned root
    // stayed put while its children seeded away at those targets: a tree
    // stretched corner to corner, edges running across the whole graph.
    const l = pillLayout()
    l.update([node('root', 400, 300)]) // where the user clicked it
    l.update(
      [node('root', 900, 400, 'g'), node('kid-a', 770, 490, 'g'), node('kid-b', 1030, 490, 'g')],
      new Set(['root']),
    )
    const root = at(l, 'root')
    expect(root.x).toBe(400) // the pin held
    for (const id of ['kid-a', 'kid-b']) {
      const kid = at(l, id)
      // Children appear beside the pin (tree spacing), not 700px away at the
      // semantic target.
      expect(Math.hypot(kid.x - root.x, kid.y - root.y)).toBeLessThan(300)
    }
  })

  it('holds a pinned node against target changes, and neighbours flow around it', () => {
    const l = pillLayout()
    l.update([node('n', 600, 400)])
    // Re-ranked target, but the node is pinned: it stays put...
    l.update([node('n', 200, 300), node('m', 600, 400)], new Set(['n']))
    const n = at(l, 'n')
    expect(n.x).toBe(600)
    expect(n.y).toBe(400)
    // ...and the newcomer targeting the same spot resolves AROUND it.
    const m = at(l, 'm')
    const gapX = Math.abs(n.x - m.x) - 2 * PILL.hw
    const gapY = Math.abs(n.y - m.y) - 2 * PILL.hh
    expect(gapX >= -1 || gapY >= -1).toBe(true)
  })
})

describe('held conversations', () => {
  const tree = (group: string, x: number, y: number): Target[] => [
    node(`${group}-root`, x, y, group),
    node(`${group}-a`, x - 130, y + 90, group),
    node(`${group}-b`, x + 130, y + 90, group),
  ]

  it('never lets a neighbouring conversation displace a held one', () => {
    // Mutation testing found nothing guarded #separateGroups' held-group
    // routing: with the check deleted, a free tree landing on a pinned one
    // shoved the node the user was holding. The held tree must not move; the
    // free one resolves around it.
    const l = pillLayout()
    l.update(tree('g', 500, 400))
    l.update([...tree('g', 500, 400), ...tree('f', 520, 410)], new Set(['g-root']))
    expect(at(l, 'g-root').x).toBe(500)
    expect(at(l, 'g-root').y).toBe(400)
    const box = (g: string) => {
      const ps = [`${g}-root`, `${g}-a`, `${g}-b`].map((id) => at(l, id))
      return {
        l: Math.min(...ps.map((p) => p.x)) - PILL.hw,
        r: Math.max(...ps.map((p) => p.x)) + PILL.hw,
        t: Math.min(...ps.map((p) => p.y)) - PILL.hh,
        b: Math.max(...ps.map((p) => p.y)) + PILL.hh,
      }
    }
    const G = box('g')
    const F = box('f')
    const overlapX = Math.min(G.r, F.r) - Math.max(G.l, F.l)
    const overlapY = Math.min(G.b, F.b) - Math.max(G.t, F.t)
    expect(overlapX <= 1 || overlapY <= 1).toBe(true)
  })
})

describe('circles, when no gap is configured', () => {
  it('clamps every node fully inside the frame', () => {
    const l = new Layout(() => {})
    l.setCollision(null)
    l.setBounds(W, H, 18, 52)
    l.update([{ id: 'a', tx: -500, ty: -500, r: 33 }])
    const { x, y } = at(l, 'a')
    expect(x).toBeGreaterThanOrEqual(33)
    expect(y).toBeGreaterThanOrEqual(18)
  })

  it('separates overlapping avatars radially', () => {
    const l = new Layout(() => {})
    l.setCollision(null)
    l.setBounds(W, H, 18, 52)
    l.update([
      { id: 'a', tx: 600, ty: 400, r: 30 },
      { id: 'b', tx: 610, ty: 400, r: 30 },
    ])
    const a = at(l, 'a')
    const b = at(l, 'b')
    // r + 9 of breathing room each, as the old forceCollide gave.
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(30 + 30 + 18 - 1)
  })
})
