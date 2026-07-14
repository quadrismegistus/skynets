<script lang="ts">
  import { getTimeline, type FeedItem } from '../api/timeline'
  import { bskyUrl, reposter, reposterProfile } from '../api/post'
  import {
    buildGraph,
    layoutPositions,
    parentUriOf,
    selectVisible,
    threadDescendants,
    type GraphNode,
    type SelectMode,
  } from '../state/graph'
  import { ForceLayout, type Target } from '../state/forceLayout'
  import { read } from '../state/read.svelte'
  import { settings } from '../state/settings.svelte'
  import { compose } from '../state/compose.svelte'
  import { threads } from '../state/threads.svelte'
  import { ancestors } from '../state/ancestors.svelte'
  import { follows } from '../state/follows.svelte'
  import { session } from '../state/session.svelte'
  import { archive } from '../state/archive'
  import { backfill } from '../state/backfill'
  import { getFollowDids } from '../api/actors'

  // Captured at component init (before any archive write) so backfill can tell
  // prior-session posts (firstSeen < this) from ones loaded this session.
  const APP_MOUNT = Date.now()
  import { digest } from '../state/digest.svelte'
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

  // View preferences (node limit, selection mode, auto-cycle) live in a
  // persisted store; turnover offset and popover visibility are ephemeral.
  let turnoverOffset = $state(0)
  let showConfig = $state(false)
  let showDigest = $state(false)
  const modes: SelectMode[] = ['top', 'recent', 'mix']

  let w = $state(0)
  let h = $state(0)

  // Live node positions, written by the simulation each tick.
  let positions = $state<Map<string, { x: number; y: number }>>(new Map())

  // Threads the user has mapped in (by thread root uri), and pinned nodes (by uri).
  const expanded = new SvelteSet<string>()
  const pinned = new SvelteSet<string>()

  // The single source of truth for what counts as "your feed": the Reposts
  // and Follows-only toggles apply HERE, before anything downstream (primary
  // status, provenance, ancestor-fetching) is derived. Filtering later (as
  // `visible` once did) let a hidden repost leak its uri into the primary set,
  // so its unattributed fetched copy displayed as a plain timeline post from
  // a stranger — the root cause of the "unfollowed node, unexplained" saga.
  const feedItems = $derived(
    items.filter((i) => {
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
  // Posts revived from the archive when a rolling digest references one that's
  // scrolled out of the loaded feed (off-window reveal, PLAN §7 Phase A).
  let revived = $state<FeedItem[]>([])
  const primarySources = $derived([...compose.injected, ...feedItems])
  const allItems = $derived([...primarySources, ...threads.posts, ...ancestors.posts, ...revived])
  const primaryUris = $derived(new Set(primarySources.map((i) => i.post.uri)))
  const visible = $derived(allItems.filter((i) => !read.isDismissed(i.post.uri)))
  const graph = $derived(buildGraph(visible, expanded, primaryUris))

  // Only primary nodes compete for the window, so the queue/turnover counts
  // are over them; context nodes ride along and don't inflate the numbers.
  const total = $derived(graph.nodes.filter((n) => n.primary).length)
  const queued = $derived(total <= settings.nodeLimit ? 0 : total - settings.nodeLimit)

  // Which nodes to show (top/recent/mix), plus pinned nodes and — when "connect
  // replies" is on — the present ancestor chain of each shown node, so a reply is
  // drawn connected to the post it replies to. Layout is computed over this set.
  const visibleNodes = $derived.by(() => {
    const selected = selectVisible(
      graph.nodes,
      settings.selectMode,
      settings.nodeLimit,
      turnoverOffset,
    )
    if (!pinned.size && !settings.connectReplies) return selected
    const set = new Map(selected.map((n) => [n.uri, n]))
    for (const n of graph.nodes) if (pinned.has(n.uri) && !set.has(n.uri)) set.set(n.uri, n)
    if (settings.connectReplies) {
      const byUri = new Map(graph.nodes.map((n) => [n.uri, n]))
      for (const start of [...set.values()]) {
        let cur: GraphNode | undefined = start
        const guard = new Set<string>([start.uri])
        while (cur) {
          const p = parentUriOf(cur.item)
          if (!p || guard.has(p)) break
          const pn = byUri.get(p)
          if (!pn) break
          guard.add(p)
          set.set(p, pn)
          cur = pn
        }
      }
    }
    return [...set.values()]
  })
  const nodeLayout = $derived(layoutPositions(visibleNodes))

  const visibleUris = $derived(new Set(visibleNodes.map((n) => n.uri)))
  const visibleEdges = $derived(
    graph.edges.filter((e) => visibleUris.has(e.from) && visibleUris.has(e.to)),
  )

  const edgeCount = $derived.by(() => {
    const c = new Map<string, number>()
    for (const e of visibleEdges) c.set(e.to, (c.get(e.to) ?? 0) + 1)
    return c
  })

  // Semantic targets (px) each node is pulled toward.
  const targets = $derived.by<Target[]>(() => {
    // When the digest panel is open it overlays the right edge, so shrink the
    // usable width by the panel so every node stays visible to its left.
    const panelW = showDigest ? Math.min(PANEL_W, w * 0.88) : 0
    const innerW = Math.max(0, w - 2 * PAD_X - panelW)
    const innerH = Math.max(0, h - PAD_TOP - PAD_BOTTOM)
    return visibleNodes.map((n) => {
      const p = nodeLayout.get(n.uri) ?? { x: 0.5, y: 0.5, sizeRank: 0.5 }
      return {
        id: n.uri,
        tx: PAD_X + p.x * innerW,
        ty: PAD_TOP + p.y * innerH,
        r: (MIN_SIZE + p.sizeRank * (MAX_SIZE - MIN_SIZE)) / 2,
      }
    })
  })

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
  const annotations = $derived.by(() => {
    const convos = digest.digest?.conversations ?? []
    return convos
      .map((c) => {
        const pts = c.postUris
          .map((u) => placedByUri.get(u))
          .filter((p): p is NonNullable<typeof p> => p != null)
        if (pts.length === 0) return null
        const cx = pts.reduce((s, p) => s + p.px, 0) / pts.length
        const cy = pts.reduce((s, p) => s + p.py, 0) / pts.length
        // Each conversation is a topic node linked to its (visible) member posts.
        const members = pts.map((p) => ({ uri: p.node.uri, x: p.px, y: p.py }))
        return { id: c.id, sid: `topic:${c.id}`, label: c.label, color: convoColor(c.id), cx, cy, uris: c.postUris, members }
      })
      .filter((a): a is NonNullable<typeof a> => a !== null)
  })

  // Topic nodes join the force simulation as real nodes: a target at the
  // members' centroid, and a link to each member so the edges actually pull the
  // conversation's posts together (and the topic node is draggable, like a post).
  const topicTargets = $derived<Target[]>(
    annotations.map((a) => ({ id: a.sid, tx: a.cx, ty: a.cy, r: 24 })),
  )
  const topicLinks = $derived(
    annotations.flatMap((a) => a.members.map((m) => ({ source: a.sid, target: m.uri }))),
  )
  // Topic render positions come from the sim (fallback: the members' centroid).
  const topics = $derived(
    annotations.map((a) => {
      const p = positions.get(a.sid)
      return { ...a, tx: p?.x ?? a.cx, ty: p?.y ?? a.cy }
    }),
  )

  async function summarize() {
    showDigest = true
    // Pull more pages until we have enough posts to fill the digest window (or
    // the timeline runs out). More posts = richer conversations — the "ICE
    // killing" thread only cohered past ~30 posts — so the digest shouldn't be
    // starved by whatever the node limit happened to load.
    let guard = 0
    while (feedItems.length < digest.window && cursor && !loading && guard++ < 12) {
      await load(true)
    }
    digest.summarize(feedItems.slice(0, digest.window))
  }

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
        if (item) revived = [...revived.filter((r) => r.post.uri !== uri), item]
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
  function onTopicPointerDown(e: PointerEvent, id: string) {
    e.preventDefault()
    const sx = e.clientX
    const sy = e.clientY
    let moved = false
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return
      moved = true
      onNodeDrag(id, ev.clientX, ev.clientY)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (moved) onNodeDragEnd(id)
      else togglePinUri(id)
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
          x1: a.px + ux * (a.size / 2),
          y1: a.py + uy * (a.size / 2),
          x2: b.px - ux * (b.size / 2 + 7),
          y2: b.py - uy * (b.size / 2 + 7),
        }
      })
      .filter((l): l is NonNullable<typeof l> => l !== null),
  )

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
    if (!did) return
    archive
      .open(did)
      .then(async () => {
        await digest.engine.rehydrate()
        // Snapshot the follows list for the corpus (network-over-time). Runs
        // once per session in the background; recordFollows skips if unchanged.
        archive.recordFollows(await getFollowDids(did)).catch(() => {})
        // Gap-healing backfill: page the timeline backward to import history
        // from before this session (throttled; stops at the archived boundary).
        // Runs silently in the background; the corpus grows. Surfaced later by
        // the archive UI (deferred).
        backfill(APP_MOUNT).catch(() => {})
      })
      .catch(() => {
        /* archive unavailable (private mode / no IndexedDB) — the digest still
           works in-memory, just not persisted. */
      })
  })

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
    layout?.update(t, links, new Set(pinned), settings.clusterForce)
  })

  // Connect replies: pull in the parents of any loaded reply we don't have yet
  // (skipping dismissed ones). As fetched parents reveal their own parents, this
  // climbs the chain toward the thread root over successive runs.
  $effect(() => {
    if (!settings.connectReplies) return
    const present = new Set(allItems.map((i) => i.post.uri))
    const wanted = new Set<string>()
    for (const it of allItems) {
      const p = parentUriOf(it)
      if (p && !present.has(p) && !read.isDismissed(p)) wanted.add(p)
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
      const page = await getTimeline()
      void archive.record(page.items)
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

  // Auto-cadence: in Continuous digest mode, ingest new posts into the rolling
  // engine on a timer — hands-free. The engine dedups already-seen posts and the
  // gate skips the LLM when nothing is new, so most ticks are cheap. Toggling
  // Continuous on triggers the initial establish; the live poll then feeds new
  // posts in over time.
  const DIGEST_CADENCE_MS = 60_000
  async function runDigestTick() {
    if (loading || digest.loading || feedItems.length === 0) return
    // First establish fills the window so the initial clustering is rich.
    if (digest.engine.clusters.length === 0) {
      let guard = 0
      while (feedItems.length < digest.window && cursor && !loading && guard++ < 12) {
        await load(true)
      }
    }
    await digest.summarize(feedItems.slice(0, digest.window))
  }
  $effect(() => {
    if (!digest.continuous) return
    // Only `digest.continuous` is read synchronously here, so the interval isn't
    // torn down every time the feed changes; the ticks read the feed at call time.
    const t0 = setTimeout(runDigestTick, 400)
    const id = setInterval(runDigestTick, DIGEST_CADENCE_MS)
    return () => {
      clearTimeout(t0)
      clearInterval(id)
    }
  })

  async function load(append: boolean) {
    if (loading) return
    loading = true
    error = undefined
    try {
      const page = await getTimeline(append ? cursor : undefined)
      void archive.record(page.items)
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
    // Dismiss the post and every reply hanging off it, so clearing a thread
    // clears the whole thread rather than leaving orphaned replies behind.
    const all = [uri, ...threadDescendants(allItems, uri)]
    read.dismissMany(all)
    if (hovered && all.includes(hovered)) hovered = null
  }

  // Distinguish single click (pin the node) from double click (open on bsky.app):
  // a lone click waits ~220ms for a possible double.
  let clickTimer: ReturnType<typeof setTimeout> | undefined
  function onNodeClick(node: GraphNode) {
    clearTimeout(clickTimer)
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
    } else if (k === 'd' && hovered) dismiss(hovered)
    else if (k === 'r') load(true)
    else if (k === 'n') nextBatch()
    else if (k === 'l') turnoverOffset = 0
  }

  load(false)
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
    if (!t.closest('.wrap, .card, .config-wrap, .hud, .panel, .digest-btn, .topic-node')) clearAll()
  }}
>
  {#if !settings.clusterForce}
    <div class="axis y-axis">louder ↑ · ↓ quieter</div>
    <div class="axis x-axis">← older · newer →</div>
  {/if}
  <div class="axis legend"><span class="dot"></span> size = replies</div>

  <svg class="edges" width={w} height={h}>
    <defs>
      <marker
        id="reply-arrow"
        viewBox="0 0 10 10"
        refX="8"
        refY="5"
        markerWidth="6"
        markerHeight="6"
        orient="auto-start-reverse"
      >
        <path d="M0,0 L10,5 L0,10 z" />
      </marker>
    </defs>
    {#each edgeLines as line (line.id)}
      <line
        x1={line.x1}
        y1={line.y1}
        x2={line.x2}
        y2={line.y2}
        marker-end="url(#reply-arrow)"
      />
    {/each}
  </svg>

  <!-- Topic edges: each conversation's node links to its member posts. -->
  <svg class="annotations" width={w} height={h}>
    {#each topics as a (a.id)}
      {#each a.members as m}
        <line x1={a.tx} y1={a.ty} x2={m.x} y2={m.y} stroke={a.color} />
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
      unfollowed={p.node.item.post.author.did !== session.did &&
        !follows.following(p.node.item.post.author)}
      onhover={(uri) => (uri ? setHovered(uri) : scheduleClear())}
      onclick={onNodeClick}
      ondblclick={onNodeDblClick}
      ondismiss={dismiss}
      ondragmove={onNodeDrag}
      ondragend={onNodeDragEnd}
    />
  {/each}

  {#each topics as a (a.id)}
    <button
      class="topic-node"
      class:pinned={pinned.has(a.sid)}
      style="left: {a.tx}px; top: {a.ty}px; --c: {a.color}"
      title="Drag to pull its posts together · click to pin"
      onpointerdown={(e) => onTopicPointerDown(e, a.sid)}
    >
      {a.label}
    </button>
  {/each}

  {#each cards as c (c.node.uri)}
    <PostCard
      item={c.node.item}
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
    />
  {/each}

  {#if items.length === 0 && !loading}
    <div class="empty">{error ?? 'No posts.'}</div>
  {/if}
  {#if loading && items.length === 0}
    <div class="empty">Loading timeline…</div>
  {/if}

  <div class="config-wrap">
    <button class="gear" onclick={() => (showConfig = !showConfig)} title="View settings">
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
          <span class="label">Cluster</span>
          <input type="checkbox" bind:checked={settings.clusterForce} />
          <span class="val"></span>
        </div>
        <p class="hint">Let connected posts pull together, loosening the time/engagement axes.</p>

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
          <span class="label">Debug</span>
          <input type="checkbox" bind:checked={settings.debugMode} />
          <span class="val"></span>
        </div>
        <p class="hint">Label every card's provenance; click the 🧭 line to copy the raw post JSON.</p>
      </div>
    {/if}
  </div>

  <div class="hud">
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
  .annotations line {
    stroke-width: 1.6;
    opacity: 0.4;
    stroke-dasharray: 2 4;
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
  .topic-node.pinned {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--c) 60%, transparent);
  }
  .edges line {
    stroke: var(--text-dim);
    stroke-width: 1.6;
    opacity: 0.65;
  }
  .edges marker path {
    fill: var(--text-dim);
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
    width: 260px;
    padding: 0.9rem;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    font-size: 0.8rem;
    overflow: hidden;
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
  .hud {
    position: absolute;
    right: 16px;
    bottom: 16px;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.85rem;
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
</style>
