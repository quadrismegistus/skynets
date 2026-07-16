import { describe, expect, it } from 'vitest'
import { mkPost } from '../testing'
import { postScoreRate } from './score'
import {
  buildGraph,
  layoutPositions,
  MAX_THREAD_REPLIES,
  selectVisible,
  threadDescendants,
  treeTargets,
  type GraphNode,
  type TreeLayoutBox,
  type TreeNode,
} from './graph'

const T = (min: number) => new Date(Date.parse('2026-07-12T12:00:00Z') + min * 60_000).toISOString()

describe('buildGraph', () => {
  it('dedupes by post uri', () => {
    const a = mkPost({ uri: 'at://x/1' })
    const dup = mkPost({ uri: 'at://x/1' })
    const b = mkPost({ uri: 'at://x/2' })
    expect(buildGraph([a, dup, b]).nodes).toHaveLength(2)
  })

  it('collapses a multi-post thread to one representative with a +N count', () => {
    const root = 'at://x/root'
    const items = [
      mkPost({ uri: root, likes: 30 }),
      mkPost({ uri: 'at://x/r1', parent: root, root, author: 'a-r1.test' }),
      mkPost({ uri: 'at://x/r2', parent: 'at://x/r1', root, author: 'a-r2.test' }),
    ]
    const { nodes, edges } = buildGraph(items)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].isThreadRoot).toBe(true)
    expect(nodes[0].collapsedCount).toBe(2)
    expect(edges).toHaveLength(0) // collapsed → no edges
  })

  it('expands a thread when its root is in `expanded`, wiring reply edges', () => {
    const root = 'at://x/root'
    const items = [
      mkPost({ uri: root }),
      mkPost({ uri: 'at://x/r1', parent: root, root, author: 'a-r1.test' }),
      mkPost({ uri: 'at://x/r2', parent: 'at://x/r1', root, author: 'a-r2.test' }),
    ]
    const { nodes, edges } = buildGraph(items, new Set([root]))
    expect(nodes).toHaveLength(3)
    expect(edges).toHaveLength(2)
  })

  it('groups a conversation by reply-connectivity even with inconsistent roots', () => {
    // A chain a <- b <- c <- d whose stored reply.root refs disagree (as real
    // Bluesky data often does). Connectivity must still collapse it to one node
    // rather than fragmenting into several linked nodes.
    const items = [
      mkPost({ uri: 'at://a' }),
      mkPost({ uri: 'at://b', parent: 'at://a', root: 'at://a', author: 'a-b.test' }),
      mkPost({ uri: 'at://c', parent: 'at://b', root: 'at://b', author: 'a-c.test' }), // root ≠ a
      mkPost({ uri: 'at://d', parent: 'at://c', root: 'at://elsewhere', author: 'a-d.test' }), // root ≠ a
    ]
    const { nodes, edges } = buildGraph(items)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].collapsedCount).toBe(3)
    expect(edges).toHaveLength(0)
  })

  it('shows a small (2-post) thread as connected nodes, not collapsed', () => {
    const root = 'at://x/root'
    const items = [mkPost({ uri: root }), mkPost({ uri: 'at://x/r1', parent: root, root, author: 'a-r1.test' })]
    const { nodes, edges } = buildGraph(items)
    expect(nodes).toHaveLength(2) // below COLLAPSE_MIN → not collapsed
    expect(edges).toHaveLength(1) // reply → parent edge
    expect(nodes.some((n) => n.collapsedCount > 0)).toBe(false)
  })

  it('drops conversations with no primary post (orphaned pulled-in parents)', () => {
    const items = [
      mkPost({ uri: 'at://parent', author: 'a-parent.test' }),
      mkPost({ uri: 'at://reply', parent: 'at://parent', root: 'at://parent', author: 'a-reply.test' }),
    ]
    // No filter → both shown.
    expect(buildGraph(items).nodes).toHaveLength(2)
    // The reply is primary → its parent is kept, attached.
    expect(buildGraph(items, new Set(), new Set(['at://reply'])).nodes).toHaveLength(2)
    // Nothing primary → the whole (pulled-in-only) group is dropped.
    expect(buildGraph(items, new Set(), new Set()).nodes).toHaveLength(0)
  })

  it('caps an expanded thread to the root + MAX_THREAD_REPLIES loudest', () => {
    const root = 'at://x/root'
    const items = [mkPost({ uri: root })]
    for (let i = 0; i < 15; i++) {
      items.push(mkPost({ uri: `at://x/r${i}`, parent: root, root, likes: i }))
    }
    const { nodes } = buildGraph(items, new Set([root]))
    // root + 10 replies = 11 shown; the rep badges the 5 hidden.
    expect(nodes).toHaveLength(1 + MAX_THREAD_REPLIES)
    const rep = nodes.find((n) => n.isThreadRoot)!
    expect(rep.collapsedCount).toBe(15 - MAX_THREAD_REPLIES)
  })

  it('keeps the capped selection connected: a loud deep reply brings its quiet bridges', () => {
    const root = 'at://x/root'
    const items = [mkPost({ uri: root, likes: 5 })]
    // A quiet bridge chain root <- b1 <- b2 ending in the loudest reply.
    items.push(mkPost({ uri: 'at://x/b1', parent: root, root, likes: 0, author: 'a-b1.test' }))
    items.push(mkPost({ uri: 'at://x/b2', parent: 'at://x/b1', root, likes: 0, author: 'a-b2.test' }))
    items.push(mkPost({ uri: 'at://x/deep', parent: 'at://x/b2', root, likes: 500, author: 'a-deep.test' }))
    // Plus 12 medium direct replies competing for the cap.
    for (let i = 0; i < 12; i++) {
      items.push(mkPost({ uri: `at://x/d${i}`, parent: root, root, likes: 20 + i }))
    }
    const { nodes, edges } = buildGraph(items, new Set([root]))
    const shown = new Set(nodes.map((n) => n.uri))
    // The loud deep reply is shown WITH its bridges, not floating alone.
    expect(shown.has('at://x/deep')).toBe(true)
    expect(shown.has('at://x/b1')).toBe(true)
    expect(shown.has('at://x/b2')).toBe(true)
    // Every shown node except the rep has an edge to a shown parent.
    const edgeFrom = new Set(edges.map((e) => e.from))
    for (const n of nodes) {
      if (!n.isThreadRoot) expect(edgeFrom.has(n.uri)).toBe(true)
    }
    // Still capped, and the rep badges what was cut.
    expect(nodes.length).toBeLessThanOrEqual(1 + MAX_THREAD_REPLIES)
    const rep = nodes.find((n) => n.isThreadRoot)!
    expect(rep.collapsedCount).toBe(items.length - nodes.length)
  })

  it('keeps an expanded conversation even if none of its posts are primary', () => {
    const items = [
      mkPost({ uri: 'at://ctx/root' }),
      mkPost({ uri: 'at://ctx/r1', parent: 'at://ctx/root', root: 'at://ctx/root', author: 'a-r1.test' }),
    ]
    // Nothing primary and not expanded → dropped (orphan context).
    expect(buildGraph(items, new Set(), new Set()).nodes).toHaveLength(0)
    // Same group but the user mapped it → kept.
    expect(buildGraph(items, new Set(['at://ctx/root']), new Set()).nodes).toHaveLength(2)
  })

  it('shows a collapsed conversation with the face of its primary member, not a pulled-in stranger', () => {
    // A stranger's thread (root <- mid) that a followed account replied to:
    // only the reply is primary. Collapsed, the node must display the reply.
    const items = [
      mkPost({ uri: 'at://stranger/root', likes: 90, createdAt: T(0) }),
      mkPost({ uri: 'at://stranger/mid',
        parent: 'at://stranger/root',
        root: 'at://stranger/root',
        createdAt: T(1), author: 'a-mid.test' }),
      mkPost({ uri: 'at://friend/reply',
        parent: 'at://stranger/mid',
        root: 'at://stranger/root',
        createdAt: T(2), author: 'a-reply.test' }),
    ]
    const { nodes } = buildGraph(items, new Set(), new Set(['at://friend/reply']))
    expect(nodes).toHaveLength(1)
    expect(nodes[0].uri).toBe('at://friend/reply')
    expect(nodes[0].isThreadRoot).toBe(true)
    expect(nodes[0].collapsedCount).toBe(2)
    expect(nodes[0].primary).toBe(true)
  })

  it('always shows a clicked (expanded) post and its path, even if quiet and over budget', () => {
    const root = 'at://x/root'
    const items = [mkPost({ uri: root, likes: 5 })]
    // Quiet chain root <- q1 <- clicked (all 0 likes).
    items.push(mkPost({ uri: 'at://x/q1', parent: root, root, likes: 0, author: 'a-q1.test' }))
    items.push(mkPost({ uri: 'at://x/clicked', parent: 'at://x/q1', root, likes: 0, author: 'a-clicked.test' }))
    // 15 loud direct replies that would otherwise fill the whole cap.
    for (let i = 0; i < 15; i++) {
      items.push(mkPost({ uri: `at://x/d${i}`, parent: root, root, likes: 50 + i }))
    }
    const { nodes } = buildGraph(items, new Set(['at://x/clicked']))
    const shown = new Set(nodes.map((n) => n.uri))
    expect(shown.has('at://x/clicked')).toBe(true)
    expect(shown.has('at://x/q1')).toBe(true)
  })

  it('marks pulled-in context nodes as non-primary', () => {
    const items = [
      mkPost({ uri: 'at://parent', author: 'a-parent.test' }),
      mkPost({ uri: 'at://reply', parent: 'at://parent', root: 'at://parent', author: 'a-reply.test' }),
    ]
    const { nodes } = buildGraph(items, new Set(), new Set(['at://reply']))
    const byUri = new Map(nodes.map((n) => [n.uri, n]))
    expect(byUri.get('at://reply')!.primary).toBe(true)
    expect(byUri.get('at://parent')!.primary).toBe(false)
    // A collapsed group containing a primary post is selectable as a whole.
    const thread = [
      mkPost({ uri: 'at://t/0' }),
      mkPost({ uri: 'at://t/1', parent: 'at://t/0', root: 'at://t/0', author: 'a-1.test' }),
      mkPost({ uri: 'at://t/2', parent: 'at://t/1', root: 'at://t/0', author: 'a-2.test' }),
    ]
    const collapsed = buildGraph(thread, new Set(), new Set(['at://t/1'])).nodes
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0].primary).toBe(true)
  })

  it('positions a collapsed thread by peak engagement + latest activity', () => {
    const root = 'at://x/root'
    const items = [
      mkPost({ uri: root, likes: 5, createdAt: T(0) }),
      mkPost({ uri: 'at://x/r1', parent: root, root, likes: 50, createdAt: T(10), author: 'a-r1.test' }),
      mkPost({ uri: 'at://x/r2', parent: 'at://x/r1', root, likes: 3, createdAt: T(5), author: 'a-r2.test' }),
    ]
    const rep = buildGraph(items).nodes[0]
    expect(rep.timestamp).toBe(Date.parse(T(10))) // latest activity
    // peak engagement = the loud reply's velocity, not the root's.
    expect(rep.score).toBeCloseTo(postScoreRate(items[1]), 6)
    expect(rep.score).toBeGreaterThan(postScoreRate(items[0]))
  })
})

const mkNode = (
  uri: string,
  score: number,
  ts: number,
  rootUri = uri,
  replies = 0,
  expanded = false,
  primary = true,
): GraphNode => ({
  uri,
  cid: uri,
  item: mkPost({ uri, replies }),
  score,
  timestamp: ts,
  rootUri,
  isThreadRoot: false,
  collapsedCount: 0,
  expanded,
  manualExpand: expanded,
  primary,
})

describe('selectVisible', () => {
  // scores a=10 b=8 c=6 d=4 e=2 ; times a=1 b=2 c=3 d=4 e=5
  const nodes = [
    mkNode('a', 10, 1),
    mkNode('b', 8, 2),
    mkNode('c', 6, 3),
    mkNode('d', 4, 4),
    mkNode('e', 2, 5),
  ]
  const ids = (ns: GraphNode[]) =>
    ns
      .map((n) => n.uri)
      .sort()
      .join(',')

  it('returns everything when total <= limit', () => {
    expect(selectVisible(nodes, 'top', 10, 0)).toHaveLength(5)
  })
  it('top = loudest', () => {
    expect(ids(selectVisible(nodes, 'top', 2, 0))).toBe('a,b')
  })
  it('recent = newest', () => {
    expect(ids(selectVisible(nodes, 'recent', 2, 0))).toBe('d,e')
  })
  it('mix = loudest half + newest half', () => {
    expect(ids(selectVisible(nodes, 'mix', 4, 0))).toBe('a,b,d,e')
  })
  it('offset rotates the top/recent window', () => {
    expect(ids(selectVisible(nodes, 'top', 2, 1))).toBe('b,c')
  })
  it('always includes nodes flagged expanded, even outside the window', () => {
    const th = [
      mkNode('a', 10, 1),
      mkNode('b', 8, 2),
      mkNode('c', 6, 3, 'R', 0, true), // expanded
      mkNode('d', 4, 4, 'R', 0, true), // expanded
    ]
    expect(ids(selectVisible(th, 'top', 2, 0))).toBe('a,b,c,d')
  })
  it('does NOT force-include auto-expanded (non-manual) nodes past the window', () => {
    // "Reply chains" marks whole threads expanded to prevent collapse, but that
    // must not blow past the limit — only manually mapped threads force-show.
    const auto = (uri: string, s: number, ts: number) => ({
      ...mkNode(uri, s, ts, 'R', 0, true), // expanded (not collapsed)…
      manualExpand: false, // …but auto, not user-mapped
    })
    const th = [mkNode('a', 10, 1), mkNode('b', 8, 2), auto('c', 6, 3), auto('d', 4, 4)]
    expect(ids(selectVisible(th, 'top', 2, 0))).toBe('a,b')
  })
  it('buildGraph flags manualExpand only for the forceShow set, not all expanded', () => {
    const items = [
      mkPost({ uri: 'at://t/root' }),
      mkPost({ uri: 'at://t/r1', parent: 'at://t/root', root: 'at://t/root', author: 'a-r1.test' }),
      mkPost({ uri: 'at://t/r2', parent: 'at://t/r1', root: 'at://t/root', author: 'a-r2.test' }),
    ]
    // expanded (all) prevents collapse; forceShow is empty → nothing is manual.
    const auto = buildGraph(items, new Set(['at://t/root']), undefined, new Set())
    expect(auto.nodes.length).toBeGreaterThan(1) // not collapsed
    expect(auto.nodes.every((n) => !n.manualExpand)).toBe(true)
    // Same thread, but the user mapped it → manualExpand set.
    const manual = buildGraph(items, new Set(['at://t/root']), undefined, new Set(['at://t/root']))
    expect(manual.nodes.some((n) => n.manualExpand)).toBe(true)
  })
  it('never selects a context (non-primary) node on its own, however loud', () => {
    const th = [
      mkNode('ctx', 100, 9, 'ctx', 0, false, false), // loud pulled-in parent
      mkNode('a', 10, 1),
      mkNode('b', 8, 2),
      mkNode('c', 6, 3),
    ]
    // 'top' would otherwise pick ctx first; it must not appear at all.
    expect(ids(selectVisible(th, 'top', 2, 0))).toBe('a,b')
    expect(ids(selectVisible(th, 'recent', 2, 0))).toBe('b,c')
    // …unless its conversation is expanded (user mapped it).
    const mapped = [mkNode('ctx', 100, 9, 'ctx', 0, true, false), mkNode('a', 10, 1)]
    expect(ids(selectVisible(mapped, 'top', 1, 0))).toBe('a,ctx')
  })
})

describe('layoutPositions', () => {
  const nodes = [mkNode('a', 10, 1), mkNode('b', 8, 2), mkNode('c', 6, 3)]
  const pos = layoutPositions(nodes)

  it('fills the full 0..1 range on both axes', () => {
    const xs = [...pos.values()].map((p) => p.x)
    const ys = [...pos.values()].map((p) => p.y)
    expect(Math.min(...xs)).toBe(0)
    expect(Math.max(...xs)).toBe(1)
    expect(Math.min(...ys)).toBe(0)
    expect(Math.max(...ys)).toBe(1)
  })
  it('puts the loudest at the top (y=0) and newest at the right (x=1)', () => {
    expect(pos.get('a')!.y).toBe(0) // a is loudest
    expect(pos.get('c')!.x).toBe(1) // c is newest
  })

  it('sizes by reply count, independent of engagement', () => {
    // b is quieter (lower score) but has more replies → bigger, lower node.
    const ns = [mkNode('a', 10, 1, 'a', 0), mkNode('b', 1, 2, 'b', 8)]
    const p = layoutPositions(ns)
    expect(p.get('b')!.sizeRank).toBeGreaterThan(p.get('a')!.sizeRank)
    expect(p.get('b')!.y).toBeGreaterThan(p.get('a')!.y) // quieter → lower
  })
})

describe('threadDescendants', () => {
  const items = [
    mkPost({ uri: 'at://t/0' }),
    mkPost({ uri: 'at://t/1', parent: 'at://t/0', root: 'at://t/0', author: 'a-1.test' }),
    mkPost({ uri: 'at://t/2', parent: 'at://t/1', root: 'at://t/0', author: 'a-2.test' }),
    mkPost({ uri: 'at://t/3', parent: 'at://t/1', root: 'at://t/0', author: 'a-3.test' }),
    mkPost({ uri: 'at://s/0' }),
  ]
  it('walks the whole subtree, including branches', () => {
    expect(threadDescendants(items, 'at://t/0').sort()).toEqual([
      'at://t/1',
      'at://t/2',
      'at://t/3',
    ])
  })
  it('is empty for a leaf / standalone post', () => {
    expect(threadDescendants(items, 'at://s/0')).toEqual([])
    expect(threadDescendants(items, 'at://t/2')).toEqual([])
  })
})

describe('self-reply runs', () => {
  it('a single-author chain collapses into ONE run node with the posts aboard', () => {
    const root = 'at://x/root'
    const items = [
      mkPost({ uri: root, author: 'monologuist.test', text: '1/3' }),
      mkPost({ uri: 'at://x/r1', parent: root, root, author: 'monologuist.test', text: '2/3' }),
      mkPost({ uri: 'at://x/r2', parent: 'at://x/r1', root, author: 'monologuist.test', text: '3/3' }),
    ]
    const g = buildGraph(items, new Set([root]))
    expect(g.nodes).toHaveLength(1)
    expect(g.nodes[0].run).toHaveLength(3)
    expect(g.nodes[0].uri).toBe(root) // the head speaks for the run
    expect(g.memberNode.get('at://x/r2')).toBe(root)
  })

  it('edges mark speaker CHANGES: reply-to-a-run resolves to the run head', () => {
    const root = 'at://x/root'
    const items = [
      mkPost({ uri: root, author: 'monologuist.test' }),
      mkPost({ uri: 'at://x/r1', parent: root, root, author: 'monologuist.test' }),
      mkPost({ uri: 'at://x/other', parent: 'at://x/r1', root, author: 'interlocutor.test' }),
    ]
    const g = buildGraph(items, new Set([root]))
    expect(g.nodes).toHaveLength(2)
    const edge = g.edges.find((e) => e.from === 'at://x/other')
    expect(edge?.to).toBe(root) // parent r1 lives inside the run headed by root
  })

  it('a run breaks where the chain branches (two replies to one post)', () => {
    const root = 'at://x/root'
    const items = [
      mkPost({ uri: root, author: 'm.test' }),
      mkPost({ uri: 'at://x/b1', parent: root, root, author: 'm.test' }),
      mkPost({ uri: 'at://x/b2', parent: root, root, author: 'm.test' }),
    ]
    const g = buildGraph(items, new Set([root]))
    expect(g.nodes.length).toBe(3) // branch point: no run swallows the siblings
  })
})

describe('plan mode (collapseUnexpanded): budget-demoted small threads', () => {
  // A friend's reply to a stranger's OP — 2 posts, below COLLAPSE_MIN. When the
  // planner demotes it to `rep` (not in `expanded`), plan mode must collapse it
  // to ONE node wearing the PRIMARY face + a +N badge, not leave the bare
  // stranger root showing with no hint of the hidden reply.
  const items = () => [
    mkPost({ uri: 'at://stranger/op', likes: 90, createdAt: T(0), author: 'stranger.test' }),
    mkPost({
      uri: 'at://friend/reply',
      parent: 'at://stranger/op',
      root: 'at://stranger/op',
      createdAt: T(1),
      author: 'friend.test',
    }),
  ]
  const primary = new Set(['at://friend/reply'])

  it('collapses the small rep to the earliest-primary face with a +N badge', () => {
    const g = buildGraph(items(), new Set(), primary, new Set(), true)
    expect(g.nodes).toHaveLength(1)
    expect(g.nodes[0].uri).toBe('at://friend/reply') // the primary, not the stranger OP
    expect(g.nodes[0].collapsedCount).toBe(1) // +1 for the hidden OP
    expect(g.memberNode.get('at://stranger/op')).toBe('at://friend/reply')
  })

  it('a planned-full small thread still shows connected (not collapsed)', () => {
    // Same thread, but planned full (both members in `expanded`).
    const g = buildGraph(items(), new Set(['at://friend/reply']), primary, new Set(), true)
    expect(g.nodes).toHaveLength(2) // connected, not collapsed
  })

  it('without plan mode, COLLAPSE_MIN still governs (default contract intact)', () => {
    const g = buildGraph(items(), new Set(), primary) // no collapseUnexpanded flag
    expect(g.nodes).toHaveLength(2) // 2-post thread stays connected by default
  })
})

describe('treeTargets', () => {
  const box: TreeLayoutBox = { padX: 0, padTop: 0, innerW: 1000, innerH: 1000, minSize: 34, maxSize: 66 }
  const Y_UNIT = 66 + 30 // rows are maxSize + 30 apart
  const mk = (uri: string, opts: Partial<TreeNode> = {}): TreeNode => ({
    uri,
    timestamp: 0,
    x: 0.5,
    y: 0.5,
    sizeRank: 0.5,
    ...opts,
  })

  it('attaches a reply to its display-parent regardless of input order (run-tail fix)', () => {
    // `head` is a tree root; `reply`'s parent resolves to head — as when replying
    // to a self-reply run's tail, which head displays. The reply must hang BELOW
    // head, not float off to its own (0.9, 0.9) anchor — and identically whichever
    // order the nodes arrive in (the bug this guards against was order-dependent).
    for (const order of ['reply-first', 'head-first'] as const) {
      const head = mk('head', { timestamp: 1, x: 0.2, y: 0.2 })
      const reply = mk('reply', { timestamp: 2, parent: 'head', x: 0.9, y: 0.9 })
      const t = treeTargets(order === 'reply-first' ? [reply, head] : [head, reply], box)
      const h = t.find((x) => x.id === 'head')!
      const r = t.find((x) => x.id === 'reply')!
      expect(r.tx).toBeCloseTo(h.tx) // single child → centred under head, not at x=0.9
      expect(r.ty - h.ty).toBeCloseTo(Y_UNIT) // hangs exactly one row below
    }
  })

  it('fits an edge-anchored tree inside the canvas instead of cramming it', () => {
    // A chain root→a→b→c anchored in the bottom-left corner of a short canvas.
    const chain = [
      mk('root', { timestamp: 1, x: 0, y: 1 }),
      mk('a', { timestamp: 2, parent: 'root', x: 0, y: 1 }),
      mk('b', { timestamp: 3, parent: 'a', x: 0, y: 1 }),
      mk('c', { timestamp: 4, parent: 'b', x: 0, y: 1 }),
    ]
    const t = treeTargets(chain, { padX: 10, padTop: 10, innerW: 1000, innerH: 300, minSize: 34, maxSize: 66 })
    const byId = new Map(t.map((x) => [x.id, x]))
    // Nothing crammed past the bottom edge; every node stays in bounds.
    for (const x of t) {
      expect(x.ty).toBeGreaterThanOrEqual(10)
      expect(x.ty).toBeLessThanOrEqual(10 + 300 + 1e-6)
    }
    // …and the chain still reads strictly top→down (not all piled at the floor).
    expect(byId.get('root')!.ty).toBeLessThan(byId.get('a')!.ty)
    expect(byId.get('a')!.ty).toBeLessThan(byId.get('b')!.ty)
    expect(byId.get('b')!.ty).toBeLessThan(byId.get('c')!.ty)
  })

  it('spreads siblings across one row, oldest to the left', () => {
    const t = treeTargets(
      [
        mk('op', { timestamp: 1, x: 0.5, y: 0.3 }),
        mk('r1', { timestamp: 2, parent: 'op' }),
        mk('r2', { timestamp: 3, parent: 'op' }),
      ],
      box,
    )
    const byId = new Map(t.map((x) => [x.id, x]))
    expect(byId.get('r1')!.ty).toBeCloseTo(byId.get('op')!.ty + Y_UNIT)
    expect(byId.get('r2')!.ty).toBeCloseTo(byId.get('op')!.ty + Y_UNIT)
    expect(byId.get('r1')!.tx).toBeLessThan(byId.get('r2')!.tx) // r1 (older) on the left
  })

  it('places a lone node at its own semantic anchor', () => {
    const [t] = treeTargets([mk('solo', { x: 0.25, y: 0.75 })], box)
    expect(t.tx).toBeCloseTo(250)
    expect(t.ty).toBeCloseTo(750)
  })
})
