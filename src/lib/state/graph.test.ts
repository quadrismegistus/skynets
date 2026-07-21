import { describe, expect, it } from 'vitest'
import { mkPost } from '../testing'
import { postScoreRate } from './score'
import { buildConversations, planView } from './conversations'
import {
  ancestryHeld,
  buildGraph,
  climbChain,
  parentUriOf,
  layoutPositions,
  MAX_THREAD_REPLIES,
  selectVisible,
  threadDescendants,
  treeTargets,
  buildTimeDomain,
  positionsFrozenTime,
  timeDomainIsStale,
  withTopicPills,
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

  it('keeps the monologue whole when a MIDDLE post gets an external reply (#55)', () => {
    // op posts a 3-part thread; a stranger replies to the 2nd post. The stranger's
    // reply must not fracture the thread — the whole monologue stays ONE run node,
    // and the external reply hangs off it as its own node/edge.
    const root = 'at://x/root'
    const items = [
      mkPost({ uri: root, author: 'op.test', text: '1/3' }),
      mkPost({ uri: 'at://x/r1', parent: root, root, author: 'op.test', text: '2/3' }),
      mkPost({ uri: 'at://x/r2', parent: 'at://x/r1', root, author: 'op.test', text: '3/3' }),
      mkPost({ uri: 'at://x/ext', parent: 'at://x/r1', root, author: 'stranger.test', text: 'butting in' }),
    ]
    const g = buildGraph(items, new Set([root]))
    const run = g.nodes.find((n) => n.run)
    expect(run?.run).toHaveLength(3) // all three op posts aboard one run
    expect(run?.uri).toBe(root)
    expect(g.memberNode.get('at://x/r2')).toBe(root) // the tail folded in, not stray
    expect(g.nodes).toHaveLength(2) // the run + the stranger's reply, nothing more
    // The external reply edges to the run HEAD (its parent r1 lives inside the run).
    expect(g.edges.find((e) => e.from === 'at://x/ext')?.to).toBe(root)
  })

  it('op replying to an interloper does NOT rejoin the run', () => {
    // The spine follows the IMMEDIATE parent's author, not the thread-op's. So
    // when op answers the stranger (op → … stranger → op-again), that last post
    // — same author as the monologue but a child of the stranger — stays its own
    // node edging to the stranger, and must not be pulled back into the run.
    const root = 'at://x/root'
    const items = [
      mkPost({ uri: root, author: 'op.test', text: '1/3' }),
      mkPost({ uri: 'at://x/r1', parent: root, root, author: 'op.test', text: '2/3' }),
      mkPost({ uri: 'at://x/r2', parent: 'at://x/r1', root, author: 'op.test', text: '3/3' }),
      mkPost({ uri: 'at://x/ext', parent: 'at://x/r1', root, author: 'stranger.test' }),
      mkPost({ uri: 'at://x/op2', parent: 'at://x/ext', root, author: 'op.test' }),
    ]
    const g = buildGraph(items, new Set([root]))
    expect(g.nodes.find((n) => n.run)?.run).toHaveLength(3) // monologue still whole
    expect(g.memberNode.get('at://x/op2')).toBe('at://x/op2') // op2 is its own node
    expect(g.edges.find((e) => e.from === 'at://x/op2')?.to).toBe('at://x/ext') // → stranger, not the run
    expect(g.nodes).toHaveLength(3) // run + stranger + op's answer
  })
})

describe('climbChain', () => {
  // A linear reply chain c → b → a → root (child points to parent).
  const nodes = { root: { uri: 'root' }, a: { uri: 'a' }, b: { uri: 'b' }, c: { uri: 'c' } }
  const parent: Record<string, string> = { c: 'b', b: 'a', a: 'root' }
  const parentOf = (n: { uri: string }) => (parent[n.uri] ? nodes[parent[n.uri] as keyof typeof nodes] : undefined)

  it('pulls the whole ancestry with no prune', () => {
    const into = new Map([['c', nodes.c]])
    climbChain([nodes.c], into, parentOf)
    expect([...into.keys()].sort()).toEqual(['a', 'b', 'c', 'root'])
  })

  it('truncates at a pruned ancestor — it AND everything above it drop out', () => {
    // `a` is the "silenced" ancestor: a and root vanish; c and its nearer parent b stay.
    const into = new Map([['c', nodes.c]])
    climbChain([nodes.c], into, parentOf, (n) => n.uri === 'a')
    expect([...into.keys()].sort()).toEqual(['b', 'c'])
  })

  it('prunes a silenced ancestor at ANY depth (immediate parent case)', () => {
    const into = new Map([['c', nodes.c]])
    climbChain([nodes.c], into, parentOf, (n) => n.uri === 'b') // b is c's immediate parent
    expect([...into.keys()].sort()).toEqual(['c']) // b, a, root all gone
  })
})

describe('ancestryHeld (admissibility gate, #46)', () => {
  const m = (uri: string, parent?: string) => ({ post: { uri }, _parent: parent })
  const parentOf = (x: { _parent?: string }) => x._parent
  const S = (...u: string[]) => new Set(u)

  it('holds a conversation whose member has a missing, not-yet-fetched parent', () => {
    const members = [m('reply', 'parent')] // parent not present, not settled
    expect(ancestryHeld(members, S('reply'), S(), parentOf)).toBe(true)
  })

  it('admits once the parent is present (fetch landed)', () => {
    const members = [m('reply', 'parent')]
    expect(ancestryHeld(members, S('reply', 'parent'), S(), parentOf)).toBe(false)
  })

  it('admits a still-missing parent once the fetch has SETTLED (deleted/blocked never arrives)', () => {
    const members = [m('reply', 'gone')]
    expect(ancestryHeld(members, S('reply'), S('reply'), parentOf)).toBe(false)
  })

  it('a root member (no parent) never holds', () => {
    expect(ancestryHeld([m('root')], S('root'), S(), parentOf)).toBe(false)
  })

  it('one member with a mid-chain gap holds the WHOLE conversation', () => {
    // root present; a present, all resolved except `mid` whose parent isn't loaded.
    const members = [m('root'), m('mid', 'above'), m('leaf', 'mid')]
    expect(ancestryHeld(members, S('root', 'mid', 'leaf'), S(), parentOf)).toBe(true)
  })

  it('the climb does NOT seat a held member reached past a dismissed split (#63 leak)', () => {
    // A → P1(dismissed) → H → gone(missing). A.root=P1 but H.root diverges, so a
    // dismissed P1 (out of `visible`) leaves buildConversations unable to union
    // A and H — they land in SEPARATE conversations, A admitted, H held. The
    // climb resolves parents from ALL items (contextByUri), so it can reach H;
    // the held-aware prune must stop it seating H (as a solid node).
    const A = 'at://x/a'
    const P1 = 'at://x/p1'
    const H = 'at://x/h'
    const items = [
      mkPost({ uri: A, parent: P1, root: P1, author: 'a.test' }),
      mkPost({ uri: P1, parent: H, root: H, author: 'p.test' }), // the dismissed middle
      mkPost({ uri: H, parent: 'at://x/gone', root: 'at://x/rooth', author: 'h.test' }),
    ]
    const present = new Set(items.map((i) => i.post.uri)) // all loaded (P1 dismissed ≠ absent)
    const visible = items.filter((i) => i.post.uri !== P1) // dismissed drops from visible
    const convos = buildConversations(visible, new Set([A]))
    const held = new Set<string>()
    for (const c of convos) {
      if (ancestryHeld(c.members, present, new Set(), (mm) => parentUriOf(mm))) {
        for (const mm of c.members) held.add(mm.post.uri)
      }
    }
    expect(held.has(H)).toBe(true) // H held (its parent `gone` is missing)
    expect(held.has(A)).toBe(false) // A admitted (separate convo; its parent P1 is present)

    // Replicate the climb: parents resolve from ALL items; prune held members.
    const byUri = new Map(items.map((i) => [i.post.uri, { uri: i.post.uri, item: i }]))
    const parentNodeOf = (n: { uri: string }) => {
      const raw = parentUriOf(byUri.get(n.uri)!.item)
      return raw ? byUri.get(raw) : undefined
    }
    const set = new Map([[A, byUri.get(A)!]])
    climbChain([byUri.get(A)!], set, parentNodeOf, (a) => held.has(a.uri))
    expect(set.has(H)).toBe(false) // the fix: held member NOT seated
    expect(set.has(P1)).toBe(true) // the dismissed middle still shows (as a ghost)
  })
})

describe('hide muted replies: silenced ancestors (#59)', () => {
  // op is MUTED and reached only as reply context (muted authors are filtered
  // from the primary feed); two followed accounts reply down the chain.
  const M = 'at://did:plc:muted/app.bsky.feed.post/m'
  const F = 'at://did:plc:fol/app.bsky.feed.post/f'
  const G = 'at://did:plc:fol2/app.bsky.feed.post/g'
  const chain = [
    mkPost({ uri: M, author: 'muted.test', text: 'muted root' }),
    mkPost({ uri: F, parent: M, root: M, author: 'fol.test', text: 'reply to the muted post' }),
    mkPost({ uri: G, parent: F, root: M, author: 'fol2.test', text: 'reply to the reply' }),
  ]
  const primaryUris = new Set([F, G])
  const plannedFull = (items: typeof chain) => {
    const plan = planView(buildConversations(items, primaryUris), {
      budget: 50,
      autoUnrollMax: 10,
      perAuthorMax: 3,
    })
    const s = new Set<string>()
    for (const p of plan) if (p.level === 'full') for (const m of p.nodes) s.add(m.post.uri)
    return s
  }

  it('a muted ancestor WOULD be a seated full-planned member (the leak the fix closes)', () => {
    // This is why a climb-time prune alone was inert: the muted root is planned
    // full and buildGraph emits it as a node, seated before any chain-climb.
    expect(plannedFull(chain).has(M)).toBe(true)
    const g = buildGraph(chain, plannedFull(chain), primaryUris, new Set(), true)
    expect(g.nodes.map((n) => n.uri)).toContain(M)
  })

  it('excluding the silenced author from the graph input drops the muted node, keeps the replies', () => {
    // The fix filters silenced authors out of `visible` (the buildGraph input).
    const visible = chain.filter((i) => i.post.author.handle !== 'muted.test')
    const g = buildGraph(visible, plannedFull(visible), primaryUris, new Set(), true)
    const uris = g.nodes.map((n) => n.uri)
    expect(uris).not.toContain(M) // no muted hub
    expect(uris).toContain(F) // followed replies stay
    expect(uris).toContain(G)
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

  it('wraps a sibling fan wider than the frame into multiple rows', () => {
    // A topic cluster of nine leaf members laid out as ONE row spans ~2200px in
    // pill mode — wider than any frame — so the solver's "too large to fit,
    // leave it" branch fired and the row sat sliced at both window edges from
    // first paint. Wide fans wrap instead: rows of at most
    // floor(innerW / X_UNIT) columns, and the whole tree fits the frame.
    // Mimics pill mode at a 1280 window: innerW is the WORLD (frame + bleed),
    // frameW the window. maxCols = floor(1280 * 0.6 / 246) = 3.
    const pillBox: TreeLayoutBox = {
      padX: 0,
      padTop: 0,
      innerW: 1620,
      frameW: 1280,
      innerH: 1000,
      minSize: 34,
      maxSize: 66,
      pill: { w: 212, h: 56, gap: { x: 34, y: 32 } },
    }
    const fan = [
      mk('op', { timestamp: 1 }),
      ...Array.from({ length: 9 }, (_, i) => mk(`r${i}`, { timestamp: 2 + i, parent: 'op' })),
    ]
    const t = treeTargets(fan, pillBox)
    for (const x of t) {
      // Every pill wholly inside the world box, half-width included.
      expect(x.tx - 106).toBeGreaterThanOrEqual(-1)
      expect(x.tx + 106).toBeLessThanOrEqual(1621)
    }
    // The block itself is narrow enough to place freely in the 1280 frame.
    const xs = t.map((x) => x.tx)
    expect(Math.max(...xs) - Math.min(...xs) + 212).toBeLessThanOrEqual(1280 * 0.6 + 1)
    // 9 children at 3 columns → three rows (3 / 3 / 3), one Y_UNIT (88) apart.
    const rowYs = [...new Set(t.filter((x) => x.id !== 'op').map((x) => Math.round(x.ty)))].sort((a, b) => a - b)
    expect(rowYs.length).toBe(3)
    expect(rowYs[1] - rowYs[0]).toBe(88)
    // Reading order survives: the oldest reply is in the first row, leftmost.
    const byId = new Map(t.map((x) => [x.id, x]))
    expect(byId.get('r0')!.ty).toBe(Math.min(...rowYs) + 0) // first row
    expect(byId.get('r0')!.tx).toBeLessThanOrEqual(byId.get('r3')!.tx)
  })

  it('goes wide, not tall, when a fan exceeds the height budget too', () => {
    // Width capped alone turned a 21-member fan into a 7-row tower: taller
    // than the frame, its topic-pill root pinned up behind the topbar and —
    // on a narrow frame — the whole conversation benched into the reservoir.
    // The row count is budgeted like the width is; a fan too big for both
    // budgets widens past the width cap instead, ending partially visible in
    // the solver's "too large to fit" branch rather than hidden.
    const pillBox: TreeLayoutBox = {
      padX: 0,
      padTop: 0,
      innerW: 1620,
      frameW: 1280, // width budget: floor(1280 * 0.6 / 246) = 3 columns
      innerH: 900,
      frameH: 690, // height budget: floor(690 * 0.6 / 88) = 4 rows
      minSize: 34,
      maxSize: 66,
      pill: { w: 212, h: 56, gap: { x: 34, y: 32 } },
    }
    const fan = [
      mk('op', { timestamp: 1 }),
      ...Array.from({ length: 21 }, (_, i) => mk(`r${i}`, { timestamp: 2 + i, parent: 'op' })),
    ]
    const t = treeTargets(fan, pillBox)
    const members = t.filter((x) => x.id !== 'op')
    const rowYs = [...new Set(members.map((x) => Math.round(x.ty)))].sort((a, b) => a - b)
    expect(rowYs.length).toBe(4) // 6+6+6+3, not 3+3+…seven rows deep
    // The block is deliberately WIDER than the width budget now — that is the
    // trade — but no taller than the height budget.
    expect(rowYs[rowYs.length - 1] - rowYs[0]).toBeLessThanOrEqual(3 * 88 + 1)
  })

  it('starts a wrapped row below the DEEPEST subtree of the row above', () => {
    // If row two began one unit down regardless, a first-row child with its own
    // replies would have the next row laid out on top of its subtree.
    const pillBox: TreeLayoutBox = {
      padX: 0,
      padTop: 0,
      innerW: 1000,
      frameW: 850, // floor(850 * 0.6 / 246) = 2 columns
      innerH: 2000,
      minSize: 34,
      maxSize: 66,
      pill: { w: 212, h: 56, gap: { x: 34, y: 32 } },
    }
    const t = treeTargets(
      [
        mk('op', { timestamp: 1 }),
        mk('a', { timestamp: 2, parent: 'op' }),
        mk('a1', { timestamp: 3, parent: 'a' }), // a's reply: row 1 is 2 deep
        mk('b', { timestamp: 4, parent: 'op' }),
        mk('c', { timestamp: 5, parent: 'op' }), // wraps to row 2
      ],
      pillBox,
    )
    const byId = new Map(t.map((x) => [x.id, x]))
    const Y = 88 // pill.h + gap.y
    expect(byId.get('a')!.ty).toBeCloseTo(byId.get('op')!.ty + Y)
    expect(byId.get('a1')!.ty).toBeCloseTo(byId.get('a')!.ty + Y)
    // c starts BELOW a's subtree (two units down), not on top of a1.
    expect(byId.get('c')!.ty).toBeCloseTo(byId.get('op')!.ty + 3 * Y)
  })

  it('centres a lone conversation rather than stranding it at its root', () => {
    // There is nothing to rank a single conversation against, so it goes to the
    // middle. It used to keep its root's own coordinates — which is by
    // construction the oldest, quietest post — so a feed showing one thread
    // parked it in a corner, and it then leapt the full diagonal as soon as a
    // second conversation arrived. Continuous beats "accurate" for n=1.
    const [t] = treeTargets([mk('solo', { x: 0.25, y: 0.75 })], box)
    expect(t.tx).toBeCloseTo(500)
    expect(t.ty).toBeCloseTo(500)
  })

  it('sits above the thread when its members are mid-thread replies', () => {
    // This case used to skip the pill entirely: mid-thread members keep their
    // real parent, so the pill had no children and was dropped rather than
    // become a stranded root. But this is exactly the shape a pill takes after
    // its conversation is EXPANDED — pulling in a member's ancestors gives that
    // member a parent — and dropping it left the pill floating where it stood
    // with edges radiating back across the canvas. It now adopts the root of
    // its members' tree instead, so it rides above the thread.
    const posts = [
      mk('op', { timestamp: 1000 }),
      mk('r1', { timestamp: 2000, parent: 'op' }),
      mk('r2', { timestamp: 3000, parent: 'op' }),
      mk('other', { timestamp: 4000 }),
    ]
    const combined = withTopicPills(posts, [{ sid: 'topic:x', members: ['r1', 'r2'] }])
    const px = combined.find((c) => c.uri === 'topic:x')!
    expect(px).toBeDefined()
    expect(px.parent).toBeUndefined() // still a tree root
    expect(combined.find((c) => c.uri === 'op')!.parent).toBe('topic:x') // above the thread
    expect(combined.find((c) => c.uri === 'r1')!.parent).toBe('op') // replies keep their thread
    expect(px.timestamp).toBe(3000) // its members' recency, not the epoch
    expect(combined.find((c) => c.uri === 'other')!.parent).toBeUndefined() // untouched

    // A pill over genuine thread ROOTS still becomes a tree, and carries its
    // members' recency rather than the epoch.
    const roots = [mk('a', { timestamp: 1000 }), mk('b', { timestamp: 5000 }), mk('c', { timestamp: 9000 })]
    const withPill = withTopicPills(roots, [{ sid: 'topic:y', members: ['a', 'b'] }])
    const pill = withPill.find((x) => x.uri === 'topic:y')!
    expect(pill.timestamp).toBe(5000) // newest member, not 0
    const t = treeTargets(withPill, box)
    const byId = new Map(t.map((x) => [x.id, x]))
    expect(byId.get('topic:y')!.tx).toBeGreaterThan(0) // not pinned to 1970's corner
  })

  // A root is always the OLDEST post in its thread. Anchoring on it hauled every
  // conversation back to its opening post's time, so threads piled up on the left
  // while standalone posts kept their real recency on the right — two placement
  // rules, two clusters. These pin the single-rule behaviour.
  it('places a thread by its NEWEST activity, not by when it started', () => {
    const t = treeTargets(
      [
        // An old thread that is still going: its own x-rank says far left.
        mk('a0', { timestamp: 1, x: 0 }),
        mk('a1', { timestamp: 100, parent: 'a0', x: 0 }),
        // A standalone post, newer than a0 but staler than the live reply.
        mk('b0', { timestamp: 50, x: 1 }),
      ],
      box,
    )
    const byId = new Map(t.map((x) => [x.id, x]))
    // Old behaviour: a0 used its own x=0 and sat left of b0 (x=1). Now the live
    // conversation wins the right-hand side.
    expect(byId.get('a0')!.tx).toBeGreaterThan(byId.get('b0')!.tx)
    // …and the reply still hangs directly under its parent — tree undeformed.
    expect(byId.get('a1')!.tx).toBeCloseTo(byId.get('a0')!.tx)
    expect(byId.get('a1')!.ty - byId.get('a0')!.ty).toBeCloseTo(Y_UNIT)
  })

  it('places a thread by its LOUDEST post, not by how quiet the opener was', () => {
    const t = treeTargets(
      [
        mk('a0', { timestamp: 1, y: 1 }), // quietest post on the canvas…
        mk('a1', { timestamp: 2, parent: 'a0', y: 0 }), // …but it blew up
        mk('b0', { timestamp: 3, y: 0.5 }),
      ],
      box,
    )
    const byId = new Map(t.map((x) => [x.id, x]))
    expect(byId.get('a0')!.ty).toBeLessThan(byId.get('b0')!.ty) // louder ⇒ higher
  })

  it('spreads conversations across the canvas, not the posts within them', () => {
    // Three conversations of very different sizes. Anchors should land at the
    // rank extremes and midpoint regardless of how many posts each contains.
    const t = treeTargets(
      [
        mk('a0', { timestamp: 1 }),
        mk('a1', { timestamp: 2, parent: 'a0' }),
        mk('a2', { timestamp: 3, parent: 'a0' }),
        mk('b0', { timestamp: 10 }),
        mk('c0', { timestamp: 20 }),
      ],
      box,
    )
    const byId = new Map(t.map((x) => [x.id, x]))
    expect(byId.get('b0')!.tx).toBeCloseTo(500) // middle conversation
    expect(byId.get('c0')!.tx).toBeCloseTo(1000) // newest, hard right
    // The oldest conversation wants the far left, but it has two replies, so
    // subtree-fitting nudges its anchor right by exactly half a sibling slot —
    // putting its LEFTMOST reply on the edge rather than off it.
    expect(byId.get('a1')!.tx).toBeCloseTo(0)
    expect(byId.get('a0')!.tx).toBeLessThan(byId.get('b0')!.tx)
  })
})

describe('withTopicPills', () => {
  const post = (uri: string, opts: Partial<TreeNode> = {}): TreeNode => ({
    uri,
    timestamp: 0,
    x: 0.5,
    y: 0.5,
    sizeRank: 0.5,
    ...opts,
  })

  it('re-parents a pill’s thread-root members under a pill anchored at the loudest', () => {
    const posts = [
      post('op1', { x: 0.3, y: 0.8 }), // quieter (bigger y)
      post('op2', { x: 0.6, y: 0.2 }), // louder (smaller y) → the anchor
    ]
    const out = withTopicPills(posts, [{ sid: 'topic:t', members: ['op1', 'op2'] }])
    const pill = out.find((n) => n.uri === 'topic:t')!
    expect(pill.parent).toBeUndefined() // the pill is a tree root
    expect([pill.x, pill.y]).toEqual([0.6, 0.2]) // anchored at the loudest member
    expect(out.find((n) => n.uri === 'op1')!.parent).toBe('topic:t')
    expect(out.find((n) => n.uri === 'op2')!.parent).toBe('topic:t')
  })

  it('keeps a mid-thread member on its real reply-parent, not the pill', () => {
    const posts = [post('op', { y: 0.3 }), post('reply', { parent: 'op', y: 0.4 })]
    const out = withTopicPills(posts, [{ sid: 'topic:t', members: ['op', 'reply'] }])
    expect(out.find((n) => n.uri === 'op')!.parent).toBe('topic:t') // root → under the pill
    expect(out.find((n) => n.uri === 'reply')!.parent).toBe('op') // reply keeps its thread
  })

  it('skips a topic with fewer than 2 visible members (no pill node, no reparent)', () => {
    const posts = [post('op')]
    // 'missing' isn't among the posts → only 1 visible member → no pill.
    const out = withTopicPills(posts, [{ sid: 'topic:t', members: ['op', 'missing'] }])
    expect(out.some((n) => n.uri === 'topic:t')).toBe(false)
    expect(out.find((n) => n.uri === 'op')!.parent).toBeUndefined()
  })

  it('gives a shared thread root to the first pill that claims it', () => {
    // Two conversations whose members live in the SAME thread both climb to the
    // same root. Without a guard the second would steal it, and the first pill's
    // edges would radiate across the canvas to members it no longer parents.
    const posts = [post('op'), post('r1', { parent: 'op' }), post('r2', { parent: 'op' })]
    const out = withTopicPills(posts, [
      { sid: 'topic:first', members: ['op', 'r1'] },
      { sid: 'topic:second', members: ['r1', 'r2'] },
    ])
    expect(out.find((n) => n.uri === 'op')!.parent).toBe('topic:first')
    // The loser is SKIPPED, not drawn childless. This test previously asserted
    // it was still emitted with zero children, which is the centroid pathology
    // the pill-as-tree-root design exists to remove -- the test encoded the bug.
    expect(out.some((n) => n.uri === 'topic:second')).toBe(false)
  })

  it('survives a malformed reply cycle without hanging', () => {
    // rootOf climbs parent links; a cycle would spin forever without the guard.
    const posts = [post('a', { parent: 'b' }), post('b', { parent: 'a' })]
    const out = withTopicPills(posts, [{ sid: 'topic:t', members: ['a', 'b'] }])
    expect(out.length).toBeGreaterThan(0)
    // Whatever the climb settles on, the pill must either adopt it or not be
    // drawn -- never be emitted as a root with an empty subtree.
    const pill = out.find((n) => n.uri === 'topic:t')
    if (pill) expect(out.some((n) => n.parent === 'topic:t')).toBe(true)
  })

  it('never emits a pill with no children', () => {
    // The invariant behind both cases above, stated directly.
    const posts = [post('op'), post('r1', { parent: 'op' }), post('r2', { parent: 'op' })]
    const out = withTopicPills(posts, [
      { sid: 'topic:a', members: ['op', 'r1'] },
      { sid: 'topic:b', members: ['r1', 'r2'] },
      { sid: 'topic:c', members: ['r2', 'op'] },
    ])
    for (const n of out) {
      if (!n.uri.startsWith('topic:')) continue
      expect(out.some((m) => m.parent === n.uri)).toBe(true)
    }
  })

  it('leaves non-topic posts untouched', () => {
    const posts = [post('a'), post('b', { parent: 'a' })]
    const out = withTopicPills(posts, [])
    expect(out).toHaveLength(2)
    expect(out.find((n) => n.uri === 'a')!.parent).toBeUndefined()
    expect(out.find((n) => n.uri === 'b')!.parent).toBe('a')
  })

  // Cluster salience: a BIG or fast cluster is lifted toward the top so volume
  // surfaces rather than hiding at the loudest member's rank. Size-gated, so
  // small clusters (every test above) are unaffected — the anchor test at the top
  // still asserts pill.y === the loudest member's y for a 2-member cluster.
  it('lifts a big cluster’s pill above its loudest member (size surfaces)', () => {
    const posts = [
      post('op1', { x: 0.5, y: 0.9 }), // quiet
      post('op2', { x: 0.5, y: 0.6 }), // loudest visible → the base anchor
    ]
    // Only 2 members visible, but the FULL cluster is large (size drives the lift).
    const out = withTopicPills(posts, [{ sid: 'topic:big', members: ['op1', 'op2'], size: 16 }])
    const pill = out.find((n) => n.uri === 'topic:big')!
    expect(pill.y).toBeLessThan(0.6) // lifted above the loudest member
    expect(pill.y).toBeGreaterThanOrEqual(0) // clamped at the top
  })

  it('lifts a big RECENT cluster more than a big STALE one (velocity modulates)', () => {
    const pillY = (sid: string, x: number) =>
      withTopicPills(
        [post(`${sid}-a`, { x, y: 0.6 }), post(`${sid}-b`, { x, y: 0.9 })],
        [{ sid, members: [`${sid}-a`, `${sid}-b`], size: 16 }],
      ).find((n) => n.uri === sid)!.y
    expect(pillY('topic:recent', 0.95)).toBeLessThan(pillY('topic:stale', 0.05))
  })
})

describe('frozen time axis', () => {
  const node = (uri: string, timestamp: number, score = 1): GraphNode =>
    ({ uri, timestamp, score, collapsedCount: 0, item: { post: { replyCount: 0 } } }) as unknown as GraphNode

  it('survives a malformed timestamp instead of unsorting the domain', () => {
    // One NaN makes every sort comparison NaN, which leaves the array UNSORTED
    // and breaks the binary search for every post. createdAt is attacker-set.
    const d = buildTimeDomain([node('a', 100), node('bad', NaN), node('c', 300), node('b', 200)])
    expect(d.t).toEqual([100, 200, 300])
    const pos = positionsFrozenTime([node('bad', NaN)], [node('bad', NaN)], d)
    expect(Number.isFinite(pos.get('bad')!.x)).toBe(true)
  })

  it('maps the oldest post to 0 and the newest to the head of the tail', () => {
    // The earlier version returned count/(n-1), shifting every rank up by one,
    // so the top TWO values both saturated at 1 and nothing reached 0.
    const corpus = [node('a', 10), node('b', 20), node('c', 30), node('d', 40), node('e', 50)]
    const d = buildTimeDomain(corpus)
    const pos = positionsFrozenTime(corpus, corpus, d)
    expect(pos.get('a')!.x).toBeCloseTo(0, 5)
    expect(pos.get('e')!.x).toBeGreaterThan(pos.get('d')!.x)
    expect(pos.get('e')!.x).toBeLessThanOrEqual(1)
  })

  it('does not move existing posts when a newer one arrives', () => {
    // The whole point: backfill must not re-rank what is already on screen.
    const corpus = [node('a', 10), node('b', 20), node('c', 30)]
    const d = buildTimeDomain(corpus)
    const before = positionsFrozenTime(corpus, corpus, d)
    const after = positionsFrozenTime([...corpus, node('new', 99)], [...corpus, node('new', 99)], d)
    for (const uri of ['a', 'b', 'c']) {
      expect(after.get(uri)!.x).toBeCloseTo(before.get(uri)!.x, 10)
    }
  })

  it('rebuilds on a corpus that has moved on, in either direction', () => {
    // Keyed on how many posts fall outside the domain, not on node count: the
    // count test could never fire on a shrinking corpus, and counted DISPLAY
    // nodes, so expanding one thread triggered a full re-layout.
    const d = buildTimeDomain([node('a', 10), node('b', 20), node('c', 30)])
    expect(timeDomainIsStale(d, [node('a', 10), node('b', 20)])).toBe(false)
    expect(timeDomainIsStale(d, [node('x', 900), node('y', 950), node('z', 980)])).toBe(true)
    expect(timeDomainIsStale(null, [node('a', 10)])).toBe(true)
  })

  it('positions ghost nodes absent from the corpus', () => {
    // They were left out of the map entirely and fell back to a shared 0.5,
    // which silently promoted a dismissed ancestor's thread up the y axis.
    const corpus = [node('a', 10, 1), node('b', 20, 5)]
    const d = buildTimeDomain(corpus)
    const pos = positionsFrozenTime([...corpus, node('ghost', 15, 3)], corpus, d)
    expect(pos.has('ghost')).toBe(true)
    // And it lands BETWEEN its neighbours rather than snapping onto one: the
    // domain is fixed while posts keep arriving between its values.
    expect(pos.get('ghost')!.x).toBeGreaterThan(pos.get('a')!.x)
    expect(pos.get('ghost')!.x).toBeLessThan(pos.get('b')!.x)
  })

  it('leaves the y axis live, so a decaying score still ranks correctly', () => {
    // Freezing y is what sank the whole population over a few hours: score is a
    // rate that decays with age, unlike a timestamp.
    const d = buildTimeDomain([node('a', 10), node('b', 20)])
    const quiet = positionsFrozenTime([node('a', 10, 1)], [node('a', 10, 1), node('b', 20, 9)], d)
    const loud = positionsFrozenTime([node('b', 20, 9)], [node('a', 10, 1), node('b', 20, 9)], d)
    expect(loud.get('b')!.y).toBeLessThan(quiet.get('a')!.y) // louder sits higher
  })

  it('advances a post newer than the whole domain into the reserved tail and clamps at 1', () => {
    // A post past the snapshot doesn't share the newest column — it moves through
    // the NEW_TAIL band toward x=1, and clamps there rather than running off.
    const corpus = [node('a', 10), node('b', 20), node('c', 30)]
    const d = buildTimeDomain(corpus)
    const head = positionsFrozenTime([node('c', 30)], corpus, d).get('c')!.x // domain.max
    const near = positionsFrozenTime([node('near', 32)], corpus, d).get('near')!.x
    const far = positionsFrozenTime([node('far', 1e9)], corpus, d).get('far')!.x
    expect(head).toBeCloseTo(0.75, 5) // 1 - NEW_TAIL, the tail head
    expect(near).toBeGreaterThan(head) // into the tail
    expect(far).toBeCloseTo(1, 5) // clamped at the axis edge
  })

  it('keeps x within [0,1] for posts older, inside, newer, and malformed', () => {
    const corpus = [node('a', 100), node('b', 200), node('c', 300)]
    const d = buildTimeDomain(corpus)
    const mixed = [node('older', 1), node('inside', 250), node('newer', 1e12), node('nan', NaN)]
    const pos = positionsFrozenTime(mixed, corpus, d)
    for (const n of mixed) {
      const x = pos.get(n.uri)!.x
      expect(Number.isFinite(x)).toBe(true)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(1)
    }
    expect(pos.get('older')!.x).toBe(0) // older than the domain clamps to the left edge
    expect(pos.get('nan')!.x).toBe(0.5) // malformed → centre, never NaN
  })
})
