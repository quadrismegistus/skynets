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
  // The self-reply SPINE: the unique same-author child that continues a
  // monologue. External replies to a middle post (other authors) branch OFF the
  // spine — they become their own nodes and edge back to the run head — but they
  // no longer BREAK the run, which a bare "parent has exactly one child" test did
  // (an interloper replying to post 2/N split the thread's tail into a stray
  // node, #55). Two+ same-author children IS a genuine self-fork: ambiguous which
  // continues the monologue, so the run stops there (unchanged).
  const spineChildOf = (parent: FeedItem): FeedItem | undefined => {
    const own = (children.get(parent.post.uri) ?? []).filter(
      (k) => k.post.author.did === parent.post.author.did,
    )
    return own.length === 1 ? own[0] : undefined
  }
  const startsRun = (m: FeedItem) => {
    const p = parentUriOf(m)
    const pm = p ? byUri.get(p) : undefined
    return !pm || spineChildOf(pm) !== m
  }
  const runs: FeedItem[][] = []
  for (const m of members) {
    if (!startsRun(m)) continue
    const run: FeedItem[] = [m]
    for (let next = spineChildOf(m); next; next = spineChildOf(next)) run.push(next)
    runs.push(run)
  }
  return runs
}

/**
 * Climb reply chains: from each start node, walk up its ancestry (via `parentOf`)
 * adding every ancestor to `into`, until a parent isn't loaded or is already in.
 *
 * `prune`, when given, TRUNCATES a chain: an ancestor it returns true for is
 * excluded AND the walk does not climb past it. This is how "hide muted replies"
 * cuts a chain that leads to a silenced account — the muted ancestor and
 * everything above it drop out, while the reply and any nearer ancestors stay
 * (the walk checks every hop, so a silenced account at any depth is caught).
 * Pure and node-shape-agnostic (only `.uri` is read) so it unit-tests directly.
 */
export function climbChain<T extends { uri: string }>(
  starts: T[],
  into: Map<string, T>,
  parentOf: (node: T) => T | undefined,
  prune?: (ancestor: T) => boolean,
): void {
  let frontier = starts
  while (frontier.length) {
    const next: T[] = []
    for (const n of frontier) {
      const pn = parentOf(n)
      if (!pn || pn.uri === n.uri || into.has(pn.uri)) continue
      if (prune?.(pn)) continue // silenced ancestor: exclude it and stop climbing here
      into.set(pn.uri, pn)
      next.push(pn)
    }
    frontier = next
  }
}

/**
 * Admissibility gate (#46): is a conversation's ancestry still resolving?
 *
 * A member whose immediate parent isn't loaded yet (`!present`) reads as a reply
 * with no visible chain, and it pops as the fetched parent lands. Hold the
 * conversation while any such member's fetch is still in flight (`!settled`).
 * Once the fetch settles — the parent arrived (now `present`) or it never will
 * (deleted/blocked) — the member no longer holds the gate, so this never waits
 * forever. Applies per member, so a gap anywhere in the chain holds the whole
 * conversation. Pure (takes plain sets) so it unit-tests directly.
 */
export function ancestryHeld<T extends { post: { uri: string } }>(
  members: T[],
  present: ReadonlySet<string>,
  settled: ReadonlySet<string>,
  parentOf: (m: T) => string | undefined,
): boolean {
  return members.some((m) => {
    const p = parentOf(m)
    return p !== undefined && !present.has(p) && !settled.has(m.post.uri)
  })
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
/**
 * A frozen snapshot of the TIME axis only.
 *
 * An earlier attempt froze both axes to stop background backfill re-normalising
 * every post's rank. It had to be removed: `score` is a rate that decays with
 * wall-clock age, so freezing it made the whole population slide down the y
 * axis until only new arrivals reached the top. Timestamps do not decay, so x
 * can be frozen safely and y left live — which is where the stability was
 * wanted anyway, since x is the axis backfill disturbs.
 */
export interface TimeDomain {
  /** Ascending, finite timestamps only. */
  t: number[]
  min: number
  max: number
}

export function buildTimeDomain(nodes: GraphNode[]): TimeDomain {
  // Non-finite values are dropped rather than sorted. A single NaN makes every
  // comparison in the sort return NaN, which leaves the array UNSORTED and
  // breaks the binary search for every post, not just the bad one. createdAt is
  // attacker-controlled, so this is reachable with one malformed post.
  const t = nodes.map((n) => n.timestamp).filter(Number.isFinite).sort((a, b) => a - b)
  return { t, min: t[0] ?? 0, max: t[t.length - 1] ?? 0 }
}

/**
 * Rebuild when the domain no longer describes the corpus — measured by how many
 * posts fall outside its range, not by how the node COUNT has changed.
 *
 * Counting nodes was wrong twice over: it could never fire on a shrinking
 * corpus (|n - size| / size can't exceed 1 as n falls), and `graph.nodes` counts
 * DISPLAY nodes, so expanding one thread doubled it and triggered a full
 * re-layout from a single click.
 */
export function timeDomainIsStale(d: TimeDomain | null, nodes: GraphNode[]): boolean {
  if (!d || d.t.length < 2) return true
  let outside = 0
  let seen = 0
  for (const n of nodes) {
    if (!Number.isFinite(n.timestamp)) continue
    seen++
    if (n.timestamp < d.min || n.timestamp > d.max) outside++
  }
  return seen > 0 && outside / seen > 0.4
}

/** Fraction of the domain strictly below `v`, in [0,1]. */
function timeRank(d: TimeDomain, v: number): number {
  const n = d.t.length
  if (n < 2) return 0.5
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (d.t[mid] <= v) lo = mid + 1
    else hi = mid
  }
  // (lo - 1) / (n - 1) matches fractionalRanks: smallest maps to 0, largest to
  // 1. Using lo/(n-1) shifted everything up a rank, so the top TWO saturated.
  if (lo <= 0) return 0
  if (lo >= n) return 1
  // Interpolated between the bracketing pair, not snapped to the lower one. The
  // domain is fixed while new posts keep arriving BETWEEN its values, and
  // stepwise ranks would stack every one of them onto its neighbour's exact
  // column -- worst on a small domain, where a post halfway between the only
  // two entries landed on the older one.
  const lower = d.t[lo - 1]
  const upper = d.t[lo]
  const within = upper > lower ? (v - lower) / (upper - lower) : 0
  return Math.max(0, Math.min(1, (lo - 1 + within) / (n - 1)))
}

/**
 * Share of the x axis reserved for posts newer than the snapshot.
 *
 * Every point of tail compresses the head, packing conversations closer, so a
 * narrower tail ought to help the two conversations that end up too wide to
 * resolve against the frame edge. Measured, it does the opposite: at 0.12 the
 * split went 15/4/2 -> 12/7/2 and churn 219px -> 315px per post, with the same
 * two still sliced. Whatever is slicing them is not tail width, and 0.25 is the
 * better setting on both axes.
 */
export const NEW_TAIL = 0.25

/**
 * Positions with x frozen against `domain` and y/size ranked live over `corpus`.
 *
 * `nodes` is what gets positioned (which includes ghost context nodes absent
 * from the corpus — they were left unpositioned by the earlier attempt and fell
 * back to a shared 0.5, silently promoting a dismissed ancestor's thread up the
 * engagement axis).
 */
export function positionsFrozenTime(
  nodes: GraphNode[],
  corpus: GraphNode[],
  domain: TimeDomain,
): Map<string, NodePosition> {
  const scores = corpus.map((n) => n.score).filter(Number.isFinite).sort((a, b) => a - b)
  const replies = corpus.map(replySignal).filter(Number.isFinite).sort((a, b) => a - b)
  const rankIn = (sorted: number[], v: number) => {
    const n = sorted.length
    if (n < 2 || !Number.isFinite(v)) return 0.5
    let lo = 0
    let hi = n
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid] <= v) lo = mid + 1
      else hi = mid
    }
    return Math.max(0, Math.min(1, (lo - 1) / (n - 1)))
  }
  // Derived from the domain's own span rather than a fixed number of hours: a
  // constant either swallows a quiet feed's whole history or saturates in
  // minutes on a busy one. Posts beyond it share the last column, which is the
  // clamping this tail exists to postpone, not abolish.
  const tailSpan = Math.max(1, (domain.max - domain.min) * 0.15)

  const out = new Map<string, NodePosition>()
  for (const n of nodes) {
    const t = n.timestamp
    const x = !Number.isFinite(t)
      ? 0.5
      : t <= domain.max
        ? timeRank(domain, t) * (1 - NEW_TAIL)
        : 1 - NEW_TAIL + NEW_TAIL * Math.min(1, (t - domain.max) / tailSpan)
    out.set(n.uri, { x, y: 1 - rankIn(scores, n.score), sizeRank: rankIn(replies, replySignal(n)) })
  }
  return out
}

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
  /** Optional per-node card height in px (reader lens). When set, rows stack by
   * real pixel span so cards can vary in height; when absent every node is the
   * uniform pill.h / maxSize and the layout is exactly as before. */
  height?: number
  /** A small node (e.g. a "+K more" marker) that reserves a narrow column in the
   * compaction pass rather than a full card width. */
  slim?: boolean
}
export interface TreeLayoutBox {
  padX: number
  padTop: number
  innerW: number
  innerH: number
  /** VISIBLE frame width, when it differs from innerW. In pill mode innerW is
   * the WORLD — frame plus the reservoir bleed on both sides — which is the
   * right span to rank across but the wrong budget for row wrapping: a row
   * sized to the world overhangs the window and lands in the solver's
   * "too large to fit" branch, the exact failure wrapping exists to prevent.
   * Defaults to innerW (avatar mode, where the two coincide). */
  frameW?: number
  /** VISIBLE frame height, same story vertically. Defaults to innerH. */
  frameH?: number
  minSize: number
  maxSize: number
  /** Pill mode: nodes are w x h rectangles rather than circles up to maxSize.
   * `gap` is the same spacing the collision force uses. */
  pill?: { w: number; h: number; gap: { x: number; y: number } }
}
export interface TreeTarget {
  id: string
  tx: number
  ty: number
  r: number
  /** Half-extents, set only in pill mode (see the rect collision in layout). */
  hw?: number
  hh?: number
  /** The tree this node belongs to (its root's uri). Lets the layout keep a
   * whole conversation on one side of the frame edge rather than splitting it. */
  group?: string
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
  const { padX, padTop, innerW, innerH, minSize, maxSize, pill } = box
  // Grid units must EXCEED a node's collision footprint (r up to maxSize/2 plus
  // the collide padding, doubled for two neighbours) or the tidy tree gets shoved
  // into a tangle by the collision force. Rows are taller than columns are wide
  // so a thread reads top-down as a conversation.
  // A pill is wide and short, so its columns need far more room than its rows —
  // the opposite of the avatar case, where rows are the taller unit.
  const X_UNIT = pill ? pill.w + pill.gap.x : maxSize + 18
  const Y_UNIT = pill ? pill.h + pill.gap.y : maxSize + 30

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

  // A node's own card height, and the vertical gap between stacked cards. When a
  // node carries no explicit height it's the uniform footprint (pill.h or an
  // avatar's maxSize), so hOf-based stacking below reproduces the old Y_UNIT
  // layout exactly; a reader-lens node supplies its text-sized height instead.
  const GAP_Y = pill ? pill.gap.y : 30
  const hOf = (uri: string) => byUri.get(uri)?.height ?? (pill ? pill.h : maxSize)

  // How many columns a sibling fan may span before wrapping. A fan of nine
  // laid out as ONE row spans ~2200px in pill mode — wider than any frame —
  // so the solver's "too large to fit, leave it" branch fired and the row sat
  // sliced at both window edges. Budgeted against the VISIBLE frame, and only
  // a FRACTION of it: a block sized to exactly the frame has no legal
  // position the moment anything else is on canvas — one nudge from a
  // neighbour pushes it over an edge, and the solver's rescue/bench loop ends
  // up hiding it entirely (measured: 19 of 20 pills benched into the
  // reservoir). 0.6 leaves a block room to be SHOVED and still fit.
  const WRAP_FRACTION = 0.6
  const maxCols = Math.max(1, Math.floor(((box.frameW ?? innerW) * WRAP_FRACTION) / X_UNIT))
  // The same budget VERTICALLY, in rows. Width capped alone turned a big fan
  // into a tower taller than the frame: its root (a topic pill) got pinned up
  // behind the topbar, and on a narrow frame the solver benched the whole
  // now-narrow conversation into the reservoir — hidden entirely, where the
  // unwrapped row had at least been partially visible.
  const maxRows = Math.max(1, Math.floor(((box.frameH ?? innerH) * WRAP_FRACTION) / Y_UNIT))

  const kidsOf = (uri: string) =>
    (childrenOf.get(uri) ?? []).slice().sort((a, b) => a.timestamp - b.timestamp)

  /** Chunk children into rows of at most `cap` columns. Every row keeps at
   * least one child, so a single over-wide subtree still lays out (its own
   * children wrap in turn). Oldest first, reading order. */
  const chunk = (kids: TreeNode[], ws: number[], cap: number): TreeNode[][] => {
    const rows: TreeNode[][] = []
    let row: TreeNode[] = []
    let used = 0
    kids.forEach((k, i) => {
      if (row.length && used + ws[i] > cap) {
        rows.push(row)
        row = []
        used = 0
      }
      row.push(k)
      used += ws[i]
    })
    if (row.length) rows.push(row)
    return rows
  }

  /** A node's children in rows: wrapped to the width budget, then widened —
   * per fan — while the ROW COUNT overflows the height budget. A fan too big
   * for both budgets goes wide rather than tall: it ends in the solver's
   * "too large to fit, leave it" branch, partially visible, which beats a
   * tower that hides its root behind the topbar or benches whole. (Row count
   * approximates height — deep subtrees add more — but the pathological case
   * is a broad fan of leaves, which it captures exactly.) */
  const rowsOf = (uri: string, guard: Set<string>): TreeNode[][] => {
    const kids = kidsOf(uri)
    if (!kids.length) return []
    const ws = kids.map((k) => widthOf(k.uri, guard))
    const total = ws.reduce((a, b) => a + b, 0)
    let cap = maxCols
    let rows = chunk(kids, ws, cap)
    while (rows.length > maxRows && cap < total) {
      cap++
      rows = chunk(kids, ws, cap)
    }
    return rows
  }

  // A subtree's width is its WIDEST row (not the sum of its children), so
  // wrapping propagates upward: a wrapped fan takes less horizontal room, and
  // its grandparent spreads its own children accordingly.
  // A slim node (a "+K more" marker) reserves a fraction of a column, so it
  // doesn't strand itself in a full card-width of empty space. SLIM_HW is its
  // collision half-width — it must match the fraction, or the solver keeps a
  // full card gap around a ~92px pill and shoves its siblings out of the block.
  const SLIM_W = 0.35
  const SLIM_HW = 46
  const widths = new Map<string, number>()
  const widthOf = (uri: string, guard: Set<string>): number => {
    const memo = widths.get(uri)
    if (memo !== undefined) return memo
    if (guard.has(uri)) return 1
    guard.add(uri)
    let w = byUri.get(uri)?.slim ? SLIM_W : 1
    for (const row of rowsOf(uri, guard)) {
      w = Math.max(
        w,
        row.reduce((sum, k) => sum + widthOf(k.uri, guard), 0),
      )
    }
    widths.set(uri, w)
    return w
  }

  // Subtree height in rows, for stacking wrapped rows without overlap: the
  // next row starts below the DEEPEST subtree of the row above it, not one
  // unit down.
  const heights = new Map<string, number>()
  const heightOf = (uri: string, guard: Set<string>): number => {
    const memo = heights.get(uri)
    if (memo !== undefined) return memo
    if (guard.has(uri)) return 1
    guard.add(uri)
    let h = 1
    for (const row of rowsOf(uri, guard)) {
      h += Math.max(...row.map((k) => heightOf(k.uri, guard)))
    }
    heights.set(uri, h)
    return h
  }

  // Subtree vertical span in PIXELS: from a node's centre down to the bottom
  // edge of the deepest card beneath it. This is what stacks rows without
  // overlap when cards vary in height (heightOf, above, is the row-count twin
  // used only for the wrap budget). With uniform heights it equals the old
  // heightOf * Y_UNIT progression exactly.
  const spans = new Map<string, number>()
  const spanDown = (uri: string): number => {
    const memo = spans.get(uri)
    if (memo !== undefined) return memo
    spans.set(uri, hOf(uri) / 2) // cycle guard: temporary value while recursing
    let down = hOf(uri) / 2
    for (const row of rowsOf(uri, new Set())) {
      const rowTopHalf = Math.max(...row.map((k) => hOf(k.uri) / 2))
      down += GAP_Y + rowTopHalf + Math.max(...row.map((k) => spanDown(k.uri)))
    }
    spans.set(uri, down)
    return down
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
    e.maxDy = Math.max(e.maxDy, dy) // centre-based, as before: the lens re-anchors
    // its own tree top-centre, so the packer's bottom-edge clamp would be moot
    // here and over-clamps a tall avatar chain for other callers (graph.test).
    // Stack child rows by PIXEL span: each row sits below the actual bottom of
    // the deepest card in the row above, so cards may vary in height (a short
    // reply takes little room, a full-length post more). `down` tracks the
    // distance from THIS node's centre to the current stacking floor. With
    // uniform heights it reduces to the old one-row-per-Y_UNIT layout.
    let down = hOf(uri) / 2 // start at the bottom edge of this node's own card
    for (const row of rowsOf(uri, new Set())) {
      const rowTopHalf = Math.max(...row.map((k) => hOf(k.uri) / 2))
      const rowCy = dy + down + GAP_Y + rowTopHalf // the row's shared centre line
      const total = row.reduce((sum, k) => sum + widthOf(k.uri, new Set()), 0)
      let cursor = -total / 2
      for (const k of row) {
        const w = widthOf(k.uri, new Set())
        assign(k.uri, dx + (cursor + w / 2) * X_UNIT, rowCy, guard, rootUri)
        cursor += w
      }
      down += GAP_Y + rowTopHalf + Math.max(...row.map((k) => spanDown(k.uri)))
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

  // Anchor each tree by the CONVERSATION, not by its root post. A root is by
  // definition the oldest post in its thread and often the quietest, so anchoring
  // on it dragged every thread leftward and let a busy conversation sit low —
  // while a standalone post kept its true position. Two placement rules meant two
  // populations on screen (a dense mass of threads up-left, singletons scattered
  // right) with the newest+quietest corner unreachable: a recent quiet post is
  // nearly always a reply, hauled back to its root. Summarising the whole subtree
  // — newest activity on x, peak engagement on y — puts every conversation,
  // including a conversation of one, under a single rule.
  const rootUris = [...extent.keys()]
  const summary = new Map<string, { t: number; y: number }>()
  for (const u of rootUris) summary.set(u, { t: -Infinity, y: Infinity })
  for (const n of nodes) {
    const s = summary.get(nodeRoot.get(n.uri) ?? n.uri)
    if (!s) continue
    // Number.isFinite, not a bare >: an unparseable createdAt yields NaN, every
    // comparison against it is false, and the root kept the -Infinity sentinel —
    // pinning a post with a malformed date to the far left. createdAt is
    // attacker-controllable, so this is reachable from the network.
    if (Number.isFinite(n.timestamp) && n.timestamp > s.t) s.t = n.timestamp
    if (n.y < s.y) s.y = n.y // y is 1 - scoreRank, so LOWER means louder
  }
  // Rank conversations among conversations. layoutPositions ranks every visible
  // post, but only these anchors ever consume a rank and they're a biased subset
  // of them — so a spread that is uniform over posts arrived clumped over the
  // things actually placed. Re-ranking here restores it by construction.
  // No special case for a lone conversation: fractionalRanks already returns
  // 0.5 for n=1, which centres it. Falling back to the root's own coordinates
  // instead put it at the root's position — by construction the oldest and
  // usually quietest post, i.e. the exact corner this whole change exists to
  // stop using — and then flung it across the full diagonal the moment a second
  // conversation appeared. Centring is both better and continuous.
  const anchor = new Map<string, { x: number; y: number }>()
  const ax = fractionalRanks(rootUris.map((u) => summary.get(u)!.t))
  const ay = fractionalRanks(rootUris.map((u) => summary.get(u)!.y))
  rootUris.forEach((u, i) => anchor.set(u, { x: ax[i], y: ay[i] }))

  // Clamp v into [lo, hi]; if the span doesn't fit (lo > hi), centre it.
  const fit = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)))
  return nodes.map((n) => {
    const o = off.get(n.uri) ?? { dx: 0, dy: 0 }
    const rootUri = nodeRoot.get(n.uri) ?? n.uri
    const root = byUri.get(rootUri) ?? n
    const e = extent.get(rootUri) ?? { minDx: 0, maxDx: 0, maxDy: 0 }
    const a = anchor.get(rootUri) ?? { x: root.x, y: root.y }
    // Place the root so its leftmost/rightmost/bottommost descendants stay in
    // bounds, then hang the tree off that fitted root — no per-node edge cramming.
    // The tree itself is untouched: `o` is a rigid offset from the root, so
    // changing the anchor translates the whole constellation without deforming it.
    const rootX = fit(padX + a.x * innerW, padX - e.minDx, padX + innerW - e.maxDx)
    const rootY = fit(padTop + a.y * innerH, padTop, padTop + innerH - e.maxDy)
    return {
      id: n.uri,
      tx: rootX + o.dx,
      ty: rootY + o.dy,
      r: (minSize + n.sizeRank * (maxSize - minSize)) / 2, // size stays the node's own
      ...(pill
        ? { hw: byUri.get(n.uri)?.slim ? SLIM_HW : pill.w / 2, hh: hOf(n.uri) / 2, group: rootUri }
        : {}),
    }
  })
}

/** One topic pill's synthetic id + its VISIBLE member display-uris. */
export interface TopicPill {
  sid: string
  members: string[]
}

/**
 * Attach topic pills as synthetic tree roots over their members, so a topic
 * lays out like a reply chain (pill on top, members below) instead of a pill at
 * the members' centroid with edges radiating across the page.
 *
 * A pill with 2+ visible members becomes a root anchored at its LOUDEST member
 * (smallest y = highest engagement), and each member that is a thread ROOT (no
 * real reply-parent) re-parents under it — so mid-thread posts keep their thread
 * intact and only OPs hang off the pill. Fewer than 2 visible members → the pill
 * is skipped (the caller falls back to a centroid). Returns the combined node
 * list to feed treeTargets. Pure, so the reparenting rules are testable.
 */
export function withTopicPills(posts: TreeNode[], pills: TopicPill[]): TreeNode[] {
  const byUri = new Map(posts.map((p) => [p.uri, p]))
  const pillOf = new Map<string, string>() // member uri → pill sid
  const pillNodes: TreeNode[] = []
  for (const pill of pills) {
    const members = pill.members.filter((u) => byUri.has(u))
    // Gate on members that will actually REPARENT, not merely on visible ones.
    // A mid-thread post keeps its real parent (below), so a pill can clear a
    // 2-visible-member bar and still end up with no children — a synthetic root
    // whose whole subtree is itself. It then consumes a rank of its own and
    // ties with the conversation its members already live in, landing at a
    // canvas edge with edges radiating back to them: exactly the centroid
    // pathology the pill-as-tree-root design was built to remove. Skipped here,
    // it falls back to the caller's centroid like any other under-populated pill.
    // One reparenting member is enough to make a real tree (a pill over a
    // thread root plus its replies). The pathology is specifically ZERO.
    // Attach the pill above the ROOT of each member's visible tree, not merely
    // above members that happen to be parentless. Expanding a conversation
    // pulls a member's ancestors onto the canvas, which GIVES that member a
    // parent; once the last one had a parent, the pill was skipped entirely and
    // fell back to the caller's centroid — stranded where it stood with edges
    // radiating back to its members, which is the pathology described below
    // arriving by a different route.
    const rootOf = (u: string) => {
      let cur = u
      for (let hops = 0; hops < 64; hops++) {
        const par = byUri.get(cur)?.parent
        if (!par || !byUri.has(par)) return cur
        cur = par
      }
      return cur // cycle guard: malformed reply chains shouldn't hang the layout
    }
    // Only roots nobody has claimed yet. Without this a pill whose members all
    // sit inside another pill's thread was still emitted, with zero children:
    // a synthetic tree root whose whole subtree is itself. That bypasses the
    // centroid fallback AND consumes a conversation rank, which is exactly the
    // pathology described above arriving by a new route. The old code gated on
    // `attachable.length === 0` for this reason; the gate was dropped when the
    // climb was introduced and nothing replaced it.
    const roots = [...new Set(members.map(rootOf))].filter((u) => !pillOf.has(u))
    if (members.length < 2 || roots.length === 0) continue
    let loudest = members[0]
    for (const u of members) if (byUri.get(u)!.y < byUri.get(loudest)!.y) loudest = u
    const a = byUri.get(loudest)!
    // The pill's OWN timestamp matters now that treeTargets ranks conversations
    // by last activity. A pill whose members all keep real parents (mid-thread
    // posts aren't reparented) ends up with no children, so its subtree is just
    // itself — and a 0 here made it the oldest thing on the canvas, pinning it
    // to the corner while its members sat mid-canvas with edges radiating out:
    // precisely the layout the pill-as-tree-root design replaced.
    const newest = members.reduce((t, u) => Math.max(t, byUri.get(u)!.timestamp || 0), 0)
    pillNodes.push({ uri: pill.sid, timestamp: newest, parent: undefined, x: a.x, y: a.y, sizeRank: 1 })
    // First pill to claim a root keeps it; `roots` is already filtered to the
    // unclaimed, so the loser is skipped above rather than emitted childless.
    for (const u of roots) pillOf.set(u, pill.sid)
  }
  // Keyed on pillOf alone. Testing `p.parent` as well skipped a root that
  // rootOf reached through a dangling parent or a cycle -- the pill claimed it
  // and then failed to adopt it, leaving the pill childless again.
  const reparented = posts.map((p) => (pillOf.has(p.uri) ? { ...p, parent: pillOf.get(p.uri) } : p))
  return [...pillNodes, ...reparented]
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
