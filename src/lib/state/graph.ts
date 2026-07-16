import { AppBskyFeedPost } from '@atproto/api'
import type { FeedItem } from '../api/timeline'
import { postScoreRate } from './score'

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
  /** True if this node's conversation is currently expanded (mapped) — shown as
   * separate connected nodes rather than a collapsed representative. */
  expanded: boolean
  /** True if the user *manually* mapped this conversation (clicked to expand),
   * as opposed to it being auto-expanded by "Reply chains". Manual maps are
   * force-shown in full; auto-expanded context rides the bounded budget so a
   * whole feed of reply threads can't blow past the node limit. */
  manualExpand: boolean
  /** True if this post is yours or from your timeline — pulled-in context
   * (reply parents, fetched thread replies) is false and never competes for
   * screen slots on its own; it only appears attached. */
  primary: boolean
  /** A dismissed post resurrected because a visible reply needs its chain —
   * rendered dimmed, never selected on its own merits. */
  ghost?: boolean
  /** Contiguous self-reply run this node stands for (≥2 posts): a "🧵 1/N"
   * monologue displays as ONE node with a scrollable card. item = run[0]. */
  run?: FeedItem[]
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
  /** Every member uri → the uri of the NODE that displays it (itself for
   * standalone posts; the run head for run members; the representative for
   * collapsed conversations). Edge drawing, chain climbs, and topic-pill
   * targeting must resolve through this. */
  memberNode: Map<string, string>
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

/** A standalone context node for an item that isn't part of the built graph —
 * used to resurrect DISMISSED ancestors as dimmed "ghosts" so a visible reply
 * always has its chain. Not a thread representative; never primary. */
export function contextNode(item: FeedItem, ghost = true): GraphNode {
  return {
    uri: item.post.uri,
    cid: item.post.cid,
    item,
    score: postScoreRate(item),
    timestamp: timestampOf(item),
    rootUri: item.post.uri,
    isThreadRoot: false,
    collapsedCount: 0,
    expanded: true,
    manualExpand: false,
    primary: false,
    ghost,
  }
}

/**
 * Segment a conversation's members into RUNS: maximal chains of contiguous
 * self-replies (an author replying to themself, single-child links only). A
 * "🧵 1/30" thread is one utterance wearing thirty posts — it displays as ONE
 * scrollable node, and costs the planner one slot. A run breaks where the
 * speaker changes, where the chain branches, or where the parent isn't loaded.
 */
export function segmentRuns(members: FeedItem[]): FeedItem[][] {
  const byUri = new Map(members.map((m) => [m.post.uri, m]))
  const children = new Map<string, FeedItem[]>()
  for (const m of members) {
    const p = parentUriOf(m)
    if (p && byUri.has(p)) {
      const arr = children.get(p)
      if (arr) arr.push(m)
      else children.set(p, [m])
    }
  }
  const continuesRun = (parent: FeedItem, child: FeedItem) =>
    child.post.author.did === parent.post.author.did && (children.get(parent.post.uri)?.length ?? 0) === 1
  const startsRun = (m: FeedItem) => {
    const p = parentUriOf(m)
    const pm = p ? byUri.get(p) : undefined
    return !pm || !continuesRun(pm, m)
  }
  const runs: FeedItem[][] = []
  for (const m of members) {
    if (!startsRun(m)) continue
    const run: FeedItem[] = [m]
    let cur = m
    for (;;) {
      const kids = children.get(cur.post.uri) ?? []
      if (kids.length !== 1 || !continuesRun(cur, kids[0])) break
      run.push(kids[0])
      cur = kids[0]
    }
    runs.push(run)
  }
  return runs
}

/**
 * The conversation model (PLAN §8): the graph as a first-class data structure.
 *
 * Every display decision this app makes — what to show, what to collapse, what
 * to unroll — is really a decision about CONVERSATIONS, but the old pipeline
 * ranked posts and discovered conversation shapes late (after selection,
 * during chain-climbs, across async fetches). Each layer knew a little; none
 * knew the whole; mega-threads and reply-flooding accounts slipped through
 * every local cap.
 *
 * Here the components are computed once, with global knowledge:
 * connected components over the union of DECLARED thread roots (reply.root
 * refs, present even when the chain's middle is unloaded) and loaded parent
 * links. A partially-fetched mega-thread is ONE conversation here, not a
 * confetti of fragments.
 */

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

/** One node fed to the tree layout. `parent` is the uri of the node that
 * DISPLAYS this node's parent (a run head / representative) when that node is
 * also in the set — resolved by the caller so childrenOf and root-detection use
 * the SAME signal (a reply to a run's tail must not read as a root). `x`/`y` are
 * the node's own semantic anchor in [0,1]; a tree hangs from its root's anchor. */
export interface TreeNode {
  uri: string
  timestamp: number
  parent?: string
  x: number
  y: number
  sizeRank: number
}
export interface TreeLayoutBox {
  padX: number
  padTop: number
  innerW: number
  innerH: number
  minSize: number
  maxSize: number
}
export interface TreeTarget {
  id: string
  tx: number
  ty: number
  r: number
}

/**
 * Lay out reply trees as force-sim targets: each conversation's topmost node is
 * anchored to the semantic axes, its replies hang below as a tidy tree (one row
 * per depth, siblings spread by subtree width, oldest left). The WHOLE subtree
 * is fitted on-canvas by clamping its ROOT — a tree hangs down+sideways, so a
 * root anchored near an edge would otherwise cram its descendants into the wall
 * (the bottom-left pile when a quiet/old OP has no room below it).
 *
 * Pure (no DOM / reactive state) so the layout math is testable in isolation.
 */
export function treeTargets(nodes: TreeNode[], box: TreeLayoutBox): TreeTarget[] {
  const { padX, padTop, innerW, innerH, minSize, maxSize } = box
  // Grid units must EXCEED a node's collision footprint (r up to maxSize/2 plus
  // the collide padding, doubled for two neighbours) or the tidy tree gets shoved
  // into a tangle by the collision force. Rows are taller than columns are wide
  // so a thread reads top-down as a conversation.
  const X_UNIT = maxSize + 18
  const Y_UNIT = maxSize + 30

  const byUri = new Map(nodes.map((n) => [n.uri, n]))
  const childrenOf = new Map<string, TreeNode[]>()
  for (const n of nodes) {
    const p = n.parent
    if (p && p !== n.uri && byUri.has(p)) {
      const arr = childrenOf.get(p)
      if (arr) arr.push(n)
      else childrenOf.set(p, [n])
    }
  }

  const widths = new Map<string, number>()
  const widthOf = (uri: string, guard: Set<string>): number => {
    const memo = widths.get(uri)
    if (memo !== undefined) return memo
    if (guard.has(uri)) return 1
    guard.add(uri)
    const kids = childrenOf.get(uri) ?? []
    const w = kids.length ? kids.reduce((sum, k) => sum + widthOf(k.uri, guard), 0) : 1
    widths.set(uri, Math.max(1, w))
    return Math.max(1, w)
  }

  const off = new Map<string, { dx: number; dy: number }>()
  const nodeRoot = new Map<string, string>()
  const extent = new Map<string, { minDx: number; maxDx: number; maxDy: number }>()
  const assign = (uri: string, dx: number, dy: number, guard: Set<string>, rootUri: string) => {
    if (guard.has(uri)) return
    guard.add(uri)
    off.set(uri, { dx, dy })
    nodeRoot.set(uri, rootUri)
    const e = extent.get(rootUri)!
    e.minDx = Math.min(e.minDx, dx)
    e.maxDx = Math.max(e.maxDx, dx)
    e.maxDy = Math.max(e.maxDy, dy)
    const kids = (childrenOf.get(uri) ?? []).slice().sort((a, b) => a.timestamp - b.timestamp)
    const total = kids.reduce((sum, k) => sum + widthOf(k.uri, new Set()), 0)
    let cursor = -total / 2
    for (const k of kids) {
      const w = widthOf(k.uri, new Set())
      assign(k.uri, dx + (cursor + w / 2) * X_UNIT, dy + Y_UNIT, guard, rootUri)
      cursor += w
    }
  }
  const assigned = new Set<string>()
  for (const n of nodes) {
    // A tree root: no in-set parent. `parent` is already resolved to the
    // displaying node, so this test and childrenOf agree by construction.
    if (!n.parent || !byUri.has(n.parent)) {
      extent.set(n.uri, { minDx: 0, maxDx: 0, maxDy: 0 })
      assign(n.uri, 0, 0, assigned, n.uri)
    }
  }

  // Clamp v into [lo, hi]; if the span doesn't fit (lo > hi), centre it.
  const fit = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)))
  return nodes.map((n) => {
    const o = off.get(n.uri) ?? { dx: 0, dy: 0 }
    const rootUri = nodeRoot.get(n.uri) ?? n.uri
    const root = byUri.get(rootUri) ?? n
    const e = extent.get(rootUri) ?? { minDx: 0, maxDx: 0, maxDy: 0 }
    // Place the root so its leftmost/rightmost/bottommost descendants stay in
    // bounds, then hang the tree off that fitted root — no per-node edge cramming.
    const rootX = fit(padX + root.x * innerW, padX - e.minDx, padX + innerW - e.maxDx)
    const rootY = fit(padTop + root.y * innerH, padTop, padTop + innerH - e.maxDy)
    return {
      id: n.uri,
      tx: rootX + o.dx,
      ty: rootY + o.dy,
      r: (minSize + n.sizeRank * (maxSize - minSize)) / 2, // size stays the node's own
    }
  })
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
 *
 * Only *primary* nodes compete for the window — pulled-in context (reply
 * parents, fetched thread posts) is never shown on its own merits; it appears
 * only via expansion (below) or the connect-replies ancestor chain, so an
 * unfollowed parent can't surface alone without the reply that brought it in.
 */
export function selectVisible(
  nodes: GraphNode[],
  mode: SelectMode,
  limit: number,
  offset: number,
): GraphNode[] {
  const pool = nodes.filter((n) => n.primary)
  let chosen: GraphNode[]
  if (pool.length <= limit) {
    chosen = pool
  } else if (mode === 'mix') {
    const byScore = [...pool].sort((a, b) => b.score - a.score)
    const byTime = [...pool].sort((a, b) => b.timestamp - a.timestamp)
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
        ? [...pool].sort((a, b) => b.timestamp - a.timestamp)
        : [...pool].sort((a, b) => b.score - a.score)
    chosen = windowSlice(sorted, limit, offset)
  }

  const set = new Map(chosen.map((n) => [n.uri, n]))
  // Always include every node of a *manually* mapped conversation — the user
  // asked for it, so it shows in full. Auto-expanded reply-chain context is NOT
  // force-included here; it rides the bounded budget in the caller, or a whole
  // feed of reply threads would blow past the limit.
  for (const n of nodes) if (n.manualExpand) set.set(n.uri, n)
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
  run?: FeedItem[]
  score: number
  timestamp: number
  rootUri: string
  isThreadRoot: boolean
  collapsedCount: number
  expanded: boolean
  manualExpand: boolean
  primary: boolean
}

/**
 * Build the post graph from timeline items. Posts are grouped by reply
 * *connectivity* (union-find over parent links, robust to inconsistent thread
 * roots): a group of 3+ collapses to a single representative node unless its
 * group is in `expanded`; a group of 2 shows as connected nodes. A collapsed
 * thread is positioned by its *latest* activity and *peak* engagement. Duplicate
 * posts (an original that also appears as a repost) collapse by uri first.
 */
export function buildGraph(
  items: FeedItem[],
  expanded: ReadonlySet<string> = new Set(),
  primary?: ReadonlySet<string>,
  /** Conversations the user *manually* mapped (a subset of `expanded`). These
   * are force-shown in selection; the rest of `expanded` (auto reply-chains)
   * is bounded by the caller's budget. Defaults to all of `expanded`. */
  forceShow?: ReadonlySet<string>,
  /** Plan-execution mode (PLAN §8): collapse ANY conversation that isn't
   * `expanded` (planned-full), regardless of size. The planner has already
   * decided full-vs-collapsed, so the COLLAPSE_MIN size heuristic — meant for
   * standalone callers — must not override it and leave a budget-demoted small
   * thread showing its bare (often stranger) root with no +N badge. */
  collapseUnexpanded = false,
): Graph {
  // Dedup by post uri, keeping first occurrence.
  const byUri = new Map<string, FeedItem>()
  for (const item of items) {
    if (!byUri.has(item.post.uri)) byUri.set(item.post.uri, item)
  }
  const unique = [...byUri.values()]
  if (unique.length === 0) return { nodes: [], edges: [], memberNode: new Map() }

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
  const ensure = (u: string) => {
    if (!uf.has(u)) uf.set(u, u)
  }
  for (const item of unique) ensure(item.post.uri)
  for (const item of unique) {
    // Union by DECLARED root as well as loaded parent links, so a partially
    // loaded thread is one group here (matching state/conversations.ts), not a
    // confetti of fragments split wherever the middles aren't loaded yet.
    const declared = rootUriOf(item)
    ensure(declared)
    const a0 = find(item.post.uri)
    const b0 = find(declared)
    if (a0 !== b0) uf.set(a0, b0)
    const p = parentUriOf(item)
    if (p) {
      ensure(p)
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
  const memberNode = new Map<string, string>()
  for (const [rootUri, members] of groups) {
    // Expansion is keyed by *membership* (any member's uri was clicked to map),
    // which stays stable as fetched replies merge the group and shift its key.
    // Manual maps default to "all expanded" when no forceShow set is given, so
    // callers that don't distinguish (tests, single-shot) keep old behavior.
    const isManual = forceShow
      ? members.some((m) => forceShow.has(m.post.uri))
      : members.some((m) => expanded.has(m.post.uri))
    // Whether a conversation unrolls is the PLANNER's decision now (PLAN §8):
    // callers pass the planned-full membership as `expanded`.
    const isExpanded = isManual || members.some((m) => expanded.has(m.post.uri))
    const isPrimary = (m: FeedItem) => !primary || primary.has(m.post.uri)

    // Drop conversations that are pure pulled-in context (no primary post of
    // your own / from your timeline) — so a fetched reply-parent never floats
    // alone; it only appears attached to a post that's actually in your feed.
    // Expanded groups are kept regardless: the user explicitly mapped them.
    if (!isExpanded && !members.some(isPrimary)) continue

    if (members.length === 1) {
      const it = members[0]
      memberNode.set(it.post.uri, it.post.uri)
      units.push({
        item: it,
        score: postScoreRate(it),
        timestamp: timestampOf(it),
        rootUri,
        isThreadRoot: false,
        collapsedCount: 0,
        expanded: isExpanded,
        manualExpand: isManual,
        primary: isPrimary(it),
      })
      continue
    }
    // Structural representative: the conversation's entry point (a member with
    // no parent in the group), preferring the earliest; else just the earliest.
    // Used to anchor the tree when showing members as connected nodes.
    const uris = inGroup(members)
    const tops = members.filter((m) => {
      const p = parentUriOf(m)
      return !p || !uris.has(p)
    })
    const pool = tops.length ? tops : members
    const rep = pool.reduce((a, b) => (timestampOf(a) <= timestampOf(b) ? a : b))

    // Display representative for a *collapsed* group: prefer the earliest
    // primary member — the post that actually earned this conversation a place
    // in your graph — so a collapsed thread never wears the face of a pulled-in
    // stranger (the structural top is often an unfollowed root author).
    const primaries = members.filter(isPrimary)
    const displayRep = primaries.length
      ? primaries.reduce((a, b) => (timestampOf(a) <= timestampOf(b) ? a : b))
      : rep

    // Small threads (or explicitly expanded ones) show as connected nodes;
    // larger threads collapse to one node unless the user maps their replies.
    // In plan mode, anything not planned-full collapses (the planner owns the
    // full-vs-rep call), so a budget-demoted 2-post thread reads as one node
    // with the earliest-primary face + a +N badge, like any other rep.
    const collapse = !isExpanded && (collapseUnexpanded || members.length >= COLLAPSE_MIN)

    if (!collapse) {
      // Show the rep + the loudest replies, so a huge thread can't flood the
      // graph — but never orphan a shown reply from the conversation: each
      // pick brings its not-yet-shown ancestors along, so the shown subset is
      // always a connected subtree (slicing purely by loudness used to cut the
      // quiet bridge replies and leave the loud ones floating disconnected).
      const memberByUri = new Map(members.map((m) => [m.post.uri, m]))
      const budget = 1 + MAX_THREAD_REPLIES
      const chosen = new Set<string>([rep.post.uri])
      // Seed with the explicitly clicked posts (and their ancestor paths):
      // whatever the user asked to map must be shown, budget notwithstanding.
      for (const m of members) {
        if (!expanded.has(m.post.uri)) continue
        let cur: FeedItem | undefined = m
        while (cur && !chosen.has(cur.post.uri)) {
          chosen.add(cur.post.uri)
          const p = parentUriOf(cur)
          cur = p ? memberByUri.get(p) : undefined
        }
      }
      const others = members
        .filter((m) => m !== rep)
        .sort((a, b) => postScoreRate(b) - postScoreRate(a))
      for (const m of others) {
        if (chosen.size >= budget) break
        if (chosen.has(m.post.uri)) continue
        const path: string[] = []
        let cur: FeedItem | undefined = m
        while (cur && !chosen.has(cur.post.uri) && !path.includes(cur.post.uri)) {
          path.push(cur.post.uri)
          const p = parentUriOf(cur)
          cur = p ? memberByUri.get(p) : undefined
        }
        if (chosen.size + path.length > budget) continue // a shorter chain may still fit
        for (const u of path) chosen.add(u)
      }
      const shown = members.filter((m) => chosen.has(m.post.uri))
      const hidden = members.length - shown.length
      // Contiguous self-replies display as ONE run node (scrollable card);
      // edges then mark speaker changes, not every post boundary.
      for (const run of segmentRuns(shown)) {
        const head = run[0]
        const hasRep = run.some((m) => m === rep)
        units.push({
          item: head,
          run: run.length > 1 ? run : undefined,
          score: Math.max(...run.map(postScoreRate)),
          timestamp: timestampOf(head),
          rootUri,
          isThreadRoot: hasRep,
          collapsedCount: hasRep ? hidden : 0,
          expanded: isExpanded,
          manualExpand: isManual,
          primary: run.some(isPrimary),
        })
        for (const m of run) memberNode.set(m.post.uri, head.post.uri)
      }
    } else {
      // Collapsed: one node, placed by peak engagement + latest activity.
      // Selectable if the conversation holds any primary post.
      units.push({
        item: displayRep,
        score: Math.max(...members.map(postScoreRate)),
        timestamp: Math.max(...members.map(timestampOf)),
        rootUri,
        isThreadRoot: true,
        collapsedCount: members.length - 1,
        expanded: false,
        manualExpand: false,
        primary: primaries.length > 0,
      })
      for (const m of members) memberNode.set(m.post.uri, displayRep.post.uri)
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
    expanded: u.expanded,
    manualExpand: u.manualExpand,
    primary: u.primary,
    run: u.run,
  }))

  const present = new Set(nodes.map((n) => n.uri))
  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  for (const u of units) {
    const parent = parentUriOf(u.item)
    const child = u.item.post.uri
    // The parent post may live INSIDE another node (a run, a collapsed rep) —
    // resolve to the node that displays it.
    const parentNode = parent ? memberNode.get(parent) ?? parent : undefined
    if (parentNode && parentNode !== child && present.has(parentNode) && present.has(child)) {
      const id = `${child}->${parentNode}`
      if (!seen.has(id)) {
        seen.add(id)
        edges.push({ id, from: child, to: parentNode })
      }
    }
  }

  return { nodes, edges, memberNode }
}
