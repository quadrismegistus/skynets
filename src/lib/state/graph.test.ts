import { describe, expect, it } from 'vitest'
import { mkPost } from '../testing'
import {
  buildGraph,
  layoutPositions,
  MAX_THREAD_REPLIES,
  selectVisible,
  threadDescendants,
  type GraphNode,
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
      mkPost({ uri: 'at://x/r1', parent: root, root }),
      mkPost({ uri: 'at://x/r2', parent: 'at://x/r1', root }),
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
      mkPost({ uri: 'at://x/r1', parent: root, root }),
      mkPost({ uri: 'at://x/r2', parent: 'at://x/r1', root }),
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
      mkPost({ uri: 'at://b', parent: 'at://a', root: 'at://a' }),
      mkPost({ uri: 'at://c', parent: 'at://b', root: 'at://b' }), // root ≠ a
      mkPost({ uri: 'at://d', parent: 'at://c', root: 'at://elsewhere' }), // root ≠ a
    ]
    const { nodes, edges } = buildGraph(items)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].collapsedCount).toBe(3)
    expect(edges).toHaveLength(0)
  })

  it('shows a small (2-post) thread as connected nodes, not collapsed', () => {
    const root = 'at://x/root'
    const items = [mkPost({ uri: root }), mkPost({ uri: 'at://x/r1', parent: root, root })]
    const { nodes, edges } = buildGraph(items)
    expect(nodes).toHaveLength(2) // below COLLAPSE_MIN → not collapsed
    expect(edges).toHaveLength(1) // reply → parent edge
    expect(nodes.some((n) => n.collapsedCount > 0)).toBe(false)
  })

  it('drops conversations with no primary post (orphaned pulled-in parents)', () => {
    const items = [
      mkPost({ uri: 'at://parent' }),
      mkPost({ uri: 'at://reply', parent: 'at://parent', root: 'at://parent' }),
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

  it('positions a collapsed thread by peak engagement + latest activity', () => {
    const root = 'at://x/root'
    const items = [
      mkPost({ uri: root, likes: 5, createdAt: T(0) }),
      mkPost({ uri: 'at://x/r1', parent: root, root, likes: 50, createdAt: T(10) }),
      mkPost({ uri: 'at://x/r2', parent: 'at://x/r1', root, likes: 3, createdAt: T(5) }),
    ]
    const rep = buildGraph(items).nodes[0]
    expect(rep.timestamp).toBe(Date.parse(T(10))) // latest activity
    // peak engagement = the reply's score (cbrt(51)), not the root's (cbrt(6)).
    expect(rep.score).toBeCloseTo(Math.cbrt(51), 6)
    expect(rep.score).toBeGreaterThan(Math.cbrt(6))
  })
})

const mkNode = (uri: string, score: number, ts: number, rootUri = uri, replies = 0): GraphNode => ({
  uri,
  cid: uri,
  item: mkPost({ uri, replies }),
  score,
  timestamp: ts,
  rootUri,
  isThreadRoot: false,
  collapsedCount: 0,
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
    expect(selectVisible(nodes, 'top', 10, 0, new Set())).toHaveLength(5)
  })
  it('top = loudest', () => {
    expect(ids(selectVisible(nodes, 'top', 2, 0, new Set()))).toBe('a,b')
  })
  it('recent = newest', () => {
    expect(ids(selectVisible(nodes, 'recent', 2, 0, new Set()))).toBe('d,e')
  })
  it('mix = loudest half + newest half', () => {
    expect(ids(selectVisible(nodes, 'mix', 4, 0, new Set()))).toBe('a,b,d,e')
  })
  it('offset rotates the top/recent window', () => {
    expect(ids(selectVisible(nodes, 'top', 2, 1, new Set()))).toBe('b,c')
  })
  it('always includes members of an expanded thread', () => {
    const th = [mkNode('a', 10, 1), mkNode('b', 8, 2), mkNode('c', 6, 3, 'R'), mkNode('d', 4, 4, 'R')]
    expect(ids(selectVisible(th, 'top', 2, 0, new Set(['R'])))).toBe('a,b,c,d')
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
    mkPost({ uri: 'at://t/1', parent: 'at://t/0', root: 'at://t/0' }),
    mkPost({ uri: 'at://t/2', parent: 'at://t/1', root: 'at://t/0' }),
    mkPost({ uri: 'at://t/3', parent: 'at://t/1', root: 'at://t/0' }),
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
