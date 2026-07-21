<script lang="ts">
  import { getFeedPage, type FeedItem } from '../api/timeline'
  import { feeds } from '../state/feeds.svelte'
  import { bskyUrl, reposter, reposterProfile } from '../api/post'
  import {
    ancestryHeld,
    buildGraph,
    climbChain,
    contextNode,
    buildTimeDomain,
    NEW_TAIL,
    positionsFrozenTime,
    timeDomainIsStale,
    type TimeDomain,
    parentUriOf,
    rootUriOf,
    threadDescendants,
    type GraphNode,
    type SelectMode,
  } from '../state/graph'
  import { Layout, pillBudgetBase, type Target } from '../state/layout'
  import { buildConversations, planView } from '../state/conversations'
  import { read } from '../state/read.svelte'
  import { reactions, type Reaction, type ReactionKind } from '../state/reactions.svelte'
  import { moderation } from '../state/moderation.svelte'
  import { settings, debugAllowed, MOTION_MIN, MOTION_MAX } from '../state/settings.svelte'
  import { compose } from '../state/compose.svelte'
  import { threads } from '../state/threads.svelte'
  import { ancestors } from '../state/ancestors.svelte'
  import { follows } from '../state/follows.svelte'
  import { session } from '../state/session.svelte'
  import { archive, type FeedSnapshot } from '../state/archive'
  import { corpus, reconstructFeedItems } from '../state/corpus.svelte'
  import CoverageView from './CoverageView.svelte'
  import { backfill, type BackfillResult } from '../state/backfill'
  import { getFollowDids } from '../api/actors'

  // Captured at component init (before any archive write) so backfill can tell
  // prior-session posts (firstSeen < this) from ones loaded this session.
  const APP_MOUNT = Date.now()
  import { digest } from '../state/digest.svelte'
  import { deploy } from '../state/deploy.svelte'
  import { isDemo } from '../api/demo'
  import { convoColor } from '../api/llm'
  import { untrack } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import PostNode from './PostNode.svelte'
  import PostCard from './PostCard.svelte'
  import DigestPanel from './DigestPanel.svelte'

  const PAD_X = 64
  const PAD_TOP = 52
  const PAD_BOTTOM = 56
  const PANEL_W = 340 // DigestPanel width; nodes lay out left of it when open
  const MIN_SIZE = 34
  const MAX_SIZE = 66

  const CARD_W = 360

  let items = $state<FeedItem[]>([])
  let cursor = $state<string | undefined>(undefined)
  let loading = $state(false)
  let error = $state<string | undefined>(undefined)
  let hovered = $state<string | null>(null)
  let hoveredTopic = $state<string | null>(null)

  // View preferences (node limit, selection mode, auto-cycle) live in a
  // persisted store; turnover offset and popover visibility are ephemeral.
  let turnoverOffset = $state(0)
  let showConfig = $state(false)
  let showDigest = $state(false)
  let backfillStatus = $state<BackfillResult | undefined>(undefined)
  let backfilling = $state(false)
  let archiveStats = $state<{ posts: number; appearances: number; counts: number; follows: number } | undefined>(undefined)
  let showCoverage = $state(false)
  let archiveReady = $state(false)
  // Funnel pulled-in context (mapped threads + fetched reply ancestors) into the
  // corpus as kind 'context' (archive-first, PLAN §8 phase 2). The corpus is the
  // single source the graph derives context from — the mirror updates
  // immediately (so context shows without waiting on the DB), and the write
  // through to IndexedDB persists once open (flushToArchive catches up anything
  // recorded before then). corpus.has dedups, so each post is recorded once.
  $effect(() => {
    const ctx = [...threads.posts, ...ancestors.posts]
    const fresh = ctx.filter((i) => !corpus.has(i.post.uri))
    if (fresh.length) void corpus.record($state.snapshot(fresh) as FeedItem[], 'context')
  })
  const modes: SelectMode[] = ['top', 'recent', 'mix']

  let w = $state(0)
  let h = $state(0)

  // ---- Pill mode (speculative) ---------------------------------------------
  // Posts render as avatar + opening line instead of a bare avatar, so the graph
  // can be read without hovering. A pill is roughly four times an avatar's
  // footprint, so far fewer posts fit — that is the trade, not a side effect.
  const PILL_H = 56
  /** Breathing room between pills. Used by the tidy-tree grid, the collision
   * pass and the node budget alike — see Layout.setCollision. */
  const PILL_GAP = { x: 34, y: 32 }
  // Narrow canvases get a narrower pill, so a phone still fits one comfortably.
  // ?pills=1 turns it on without a settings control, so the idea can be looked
  // at on any build (and screenshotted) before deciding it deserves UI.
  const pillsParam = typeof location !== 'undefined' && new URLSearchParams(location.search).has('pills')
  const pill = $derived(
    settings.postNodes || pillsParam
      ? // On a phone the pill takes nearly the full width: PAD_X is sized for
        // avatars, and honouring it here wastes a third of a narrow canvas.
        { w: Math.round(Math.min(212, Math.max(148, w - 32))), h: PILL_H, gap: PILL_GAP }
      : undefined,
  )
  /**
   * The reservoir: how far the world extends past each edge of the frame, and
   * how many extra posts that buys. A ring roughly one pill deep holds about
   * 40% again of what fits inside, which is enough that several dismissals in a
   * row still have supply without paying to label posts nobody will see.
   */
  const OVERFLOW = 0.4
  // Sized so the ring's AREA is about OVERFLOW of the frame's, which is not the
  // same as making it a pill deep: a perimeter band grows with the perimeter, so
  // a ring "one pill deep" on every side swallowed half the budget and hid it.
  // Far enough past the edge to put a pill OUT OF SIGHT: a centre at -bleed.x
  // with bleed.x > half a pill leaves no part of it in frame. Anything less
  // parks it half-visible on the rim, which is a clipped post, not a reserve.
  const bleed = $derived(
    pill ? { x: Math.round(pill.w * 0.8), y: Math.round(pill.h * 1.1) } : { x: 0, y: 0 },
  )
  /**
   * How many posts comfortably fill the frame — the target that replaced the
   * old fixed Count. Area-derived for both modes and scaled by the user's
   * density preference (settings.density, 0.5–2.5, 1 = comfortable — a
   * MULTIPLIER of what fits, which is why it travels across screen sizes where
   * the old fixed 0–60 count could not):
   *
   * - Pills tile, so this is a real packing estimate: half of what geometrically
   *   fits (the rest is spread room for the solver) plus the reservoir ring —
   *   sized by the WORLD/frame area ratio, not a flat 1+OVERFLOW, so a phone
   *   (whose bleed.x is nearly a frame wide) plans enough that ~8 still reach the
   *   screen instead of the ~3 a flat ring left after the solver stocked the
   *   reservoir. See pillBudgetBase; desktop is unchanged (its ratio ≈ 1+OVERFLOW).
   *   This runs DENSER than the old ?pills=1 default (which capped at the Count
   *   value), by design — one density knob governs both modes; drag it down if cramped.
   * - Avatars don't tile — a conversation spreads out — so it's a UX target, the
   *   same megapixel heuristic the Count default used (~30 on a 1080p screen).
   *   NB w/h are the CANVAS (below the topbar), so at density 1 this lands ~1–2
   *   short of the old window-based default, not exactly on it.
   *
   * Clamped [8, 120]: the floor keeps a phone usable; the ceiling is only an
   * absolute DOM/label backstop. It is area-SCALED in effect — `base` is
   * screen-derived and density tops out at 2.5, so base*density fills the frame
   * at every size and the slider keeps its full travel. (A fixed 60 cap left the
   * slider's top half inert on large monitors, where comfortable already ≈ 60;
   * 120 is only reachable by cranking density on a 5K-class display.)
   */
  const budget = $derived.by(() => {
    let base: number
    if (pill) {
      // By area, not whole columns: on a narrow canvas the column count rounds
      // down to 1 and throws away most of the height. The reservoir supply is
      // area-scaled (see pillBudgetBase) — bleed.x/bleed.y are the same ring the
      // treeLayout spreads across, so the frame gets its true share of the plan.
      const cell = (pill.w + pill.gap.x) * (pill.h + pill.gap.y)
      const fw = Math.max(0, w - 24)
      const fh = Math.max(0, h - PAD_TOP - 60)
      // POINTS SPIKE: no reservoir — budget the FRAME alone (0 bleed, 0 overflow),
      // so we plan what fits the viewport WELL rather than a world+ring's worth.
      base = pillBudgetBase(fw, fh, cell, 0, 0, 0)
    } else {
      base = ((w * h) / 1e6) * 14.5
    }
    return Math.max(8, Math.min(120, Math.round(base * settings.density)))
  })
  // Bottom UI chrome, measured so the sim keeps nodes out of the corners it
  // occupies (measured into bottomChrome; the canvas ends above the bar).
  let gearEl = $state<HTMLElement>()
  let hudEl = $state<HTMLElement>()
  // Measured height of the bottom control bar — the canvas ends above it.
  let bottomChrome = $state(0)
  /** The same bar's top edge WITHOUT the sim's padding, so a panel can sit
   * flush against it rather than leaving a gap the graph shows through. */
  let bottomBar = $state(0)

  // Live node positions, written by the simulation each tick.
  let positions = $state<Map<string, { x: number; y: number }>>(new Map())

  // Threads the user has mapped in (by thread root uri), and pinned nodes (by uri).
  const expanded = new SvelteSet<string>()
  const pinned = new SvelteSet<string>()
  // Topic pills the user double-clicked to reveal ALL their member posts (by
  // conversation id), even those the node budget would otherwise leave off.
  const revealedTopics = new SvelteSet<string>()

  // The single source of truth for what counts as "your feed": the Reposts
  // and Follows-only toggles apply HERE, before anything downstream (primary
  // status, provenance, ancestor-fetching) is derived. Filtering later (as
  // `visible` once did) let a hidden repost leak its uri into the primary set,
  // so its unattributed fetched copy displayed as a plain timeline post from
  // a stranger — the root cause of the "unfollowed node, unexplained" saga.
  const feedItems = $derived(
    items.filter((i) => {
      // Moderation gates feed INFLOW only: a post your settings hide never
      // enters your feed. It may still arrive as somebody's reply parent, and
      // there it stays (covered, not dropped) — deleting an ancestor would
      // tear a hole in the conversation. See state/moderation.svelte.ts.
      if (moderation.hidden(i)) return false
      // Opt-in: a muted account's own posts are always gone, but by default a
      // friend's reply to them still shows (with the muted parent covered).
      // Turn this on and the reply goes too — muting someone you find
      // exhausting doesn't help much if five people you follow are arguing
      // with them in your feed.
      if (settings.hideMutedReplies && moderation.repliesToSilenced(i)) return false
      const rp = reposterProfile(i)
      if (rp && !settings.showReposts) return false
      // Pruning: unfollowing takes effect immediately. A repost goes when its
      // *reposter* (who routed it into your feed) is unfollowed; a plain post
      // goes when its author is. Only session-confirmed unfollows count —
      // never a merely-missing viewer field.
      if (rp && rp.did && follows.knownUnfollowed(rp.did)) return false
      if (!rp && follows.knownUnfollowed(i.post.author.did)) return false
      if (settings.followsOnly) {
        return (
          i.post.author.did === session.did ||
          rp !== undefined ||
          follows.following(i.post.author)
        )
      }
      return true
    }),
  )

  // Merge optimistically-posted items (our own new posts/replies) with the feed,
  // then drop dismissed ones. buildGraph dedupes by uri.
  // Primary = your own posts + your timeline; fetched thread posts and reply
  // parents are pulled-in *context* that only ever appears attached (mapped or
  // chained), never on its own. Primary sources come first so a timeline copy
  // of a post wins dedup over a fetched one.
  const primarySources = $derived([...compose.injected, ...feedItems])
  // The graph's item pool (archive-first, PLAN §8 phase 2 step 3): the primary
  // feed plus every corpus post that has served as context — mapped threads,
  // fetched ancestors, off-window revivals, all unified in the corpus now
  // instead of three separate arrays. Deduped with the primary copy winning, so
  // a post that's both keeps its feed identity; a hidden repost that's ALSO a
  // needed ancestor still comes in as context (corpus tracks the two roles apart).
  const allItems = $derived.by(() => {
    const seen = new Set<string>()
    const out: FeedItem[] = []
    for (const i of primarySources) {
      if (!seen.has(i.post.uri)) {
        seen.add(i.post.uri)
        out.push(i)
      }
    }
    for (const i of corpus.contextItems) {
      if (!seen.has(i.post.uri)) {
        seen.add(i.post.uri)
        out.push(i)
      }
    }
    return out
  })
  // Every loaded post by uri — lets the digest resolve a reply's parent text to
  // feed the classifier (a bare reply is unclassifiable without it).
  const contextByUri = $derived(new Map(allItems.map((i) => [i.post.uri, i])))
  const primaryUris = $derived(new Set(primarySources.map((i) => i.post.uri)))
  // POINTS SPIKE — the BATCH is the unit of layout. One set of posts is chosen,
  // laid out well, and only DRAINS as you dismiss; live-poll arrivals and later
  // pages pool invisibly for the next batch. Null = between batches (the plan
  // selects freely and the capture effect below takes a snapshot).
  let batch = $state<Set<string> | null>(null)
  const visible = $derived(
    allItems.filter(
      (i) =>
        !read.isDismissed(i.post.uri) &&
        (batch === null || batch.has(i.post.uri)) &&
        // "Hide muted replies" drops silenced ANCESTORS from the graph entirely,
        // not just the feed. corpus.contextItems is unmoderated, so a muted
        // account pulled in as reply context reaches allItems; without this it
        // becomes a full-planned member and is SEATED (as a covered hub a
        // followed reply hangs off) before the chain-climb prune can act. The
        // climb prune (below) still handles the ghost/context-only path, where
        // the parent is resolved from contextByUri rather than a seated node.
        !(settings.hideMutedReplies && moderation.isSilenced(i.post.author)),
    ),
  )
  // THE PLAN (PLAN §8): conversations are the unit of every display decision.
  // One pass with global knowledge ranks conversations (not posts), applies
  // author diversity (a reply-flooding account can't fill the window with
  // dozens of small conversations), and allocates each a resolution: full
  // tree, collapsed representative (+N), or hidden (queued).
  const convos = $derived(buildConversations(visible, primaryUris))
  // Admissibility gate (#46): hold a conversation OUT of the graph while its
  // ancestry is still being fetched, so a reply paints WITH its chain instead of
  // popping as parents arrive. Whole-conversation: a gap anywhere holds it all.
  // A manually-mapped/revealed conversation is never held — the user asked for
  // it. Releases when the fetch settles (ancestors.settledUris), so a
  // deleted/blocked parent doesn't hold forever.
  const presentUris = $derived(new Set(allItems.map((i) => i.post.uri)))
  const heldConvoIds = $derived.by(() => {
    if (!settings.connectReplies && !settings.replyChains) return new Set<string>()
    const held = new Set<string>()
    for (const c of convos) {
      const forced = c.members.some((m) => expanded.has(m.post.uri) || revealedUris.has(m.post.uri))
      if (!forced && ancestryHeld(c.members, presentUris, ancestors.settledUris, parentUriOf)) {
        held.add(c.id)
      }
    }
    return held
  })
  const heldMemberUris = $derived.by(() => {
    if (!heldConvoIds.size) return new Set<string>()
    const s = new Set<string>()
    for (const c of convos) if (heldConvoIds.has(c.id)) for (const m of c.members) s.add(m.post.uri)
    return s
  })
  // The graph is built from the admitted posts only; held members never become nodes.
  const admittedVisible = $derived(
    heldMemberUris.size ? visible.filter((i) => !heldMemberUris.has(i.post.uri)) : visible,
  )
  const plan = $derived.by(() => {
    // Manual maps + revealed topic pills always draw whole.
    const forceFull = new Set<string>()
    for (const c of convos) {
      if (c.members.some((m) => expanded.has(m.post.uri) || revealedUris.has(m.post.uri))) forceFull.add(c.id)
    }
    return planView(
      convos.filter((c) => !heldConvoIds.has(c.id) && (c.hasPrimary || forceFull.has(c.id))),
      {
        budget,
        // Reply chains OFF = conversations render collapsed unless mapped.
        autoUnrollMax: settings.replyChains ? 10 : 0,
        perAuthorMax: 3,
        forceFull,
        ranking: settings.selectMode,
        offset: turnoverOffset,
      },
    )
  })
  // Planned membership: full conversations show every member; 'rep' shows the
  // earliest primary member (matching buildGraph's collapsed display rep).
  const plannedFullUris = $derived.by(() => {
    const s = new Set<string>()
    for (const p of plan) if (p.level === 'full') for (const m of p.nodes) s.add(m.post.uri)
    return s
  })
  // uri → rep-planned conversation id, for EVERY member: buildGraph emits one
  // collapsed node for big rep conversations (whose exact member uri follows
  // its own tie-breaks — predicting it would re-implement them, and a mismatch
  // vanishes the conversation), while sub-COLLAPSE_MIN groups emit every
  // member. Admitting by membership and DEDUPING to one node per conversation
  // handles both without overshoot.
  const repConvoByUri = $derived.by(() => {
    const m = new Map<string, string>()
    for (const p of plan) {
      if (p.level !== 'rep') continue
      for (const mem of p.convo.members) m.set(mem.post.uri, p.convo.id)
    }
    return m
  })
  // buildGraph EXECUTES the plan: planned-full membership drives expansion, and
  // everything else collapses (collapseUnexpanded) so budget-demoted small
  // threads render as a proper rep — one node, primary face, +N badge — instead
  // of their bare root.
  const graph = $derived(buildGraph(admittedVisible, plannedFullUris, primaryUris, expanded, true))

  const total = $derived(plan.length)
  const queued = $derived(plan.filter((p) => p.level === 'hidden').length)

  // Batch capture: when between batches and the pool is stocked (budget met, or
  // nothing left to fetch), snapshot the plan's chosen conversations — COMPLETE
  // memberships, so a collapsed rep keeps its +N members — as the new batch.
  $effect(() => {
    if (batch !== null) return
    if (plan.length === 0) return
    // Let the fetcher stock the pool first, so a batch isn't captured at 3 posts
    // when another page could fill it: wait while the pool is underfilled and
    // more is coming (a fetch in flight, or a cursor the auto-load effect —
    // which only runs between batches — will chase). Settles when the budget is
    // met or the feed is exhausted.
    if (total < budget && (loading || cursor)) return
    const s = new Set<string>()
    for (const p of plan) {
      if (p.level === 'hidden') continue
      for (const m of p.convo.members) s.add(m.post.uri)
    }
    batch = s
  })
  // Batch cleared → drop it; the plan re-selects from everything waiting and the
  // capture above takes the next batch. This is the ONE moment a full re-layout
  // happens — where a reflow is expected rather than disruptive.
  $effect(() => {
    if (batch !== null && total === 0 && !loading) batch = null
  })

  // Which nodes to show (top/recent/mix), plus pinned nodes and — when "connect
  // replies" is on — the present ancestor chain of each shown node, so a reply is
  // drawn connected to the post it replies to. Layout is computed over this set.
  // Member uris of every topic the user revealed (clicked its pill) — taken from
  // the pill's own (exclusive) membership so the pill's count and what it pulls
  // in agree.
  const revealedUris = $derived.by(() => {
    const s = new Set<string>()
    if (!revealedTopics.size) return s
    for (const m of topicMembership) {
      if (revealedTopics.has(m.id)) for (const u of m.uris) s.add(u)
    }
    return s
  })

  const visibleNodes = $derived.by(() => {
    const set = new Map<string, GraphNode>()
    const seatedRep = new Set<string>()
    for (const n of graph.nodes) {
      if (plannedFullUris.has(n.uri)) {
        set.set(n.uri, n)
        continue
      }
      const convoId = repConvoByUri.get(n.uri)
      if (convoId && !seatedRep.has(convoId)) {
        seatedRep.add(convoId)
        set.set(n.uri, n) // one node per rep-planned conversation
      }
    }
    // Pinned nodes stay visible regardless of what the plan rotates out.
    for (const n of graph.nodes) if (pinned.has(n.uri) && !set.has(n.uri)) set.set(n.uri, n)
    const connect = settings.connectReplies || settings.replyChains
    if (connect) {
      // Chains belong to FULL-planned conversations (and pinned posts): every
      // such reply gets its complete loaded ancestry, with dismissed ancestors
      // returning as dimmed GHOSTS. A 'rep' node REPRESENTS its conversation —
      // it must not sprout its own spine, or a rep planned as one node drags
      // its whole thread (and every resurrected dismissal in it) onto the map,
      // blowing past the plan (the 90/37 cat pile).
      const byUri = new Map(graph.nodes.map((n) => [n.uri, n]))
      const parentNodeOf = (n: GraphNode): GraphNode | undefined => {
        const raw = parentUriOf(n.item)
        if (!raw) return undefined
        const p = graph.memberNode.get(raw) ?? raw // the node DISPLAYING the parent
        const it = byUri.get(p) ? undefined : contextByUri.get(raw)
        return byUri.get(p) ?? (it ? contextNode(it, read.isDismissed(raw)) : undefined)
      }
      const starts = [...set.values()].filter((n) => plannedFullUris.has(n.uri) || pinned.has(n.uri))
      // "Hide muted replies" TRUNCATES a chain at a silenced ancestor: the muted
      // account and everything above it drop out (at any depth — climbChain checks
      // each hop), instead of showing the muted node as the hub a followed reply
      // hangs off. Off by default, so ordinary chains keep their full ancestry.
      // Also refuse to climb INTO a held conversation. A chain split by a
      // DISMISSED middle post (dropped from `visible`, so buildConversations
      // doesn't union across it) plus a divergent reply.root can put an admitted
      // node and a held ancestor in separate conversations; the climb resolves
      // parents from the unfiltered contextByUri, so without this it would seat
      // that held member as a solid node, bypassing the gate. (#63 review)
      const prune = (a: GraphNode) =>
        heldMemberUris.has(a.uri) ||
        (settings.hideMutedReplies && moderation.isSilenced(a.item.post.author))
      climbChain(starts, set, parentNodeOf, prune)
    }
    return [...set.values()]
  })
  /**
   * Rank across the whole corpus in reservoir mode, not just the posts on
   * screen.
   *
   * Ranking the visible subset makes a post's position depend on which OTHER
   * posts happen to be planned, so dismissing one re-normalises every rank and
   * the layout re-deals instead of yielding a slot. That defeats the reservoir:
   * reserved posts can't drift inward if inward keeps moving. Corpus-wide ranks
   * are stable under dismissal, so a post keeps its place and the queue behaves
   * like one.
   *
   * The subset-scoped version exists to make any subset fill the canvas, which
   * the reservoir makes moot -- the world is deliberately larger than the frame
   * now, so filling it is no longer the goal.
   */
  /**
   * In reservoir mode the TIME axis is frozen and the rest stays live.
   *
   * Fractional rank is relative, so each post arriving from backfill
   * re-normalised every other post and the graph re-laid itself out mid-load.
   * Freezing both axes fixed that and broke something worse: `score` decays with
   * wall-clock age, so a frozen y made the whole population sink over a few
   * hours. Timestamps do not decay. x is also the axis backfill actually
   * disturbs, so this is where the stability was wanted.
   *
   * Captured in an effect rather than inside the derived: a derived that
   * assigns is lazy, so WHEN the snapshot was taken depended on read order.
   */
  // The snapshot is captured here rather than in an $effect, and is a plain
  // variable rather than $state. Both were tried: an effect that tests the
  // snapshot and replaces it is a read-write cycle, and routing the change to
  // the derived through a version counter still fed back around the graph --
  // effect_update_depth_exceeded, nothing rendered at all.
  //
  // The trade, stated plainly: a derived is lazy, so WHEN the snapshot is taken
  // depends on when the layout is first read rather than on the data. That is
  // tolerable because timeDomainIsStale is a pure test of the corpus, so a late
  // capture produces the same domain a prompt one would.
  let timeDomain: TimeDomain | null = null
  // The batch's ranking BASELINE, captured once per batch (keyed by the batch
  // Set's identity, same lazy-capture pattern as timeDomain above): the batch's
  // own nodes + their time domain. Ranking WITHIN the batch spreads the visible
  // set uniformly over the frame (corpus-wide ranks bunch it — the crowded
  // bottom band); freezing the baseline for the batch's lifetime keeps every
  // survivor's position fixed as the batch drains. Anything that joins mid-batch
  // (an expanded thread's members, climbed-in ancestors) ranks against the same
  // frozen arrays, slotting in honestly without moving anyone else.
  let baseFor: Set<string> | null = null
  let batchCorpus: GraphNode[] = []
  let batchDomain: TimeDomain | null = null
  const nodeLayout = $derived.by(() => {
    if (batch && baseFor !== batch) {
      baseFor = batch
      batchCorpus = visibleNodes
      batchDomain = buildTimeDomain(batchCorpus)
    }
    if (!batch || !batchDomain || batchCorpus.length === 0) {
      // Between batches (boot, feed switch): corpus-frozen, as before.
      if (timeDomainIsStale(timeDomain, graph.nodes)) timeDomain = buildTimeDomain(graph.nodes)
      return positionsFrozenTime(visibleNodes, graph.nodes, timeDomain!)
    }
    const pos = positionsFrozenTime(visibleNodes, batchCorpus, batchDomain)
    // positionsFrozenTime reserves NEW_TAIL of x for newer-than-domain arrivals;
    // a batch barely gets any, so stretch the head back over the full axis
    // (post-domain arrivals clamp to the right edge, which is honest enough).
    for (const p of pos.values()) p.x = Math.min(1, p.x / (1 - NEW_TAIL))
    return pos
  })

  const visibleUris = $derived(new Set(visibleNodes.map((n) => n.uri)))
  // A post may be displayed by a node other than itself (run member → run
  // head; collapsed member → representative). Ghosts display themselves.
  const displayNodeOf = (uri: string): string => graph.memberNode.get(uri) ?? uri
  // Derived from the visible set itself (not graph.edges) so links to ghost
  // ancestors — which aren't part of the built graph — draw like any other.
  const visibleEdges = $derived.by(() => {
    const out: { id: string; from: string; to: string }[] = []
    const seen = new Set<string>()
    for (const n of visibleNodes) {
      const p = parentUriOf(n.item)
      const pn = p ? displayNodeOf(p) : undefined
      if (pn && pn !== n.uri && visibleUris.has(pn)) {
        const id = `${n.uri}->${pn}`
        if (!seen.has(id)) {
          seen.add(id)
          out.push({ id, from: n.uri, to: pn })
        }
      }
    }
    return out
  })

  const edgeCount = $derived.by(() => {
    const c = new Map<string, number>()
    for (const e of visibleEdges) c.set(e.to, (c.get(e.to) ?? 0) + 1)
    return c
  })

  // POINTS SPIKE: no reply-tree layout. Every post sits at its TRUE (time,
  // engagement) coordinate, mapped straight across the frame — the honest
  // scatter the semantic axes always promised, with no tidy-tree geometry
  // bending a reply's position away from where it belongs. Reply chains are read
  // in the thread-view dialog, not drawn on the map. The only structure kept is
  // the topic pill: a hub/label anchored over its cluster (the "tree from the
  // topic node"). The collision solver only nudges genuine overlaps apart.
  const pointLayout = $derived.by(() => {
    // The digest panel overlays the right edge when open; keep posts to its left.
    const panelW = showDigest ? Math.min(PANEL_W, w * 0.88) : 0
    const innerW = Math.max(0, w - 2 * PAD_X - panelW)
    const innerH = Math.max(0, h - PAD_TOP - Math.max(PAD_BOTTOM, bottomChrome + 8))
    const present = new Set(visibleNodes.map((n) => n.uri))
    const sx = (x: number) => PAD_X + x * innerW
    const sy = (y: number) => PAD_TOP + y * innerH

    const posts: Target[] = visibleNodes.map((n) => {
      const a = nodeLayout.get(n.uri) ?? { x: 0.5, y: 0.5, sizeRank: 0.5 }
      return {
        id: n.uri,
        tx: sx(a.x),
        ty: sy(a.y),
        r: (MIN_SIZE + a.sizeRank * (MAX_SIZE - MIN_SIZE)) / 2,
        ...(pill ? { hw: pill.w / 2, hh: pill.h / 2 } : {}),
      }
    })

    // Topic pills: anchor over the LOUDEST visible member (smallest y = highest
    // engagement), lifted a touch so the label reads above the cluster rather
    // than on top of the post. Members keep their own true positions — the pill
    // is a hub/label, not a tree that pulls its members together.
    const pillMap = new Map<string, Target>()
    for (const m of topicMembership) {
      const members = [...new Set(m.uris.map((u) => displayNodeOf(u)))].filter((u) => present.has(u))
      if (members.length < 2) continue
      let loudest = members[0]
      for (const u of members)
        if ((nodeLayout.get(u)?.y ?? 1) < (nodeLayout.get(loudest)?.y ?? 1)) loudest = u
      const a = nodeLayout.get(loudest) ?? { x: 0.5, y: 0.5, sizeRank: 0.5 }
      pillMap.set(m.sid, {
        id: m.sid,
        tx: sx(a.x),
        ty: sy(Math.max(0, a.y - 0.04)),
        r: 52,
        ...(pill ? { hw: 52, hh: 14 } : {}),
      })
    }
    return { posts, pills: pillMap }
  })
  const targets = $derived(pointLayout.posts)
  const pillTargets = $derived(pointLayout.pills)

  const nodeByUri = $derived(new Map(visibleNodes.map((n) => [n.uri, n])))

  // Placed = target metadata + live simulation position (fallback to target).
  const placed = $derived.by(() =>
    targets.map((t) => {
      const p = positions.get(t.id)
      return {
        node: nodeByUri.get(t.id) as GraphNode,
        px: p?.x ?? t.tx,
        py: p?.y ?? t.ty,
        size: t.r * 2,
      }
    }),
  )

  const placedByUri = $derived(new Map(placed.map((p) => [p.node.uri, p])))

  /**
   * Which posts are new on screen, so they can be animated IN.
   *
   * This is a RENDER concern, deliberately. Three attempts to make arrivals
   * glide by seeding the simulation off-screen all failed the same way: the
   * layout continuously reconciles positions AND targets to keep trees whole
   * and clear of the frame, so a node held away from its target either gets
   * dragged back (a pop) or has its target dragged out after it (parked in the
   * reservoir for good). The sim now places an arrival at its final spot
   * immediately -- nothing to fight -- and the component animates it in from
   * off-canvas. The layout never knows the animation exists.
   */
  const ARRIVAL_MS = 450
  const arriving = new SvelteSet<string>()
  const arrivalTimers = new Set<ReturnType<typeof setTimeout>>()
  $effect(() => () => {
    for (const t of arrivalTimers) clearTimeout(t)
    arrivalTimers.clear()
  })
  let everPlaced = new Set<string>()
  let hasPainted = false
  $effect(() => {
    const now = new Set(placed.map((p) => p.node.uri))
    for (const uri of now) {
      if (everPlaced.has(uri)) continue
      // The first population has nothing to arrive into; flying the whole graph
      // in from the edges is the load flicker, not an entrance.
      if (hasPainted) {
        arriving.add(uri)
        arrivalTimers.add(setTimeout(() => arriving.delete(uri), ARRIVAL_MS + 120))
      }
    }
    everPlaced = now
    hasPainted = true
  })

  /** Where an arrival comes FROM: outward along its own direction from the
   * centre, far enough to start off-canvas, so it enters from the side it
   * belongs to rather than sliding in from an arbitrary edge. */
  function enterFrom(px: number, py: number) {
    const vx = px - w / 2
    const vy = py - h / 2
    const len = Math.hypot(vx, vy) || 1
    const reach = Math.hypot(w, h) * 0.55
    return { x: Math.round((vx / len) * reach), y: Math.round((vy / len) * reach) }
  }

  // Conversation annotations: each digest conversation, tinted over the centroid
  // of its member nodes that are currently on the canvas. A conversation with no
  // visible members simply isn't drawn (it still lives in the panel). The same
  // color keys the panel swatch and this overlay so they read as one thing.
  // Exclusive conversation membership (each post belongs to the FIRST, i.e.
  // most-active, conversation that claims it). Derived from the digest ALONE —
  // NOT from live positions — so it's stable across sim ticks. The sim inputs
  // below build on this; the render (annotations/topics) reads live positions.
  // Split conversations into pills (2+ posts → a topic node with edges) and
  // captions (a lone post → its label tucked under the node, no pill/edge).
  // Exclusive membership is assigned in one pass so a post can't feed both.
  const topicView = $derived.by(() => {
    const convos = digest.digest?.conversations ?? []
    const claimed = new Set<string>()
    const pills: { id: string; sid: string; label: string; color: string; uris: string[] }[] = []
    const captions = new Map<string, { label: string; color: string }>()
    for (const c of convos) {
      const uris = c.postUris.filter((u) => !claimed.has(u))
      uris.forEach((u) => claimed.add(u))
      if (uris.length === 0) continue
      const color = convoColor(c.id)
      if (uris.length === 1) captions.set(uris[0], { label: c.label, color })
      else pills.push({ id: c.id, sid: `topic:${c.id}`, label: c.label, color, uris })
    }
    return { pills, captions }
  })
  const topicMembership = $derived(topicView.pills)
  const nodeCaptions = $derived(topicView.captions)
  // Node uri → its conversation's digest color, so borders and reply edges can
  // tint by topic. The digest labels OPs, but the tint must flood the WHOLE
  // conversation — edges start from replies, which no pill ever names.
  const topicColorByNode = $derived.by(() => {
    // Group over ALL loaded posts, not just `visible` — a dismissed OP is absent
    // from the planning `convos` but its thread lives on as ghost + replies, and
    // the pill names that dismissed OP. Grouping over allItems keeps the OP a
    // member so its color still finds (and floods) the conversation.
    const colorConvos = buildConversations(allItems, primaryUris)
    const uriConvo = new Map<string, string>()
    for (const c of colorConvos) for (const mem of c.members) uriConvo.set(mem.post.uri, c.id)
    const colorByConvo = new Map<string, string>()
    const paint = (u: string, color: string) => {
      const cid = uriConvo.get(u)
      if (cid && !colorByConvo.has(cid)) colorByConvo.set(cid, color)
    }
    for (const pill of topicMembership) for (const u of pill.uris) paint(u, pill.color)
    for (const [u, c] of nodeCaptions) paint(u, c.color)
    const m = new Map<string, string>()
    // Iterate the rendered set (includes ghosts) so a resurrected OP's own
    // border tints too — not just the live nodes in the built graph.
    for (const n of visibleNodes) {
      const cid = uriConvo.get(n.item.post.uri)
      const color = cid ? colorByConvo.get(cid) : undefined
      if (color) m.set(n.uri, color)
    }
    return m
  })

  // Sim inputs use the members' STABLE target positions (not live ones), so the
  // topic targets don't shift every tick — which would restart the sim forever.
  const targetByUri = $derived(new Map(targets.map((t) => [t.id, t])))
  const topicTargets = $derived.by<Target[]>(() =>
    topicMembership
      .map((m) => {
        // 2+ visible members → the pill is a tree root (positioned by treeLayout);
        // keep its wide collision radius but take the tree position.
        const tree = pillTargets.get(m.sid)
        if (tree) return { ...tree, r: 52 }
        // Fewer than 2 visible → sit at the members' centroid, as before.
        const pts = m.uris.map((u) => targetByUri.get(displayNodeOf(u))).filter((t): t is Target => t != null)
        if (pts.length === 0) return null
        return {
          id: m.sid,
          tx: pts.reduce((s, t) => s + t.tx, 0) / pts.length,
          ty: pts.reduce((s, t) => s + t.ty, 0) / pts.length,
          r: 52, // big collision radius — the topic pill is wide
        }
      })
      .filter((t): t is Target => t !== null),
  )

  // Render: topic nodes + edges positioned from the LIVE sim positions. A
  // conversation with no visible members simply isn't drawn.
  const annotations = $derived.by(() =>
    topicMembership
      .map((m) => {
        const pts = m.uris
          .map((u) => placedByUri.get(displayNodeOf(u)))
          .filter((p): p is NonNullable<typeof p> => p != null)
        if (pts.length === 0) return null
        const cx = pts.reduce((s, p) => s + p.px, 0) / pts.length
        const cy = pts.reduce((s, p) => s + p.py, 0) / pts.length
        const members = pts.map((p) => ({ uri: p.node.uri, x: p.px, y: p.py }))
        return { id: m.id, sid: m.sid, label: m.label, color: m.color, cx, cy, uris: m.uris, members }
      })
      .filter((a): a is NonNullable<typeof a> => a !== null),
  )
  const topics = $derived(
    annotations.map((a) => {
      const p = positions.get(a.sid)
      return { ...a, tx: p?.x ?? a.cx, ty: p?.y ?? a.cy }
    }),
  )

  // The OP a reply should be represented by: its thread root if we've loaded it,
  // else the highest ancestor we DO have (climbing parent links), else the post
  // itself. `ensureThreadRoots` fetches these before a digest so we land on the
  // real OP rather than falling back to a reply.
  function anchorOf(it: FeedItem): FeedItem {
    const root = contextByUri.get(rootUriOf(it))
    if (root) return root
    let cur = it
    const guard = new Set<string>([it.post.uri])
    for (let i = 0; i < 40; i++) {
      const p = parentUriOf(cur)
      if (!p || guard.has(p)) break
      const parent = contextByUri.get(p)
      if (!parent) break
      guard.add(p)
      cur = parent
    }
    return cur
  }

  // What the classifier actually sees. With opsOnly/label mode, a reply is
  // represented by its thread OP (see anchorOf), deduped — so sibling replies +
  // their OP collapse to one clean anchor instead of N noisy "lol yes" lines.
  function classifierInput(items: FeedItem[]): FeedItem[] {
    if (!digest.opsOnly && !digest.labelMode) return items.slice(0, digest.window)
    const seen = new Set<string>()
    const out: FeedItem[] = []
    for (const it of items) {
      const anchor = anchorOf(it)
      if (seen.has(anchor.post.uri)) continue
      seen.add(anchor.post.uri)
      out.push(anchor)
    }
    // Label mode labels posts one-by-one, so front-load the OPs that are on
    // screen right now — their captions land first, on the nodes you're looking
    // at — then take the window from the reordered list (stable within groups).
    if (digest.labelMode) {
      out.sort(
        (a, b) => Number(visibleUris.has(b.post.uri)) - Number(visibleUris.has(a.post.uri)),
      )
    }
    return out.slice(0, digest.window)
  }

  // Fetch the parent chains of the window's replies so opsOnly/label anchoring
  // lands on the real thread OP (root) rather than falling back to the reply.
  // Deduped inside ancestors.ensure, so continuous ticks only pay for new ones.
  async function ensureThreadRoots() {
    if (!digest.opsOnly && !digest.labelMode) return
    await ancestors.ensure(
      feedItems.slice(0, digest.window).filter((i) => parentUriOf(i)).map((i) => i.post.uri),
    )
  }

  async function summarize(openPanel = true) {
    if (openPanel) showDigest = true
    // Pull more pages until we have enough posts to fill the digest window (or
    // the timeline runs out). More posts = richer conversations — the "ICE
    // killing" thread only cohered past ~30 posts — so the digest shouldn't be
    // starved by whatever the node limit happened to load.
    let guard = 0
    while (feedItems.length < digest.window && cursor && !loading && guard++ < 12) {
      await load(true)
    }
    await ensureThreadRoots()
    digest.summarize(classifierInput(feedItems), contextByUri)
  }

  // Auto-digest: run once per session as soon as the feed and a usable provider
  // are both ready. Waits for the deploy config (a locked instance pins its
  // provider/model first) and for the archive (so the rolling digest rehydrates
  // before new labeling). Silent when no provider is reachable — a first-run
  // desktop without Ollama keeps the manual button and no error spam.
  let autoDigested = false
  async function providerReady(): Promise<boolean> {
    if (isDemo()) return true
    if (digest.provider === 'anthropic') return !!digest.apiKey
    await digest.refreshOllamaModels().catch(() => {})
    return digest.ollamaModels.length > 0
  }
  $effect(() => {
    if (autoDigested || !deploy.loaded || !archiveReady || feedItems.length === 0) return
    autoDigested = true
    void providerReady().then((ok) => {
      if (ok) return summarize(false)
    })
  })

  // Click a conversation's exemplar in the panel → pin it and pop its card, so
  // the reference lands you on the actual node in the map. Only ONE panel-focused
  // post is kept at a time: focusing a new one releases the previous focus pin
  // (but leaves posts you pinned by hand alone).
  let focusedPin = $state<string | null>(null)
  async function focusPost(uri: string) {
    if (focusedPin && focusedPin !== uri) pinned.delete(focusedPin)
    // A post can be off-graph two ways: collapsed inside a thread (un-collapse
    // it), or scrolled out of the loaded window entirely. For the latter, revive
    // it from the engine's memory or the archive and inject it as a node.
    if (!nodeByUri.has(uri)) {
      expanded.add(uri)
      if (!allItems.some((i) => i.post.uri === uri)) {
        const item = digest.engine.getItem(uri) ?? (await archive.getPosts([uri])).get(uri)
        if (item) corpus.record([item], 'context') // off-window revival → into the corpus
      }
    }
    pinned.add(uri)
    focusedPin = uri
    setHovered(uri)
  }

  // Topic nodes are draggable layout nodes. A revealed pill is pinned, so
  // dragging it moves its whole conversation (the solver anchors a group to
  // its pinned member); an unrevealed pill moves alone. A plain click pins
  // the topic where it is (like a post); it does NOT open every member's
  // card. Threshold + window listeners mirror PostNode.
  function togglePinUri(id: string) {
    if (pinned.has(id)) pinned.delete(id)
    else pinned.add(id)
  }
  // Click a pill → reveal (or re-hide) ALL its member posts, even the ones the
  // node budget dropped, and pin the pill in place while revealed so it doesn't
  // drift as its posts flow in. Drag still repositions it.
  // uris a reveal added to `expanded` (to un-collapse a thread), so un-reveal can
  // remove exactly those without disturbing threads the user mapped by hand.
  const revealExpanded = new Map<string, string[]>()
  async function toggleReveal(sid: string, convoId: string) {
    if (revealedTopics.has(convoId)) {
      revealedTopics.delete(convoId)
      pinned.delete(sid)
      for (const u of revealExpanded.get(convoId) ?? []) expanded.delete(u)
      revealExpanded.delete(convoId)
      return
    }
    revealedTopics.add(convoId)
    pinned.add(sid)
    // Make good on the pill's count: members that aren't currently nodes are
    // either collapsed inside a thread (un-collapse them) or off the loaded
    // window (revive from the engine/archive), mirroring focusPost.
    const pill = topicMembership.find((m) => m.id === convoId)
    if (!pill) return
    const loaded = new Set(allItems.map((i) => i.post.uri))
    const added: string[] = []
    const toRevive: string[] = []
    for (const u of pill.uris) {
      if (!loaded.has(u)) {
        toRevive.push(u) // off the loaded window → revive below
        continue
      }
      // Un-collapse the member's thread so a reply shows CONNECTED to its parent
      // chain (buildGraph caps a shown thread, so this can't explode).
      if (!expanded.has(u)) {
        expanded.add(u)
        added.push(u)
      }
    }
    revealExpanded.set(convoId, added)
    // Fetch the parent chain of any reply members we don't have yet (no-op for
    // non-replies) so the un-collapsed thread actually has parents to show.
    ancestors.ensure(pill.uris)
    if (toRevive.length) {
      const fromArchive = await archive.getPosts(toRevive).catch(() => new Map<string, FeedItem>())
      const add: FeedItem[] = []
      for (const u of toRevive) {
        const item = digest.engine.getItem(u) ?? fromArchive.get(u)
        if (item && !corpus.has(u)) add.push(item)
      }
      if (add.length) corpus.record(add, 'context') // off-window members → into the corpus
    }
  }
  function onTopicPointerDown(e: PointerEvent, sid: string, convoId: string) {
    e.preventDefault()
    const sx = e.clientX
    const sy = e.clientY
    let moved = false
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return
      moved = true
      onNodeDrag(sid, ev.clientX, ev.clientY)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (moved) onNodeDragEnd(sid)
      else toggleReveal(sid, convoId)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  // Collapse everything: clear hover + all pins (used by a click on empty canvas).
  function clearAll() {
    hovered = null
    focusedPin = null
    pinned.clear()
  }

  // Edges go child (reply) → parent, trimmed to each node's rim and leaving a
  // gap at the parent end for the arrowhead.
  // A quadratic-bezier path from (x1,y1) to (x2,y2), bowed sideways by a control
  // point offset perpendicular to the chord. The bow makes it unambiguous which
  // two nodes an edge joins even when a third node sits on the straight line
  // between them — the edge arcs clear of it rather than passing through.
  function curvePath(x1: number, y1: number, x2: number, y2: number, frac = 0.24, cap = 50) {
    const dx = x2 - x1
    const dy = y2 - y1
    const len = Math.hypot(dx, dy) || 1
    const bow = Math.min(len * frac, cap)
    const cx = (x1 + x2) / 2 - (dy / len) * bow
    const cy = (y1 + y2) / 2 + (dx / len) * bow
    return `M${x1.toFixed(1)},${y1.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`
  }

  // POINTS SPIKE: reply chains aren't drawn on the map — they're read in the
  // thread-view dialog. Suppressing the reply edges keeps the scatter clean (no
  // long connectors between a reply and its far-off parent). Topic edges (pill →
  // members) are drawn separately below and stay. Flip to `false` to compare.
  const SHOW_REPLY_EDGES = false
  const edgeLines = $derived.by(() =>
    (SHOW_REPLY_EDGES ? visibleEdges : [])
      .map((e) => {
        const a = placedByUri.get(e.from) // reply
        const b = placedByUri.get(e.to) // parent
        if (!a || !b) return null
        const dx = b.px - a.px
        const dy = b.py - a.py
        const len = Math.hypot(dx, dy) || 1
        const ux = dx / len
        const uy = dy / len
        return {
          id: e.id,
          from: e.from,
          color: topicColorByNode.get(e.from) ?? '',
          d: curvePath(
            a.px + ux * (a.size / 2),
            a.py + uy * (a.size / 2),
            b.px - ux * (b.size / 2 + 7),
            b.py - uy * (b.size / 2 + 7),
            settings.curvedEdges ? 0.24 : 0,
          ),
        }
      })
      .filter((l): l is NonNullable<typeof l> => l !== null),
  )

  const edgeColors = $derived(new Set(edgeLines.map((l) => l.color).filter(Boolean)))

  function arrowId(color: string) {
    return color ? `arrow-${color.replace(/[^a-zA-Z0-9]/g, '')}` : 'reply-arrow'
  }

  function cardPos(p: { px: number; py: number; size: number }) {
    let x = p.px + p.size / 2 + 12
    if (x + CARD_W > w) x = p.px - p.size / 2 - 12 - CARD_W
    if (x < 8) x = 8
    // y is just an anchor; the card clamps its own top by its measured height.
    const y = Math.max(8, p.py - p.size / 2)
    return { x, y }
  }

  // A card is shown for the hovered post and for every pinned post (so a pinned
  // post stays readable, not just its avatar). Deduped by uri.
  const cards = $derived.by(() => {
    const uris = new Set<string>(pinned)
    if (hovered) uris.add(hovered)
    const out: { node: GraphNode; x: number; y: number }[] = []
    for (const uri of uris) {
      const p = placedByUri.get(uri)
      if (!p) continue
      const { x, y } = cardPos(p)
      out.push({ node: p.node, x, y })
    }
    return out
  })

  // Open the per-user archive and rehydrate the rolling digest from it, so a
  // continuous digest survives reloads and keeps its whole history (Phase A).
  $effect(() => {
    const did = session.did
    if (!did) {
      // <Graph> only mounts once logged in, so a missing did here means it's
      // still resolving — wait (this effect re-runs when it lands) so the
      // archive/restore path runs, rather than preempting it with a live load.
      // Boot live only if there's genuinely no session/archive to restore from.
      if (session.status === 'logged-out') void boot()
      return
    }
    archive
      .open(did)
      .then(async () => {
        // Persist anything the corpus mirrored before the DB opened (the initial
        // load + any context fetched in that window); the write-through no-op'd
        // then. Idempotent, so it's safe even when nothing needs catching up.
        await corpus.flushToArchive()
        await digest.engine.rehydrate()
        archiveReady = true
        // Paint the last on-screen feed from local data, then refresh live.
        await boot()
        // Snapshot the follows list for the corpus (network-over-time). Runs
        // once per session in the background; recordFollows skips if unchanged.
        archive.recordFollows(await getFollowDids(did)).catch(() => {})
        // Gap-healing backfill: page the timeline backward to import history
        // from before this session (throttled; stops at the archived boundary).
        backfilling = true
        backfill(APP_MOUNT, { onProgress: (r) => (backfillStatus = r) })
          .then((r) => (backfillStatus = r))
          .catch(() => {})
          .finally(() => (backfilling = false))
      })
      .catch(() => {
        /* archive unavailable (private mode / no IndexedDB) — the digest still
           works in-memory, just not persisted. Still load the feed live. */
        void boot()
      })
  })

  // Persist the loaded feed so a reload paints exactly it (reload-paint).
  // Debounced; each entry carries the post uri + its reposter (rebuilt on
  // restore from the profile cache). Capped so a deep-paged session can't bloat
  // the single snapshot row.
  $effect(() => {
    if (!archiveReady) return
    // Establish reactive deps cheaply, but build the snapshot arrays only when
    // the debounce actually fires — so corpus.contextItems (O(mirror)) isn't
    // scanned on every feed/context change, just once per settle.
    void items.length
    void cursor
    void corpus.contextCount
    const t = setTimeout(() => {
      if (items.length === 0) return
      const entries = items.slice(0, 500).map((i) => ({ uri: i.post.uri, reposterDid: reposterProfile(i)?.did }))
      // Also snapshot the on-screen context (ancestors/thread posts) so a reload
      // paints edges + tree positions immediately, not a beat behind the nodes.
      const context = corpus.contextItems.slice(0, 500).map((i) => i.post.uri)
      void archive.putFeedSnapshot(entries, cursor, context)
    }, 1000)
    return () => clearTimeout(t)
  })

  // Poll archive stats while the config popover is open, so the corpus counts
  // update live as the feed loads and backfill pages in.
  $effect(() => {
    if (!showConfig) return
    const tick = () => archive.stats().then((s) => (archiveStats = s)).catch(() => {})
    tick()
    const id = setInterval(tick, 1500)
    return () => clearInterval(id)
  })

  async function exportArchive() {
    const json = await archive.exportJSON()
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `mothtrap-corpus-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── layout lifecycle ──────────────────────────────────────────────────────
  // The solver returns final positions synchronously; motion is a render
  // concern. paint() glides the previously painted positions to each new
  // answer over a few hundred ms — the same division of labour as the arrival
  // animation, which is the one piece of motion work here that worked on the
  // first attempt. Exceptions that paint immediately: the very first solve
  // (there is nothing on screen to glide FROM — easing the whole graph in
  // from nowhere was the load flicker), every solve during a drag (the
  // neighbours must flow in real time, not 400ms behind the pointer), and
  // reduced-motion users.
  let layout: Layout | undefined
  let draggingUri: string | null = null
  let tweenRaf = 0
  // Read per paint, not captured at mount: the CSS side (PostNode's entrance)
  // honours a mid-session reduce-motion change via media query, and the two
  // motion systems must not disagree. One matchMedia call per solve is free.
  const reducedMotion = () =>
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

  function paint(solved: Map<string, { x: number; y: number }>) {
    cancelAnimationFrame(tweenRaf)
    // The glide duration is the "Post motion" slider (settings.motionMs), the same
    // knob PostNode's entrance reads via --arrive-dur — so the two motion systems
    // stay in step. Read untracked (paint runs inside untrack), so it just samples
    // the current value per solve; a mid-session change lands on the next solve.
    const dur = settings.motionMs
    // Nothing moved far enough to see: skip the tween, not because it would
    // look wrong but because 400ms of rAF re-renders for sub-pixel motion is
    // pure heat. This is the common case — most updates change data, not
    // geometry.
    let still = positions.size > 0
    if (still) {
      for (const [id, to] of solved) {
        const f = positions.get(id)
        if (!f || Math.abs(to.x - f.x) > 0.5 || Math.abs(to.y - f.y) > 0.5) {
          still = false
          break
        }
      }
    }
    if (still || draggingUri || positions.size === 0 || reducedMotion() || dur <= 0) {
      positions = solved
      return
    }
    const from = new Map(positions)
    const t0 = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / dur)
      const e = 1 - (1 - t) ** 3 // ease-out cubic: fast start, gentle landing
      const next = new Map<string, { x: number; y: number }>()
      for (const [id, to] of solved) {
        const f = from.get(id)
        // A node with no previous position is an arrival: paint it at its
        // final spot at once — PostNode's own entrance animates it in.
        next.set(id, f ? { x: f.x + (to.x - f.x) * e, y: f.y + (to.y - f.y) * e } : to)
      }
      positions = next
      if (t < 1) tweenRaf = requestAnimationFrame(step)
    }
    tweenRaf = requestAnimationFrame(step)
  }

  $effect(() => {
    // untrack: paint() reads `positions` to decide whether to tween, and the
    // solver calls it synchronously from inside the update effect below.
    // Untracked, or that read-write on the same $state is a dependency cycle
    // (effect_update_depth_exceeded — found the hard way, twice).
    const l = new Layout(() => untrack(() => paint(l.positions())))
    layout = l
    return () => cancelAnimationFrame(tweenRaf)
  })

  // Re-solve when targets change — EXCEPT on a pure shrink during a batch.
  // Targets are frozen per batch, but the SOLVER's equilibrium is a function of
  // the whole set: remove one post and everything it was pushing against settles
  // back toward its own target — a small global reshuffle on every dismiss. So
  // while the batch and frame are unchanged: a dismissal (ids only removed)
  // skips the re-solve entirely (survivors hold their exact solved positions;
  // the hole is the point), and newcomers (an expanded thread) are solved with
  // every already-placed node HELD, so they land collision-free without moving
  // anyone. A frame change (resize, digest panel, pill width) or a batch change
  // (refill — the deliberate reflow moment) does a full solve as before.
  let solvedFor = new Set<string>()
  let solvedSig = ''
  let solvedBatch: Set<string> | null = null
  $effect(() => {
    const t = [...targets, ...topicTargets]
    layout?.setCollision(pill ? pill.gap : null) // rectangles vs circles
    // POINTS SPIKE: no reservoir bleed — the solver keeps everything inside the
    // frame (targets are already frame-mapped), so nothing lands off-screen.
    layout?.setBounds(w, h, 18, Math.max(24, bottomChrome), 0, 0)
    const sig = `${w}|${h}|${bottomChrome}|${showDigest ? 1 : 0}|${pill ? pill.w : 0}`
    const ids = new Set(t.map((x) => x.id))
    if (batch !== null && batch === solvedBatch && sig === solvedSig) {
      const hasNew = t.some((x) => !solvedFor.has(x.id))
      if (!hasNew) {
        solvedFor = ids
        return // pure shrink — freeze
      }
      const hold = new Set(pinned)
      for (const id of solvedFor) if (ids.has(id)) hold.add(id)
      solvedFor = ids
      layout?.update(t, hold)
      return
    }
    solvedBatch = batch
    solvedSig = sig
    solvedFor = ids
    layout?.update(t, new Set(pinned))
  })

  // Measure the bottom UI chrome (gear bottom-left, Digest/Load-more
  // bottom-right) and reserve a keep-out in just those corners so nodes stop
  // hiding behind them — the bottom-center stays open. Re-measures on resize and
  // when the load-more label changes width.
  $effect(() => {
    void w
    void h
    void loading
    // The gear/hud widen as their labels change (node count, dismissed count),
    // so re-measure on those too, or the keep-out goes stale.
    void visibleNodes.length
    void total
    void read.dismissed.size
    if (!graphEl) return
    const g = graphEl.getBoundingClientRect()
    // The whole bottom bar is OFF-CANVAS, uniformly — like the top bar. The
    // old per-corner keep-out made the clamp boundary discontinuous at the
    // corner edges, and nodes crossing that x-line flip-flopped between two
    // bottom bounds (sim vs clamp, every tick — visible jitter).
    let inset = 0
    // The bar's true top edge, kept separate from the sim's keep-out. The
    // keep-out adds 10px of breathing room, which is right for nodes and wrong
    // for the digest panel: reusing it left an 18px strip between panel and bar
    // with the graph showing through.
    let barTop = 0
    const gr = gearEl?.getBoundingClientRect()
    if (gr) {
      barTop = Math.max(barTop, g.bottom - gr.top)
      inset = Math.max(inset, g.bottom - gr.top + 10)
    }
    const hr = hudEl?.getBoundingClientRect()
    if (hr) {
      barTop = Math.max(barTop, g.bottom - hr.top)
      inset = Math.max(inset, g.bottom - hr.top + 10)
    }
    bottomChrome = inset
    bottomBar = barTop
  })

  // Connect replies: pull in the parents of any loaded reply we don't have yet
  // (skipping dismissed ones). As fetched parents reveal their own parents, this
  // climbs the chain toward the thread root over successive runs.
  $effect(() => {
    if (!settings.connectReplies && !settings.replyChains) return
    const present = new Set(allItems.map((i) => i.post.uri))
    // A reply whose immediate parent isn't loaded → fetch its WHOLE ancestor
    // chain in one call (ancestors.ensure resolves the full chain to root).
    const wanted = new Set<string>()
    for (const it of allItems) {
      const p = parentUriOf(it)
      // Dismissed parents are fetched too — they return as dimmed ghosts so a
      // visible reply always has its chain.
      if (p && !present.has(p)) wanted.add(it.post.uri)
    }
    if (wanted.size) ancestors.ensure([...wanted])
  })

  // Any author about to render dashed (unfollowed) gets their follow state
  // verified against the authoritative profile record, once per session —
  // so a feed/thread response that omitted viewer.following can't leave a
  // followed account falsely dashed.
  $effect(() => {
    const suspects = visibleNodes
      .map((n) => n.item.post.author)
      .filter((a) => a.did !== session.did && !follows.following(a))
    if (suspects.length) follows.verify(suspects)
  })

  // Stock the pool BETWEEN batches: when the plan can't fill the budget and more
  // can be fetched, pull the next page. Gated to batch === null — during a batch
  // the count only drains (that's the point), so fetching to top it up would
  // page through the entire feed for posts the filter holds invisible anyway.
  $effect(() => {
    if (!loading && cursor && total < budget && batch === null) load(true)
  })

  // Feed switch: when the user picks a different feed tab, clear the loaded feed
  // and reload from scratch. The FIRST load is boot()'s job (reload-paint), so
  // skip the initial run — this only fires on an actual change of `feeds.active`.
  let lastFeed = feeds.active
  $effect(() => {
    const f = feeds.active
    if (f === lastFeed) return
    lastFeed = f
    items = []
    cursor = undefined
    turnoverOffset = 0
    batch = null // new feed, new batch (the capture effect takes a fresh one)
    // A different feed's time span is unrelated to the frozen domain: drop it so
    // the next layout rebuilds from the new corpus rather than mapping every post
    // through a stale range (which can collapse them onto one column).
    timeDomain = null
    load(false)
  })

  // Auto-cycle timer: while on, rotate the queue one step per interval.
  // (Mix mode has no meaningful rotation, so it only applies to top/recent.)
  $effect(() => {
    if (!settings.autoCycle || settings.selectMode === 'mix' || total <= budget) return
    const n = total
    const id = setInterval(
      () => {
        turnoverOffset = (turnoverOffset + 1) % n
      },
      Math.max(1, settings.cycleInterval) * 1000,
    )
    return () => clearInterval(id)
  })

  // Live updates: poll the newest page every 60s and slide in genuinely-new
  // posts (deduped). Toggle in the config popover; persisted.
  async function pollNew() {
    if (loading) return
    try {
      const page = await getFeedPage(feeds.active)
      void corpus.record(page.items, undefined, feeds.active)
      const have = new Set(items.map((i) => i.post.uri))
      const fresh = page.items.filter((i) => !have.has(i.post.uri))
      if (fresh.length) items = [...fresh, ...items]
    } catch {
      // Transient; the next tick retries.
    }
  }

  $effect(() => {
    if (!settings.livePoll) return
    const id = setInterval(pollNew, 60_000)
    return () => clearInterval(id)
  })

  // Auto-update is EVENT-driven, not clock-driven: any growth of the feed
  // (live poll, Load more, a mapped thread) debounce-triggers an ingest, so a
  // new post's label chases it onto the page within about a second instead of
  // waiting out a timer. The uri→label cache means each trigger pays only for
  // genuinely new posts. The old 60s tick stays as a fallback floor — it
  // catches a batch that landed while an ingest was already running (the
  // trigger's loading-guard skips those) and replies whose thread root arrived
  // late. Ticks with nothing new are cache-hits, near-free.
  const DIGEST_FALLBACK_MS = 60_000
  async function runDigestTick() {
    if (loading || digest.loading || feedItems.length === 0) return
    // First establish fills the window so the initial clustering is rich.
    if (digest.engine.clusters.length === 0) {
      let guard = 0
      while (feedItems.length < digest.window && cursor && !loading && guard++ < 12) {
        await load(true)
      }
    }
    await ensureThreadRoots()
    await digest.summarize(classifierInput(feedItems), contextByUri)
  }
  $effect(() => {
    if (!digest.continuous) return
    void feedItems.length // re-arm on any feed growth (poll, Load more, threads)
    // Debounce: a poll batch lands as one items assignment, but Load-more loops
    // and thread fetches can land several within a second — label once.
    const t = setTimeout(runDigestTick, 800)
    return () => clearTimeout(t)
  })
  $effect(() => {
    if (!digest.continuous) return
    const id = setInterval(runDigestTick, DIGEST_FALLBACK_MS)
    return () => clearInterval(id)
  })

  // ── boot / reload-paint ───────────────────────────────────────────────────
  let booted = false
  /** Rebuild the last on-screen feed from the archive (post content + repost
   * attribution) so the graph paints from local data before the network answers. */
  async function reconstructFeed(snap: FeedSnapshot): Promise<FeedItem[]> {
    const posts = await archive.getPosts(snap.entries.map((e) => e.uri))
    const reposterDids = [...new Set(snap.entries.map((e) => e.reposterDid).filter((d): d is string => !!d))]
    const profs = reposterDids.length ? await archive.getProfiles(reposterDids) : new Map()
    return reconstructFeedItems(snap, posts, profs)
  }
  /** Runs once: paint the last feed from the archive if we have one, then fetch
   * live and MERGE fresh posts on top; otherwise just do a normal live load. */
  async function boot() {
    if (booted) return
    booted = true
    let restored = false
    if (archive.ready) {
      try {
        const snap = await archive.getFeedSnapshot()
        if (snap?.entries.length) {
          // Resolve feed AND context from the archive BEFORE touching any state,
          // then mutate in one synchronous batch — so the first render already
          // has edges + tree positions, with no bare-nodes flash. Without the
          // context, the graph would show nodes, then reflow a beat later when
          // the ancestors re-fetch over the network.
          const feed = await reconstructFeed(snap)
          const ctx = snap.context?.length ? await archive.getPosts(snap.context) : undefined
          if (feed.length) {
            // Mirror-only: these posts are already archived (getPosts read them
            // from disk), so ingest without a redundant write that would log a
            // phantom context surfacing at reload time.
            if (ctx?.size) corpus.ingest([...ctx.values()], 'context')
            items = feed
            cursor = snap.cursor
            restored = true
          }
        }
      } catch {
        /* missing/corrupt snapshot — fall through to a live load */
      }
    }
    if (restored) await pollNew() // fresh posts slide in over the painted feed
    else await load(false)
  }

  async function load(append: boolean) {
    if (loading) return
    loading = true
    error = undefined
    try {
      const page = await getFeedPage(feeds.active, append ? cursor : undefined)
      void corpus.record(page.items, undefined, feeds.active)
      items = append ? [...items, ...page.items] : page.items
      cursor = page.cursor
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load timeline'
    } finally {
      loading = false
    }
  }

  function open(node: GraphNode) {
    window.open(bskyUrl(node.item), '_blank', 'noopener')
  }

  function togglePin(node: GraphNode) {
    if (pinned.has(node.uri)) pinned.delete(node.uri)
    else pinned.add(node.uri)
  }

  // Dragging a node holds it under the pointer (the sim flows around it).
  // Releasing lets it drift back to its semantic spot — unless it's pinned
  // (by a normal click), in which case it stays where it was dropped.
  let graphEl: HTMLDivElement
  /**
   * Pan and zoom. The simulation is untouched -- it keeps working in graph
   * coordinates and knows nothing about the view -- so panning cannot disturb
   * the layout the way seeding the sim off-screen did.
   */
  const view = $state({ x: 0, y: 0, k: 1 })
  const ZOOM_MIN = 0.35
  const ZOOM_MAX = 2.5
  const atRest = $derived(view.x === 0 && view.y === 0 && view.k === 1)

  /** Screen point -> graph coordinates, the inverse of the layer's transform.
   * Anything reading pointer positions has to go through this now. */
  function toGraph(clientX: number, clientY: number) {
    const r = graphEl.getBoundingClientRect()
    return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k }
  }

  function recentre() {
    view.x = 0
    view.y = 0
    view.k = 1
  }

  const CHROME_SELECTOR = '.wrap, .card, .config-wrap, .hud, .panel, .digest-btn, .topic-node, .coverage'

  function onWheel(e: WheelEvent) {
    if (!graphEl) return
    // Everything scrollable lives inside .graph -- the post card, the digest
    // panel, the settings popover. Zooming unconditionally swallowed their
    // wheel events, so a long card could not be scrolled at all: the graph
    // zoomed out underneath instead. Every other canvas handler already guards
    // on the target; this one did not.
    if ((e.target as HTMLElement).closest(CHROME_SELECTOR)) return
    e.preventDefault()
    const r = graphEl.getBoundingClientRect()
    const px = e.clientX - r.left
    const py = e.clientY - r.top
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, view.k * Math.exp(-e.deltaY * 0.0015)))
    // Keep the point under the cursor fixed, so zoom feels like it happens where
    // you are looking rather than at the origin.
    view.x = px - ((px - view.x) / view.k) * next
    view.y = py - ((py - view.y) / view.k) * next
    view.k = next
  }

  /**
   * Canvas pan + pinch-zoom (#42). Pointers that start on the EMPTY canvas are
   * tracked here (screen coords relative to graphEl): one finger pans, two
   * pinch-zoom. Nodes, cards and chrome keep their own handlers — the target
   * guard means a gesture never starts on top of them. Touch reaches this only
   * because `.graph` is `touch-action: none`, so the browser doesn't claim a
   * two-finger gesture as page-zoom.
   */
  const canvasPointers = new Map<number, { x: number; y: number }>()
  let pan: { sx: number; sy: number; vx: number; vy: number; moved: boolean } | null = null
  let pinch: { dist: number; mx: number; my: number; vx: number; vy: number; vk: number } | null = null
  let canvasRelease: (() => void) | null = null

  function canvasXY(e: PointerEvent) {
    const r = graphEl.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  function startPan() {
    const [p] = [...canvasPointers.values()]
    pan = { sx: p.x, sy: p.y, vx: view.x, vy: view.y, moved: false }
    pinch = null
  }
  function startPinch() {
    const [a, b] = [...canvasPointers.values()]
    pinch = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2,
      vx: view.x,
      vy: view.y,
      vk: view.k,
    }
    pan = null
  }

  function onCanvasPointerDown(e: PointerEvent) {
    if (e.button !== 0) return
    const t = e.target as HTMLElement
    if (t.closest('.wrap, .card, .config-wrap, .hud, .panel, .digest-btn, .topic-node')) return
    canvasPointers.set(e.pointerId, canvasXY(e))
    if (canvasPointers.size === 1) startPan()
    else if (canvasPointers.size === 2) startPinch()
    if (!canvasRelease) {
      window.addEventListener('pointermove', onCanvasMove)
      window.addEventListener('pointerup', onCanvasUp)
      window.addEventListener('pointercancel', onCanvasUp)
      // pointercancel matters on touch: a cancelled gesture must release, or the
      // listeners survive with stale pointers and every later touch mis-tracks.
      canvasRelease = () => {
        window.removeEventListener('pointermove', onCanvasMove)
        window.removeEventListener('pointerup', onCanvasUp)
        window.removeEventListener('pointercancel', onCanvasUp)
        canvasPointers.clear()
        pan = null
        pinch = null
        canvasRelease = null
      }
    }
  }

  function onCanvasMove(e: PointerEvent) {
    if (!canvasPointers.has(e.pointerId)) return
    canvasPointers.set(e.pointerId, canvasXY(e))
    if (pinch && canvasPointers.size >= 2) {
      const [a, b] = [...canvasPointers.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      const k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pinch.vk * (dist / pinch.dist)))
      // The graph point under the pinch's START midpoint stays under the CURRENT
      // midpoint, so it zooms/pans about the fingers, not the origin (same
      // fixed-point trick as the wheel zoom).
      const gx = (pinch.mx - pinch.vx) / pinch.vk
      const gy = (pinch.my - pinch.vy) / pinch.vk
      view.x = mx - gx * k
      view.y = my - gy * k
      view.k = k
    } else if (pan && canvasPointers.size === 1) {
      const p = canvasPointers.get(e.pointerId)!
      const dx = p.x - pan.sx
      const dy = p.y - pan.sy
      if (!pan.moved && Math.hypot(dx, dy) < 4) return
      pan.moved = true
      view.x = pan.vx + dx
      view.y = pan.vy + dy
    }
  }

  function onCanvasUp(e: PointerEvent) {
    if (!canvasPointers.delete(e.pointerId)) return
    // Re-anchor on every drop so the surviving fingers don't inherit a stale
    // base: ≥2 left → re-seat the pinch on the current pair (a 3-finger lift
    // would otherwise jump); exactly 1 left → hand off to a pan without the view
    // jumping; 0 left → release the window listeners.
    if (canvasPointers.size >= 2) startPinch()
    else if (canvasPointers.size === 1) startPan()
    else canvasRelease?.()
  }

  $effect(() => () => canvasRelease?.())

  function onNodeDrag(uri: string, clientX: number, clientY: number) {
    const p = toGraph(clientX, clientY)
    // Flagged BEFORE the solve so paint() skips the tween: neighbours must
    // flow around the pointer live, not 400ms behind it.
    draggingUri = uri
    layout?.dragTo(uri, p.x, p.y)
  }
  function onNodeDragEnd(uri: string) {
    draggingUri = null
    // No re-solve on release: the node rests at the drop point so a follow-up
    // click can pin it THERE; the next data update returns an unpinned node
    // to its semantic spot (see Layout.dragEnd).
    layout?.dragEnd(uri)
  }

  // Expansion is keyed by the clicked post's own uri (stable as the group grows);
  // buildGraph expands a conversation if any of its members' uri is in `expanded`.
  // The fetch is scoped to the clicked post (its replies + its ancestor chain),
  // not the whole root thread, so mapping stays about the post you clicked.
  function toggleMapReplies(item: FeedItem) {
    const uri = item.post.uri
    if (expanded.has(uri)) {
      expanded.delete(uri)
      pinned.delete(uri) // release the anchor on un-map
    } else {
      expanded.add(uri)
      // Anchor the newly-full conversation at the clicked post's CURRENT spot,
      // exactly as revealing a topic pill does (pinned → #anchorHeldGroups shifts
      // the whole tree's targets around it). Without this, the conversation lays
      // its tidy-tree at its SEMANTIC position and flings the chain away from the
      // click (#65). Un-map releases the pin.
      pinned.add(uri)
      threads.ensure(uri) // pull replies not already in the timeline
    }
  }
  function repliesMapped(item: FeedItem): boolean {
    // Must mirror toggleMapReplies' own condition (expanded.has), or the button
    // LABEL and its ACTION disagree. Reading the graph node's `expanded` flag was
    // the bug: buildGraph sets it true for planner-selected 'full' posts the user
    // never mapped, so the button read "Hide replies" while clicking it SHOWED
    // them (the click hit the `else`/add branch). (#52)
    return expanded.has(item.post.uri)
  }

  // Why a post is in the graph, shown on its card. Pulled-in context always
  // explains itself (an unfamiliar face should never be a mystery); ordinary
  // timeline/own posts are only labeled in Debug mode, where the line also
  // click-copies the raw post JSON.
  const ownUris = $derived(new Set(compose.injected.map((i) => i.post.uri)))
  const timelineUris = $derived(new Set(feedItems.map((i) => i.post.uri)))
  function whyHere(node: GraphNode): string | undefined {
    const uri = node.uri
    if (ownUris.has(uri)) return settings.debugMode ? 'your post' : undefined
    if (timelineUris.has(uri)) {
      // A reason we couldn't attribute (no reposter name) would otherwise
      // masquerade as a plain timeline post — call it out regardless of mode.
      if (node.item.reason && !reposter(node.item)) return 'in your timeline — unattributed repost'
      return settings.debugMode ? 'in your timeline' : undefined
    }
    if (threads.posts.some((p) => p.post.uri === uri)) return 'from a mapped thread'
    return 'context — a post upstream of your timeline'
  }

  // ─── Undo-last (#84) ──────────────────────────────────────────────────────
  // A single reversible action — the LAST dismiss or react — recoverable for a
  // short window, then gone. This is misfire recovery, deliberately NOT
  // un-dismiss or a reaction editor: it reverses a *mistake*, it does not reopen
  // a *decision*. Dismiss-is-forever and react-is-final stay intact as
  // contracts; there's no history, no redo (both non-goals). Only the most
  // recent action is undoable — each new one overwrites the single slot below.
  type UndoRecord =
    | { kind: 'dismiss'; uris: string[] }
    | { kind: 'react'; uris: string[]; target: string; reaction: ReactionKind; prevReaction?: Reaction }
  // null = nothing to undo (never acted, already undone, or the TTL lapsed).
  let undoLast = $state<UndoRecord | null>(null)
  let undoTimer: ReturnType<typeof setTimeout> | undefined
  // The undo window. It MUST stay strictly under the sync push debounce (10s,
  // #83): an undone reaction is reversed BEFORE its debounced push ever fires,
  // so the blip never leaves the device and no reaction tombstone is needed to
  // propagate the clear cross-device (see reactions.restore). Do not raise this
  // to — let alone past — the debounce, or an already-pushed reaction could need
  // a tombstone the sync layer no longer carries.
  const UNDO_TTL = 5_000

  // Arm (or re-arm) the undo affordance for `rec`, resetting its TTL. Any prior
  // record is simply dropped — last-action-only, by construction of the one slot.
  function armUndo(rec: UndoRecord) {
    undoLast = rec
    clearTimeout(undoTimer)
    undoTimer = setTimeout(() => (undoLast = null), UNDO_TTL)
  }

  // Reverse the captured action: bring the dismissed set back, and for a react
  // also revert the reaction row to its prior state (usually cleared). One-shot
  // — consumed, and the toast dismissed with it.
  function undo() {
    const rec = undoLast
    if (!rec) return
    if (rec.uris.length) read.restoreMany(rec.uris)
    if (rec.kind === 'react') reactions.restore(rec.target, rec.prevReaction)
    clearTimeout(undoTimer)
    undoLast = null
  }

  // Returns the URIs this call actually newly-dismissed (for undo capture).
  function dismiss(uri: string): string[] {
    // Dismiss the post and every reply hanging off it — "I'm done with this
    // thread". (With chains always drawn, single-post dismissal would just
    // ghost the node in place, since its own replies keep it needed — d would
    // appear to do nothing.) Ghosts serve the other direction: an ancestor
    // dismissed EARLIER resurfaces dimmed when new replies arrive needing it.
    const all = [uri, ...threadDescendants(allItems, uri)]
    // Only the posts THIS call newly dismisses are ours to undo — anything a
    // prior action already dismissed must STAY dismissed if this one is undone,
    // so undo restores just the fresh set, not the whole subtree (dismissMany
    // itself skips the dupes). Captured before the write, while isDismissed
    // still says no.
    const added = all.filter((u) => !read.isDismissed(u))
    read.dismissMany(all)
    if (hovered && all.includes(hovered)) hovered = null
    // Arm the undo, unless nothing changed — no affordance for a pure no-op.
    // react() calls through here first and then overrides this with its own
    // richer record, so a plain dismiss lands as 'dismiss' and a rate as 'react'.
    if (added.length) armUndo({ kind: 'dismiss', uris: added })
    return added
  }

  // Private thumbs up/down (#66). Local-only — never sent to Bluesky. Attributed
  // to the DISPLAYED post's author (Q1: a per-author signal, so a mixed rep node
  // tags the rep's author, not the whole chain), then dismissed (Q2: you've made
  // your call, move on). The reaction persists in the reactions store even after
  // dismissal, so a resurfaced ghost keeps its mark.
  function react(uri: string, kind: ReactionKind) {
    const did = contextByUri.get(uri)?.post.author.did
    // Snapshot the reaction row as it stands BEFORE we touch it, so undo can
    // restore the EXACT prior state: usually there was none (undo deletes the
    // row — most reacted posts are first-time), but a flip (up→down) restores
    // the old row verbatim. A shallow copy detaches it from the live map entry.
    const before = reactions.byUri.get(uri)
    const prevReaction = before ? { ...before } : undefined
    if (did) reactions.react(uri, did, kind)
    const added = dismiss(uri) // also arms a 'dismiss' undo — we override it next
    // React is the true origin: its undo reverses BOTH effects (the dismissal
    // AND the reaction), so re-arm over dismiss's record. `target` is the reacted
    // post itself — kept apart from `uris` because a react on an already-dismissed
    // ghost leaves `added` empty yet its reaction row still needs reverting.
    armUndo({ kind: 'react', uris: added, target: uri, reaction: kind, prevReaction })
  }

  // Dismiss a whole conversation from its topic node: every member post (plus
  // reply subtrees) is marked read at once.
  function dismissTopic(convoId: string) {
    // The pill vanishes once dismissed, so its onmouseleave never fires — clear
    // the hover ourselves, or `hoveredTopic` stays stuck on the gone topic and
    // swallows every later `d` press (the topic branch of onKey wins over the
    // post-dismiss branch).
    hoveredTopic = null
    const m = topicMembership.find((t) => t.id === convoId)
    if (!m) return
    const all = new Set<string>()
    for (const u of m.uris) {
      all.add(u)
      for (const d of threadDescendants(allItems, u)) all.add(d)
    }
    read.dismissMany([...all])
    revealedTopics.delete(convoId)
    pinned.delete(`topic:${convoId}`) // mirror toggleReveal's pin so it doesn't leak
    if (hovered && all.has(hovered)) hovered = null
  }

  // Touch has no hover, so taps carry the whole contract: first tap opens the
  // card (read-only, sticky — PostNode suppresses synthetic hover for touch),
  // a second tap on the same node pins it, tap-outside dismisses (clearAll).
  const coarsePointer =
    typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches

  // Distinguish single click (pin the node) from double click (open on bsky.app):
  // a lone click waits ~220ms for a possible double.
  let clickTimer: ReturnType<typeof setTimeout> | undefined
  function onNodeClick(node: GraphNode) {
    clearTimeout(clickTimer)
    if (coarsePointer) {
      // One gesture, one meaning: a tap always shows that post. Closing is
      // tapping anywhere else, dismissing is the ✕ on the card. A repeat tap
      // used to pin — a pointer-era idea that exists to survive hover-out,
      // which touch doesn't have — so the same gesture meant two things
      // depending on state you couldn't see.
      setHovered(node.uri)
      return
    }
    clickTimer = setTimeout(() => togglePin(node), 220)
  }
  function onNodeDblClick(node: GraphNode) {
    clearTimeout(clickTimer)
    open(node)
  }

  function nextBatch() {
    if (total > budget) turnoverOffset = (turnoverOffset + budget) % total
  }

  // ON-SCREEN placed nodes, left→right along the time axis (older → newer).
  // Scoped to the visible frame so keyboard/swipe navigation only ever steps to
  // posts you can actually see — a node panned/zoomed off-frame (screen pos
  // outside 0..w × 0..h after the view transform) is not a nav target.
  function timeOrder() {
    return [...placed]
      .filter((p) => {
        const sx = p.px * view.k + view.x
        const sy = p.py * view.k + view.y
        return sx >= 0 && sx <= w && sy >= 0 && sy <= h
      })
      .sort((a, b) => a.px - b.px)
  }

  // Move the selection along the time axis (x): dir -1 = older/left, +1 =
  // newer/right, matching the "older · newer →" axis. `from` is the origin uri
  // (keyboard uses the current `hovered`; a swipe passes the swiped node). With
  // no origin an arrow jumps to the extreme it points at — → newest, ← oldest.
  function navigate(dir: 1 | -1, from: string | null = hovered) {
    const order = timeOrder()
    if (!order.length) return
    const cur = from ? order.findIndex((p) => p.node.uri === from) : -1
    const next =
      cur === -1
        ? dir === 1
          ? order.length - 1
          : 0
        : Math.max(0, Math.min(order.length - 1, cur + dir))
    keyboardSelect(order[next].node.uri)
  }

  // The post the keyboard sweep should land on after `uri` (and its reply subtree)
  // leave the graph: the next on-screen survivor forward, else the nearest back.
  // Captured BEFORE the dismiss removes them. On-screen only (via timeOrder).
  function nextSurvivor(uri: string): string | null {
    const order = timeOrder()
    const i = order.findIndex((p) => p.node.uri === uri)
    if (i === -1) return null
    const gone = new Set([uri, ...threadDescendants(allItems, uri)])
    const survivor = (list: typeof order) => list.find((p) => !gone.has(p.node.uri))?.node.uri ?? null
    return survivor(order.slice(i + 1)) ?? survivor(order.slice(0, i).reverse())
  }

  // Rate the hovered post AND advance to the next (the y/n · f/s · ↑/↓ fast-sweep):
  // rate, dismiss, and hand the selection to the next survivor so the sweep flows
  // post→post without reaching for the mouse.
  function rateAndAdvance(uri: string, kind: ReactionKind) {
    const next = nextSurvivor(uri)
    react(uri, kind)
    if (next) keyboardSelect(next)
  }

  // Dismiss the hovered post AND advance — `d` joins the same sweep as the rate
  // keys (clear, no judgment, next) instead of dead-ending on a null hover.
  function dismissAndAdvance(uri: string) {
    const next = nextSurvivor(uri)
    dismiss(uri)
    if (next) keyboardSelect(next)
  }

  // Card horizontal swipe (#72, reworked): ← previous post, → next. Navigates
  // FROM the swiped card's post. Vertical is left to the card's own scroll.
  function onCardSwipe(uri: string, dir: -1 | 1) {
    navigate(dir, uri)
  }

  // Hover with a short close delay so the pointer can travel from a node to its
  // card (and interact with it) without the card vanishing.
  let clearTimer: ReturnType<typeof setTimeout> | undefined
  /** Long enough to reach the card from the node without losing it, short
   * enough that a card doesn't linger once you've moved on. */
  const GRACE = 260
  /** Last pointer position, so the clear timer can ask where the pointer IS
   * rather than infer it from the last enter/leave event it happened to see.
   * Plain state: only ever read inside a timer, never rendered. */
  let ptr = { x: -1, y: -1 }
  // A keyboard rate/dismiss/nav sets `hovered` and then OWNS it until the mouse
  // actually moves. Without this, a stationary cursor — or a node reflowing under
  // it after the dismissal — fires pointerenter and silently steals the selection
  // the keyboard just advanced to, so the next keypress hits the wrong post. Any
  // real pointer intent (a move or a press) releases the hold.
  let pointerHold = false
  // True only for a short window after a real pointer move. Node positions are
  // instant (never eased), so when the layout re-solves a node can jump out from
  // under a STILL cursor — the browser then fires pointerleave/enter that look
  // like the user leaving/arriving but were caused by the node moving, not the
  // pointer. Gating hover changes on this flag ignores those drift events, so the
  // post you're reading doesn't un-hover itself when the graph shifts (#88).
  let movedRecently = false
  let moveIdle: ReturnType<typeof setTimeout> | undefined
  const MOVE_IDLE = 120
  $effect(() => {
    const release = () => (pointerHold = false)
    const onMove = (e: PointerEvent) => {
      pointerHold = false
      movedRecently = true
      ptr = { x: e.clientX, y: e.clientY }
      clearTimeout(moveIdle)
      moveIdle = setTimeout(() => (movedRecently = false), MOVE_IDLE)
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerdown', release, { passive: true })
    return () => {
      clearTimeout(moveIdle)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerdown', release)
    }
  })

  function setHovered(uri: string) {
    clearTimeout(clearTimer)
    hovered = uri
  }

  /** Select from the keyboard and hold the selection against the pointer until
   * the mouse next moves (see `pointerHold`). */
  function keyboardSelect(uri: string) {
    pointerHold = true
    setHovered(uri)
  }

  /** Pointer-driven hover (node/card enter → set, leave → schedule clear). Ignored
   * while a keyboard selection holds (a stationary cursor can't override it). A
   * LEAVE is honoured only if the pointer actually moved just now: an unaccompanied
   * leave means the node drifted out from under a still cursor (the layout shifted),
   * not that the reader left — so the post you're reading keeps its hover (#88).
   * Enters are never gated on movement, so a genuine hover always registers. */
  function pointerHover(uri: string | null) {
    if (pointerHold) return
    if (uri) setHovered(uri)
    else if (movedRecently) scheduleClear()
  }
  /**
   * Let go of a hovered post only once the pointer is clear of BOTH the node
   * and its card.
   *
   * These two don't touch -- the card is offset from the node it belongs to --
   * so reaching from one to the other crosses a gap where neither is hovered. A
   * bare timer turned that into a race the reader could lose just by moving
   * slowly: the card they were reaching for closed under them. This re-checks
   * where the pointer actually is when the timer fires, and re-arms while it is
   * still over either one, so only genuinely leaving both closes the card.
   */
  function pointerOverPostOrCard(): boolean {
    if (ptr.x < 0 || !graphEl) return false
    // Scoped to THIS graph. Matching '.card' against the whole document also
    // matched the login card, so after a session expiry the timer kept finding
    // one and re-arming against a component that no longer exists.
    return document
      .elementsFromPoint(ptr.x, ptr.y)
      .some((el) => graphEl.contains(el) && el.closest('.wrap, .card, .profile-pop'))
  }
  function scheduleClear() {
    clearTimeout(clearTimer)
    // Bounded re-arming. The pointer position only updates on pointermove, so a
    // pointer that leaves the window while over a node leaves `ptr` frozen
    // inside it -- an unbounded re-arm would then poll elementsFromPoint (which
    // forces layout) every GRACE ms for the life of the page, and the card would
    // never close. Ten rounds is far longer than any real reach between a post
    // and its card.
    let rounds = 0
    clearTimer = setTimeout(function tick() {
      if (rounds++ < 10 && pointerOverPostOrCard()) {
        clearTimer = setTimeout(tick, GRACE)
        return
      }
      hovered = null
    }, GRACE)
  }
  $effect(() => () => clearTimeout(clearTimer))

  function onKey(e: KeyboardEvent) {
    // Don't hijack typing. A modal compose/report textarea lives outside this
    // component and its keystrokes bubble to this window handler, so a bare
    // guard on <input> alone let letters fire graph shortcuts (r/n/l — and now
    // the destructive y/n/f/s) mid-sentence. Cover textareas and contenteditable.
    const t = e.target
    if (
      t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      t instanceof HTMLSelectElement ||
      (t instanceof HTMLElement && t.isContentEditable)
    )
      return
    // A blocking modal renders a full-screen backdrop over the graph. While one
    // is open, don't let a keyboard-set `hovered` (which persists, unlike a
    // pointer hover) get navigated/rated/dismissed underneath it, and leave the
    // modal's own arrow/Escape keys alone. Six modals use `.backdrop`; the
    // coverage overlay uses `.cov-backdrop` — a NEW full-screen overlay must add
    // its backdrop class here or it reopens this leak. Side panels (digest, the
    // config popover) have no backdrop, so shortcuts still work alongside them.
    if (document.querySelector('.backdrop, .cov-backdrop')) return
    const k = e.key.toLowerCase()
    if (e.key === 'Escape') {
      hovered = null
      showConfig = false
    } else if (k === 'd' && hoveredTopic) dismissTopic(hoveredTopic)
    else if (k === 'd' && hovered) dismissAndAdvance(hovered)
    // Thumbs on the hovered post: y = up, n = down — rate, dismiss, and ADVANCE
    // to the next post (a fast triage sweep). `n` keeps its no-hover meaning
    // (nextBatch) — same hover-scoped overload the `d` key uses.
    else if (k === 'y' && hovered) rateAndAdvance(hovered, 'up')
    else if (k === 'n' && hovered) rateAndAdvance(hovered, 'down')
    // Home-row aliases so a left hand can rate while the right stays on the mouse:
    // f = up (favourable), s = down. Same rate-dismiss-advance as y/n.
    else if (k === 'f' && hovered) rateAndAdvance(hovered, 'up')
    else if (k === 's' && hovered) rateAndAdvance(hovered, 'down')
    // Arrow keys: ←/→ walk the timeline; ↑/↓ rate + advance (aliases of y/n).
    // preventDefault stops the page from scrolling.
    else if (e.key === 'ArrowUp' && hovered) {
      e.preventDefault()
      rateAndAdvance(hovered, 'up')
    } else if (e.key === 'ArrowDown' && hovered) {
      e.preventDefault()
      rateAndAdvance(hovered, 'down')
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      navigate(1)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      navigate(-1)
    } else if (k === 'r') load(true)
    else if (k === 'n') nextBatch()
    else if (k === 'l') turnoverOffset = 0
  }

  // Initial load runs from boot() (via the archive-open effect), so a saved feed
  // snapshot can paint before the first live fetch — see the open effect above.
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="graph"
  role="group"
  aria-label="Conversation graph"
  style="--bottom-chrome: {bottomChrome}px; --bottom-bar: {bottomBar}px"
  bind:this={graphEl}
  bind:clientWidth={w}
  bind:clientHeight={h}
  onwheel={onWheel}
  onpointerdown={onCanvasPointerDown}
  ondblclick={(e) => {
    // Double-click empty canvas to come home. On a node it means something else
    // already (map replies), so only the background answers.
    const t = e.target as HTMLElement
    if (!t.closest('.wrap, .card, .config-wrap, .hud, .panel, .digest-btn, .topic-node')) recentre()
  }}
  onclickcapture={(e) => {
    // A click on empty canvas (not a node, card, panel, or control) collapses
    // any open/pinned posts. Node/card handlers live on their own elements.
    const t = e.target as HTMLElement
    // Click outside the config popover closes it (the gear's own click toggles).
    if (showConfig && !t.closest('.config-wrap')) showConfig = false
    if (!t.closest('.wrap, .card, .config-wrap, .hud, .panel, .digest-btn, .topic-node')) clearAll()
  }}
>
  <div class="axis y-axis">← quieter · louder →</div>
  <div class="axis x-axis">← last active: older · newer →</div>
  <!-- Pills are a fixed size, so the legend would be describing an encoding
       that is not on screen. -->
  {#if !pill}
    <div class="axis legend"><span class="dot"></span> size = replies</div>
  {/if}

  <!-- Everything that lives in graph coordinates. Pan/zoom transforms this
       layer only, so the chrome (HUD, gear, digest) stays put. -->
  <div
    class="viewport"
    style="transform: translate({view.x}px, {view.y}px) scale({view.k}); --arrive-dur: {settings.motionMs}ms"
  >
  <svg class="edges" width={w} height={h}>
    <defs>
      <marker id="reply-arrow" viewBox="0 0 10 10" refX="8" refY="5"
        markerWidth="5" markerHeight="5" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" />
      </marker>
      {#each edgeColors as c}
        <marker id={arrowId(c)} viewBox="0 0 10 10" refX="8" refY="5"
          markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" style="fill: {c}" />
        </marker>
      {/each}
    </defs>
    {#each edgeLines as line (line.id)}
      <path
        d={line.d}
        fill="none"
        marker-end="url(#{arrowId(line.color)})"
        style={line.color ? `stroke: ${line.color}; opacity: 0.55` : ''}
      />
    {/each}
  </svg>

  <!-- Topic edges: each conversation's node links to its member posts. -->
  <svg class="annotations" width={w} height={h}>
    {#each topics as a (a.id)}
      {#each a.members as m}
        <path
          d={curvePath(a.tx, a.ty, m.x, m.y, settings.curvedEdges ? 0.18 : 0, 40)}
          fill="none"
          stroke={a.color}
        />
      {/each}
    {/each}
  </svg>

  {#each placed as p (p.node.uri)}
    <PostNode
      node={p.node}
      px={p.px}
      py={p.py}
      size={p.size}
      {pill}
      arriving={arriving.has(p.node.uri)}
      enter={enterFrom(p.px, p.py)}
      hasReplies={(edgeCount.get(p.node.uri) ?? 0) > 0}
      active={hovered === p.node.uri}
      pinned={pinned.has(p.node.uri)}
      ghost={p.node.ghost ?? false}
      reaction={reactions.reactionOf(p.node.uri)}
      accent={topicColorByNode.get(p.node.uri)}
      unfollowed={p.node.item.post.author.did !== session.did &&
        !follows.following(p.node.item.post.author)}
      onhover={pointerHover}
      onclick={onNodeClick}
      ondblclick={onNodeDblClick}
      onexpand={(n) => toggleMapReplies(n.item)}
      ondismiss={dismiss}
      ondragmove={onNodeDrag}
      ondragend={onNodeDragEnd}
    />
  {/each}

  <!-- One-off topic labels: a caption tucked against the post, no pill/edge.
       Above it in pill mode, where the label reads as a heading for the text
       it sits over; below in avatar mode, where there is no text to head.
       The offset uses the PILL's half-height, not p.size -- that is the avatar
       diameter, which in pill mode is unrelated to how tall the node is. -->
  {#each placed as p (p.node.uri)}
    {@const cap = nodeCaptions.get(p.node.uri)}
    {@const half = pill ? pill.h / 2 : p.size / 2}
    {#if cap}
      <div
        class="node-caption"
        class:above={!!pill}
        style="left: {p.px}px; top: {pill ? p.py - half - 3 : p.py + half + 3}px; --c: {cap.color}"
      >
        {cap.label}
      </div>
    {/if}
  {/each}

  {#each topics as a (a.id)}
    <button
      class="topic-node"
      class:pinned={pinned.has(a.sid)}
      class:revealed={revealedTopics.has(a.id)}
      style="left: {a.tx}px; top: {a.ty}px; --c: {a.color}"
      title="Click to reveal all {a.uris.length} posts · drag to move · D to dismiss the whole conversation"
      onmouseenter={() => (hoveredTopic = a.id)}
      onmouseleave={() => (hoveredTopic = null)}
      onpointerdown={(e) => onTopicPointerDown(e, a.sid, a.id)}
    >
      {a.label}<span class="topic-count">{a.uris.length}</span>
    </button>
  {/each}

  </div>

  <!-- Cards render OUTSIDE the transform layer, in screen coordinates.
       A transform makes its element the containing block for `position: fixed`
       descendants, so the profile popover and the ⋯ menu -- both of which
       compute coordinates from getBoundingClientRect() -- were landing ~56px
       low and then being clipped away by .graph's overflow. That is the very
       bug the popover was moved to `fixed` to fix, reintroduced by this PR's
       own pan/zoom layer. Keeping cards out also stops their text scaling with
       zoom, which is what you want from a reading surface. -->
  {#each cards as c (c.node.uri)}
    <PostCard
      item={c.node.item}
      run={c.node.run}
      x={c.x * view.k + view.x}
      y={c.y * view.k + view.y}
      boundsH={h}
      canMapReplies={c.node.isThreadRoot || (c.node.item.post.replyCount ?? 0) > 0}
      repliesMapped={repliesMapped(c.node.item)}
      context={whyHere(c.node)}
      onreply={(it) => compose.openReply(it)}
      onquote={(it) => compose.openQuote(it)}
      onmapreplies={toggleMapReplies}
      onswipe={onCardSwipe}
      onrate={(it, kind) => react(it.post.uri, kind)}
      showClose={coarsePointer}
      ondismiss={() => dismiss(c.node.uri)}
      onkeep={() => pointerHover(c.node.uri)}
      onleave={() => pointerHover(null)}
      onclose={() => {
        pinned.delete(c.node.uri)
        if (hovered === c.node.uri) hovered = null
      }}
    />
  {/each}

  {#if items.length === 0 && !loading}
    <div class="empty">{error ?? 'No posts.'}</div>
  {/if}
  {#if loading && items.length === 0}
    <div class="empty">Loading timeline…</div>
  {/if}

  <div class="config-wrap">
    <button bind:this={gearEl} class="gear" onclick={() => (showConfig = !showConfig)} title="View settings">
      ⚙ <span class="counts">{visibleNodes.length}{queued > 0 ? ` / ${total}` : ''}</span>
    </button>

    {#if showConfig}
      <div class="config">
        <div class="row seg-row">
          <span class="label">Show</span>
          <div class="seg">
            {#each modes as m}
              <button class:on={settings.selectMode === m} onclick={() => (settings.selectMode = m)}>{m}</button>
            {/each}
          </div>
        </div>
        <p class="hint">
          {settings.selectMode === 'top'
            ? 'The loudest posts by engagement per hour.'
            : settings.selectMode === 'recent'
              ? 'The newest posts.'
              : 'The loudest half + the newest half.'}
        </p>

        <div class="row">
          <span class="label">Density</span>
          <input type="range" min="0.5" max="2.5" step="0.05" bind:value={settings.density} />
          <span class="val">~{budget}</span>
        </div>
        <p class="hint">
          Fills the space at the spacing you pick — left is sparser (more room per post), right is
          denser (more posts). No fixed count.
        </p>

        <div class="row">
          <span class="label">Post pills</span>
          <input type="checkbox" bind:checked={settings.postNodes} />
          <span class="val"></span>
        </div>
        <p class="hint">
          Render posts as readable pills (avatar + opening line) instead of bare avatars. Each pill
          takes ~4× the room, so fewer fit.
        </p>

        <div class="row">
          <span class="label">Post motion</span>
          <input
            type="range"
            min={MOTION_MIN}
            max={MOTION_MAX}
            step="50"
            bind:value={settings.motionMs}
          />
          <span class="val">{settings.motionMs === 0 ? 'off' : `${settings.motionMs}ms`}</span>
        </div>
        <p class="hint">
          How fast posts glide when the layout shifts and new ones arrive. Left is instant (they snap
          into place); right is a slower, calmer motion. Reduced-motion system settings always win.
        </p>

        <div class="row">
          <span class="label">Auto-cycle</span>
          <input
            type="checkbox"
            bind:checked={settings.autoCycle}
            disabled={settings.selectMode === 'mix' || total <= budget}
          />
          <input
            type="range"
            min="1"
            max="15"
            bind:value={settings.cycleInterval}
            disabled={!settings.autoCycle || settings.selectMode === 'mix'}
          />
          <span class="val">{settings.cycleInterval}s</span>
        </div>
        <p class="hint">
          {settings.selectMode === 'mix'
            ? 'Cycling applies to Top/Recent.'
            : `Rotates the ${queued} queued posts through over time.`}
        </p>

        <div class="row">
          <span class="label">Live</span>
          <input type="checkbox" bind:checked={settings.livePoll} />
          <span class="val"></span>
        </div>
        <p class="hint">Pull new posts into the graph every 60s.</p>

        <div class="row">
          <span class="label">Connect</span>
          <input type="checkbox" bind:checked={settings.connectReplies} />
          <span class="val"></span>
        </div>
        <p class="hint">Bring in the posts replies are replying to, drawing edges.</p>

        <div class="row">
          <span class="label">Reply chains</span>
          <input type="checkbox" bind:checked={settings.replyChains} />
          <span class="val"></span>
        </div>
        <p class="hint">Show each reply's full parent chain to the thread root (won't collapse those threads).</p>

        <div class="row">
          <span class="label">Curved edges</span>
          <input type="checkbox" bind:checked={settings.curvedEdges} />
          <span class="val"></span>
        </div>
        <p class="hint">Bow edges so they arc clear of nodes in between; off draws straight lines.</p>

        <div class="row">
          <span class="label">Reposts</span>
          <input type="checkbox" bind:checked={settings.showReposts} />
          <span class="val"></span>
        </div>
        <p class="hint">Include reposts from people you follow.</p>

        <div class="row">
          <span class="label">Follows only</span>
          <input type="checkbox" bind:checked={settings.followsOnly} />
          <span class="val"></span>
        </div>
        <p class="hint">Hide feed posts from accounts you don't follow (Bluesky sometimes serves them).</p>
        <div class="row">
          <span class="label">Hide muted replies</span>
          <input type="checkbox" bind:checked={settings.hideMutedReplies} />
          <span class="val"></span>
        </div>
        <p class="hint">
          Also hide replies TO accounts you've muted or blocked, not just their own posts.
        </p>

        {#if debugAllowed}
          <div class="row">
            <span class="label">Debug</span>
            <input type="checkbox" bind:checked={settings.debugMode} />
            <span class="val"></span>
          </div>
          <p class="hint">Label every card's provenance; click the 🧭 line to copy the raw post JSON.</p>
        {/if}

        <div class="archive-box">
          <div class="archive-head">
            <span class="label">Corpus</span>
            {#if backfilling}<span class="pulse">importing… {backfillStatus?.pages ?? 0}p</span>{/if}
          </div>
          {#if archiveStats}
            <p class="hint archive-stats">
              {archiveStats.posts.toLocaleString()} posts · {archiveStats.counts.toLocaleString()} count-samples ·
              {archiveStats.follows} follows-snapshot{archiveStats.follows === 1 ? '' : 's'}
              {#if backfillStatus}<br />backfill: {backfillStatus.imported} imported{backfillStatus.hitCap ? ' (hit page cap)' : ''}{/if}
            </p>
          {:else}
            <p class="hint archive-stats">archive not open yet…</p>
          {/if}
          <div class="archive-actions">
            <button class="export-btn" onclick={() => (showCoverage = true)} disabled={!archiveStats?.posts}>Coverage…</button>
            <button class="export-btn" onclick={exportArchive} disabled={!archiveStats?.posts}>Export JSON</button>
          </div>
        </div>
      </div>
    {/if}
  </div>

  {#if showCoverage}
    <CoverageView onclose={() => (showCoverage = false)} />
  {/if}

  <div class="hud" bind:this={hudEl}>
    {#if read.dismissed.size > 0}
      <span class="dismissed-count">{read.dismissed.size} dismissed</span>
    {/if}
    {#if !atRest}
      <!-- Only when there is somewhere to come back FROM: a permanent button
           for a view that has not moved is a control that does nothing. -->
      <button class="recentre-btn" onclick={recentre} title="Recentre the graph (or double-click the canvas)">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
      </button>
    {/if}
    <button class="digest-btn" onclick={() => (showDigest ? (showDigest = false) : summarize())} title="Summarize conversations">
      ✦ Digest
    </button>
    <button
      class="refresh"
      class:spinning={loading}
      onclick={() => load(true)}
      disabled={loading || !cursor}
      title={loading ? 'Loading…' : 'Load more posts'}
      aria-label="Load more posts"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  </div>

  {#if showDigest}
    <DigestPanel
      items={feedItems}
      onclose={() => (showDigest = false)}
      onsummarize={summarize}
      onfocus={focusPost}
    />
  {/if}
  {#if error && items.length > 0}
    <div class="err-toast">{error}</div>
  {/if}
  {#if undoLast}
    <!-- Transient misfire-recovery toast (#84): names what just happened and
         offers a single Undo, auto-clearing after UNDO_TTL and replaced by the
         next action. role=status announces it politely without stealing focus
         mid-sweep. -->
    <div class="undo-toast" role="status">
      <span class="undo-label"
        >{undoLast.kind === 'react'
          ? `Rated ${undoLast.reaction === 'up' ? '↑' : '↓'}`
          : 'Dismissed'}</span
      >
      <button type="button" class="undo-btn" onclick={undo}>Undo</button>
    </div>
  {/if}
</div>

<style>
  .viewport {
    position: absolute;
    inset: 0;
    /* Transform from the top-left, so graph coordinates map straight through
       without an origin correction in toGraph(). */
    transform-origin: 0 0;
    /* No pointer-events rules here. Forcing them onto the children made the
       edges SVG -- which spans the whole canvas -- intercept everything and
       obscure every node under it, so hovers timed out across the suite. The
       children already declare what they want; the pan handler sits on .graph
       and reads event.target, so background events reach it by bubbling. */
  }
  .graph {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    /* Own the touch gestures on the whole canvas so the browser never claims a
       two-finger pinch as page-zoom (#42). It must live on .graph, not the
       .viewport — the viewport is TRANSFORMED (pan/zoom), so its hit-box stops
       covering the canvas once you pan or zoom out, and the browser would
       reclaim the exposed strip. Scrollable overlays below re-enable pan-y so
       their content still scrolls under this none. */
    touch-action: none;
  }
  .edges {
    position: absolute;
    inset: 0;
    pointer-events: none;
    /* The world extends past the frame, and pan/zoom brings it on screen. The
       SVG is sized w x h, so without this a reply edge out in the reservoir is
       sliced at the old frame line and its tree renders as loose nodes. */
    overflow: visible;
  }
  .annotations {
    position: absolute;
    inset: 0;
    overflow: visible;
    pointer-events: none;
  }
  .annotations path {
    fill: none;
    stroke-width: 1.5;
    opacity: 0.65;
    stroke-dasharray: 3 4;
  }
  /* Topic node: sits like a node at the centroid of its conversation, edges
     radiating to member posts. Clickable to reveal the whole conversation. */
  .topic-node {
    position: absolute;
    transform: translate(-50%, -50%);
    max-width: 8rem;
    padding: 0.3rem 0.6rem;
    font-size: 0.72rem;
    font-weight: 600;
    line-height: 1.15;
    color: var(--c);
    background: color-mix(in srgb, var(--bg-elev) 90%, transparent);
    border: 2px solid var(--c);
    border-radius: 999px;
    text-align: center;
    cursor: grab;
    touch-action: none;
    user-select: none;
    backdrop-filter: blur(3px);
    z-index: 3;
  }
  .topic-node:hover {
    background: color-mix(in srgb, var(--c) 22%, var(--bg-elev));
  }
  /* A one-off topic's label, centered just beneath its post node. */
  .node-caption {
    position: absolute;
    transform: translate(-50%, 0);
    max-width: 8rem;
    font-size: 0.62rem;
    font-weight: 600;
    line-height: 1.1;
    color: var(--c);
    text-align: center;
    pointer-events: none;
    text-shadow:
      0 1px 3px var(--bg),
      0 0 4px var(--bg);
    z-index: 2;
  }
  /* Anchor the caption's BOTTOM to the pill's top, so a label that wraps to two
     lines grows upward instead of sliding down over the post. Position only --
     every other declaration belongs to .node-caption and applies in both modes.
     Splitting the block put them all in here, which left avatar-mode captions
     unstyled: body-sized, untinted, unclamped, and swallowing pointer events. */
  .node-caption.above {
    transform: translate(-50%, -100%);
  }
  .topic-node.pinned {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--c) 60%, transparent);
  }
  .topic-node.revealed {
    background: color-mix(in srgb, var(--c) 30%, var(--bg-elev));
    color: var(--text);
  }
  .topic-count {
    display: inline-block;
    margin-left: 0.35rem;
    padding: 0 0.3rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--c) 35%, transparent);
    font-size: 0.62rem;
    font-variant-numeric: tabular-nums;
    vertical-align: baseline;
  }
  .edges path {
    fill: none;
    stroke: var(--text-dim);
    stroke-width: 2;
    opacity: 0.7;
    stroke-dasharray: 5 4;
  }
  /* Arrowheads: default gray; colored markers carry an inline fill that must
     win, so keep this on the low-specificity default only. */
  .edges marker path {
    fill: var(--text-dim);
    stroke: none;
    stroke-dasharray: none;
    opacity: 0.9;
  }
  .axis {
    position: absolute;
    color: var(--text-dim);
    font-size: 0.72rem;
    letter-spacing: 0.03em;
    pointer-events: none;
    user-select: none;
  }
  .x-axis {
    bottom: 18px;
    left: 50%;
    transform: translateX(-50%);
  }
  .y-axis {
    top: 50%;
    left: 14px;
    transform: translateY(-50%) rotate(180deg);
    writing-mode: vertical-rl;
  }
  .legend {
    top: 14px;
    right: 16px;
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  .legend .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 2px solid var(--text-dim);
    display: inline-block;
  }
  .empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--text-dim);
  }
  .config-wrap {
    position: absolute;
    /* Clear the home indicator / side notch when viewport-fit=cover paints the
       canvas edge-to-edge; env() is 0 on desktop so the 16px gap is unchanged. */
    left: max(16px, env(safe-area-inset-left, 0px));
    bottom: max(16px, env(safe-area-inset-bottom, 0px));
    z-index: 30; /* above topic nodes (z-index 3) and the digest panel */
  }
  .gear {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.7rem;
    font-size: 0.85rem;
    background: color-mix(in srgb, var(--bg-elev) 88%, transparent);
    backdrop-filter: blur(6px);
  }
  .gear .counts {
    color: var(--text-dim);
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
  }
  .config {
    position: absolute;
    left: 0;
    bottom: calc(100% + 8px);
    width: 500px;
    max-width: min(92vw, calc(100vw - 24px));
    max-height: calc(100vh - 120px); /* fallback */
    max-height: calc(100dvh - 120px);
    overflow-y: auto;
    touch-action: pan-y; /* scroll under .graph's touch-action: none (#42) */
    padding: 0.9rem;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    font-size: 0.8rem;
  }
  .config .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .config .label {
    color: var(--text-dim);
    min-width: 4.5em;
    flex: none;
  }
  .config input[type='range'] {
    flex: 1 1 0;
    min-width: 0;
    accent-color: var(--accent);
  }
  .config input[type='checkbox'] {
    flex: none;
    accent-color: var(--accent);
  }
  .config .val {
    color: var(--text);
    min-width: 2.4em;
    flex: none;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .config .hint {
    margin: 0 0 0.5rem;
    color: var(--text-dim);
    font-size: 0.72rem;
    line-height: 1.35;
  }
  .seg {
    display: flex;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .seg button {
    border: none;
    border-radius: 0;
    background: transparent;
    padding: 0.3rem 0.6rem;
    font-size: 0.78rem;
    text-transform: capitalize;
    color: var(--text-dim);
  }
  .seg button.on {
    background: var(--accent);
    color: #fff;
  }
  .archive-box {
    margin-top: 0.3rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border);
  }
  .archive-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .archive-head .label {
    color: var(--text-dim);
  }
  .pulse {
    color: var(--accent);
    font-size: 0.7rem;
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.4;
    }
  }
  .archive-stats {
    margin: 0.35rem 0 0.5rem;
    line-height: 1.5;
  }
  .archive-actions {
    display: flex;
    gap: 0.4rem;
  }
  .export-btn {
    flex: 1 1 0;
    font-size: 0.75rem;
    padding: 0.35rem;
  }
  .export-btn:disabled {
    opacity: 0.5;
  }
  .hud {
    position: absolute;
    /* Clear the home indicator / side notch under viewport-fit=cover. */
    right: max(16px, env(safe-area-inset-right, 0px));
    bottom: max(16px, env(safe-area-inset-bottom, 0px));
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.85rem;
    z-index: 30; /* above topic nodes */
  }
  .dismissed-count {
    color: var(--text-dim);
    font-size: 0.78rem;
  }
  .recentre-btn {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    padding: 0;
    color: var(--text-dim);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 999px;
    cursor: pointer;
  }
  .recentre-btn svg {
    width: 17px;
    height: 17px;
  }
  .recentre-btn:hover {
    color: var(--text);
    border-color: var(--accent);
  }
  .digest-btn {
    background: color-mix(in srgb, var(--bg-elev) 88%, transparent);
    backdrop-filter: blur(6px);
    font-size: 0.82rem;
  }
  /* Was a "Load more" text button; an icon says the same thing in a third of
     the width, which matters on a phone where the bottom bar is crowded. */
  .refresh {
    width: 34px;
    height: 34px;
    padding: 0;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--text);
    background: color-mix(in srgb, var(--bg-elev) 88%, transparent);
    backdrop-filter: blur(6px);
  }
  .refresh svg {
    /* Explicit size: the svg has only a viewBox, so without this it collapses
       and the button renders empty. */
    width: 17px;
    height: 17px;
    display: block;
  }
  .refresh:disabled {
    opacity: 0.4;
  }
  .refresh.spinning svg {
    animation: refresh-spin 0.9s linear infinite;
  }
  @keyframes refresh-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .err-toast {
    position: absolute;
    left: max(16px, env(safe-area-inset-left, 0px));
    bottom: max(16px, env(safe-area-inset-bottom, 0px));
    color: var(--danger);
    font-size: 0.8rem;
  }

  /* Undo-last toast (#84): a transient pill, bottom-CENTRE so it clears the
     err-toast (bottom-left) and the HUD/config (bottom-right). It fades up on
     arm; it's swapped or cleared by the component, never by CSS. */
  .undo-toast {
    position: absolute;
    left: 50%;
    bottom: max(16px, env(safe-area-inset-bottom, 0px));
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0.3rem 0.3rem 0.3rem 0.85rem;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 999px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    color: var(--text);
    font-size: 0.8rem;
    animation: undo-in 140ms ease-out;
    z-index: 20;
  }
  @keyframes undo-in {
    from {
      opacity: 0;
      transform: translate(-50%, 6px);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  }
  .undo-btn {
    border: none;
    border-radius: 999px;
    padding: 0.25rem 0.75rem;
    background: var(--accent);
    color: #fff;
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
  }
  .undo-btn:hover {
    background: var(--accent-hover);
  }

  /* Narrow screens: axis hints are teaching aids, not controls — hide them so
     the bottom row (gear / Digest / Load more) has the full width. */
  @media (max-width: 600px) {
    .axis {
      display: none;
    }
    .hud {
      right: max(10px, env(safe-area-inset-right, 0px));
      bottom: max(12px, env(safe-area-inset-bottom, 0px));
      gap: 0.45rem;
    }
    .config-wrap {
      bottom: max(12px, env(safe-area-inset-bottom, 0px));
    }
  }
</style>
