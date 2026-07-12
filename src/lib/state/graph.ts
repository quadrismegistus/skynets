import { AppBskyFeedPost } from '@atproto/api'
import type { FeedItem } from '../api/timeline'
import { postScore } from './score'

export interface GraphNode {
  uri: string
  cid: string
  item: FeedItem
  score: number
  timestamp: number
  /** Normalized layout coords in [0,1]: x = recency (1 = newest), y = engagement (0 = loudest). */
  x: number
  y: number
  /** Normalized size in [0,1] by score, for the renderer to map to px. */
  sizeRank: number
  /** Thread this post belongs to (root post uri). */
  rootUri: string
  /** True if this node is the collapse/expand handle for its thread. */
  isThreadRoot: boolean
  /** Replies hidden under this collapsed representative (0 if standalone or expanded). */
  collapsedCount: number
}

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

/** Small deterministic-ish jitter so equal ranks don't stack exactly. */
function jitter(amount = 0.015): number {
  return (Math.random() - 0.5) * 2 * amount
}

function timestampOf(item: FeedItem): number {
  const rec = item.post.record
  const created = AppBskyFeedPost.isRecord(rec) ? rec.createdAt : undefined
  return Date.parse(created ?? item.post.indexedAt)
}

/** The parent post uri this item replies to, if any (from the record's reply ref). */
function parentUri(item: FeedItem): string | undefined {
  const rec = item.post.record
  if (AppBskyFeedPost.isRecord(rec) && rec.reply) return rec.reply.parent.uri
  return undefined
}

/**
 * All descendant post uris of `uri` within `items` — i.e. every reply, reply-to-a-reply,
 * and so on that we currently have loaded. Used so dismissing a post also dismisses the
 * replies hanging off it.
 */
export function threadDescendants(items: FeedItem[], uri: string): string[] {
  const children = new Map<string, string[]>()
  for (const it of items) {
    const parent = parentUri(it)
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
function rootUriOf(item: FeedItem): string {
  const rec = item.post.record
  if (AppBskyFeedPost.isRecord(rec) && rec.reply) return rec.reply.root.uri
  return item.post.uri
}

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
 * Build the post graph from timeline items. Posts are grouped by thread: any
 * thread with 2+ posts in view collapses to a single representative node (the
 * root author) unless its root uri is in `expanded`, in which case every member
 * is shown and wired with reply edges. A collapsed thread is positioned by its
 * *latest* activity and *peak* engagement so a hot thread still sits where it
 * belongs. Duplicate posts (an original that also appears as a repost) collapse
 * by uri first.
 */
export function buildGraph(items: FeedItem[], expanded: ReadonlySet<string> = new Set()): Graph {
  // Dedup by post uri, keeping first occurrence.
  const byUri = new Map<string, FeedItem>()
  for (const item of items) {
    if (!byUri.has(item.post.uri)) byUri.set(item.post.uri, item)
  }
  const unique = [...byUri.values()]
  if (unique.length === 0) return { nodes: [], edges: [] }

  // Group by thread root.
  const groups = new Map<string, FeedItem[]>()
  for (const item of unique) {
    const root = rootUriOf(item)
    const g = groups.get(root)
    if (g) g.push(item)
    else groups.set(root, [item])
  }

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
    // Representative: the actual root post if we have it, else the earliest.
    const rep =
      members.find((m) => m.post.uri === rootUri) ??
      members.reduce((a, b) => (timestampOf(a) <= timestampOf(b) ? a : b))

    if (expanded.has(rootUri)) {
      for (const m of members) {
        units.push({
          item: m,
          score: postScore(m),
          timestamp: timestampOf(m),
          rootUri,
          isThreadRoot: m === rep,
          collapsedCount: 0,
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

  const scoreRanks = fractionalRanks(units.map((u) => u.score))
  const timeRanks = fractionalRanks(units.map((u) => u.timestamp))

  const nodes: GraphNode[] = units.map((u, i) => ({
    uri: u.item.post.uri,
    cid: u.item.post.cid,
    item: u.item,
    score: u.score,
    timestamp: u.timestamp,
    // x = recency: newest (highest timestamp rank) to the right.
    x: clamp01(timeRanks[i] + jitter()),
    // y = engagement: loudest (highest score rank) at the top → invert.
    y: clamp01(1 - scoreRanks[i] + jitter()),
    sizeRank: scoreRanks[i],
    rootUri: u.rootUri,
    isThreadRoot: u.isThreadRoot,
    collapsedCount: u.collapsedCount,
  }))

  const present = new Set(nodes.map((n) => n.uri))
  const edges: GraphEdge[] = []
  for (const u of units) {
    const parent = parentUri(u.item)
    const child = u.item.post.uri
    if (parent && present.has(parent) && present.has(child)) {
      edges.push({ id: `${child}->${parent}`, from: child, to: parent })
    }
  }

  return { nodes, edges }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
