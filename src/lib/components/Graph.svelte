<script lang="ts">
  import { getFeedPage, type FeedItem } from '../api/timeline'
  import { feeds } from '../state/feeds.svelte'
  import { bskyUrl, reposter, reposterProfile } from '../api/post'
  import {
    buildGraph,
    contextNode,
    layoutPositions,
    parentUriOf,
    rootUriOf,
    threadDescendants,
    treeTargets,
    withTopicPills,
    type GraphNode,
    type SelectMode,
    type TopicPill,
    type TreeNode,
  } from '../state/graph'
  import { ForceLayout, type Target } from '../state/forceLayout'
  import { buildConversations, planView } from '../state/conversations'
  import { read } from '../state/read.svelte'
  import { moderation } from '../state/moderation.svelte'
  import { settings, debugAllowed } from '../state/settings.svelte'
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
  // Bottom UI chrome, measured so the sim keeps nodes out of the corners it
  // occupies (measured into bottomChrome; the canvas ends above the bar).
  let gearEl = $state<HTMLElement>()
  let hudEl = $state<HTMLElement>()
  // Measured height of the bottom control bar — the canvas ends above it.
  let bottomChrome = $state(0)

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
  const visible = $derived(allItems.filter((i) => !read.isDismissed(i.post.uri)))
  // THE PLAN (PLAN §8): conversations are the unit of every display decision.
  // One pass with global knowledge ranks conversations (not posts), applies
  // author diversity (a reply-flooding account can't fill the window with
  // dozens of small conversations), and allocates each a resolution: full
  // tree, collapsed representative (+N), or hidden (queued).
  const convos = $derived(buildConversations(visible, primaryUris))
  const plan = $derived.by(() => {
    // Manual maps + revealed topic pills always draw whole.
    const forceFull = new Set<string>()
    for (const c of convos) {
      if (c.members.some((m) => expanded.has(m.post.uri) || revealedUris.has(m.post.uri))) forceFull.add(c.id)
    }
    return planView(
      convos.filter((c) => c.hasPrimary || forceFull.has(c.id)),
      {
        budget: settings.nodeLimit,
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
  const graph = $derived(buildGraph(visible, plannedFullUris, primaryUris, expanded, true))

  const total = $derived(plan.length)
  const queued = $derived(plan.filter((p) => p.level === 'hidden').length)

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
      let frontier = [...set.values()].filter((n) => plannedFullUris.has(n.uri) || pinned.has(n.uri))
      while (frontier.length) {
        const next: GraphNode[] = []
        for (const n of frontier) {
          const raw = parentUriOf(n.item)
          if (!raw) continue
          const p = graph.memberNode.get(raw) ?? raw // the node DISPLAYING the parent
          if (p === n.uri || set.has(p)) continue
          const pn = byUri.get(p) ?? (() => {
            const it = contextByUri.get(raw)
            return it ? contextNode(it, read.isDismissed(raw)) : undefined
          })()
          if (!pn) continue // parent not loaded (yet) — the fetch effect is on it
          set.set(pn.uri, pn)
          next.push(pn)
        }
        frontier = next
      }
    }
    return [...set.values()]
  })
  const nodeLayout = $derived(layoutPositions(visibleNodes))

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

  // Semantic targets (px) each node is pulled toward. The conversation is the
  // spatial unit: a chain's topmost visible node anchors to the semantic axes,
  // its replies hang below as a tidy tree. The math lives in treeTargets (pure,
  // tested); here we resolve each node's parent through displayNodeOf (run head /
  // representative) so childrenOf and root-detection agree by construction.
  // A topic PILL is laid out like the root of a reply tree: it's a synthetic
  // node anchored at its LOUDEST visible member's semantic position, and its
  // member OPs (with their reply-subtrees) hang below it — instead of a pill at
  // the members' centroid with edges radiating across the page. treeTargets
  // does both the post trees and the pill trees in one pass; we split the result.
  const treeLayout = $derived.by(() => {
    // When the digest panel is open it overlays the right edge, so shrink the
    // usable width by the panel so every node stays visible to its left.
    const panelW = showDigest ? Math.min(PANEL_W, w * 0.88) : 0
    const innerW = Math.max(0, w - 2 * PAD_X - panelW)
    const innerH = Math.max(0, h - PAD_TOP - Math.max(PAD_BOTTOM, bottomChrome + 8))
    const present = new Set(visibleNodes.map((n) => n.uri))
    const postNodes: TreeNode[] = visibleNodes.map((n) => {
      const raw = parentUriOf(n.item)
      const p = raw ? displayNodeOf(raw) : undefined
      const a = nodeLayout.get(n.uri) ?? { x: 0.5, y: 0.5, sizeRank: 0.5 }
      return {
        uri: n.uri,
        timestamp: n.timestamp,
        parent: p && p !== n.uri && present.has(p) ? p : undefined,
        x: a.x,
        y: a.y,
        sizeRank: a.sizeRank,
      }
    })
    // Topic pills become tree roots over their (visible, display-resolved)
    // members; withTopicPills does the loudest-anchor + thread-root reparenting.
    const pills: TopicPill[] = topicMembership.map((m) => ({
      sid: m.sid,
      members: [...new Set(m.uris.map((u) => displayNodeOf(u)))].filter((u) => present.has(u)),
    }))
    const pillSids = new Set(pills.map((p) => p.sid))

    const all = treeTargets(withTopicPills(postNodes, pills), {
      padX: PAD_X,
      padTop: PAD_TOP,
      innerW,
      innerH,
      minSize: MIN_SIZE,
      maxSize: MAX_SIZE,
    })
    const posts: Target[] = []
    const pillMap = new Map<string, Target>()
    for (const t of all) (pillSids.has(t.id) ? pillMap.set(t.id, t) : posts.push(t))
    return { posts, pills: pillMap }
  })
  const targets = $derived(treeLayout.posts)
  const pillTargets = $derived(treeLayout.pills)

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
  const topicLinks = $derived(
    topicMembership.flatMap((m) =>
      m.uris.filter((u) => targetByUri.has(u)).map((u) => ({ source: m.sid, target: u })),
    ),
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

  // Topic nodes are draggable sim nodes (dragging pulls their member posts via
  // the links). A plain click pins the topic where it is (like a post); it does
  // NOT open every member's card. Threshold + window listeners mirror PostNode.
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

  const edgeLines = $derived.by(() =>
    visibleEdges
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

  // ── force layout lifecycle ────────────────────────────────────────────────
  let layout: ForceLayout | undefined
  $effect(() => {
    const l = new ForceLayout(() => {
      positions = l.positions()
    })
    layout = l
    return () => l.stop()
  })

  // Reheat whenever targets or links change (new data, resize, dismissal, turnover),
  // or when the pinned set changes (pinned nodes get fixed positions).
  $effect(() => {
    const t = [...targets, ...topicTargets]
    const links = [...visibleEdges.map((e) => ({ source: e.from, target: e.to })), ...topicLinks]
    // Clamp nodes inside the canvas so they can't drift up under the top bar (the
    // graph starts below it, but the sim could otherwise push a node to the edge).
    layout?.setBounds(w, h, 18, Math.max(24, bottomChrome))
    layout?.update(t, links, new Set(pinned), settings.cohesion)
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
    const gr = gearEl?.getBoundingClientRect()
    if (gr) inset = Math.max(inset, g.bottom - gr.top + 10)
    const hr = hudEl?.getBoundingClientRect()
    if (hr) inset = Math.max(inset, g.bottom - hr.top + 10)
    bottomChrome = inset
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

  // Keep the graph full: when the queue runs dry (fewer posts loaded than the
  // node limit) and more can be fetched, pull the next page. This is what makes
  // dismissing a post backfill the next one so the visible count holds steady.
  $effect(() => {
    if (!loading && cursor && total < settings.nodeLimit) load(true)
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
    load(false)
  })

  // Auto-cycle timer: while on, rotate the queue one step per interval.
  // (Mix mode has no meaningful rotation, so it only applies to top/recent.)
  $effect(() => {
    if (!settings.autoCycle || settings.selectMode === 'mix' || total <= settings.nodeLimit) return
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
      void corpus.record(page.items)
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
      void corpus.record(page.items)
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
  function onNodeDrag(uri: string, clientX: number, clientY: number) {
    const r = graphEl.getBoundingClientRect()
    layout?.dragTo(uri, clientX - r.left, clientY - r.top)
  }
  function onNodeDragEnd(uri: string) {
    layout?.dragEnd(uri, pinned.has(uri))
  }

  // Expansion is keyed by the clicked post's own uri (stable as the group grows);
  // buildGraph expands a conversation if any of its members' uri is in `expanded`.
  // The fetch is scoped to the clicked post (its replies + its ancestor chain),
  // not the whole root thread, so mapping stays about the post you clicked.
  function toggleMapReplies(item: FeedItem) {
    const uri = item.post.uri
    if (expanded.has(uri)) {
      expanded.delete(uri)
    } else {
      expanded.add(uri)
      threads.ensure(uri) // pull replies not already in the timeline
    }
  }
  function repliesMapped(item: FeedItem): boolean {
    return nodeByUri.get(item.post.uri)?.expanded ?? expanded.has(item.post.uri)
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

  function dismiss(uri: string) {
    // Dismiss the post and every reply hanging off it — "I'm done with this
    // thread". (With chains always drawn, single-post dismissal would just
    // ghost the node in place, since its own replies keep it needed — d would
    // appear to do nothing.) Ghosts serve the other direction: an ancestor
    // dismissed EARLIER resurfaces dimmed when new replies arrive needing it.
    const all = [uri, ...threadDescendants(allItems, uri)]
    read.dismissMany(all)
    if (hovered && all.includes(hovered)) hovered = null
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
    if (coarsePointer && hovered !== node.uri && !pinned.has(node.uri)) {
      setHovered(node.uri) // tap = read; pinning waits for a repeat tap
      return
    }
    clickTimer = setTimeout(() => togglePin(node), 220)
  }
  function onNodeDblClick(node: GraphNode) {
    clearTimeout(clickTimer)
    open(node)
  }

  function nextBatch() {
    if (total > settings.nodeLimit) turnoverOffset = (turnoverOffset + settings.nodeLimit) % total
  }

  // Hover with a short close delay so the pointer can travel from a node to its
  // card (and interact with it) without the card vanishing.
  let clearTimer: ReturnType<typeof setTimeout> | undefined
  function setHovered(uri: string) {
    clearTimeout(clearTimer)
    hovered = uri
  }
  function scheduleClear() {
    clearTimeout(clearTimer)
    clearTimer = setTimeout(() => (hovered = null), 140)
  }

  function onKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement) return
    const k = e.key.toLowerCase()
    if (e.key === 'Escape') {
      hovered = null
      showConfig = false
    } else if (k === 'd' && hoveredTopic) dismissTopic(hoveredTopic)
    else if (k === 'd' && hovered) dismiss(hovered)
    else if (k === 'r') load(true)
    else if (k === 'n') nextBatch()
    else if (k === 'l') turnoverOffset = 0
  }

  // Initial load runs from boot() (via the archive-open effect), so a saved feed
  // snapshot can paint before the first live fetch — see the open effect above.
</script>

<svelte:window onkeydown={onKey} />

<div
  class="graph"
  bind:this={graphEl}
  bind:clientWidth={w}
  bind:clientHeight={h}
  onclickcapture={(e) => {
    // A click on empty canvas (not a node, card, panel, or control) collapses
    // any open/pinned posts. Node/card handlers live on their own elements.
    const t = e.target as HTMLElement
    // Click outside the config popover closes it (the gear's own click toggles).
    if (showConfig && !t.closest('.config-wrap')) showConfig = false
    if (!t.closest('.wrap, .card, .config-wrap, .hud, .panel, .digest-btn, .topic-node')) clearAll()
  }}
>
  {#if settings.cohesion < 0.5}
    <div class="axis y-axis">← quieter · louder →</div>
    <div class="axis x-axis">← last active: older · newer →</div>
  {/if}
  <div class="axis legend"><span class="dot"></span> size = replies</div>

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
      hasReplies={(edgeCount.get(p.node.uri) ?? 0) > 0}
      active={hovered === p.node.uri}
      pinned={pinned.has(p.node.uri)}
      ghost={p.node.ghost ?? false}
      accent={topicColorByNode.get(p.node.uri)}
      unfollowed={p.node.item.post.author.did !== session.did &&
        !follows.following(p.node.item.post.author)}
      onhover={(uri) => (uri ? setHovered(uri) : scheduleClear())}
      onclick={onNodeClick}
      ondblclick={onNodeDblClick}
      onexpand={(n) => toggleMapReplies(n.item)}
      ondismiss={dismiss}
      ondragmove={onNodeDrag}
      ondragend={onNodeDragEnd}
    />
  {/each}

  <!-- One-off topic labels: a caption tucked just under the post, no pill/edge. -->
  {#each placed as p (p.node.uri)}
    {@const cap = nodeCaptions.get(p.node.uri)}
    {#if cap}
      <div
        class="node-caption"
        style="left: {p.px}px; top: {p.py + p.size / 2 + 3}px; --c: {cap.color}"
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

  {#each cards as c (c.node.uri)}
    <PostCard
      item={c.node.item}
      run={c.node.run}
      x={c.x}
      y={c.y}
      boundsH={h}
      canMapReplies={c.node.isThreadRoot || (c.node.item.post.replyCount ?? 0) > 0}
      repliesMapped={repliesMapped(c.node.item)}
      context={whyHere(c.node)}
      onreply={(it) => compose.openReply(it)}
      onquote={(it) => compose.openQuote(it)}
      onmapreplies={toggleMapReplies}
      onkeep={() => setHovered(c.node.uri)}
      onleave={scheduleClear}
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
          <span class="label">Count</span>
          <input type="range" min="5" max="60" bind:value={settings.nodeLimit} />
          <span class="val">{settings.nodeLimit}</span>
        </div>

        <div class="row">
          <span class="label">Auto-cycle</span>
          <input
            type="checkbox"
            bind:checked={settings.autoCycle}
            disabled={settings.selectMode === 'mix' || total <= settings.nodeLimit}
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
          <span class="label">Cohesion</span>
          <input type="range" min="0" max="1" step="0.05" bind:value={settings.cohesion} />
          <span class="val">{Math.round(settings.cohesion * 100)}%</span>
        </div>
        <p class="hint">
          Left: posts hold to the time/engagement axes. Right: connections pull connected posts
          together into clumps.
        </p>

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
    <button class="digest-btn" onclick={() => (showDigest ? (showDigest = false) : summarize())} title="Summarize conversations">
      ✦ Digest
    </button>
    <button class="load-more" onclick={() => load(true)} disabled={loading || !cursor}>
      {loading ? 'Loading…' : 'Load more'}
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
</div>

<style>
  .graph {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
  .edges {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .annotations {
    position: absolute;
    inset: 0;
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
    left: 16px;
    bottom: 16px;
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
    right: 16px;
    bottom: 16px;
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
  .digest-btn {
    background: color-mix(in srgb, var(--bg-elev) 88%, transparent);
    backdrop-filter: blur(6px);
    font-size: 0.82rem;
  }
  .err-toast {
    position: absolute;
    left: 16px;
    bottom: 16px;
    color: var(--danger);
    font-size: 0.8rem;
  }

  /* Narrow screens: axis hints are teaching aids, not controls — hide them so
     the bottom row (gear / Digest / Load more) has the full width. */
  @media (max-width: 600px) {
    .axis {
      display: none;
    }
    .hud {
      right: 10px;
      bottom: 12px;
      gap: 0.45rem;
    }
    .config-wrap {
      bottom: 12px;
    }
  }
</style>
