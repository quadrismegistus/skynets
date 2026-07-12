import { AppBskyFeedPost } from '@atproto/api'
import type { FeedItem } from '../api/timeline'
import { postScore } from './score'

export interface GraphNode {
  uri: string
  cid: string
  item: FeedItem
  score: number
  timestamp: number
  /** Thread this post belongs to (root post uri). */
  rootUri: string
  /** True if this node is the collapse/expand handle for its thread. */
  isThreadRoot: boolean
  /** Replies hidden under this collapsed representative (0 if standalone or expanded). */
  collapsedCount: number
}

/** Normalized layout position in [0,1], computed per visible set (not baked in). */
export interface NodePosition {
  /** x = recency (1 = newest). */
  x: number
  /** y = engagement (0 = loudest). */
  y: number
  /** size by engagement rank in [0,1]. */
  sizeRank: number
}

export type SelectMode = 'top' | 'recent' | 'mix'

export interface GraphEdge {
  id: string
  from: string // child (reply) uri
  to: string // parent uri
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/** Fractional rank in [0,1] of each value by ascending order (ties broken by index). */
function fractionalRanks(values: number[]): number[] {
  const n = values.length
  const order = [...values.keys()].sort((a, b) => values[a] - values[b] || a - b)
  const ranks = new Array<number>(n)
  order.forEach((origIdx, sortedPos) => {
    ranks[origIdx] = n > 1 ? sortedPos / (n - 1) : 0.5
  })
  return ranks
}

function timestampOf(item: FeedItem): number {
  const rec = item.post.record
  const created = AppBskyFeedPost.isRecord(rec) ? rec.createdAt : undefined
  return Date.parse(created ?? item.post.indexedAt)
}

/** The parent post uri this item replies to, if any (from the record's reply ref). */
export function parentUriOf(item: FeedItem): string | undefined {
  const rec = item.post.record
  if (AppBskyFeedPost.isRecord(rec) && rec.reply) return rec.reply.parent.uri
  return undefined
}

/**
 * Compute normalized [0,1] layout positions over *these* nodes (not the global
 * set), so whatever subset is shown always fills the full x/y range. x = recency
 * rank, y = engagement rank (inverted so loudest is at top), size = engagement
 * rank. Overlaps are separated by the force sim's collision, so no jitter needed.
 */
export function layoutPositions(nodes: GraphNode[]): Map<string, NodePosition> {
  const timeRanks = fractionalRanks(nodes.map((n) => n.timestamp))
  const scoreRanks = fractionalRanks(nodes.map((n) => n.score))
  // Size encodes conversation size (replies) — for a collapsed thread, the
  // number of posts folded under it — so it carries a signal distinct from the
  // engagement y-axis rather than duplicating it.
  const replyRanks = fractionalRanks(nodes.map(replySignal))
  const out = new Map<string, NodePosition>()
  nodes.forEach((n, i) => {
    out.set(n.uri, { x: timeRanks[i], y: 1 - scoreRanks[i], sizeRank: replyRanks[i] })
  })
  return out
}

function replySignal(n: GraphNode): number {
  return Math.max(n.item.post.replyCount ?? 0, n.collapsedCount)
}

/** Wrapping slice of `limit` items from a sorted list starting at `offset`. */
function windowSlice<T>(sorted: T[], limit: number, offset: number): T[] {
  const total = sorted.length
  if (total <= limit) return sorted
  const start = ((offset % total) + total) % total
  const out: T[] = []
  for (let i = 0; i < limit; i++) out.push(sorted[(start + i) % total])
  return out
}

/**
 * Choose which nodes to show:
 * - `top`: the loudest `limit` (highest engagement).
 * - `recent`: the newest `limit`.
 * - `mix`: the loudest half + the newest half (deduped).
 * `offset` rotates the top/recent window (the turnover queue). Members of an
 * expanded thread are always included so unspooling never hides part of a thread.
 */
export function selectVisible(
  nodes: GraphNode[],
  mode: SelectMode,
  limit: number,
  offset: number,
  expanded: ReadonlySet<string>,
): GraphNode[] {
  let chosen: GraphNode[]
  if (nodes.length <= limit) {
    chosen = nodes
  } else if (mode === 'mix') {
    const byScore = [...nodes].sort((a, b) => b.score - a.score)
    const byTime = [...nodes].sort((a, b) => b.timestamp - a.timestamp)
    const recentHalf = Math.floor(limit / 2)
    const picked = new Map<string, GraphNode>()
    for (const n of byScore) {
      if (picked.size >= limit - recentHalf) break
      picked.set(n.uri, n)
    }
    for (const n of byTime) {
      if (picked.size >= limit) break
      if (!picked.has(n.uri)) picked.set(n.uri, n)
    }
    chosen = [...picked.values()]
  } else {
    const sorted =
      mode === 'recent'
        ? [...nodes].sort((a, b) => b.timestamp - a.timestamp)
        : [...nodes].sort((a, b) => b.score - a.score)
    chosen = windowSlice(sorted, limit, offset)
  }

  const set = new Map(chosen.map((n) => [n.uri, n]))
  for (const n of nodes) if (expanded.has(n.rootUri)) set.set(n.uri, n)
  return [...set.values()]
}

/**
 * All descendant post uris of `uri` within `items` — i.e. every reply, reply-to-a-reply,
 * and so on that we currently have loaded. Used so dismissing a post also dismisses the
 * replies hanging off it.
 */
export function threadDescendants(items: FeedItem[], uri: string): string[] {
  const children = new Map<string, string[]>()
  for (const it of items) {
    const parent = parentUriOf(it)
    if (parent) {
      const arr = children.get(parent)
      if (arr) arr.push(it.post.uri)
      else children.set(parent, [it.post.uri])
    }
  }
  const out: string[] = []
  const seen = new Set<string>([uri])
  const stack = [uri]
  while (stack.length) {
    const cur = stack.pop() as string
    for (const child of children.get(cur) ?? []) {
      if (!seen.has(child)) {
        seen.add(child)
        out.push(child)
        stack.push(child)
      }
    }
  }
  return out
}

/** The thread root uri this item belongs to (its own uri if not a reply). */
export function rootUriOf(item: FeedItem): string {
  const rec = item.post.record
  if (AppBskyFeedPost.isRecord(rec) && rec.reply) return rec.reply.root.uri
  return item.post.uri
}

/** When a thread is expanded, show at most this many replies (the loudest). */
export const MAX_THREAD_REPLIES = 10

/** Threads with fewer than this many posts show as connected nodes (edges) rather
 * than collapsing — so small conversations read as a network, big ones stay tidy. */
export const COLLAPSE_MIN = 3

/** One layout unit — either a standalone post or a collapsed thread. */
interface Unit {
  item: FeedItem
  score: number
  timestamp: number
  rootUri: string
  isThreadRoot: boolean
  collapsedCount: number
}

/**
 * Build the post graph from timeline items. Posts are grouped by reply
 * *connectivity* (union-find over parent links, robust to inconsistent thread
 * roots): a group of 3+ collapses to a single representative node unless its
 * group is in `expanded`; a group of 2 shows as connected nodes. A collapsed
 * thread is positioned by its *latest* activity and *peak* engagement. Duplicate
 * posts (an original that also appears as a repost) collapse by uri first.
 */
export function buildGraph(items: FeedItem[], expanded: ReadonlySet<string> = new Set()): Graph {
  // Dedup by post uri, keeping first occurrence.
  const byUri = new Map<string, FeedItem>()
  for (const item of items) {
    if (!byUri.has(item.post.uri)) byUri.set(item.post.uri, item)
  }
  const unique = [...byUri.values()]
  if (unique.length === 0) return { nodes: [], edges: [] }

  // Group by reply *connectivity* (union-find over parent links), not by the
  // stored thread root — Bluesky thread data often has inconsistent root refs
  // that would otherwise split one conversation into several nodes.
  const uf = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (uf.get(r) !== r) r = uf.get(r) as string
    while (uf.get(x) !== r) {
      const n = uf.get(x) as string
      uf.set(x, r)
      x = n
    }
    return r
  }
  for (const item of unique) uf.set(item.post.uri, item.post.uri)
  for (const item of unique) {
    const p = parentUriOf(item)
    if (p && uf.has(p)) {
      const a = find(item.post.uri)
      const b = find(p)
      if (a !== b) uf.set(a, b)
    }
  }
  const groups = new Map<string, FeedItem[]>()
  for (const item of unique) {
    const key = find(item.post.uri)
    const g = groups.get(key)
    if (g) g.push(item)
    else groups.set(key, [item])
  }

  const inGroup = (members: FeedItem[]) => new Set(members.map((m) => m.post.uri))

  const units: Unit[] = []
  for (const [rootUri, members] of groups) {
    if (members.length === 1) {
      const it = members[0]
      units.push({
        item: it,
        score: postScore(it),
        timestamp: timestampOf(it),
        rootUri,
        isThreadRoot: false,
        collapsedCount: 0,
      })
      continue
    }
    // Representative: the conversation's entry point (a member with no parent in
    // the group), preferring the earliest; else just the earliest.
    const uris = inGroup(members)
    const tops = members.filter((m) => {
      const p = parentUriOf(m)
      return !p || !uris.has(p)
    })
    const pool = tops.length ? tops : members
    const rep = pool.reduce((a, b) => (timestampOf(a) <= timestampOf(b) ? a : b))

    // Small threads (or explicitly expanded ones) show as connected nodes;
    // larger threads collapse to one node unless the user maps their replies.
    const collapse = members.length >= COLLAPSE_MIN && !expanded.has(rootUri)

    if (!collapse) {
      // Show the root + only the loudest replies, so a huge thread can't flood
      // the graph. The rep keeps a "+N" badge for any replies beyond the cap.
      const others = members
        .filter((m) => m !== rep)
        .sort((a, b) => postScore(b) - postScore(a))
      const shown = others.slice(0, MAX_THREAD_REPLIES)
      const hidden = others.length - shown.length
      for (const m of [rep, ...shown]) {
        units.push({
          item: m,
          score: postScore(m),
          timestamp: timestampOf(m),
          rootUri,
          isThreadRoot: m === rep,
          collapsedCount: m === rep ? hidden : 0,
        })
      }
    } else {
      // Collapsed: one node, placed by peak engagement + latest activity.
      units.push({
        item: rep,
        score: Math.max(...members.map(postScore)),
        timestamp: Math.max(...members.map(timestampOf)),
        rootUri,
        isThreadRoot: true,
        collapsedCount: members.length - 1,
      })
    }
  }

  // Positions are computed later per *visible* set (see layoutPositions), not here.
  const nodes: GraphNode[] = units.map((u) => ({
    uri: u.item.post.uri,
    cid: u.item.post.cid,
    item: u.item,
    score: u.score,
    timestamp: u.timestamp,
    rootUri: u.rootUri,
    isThreadRoot: u.isThreadRoot,
    collapsedCount: u.collapsedCount,
  }))

  const present = new Set(nodes.map((n) => n.uri))
  const edges: GraphEdge[] = []
  for (const u of units) {
    const parent = parentUriOf(u.item)
    const child = u.item.post.uri
    if (parent && present.has(parent) && present.has(child)) {
      edges.push({ id: `${child}->${parent}`, from: child, to: parent })
    }
  }

  return { nodes, edges }
}
