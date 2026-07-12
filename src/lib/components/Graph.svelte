<script lang="ts">
  import { getTimeline, type FeedItem } from '../api/timeline'
  import { bskyUrl } from '../api/post'
  import {
    buildGraph,
    layoutPositions,
    parentUriOf,
    rootUriOf,
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
  import { SvelteSet } from 'svelte/reactivity'
  import PostNode from './PostNode.svelte'
  import PostCard from './PostCard.svelte'

  const PAD_X = 64
  const PAD_TOP = 52
  const PAD_BOTTOM = 56
  const MIN_SIZE = 34
  const MAX_SIZE = 66
  const CARD_W = 300

  let items = $state<FeedItem[]>([])
  let cursor = $state<string | undefined>(undefined)
  let loading = $state(false)
  let error = $state<string | undefined>(undefined)
  let hovered = $state<string | null>(null)

  // View preferences (node limit, selection mode, auto-cycle) live in a
  // persisted store; turnover offset and popover visibility are ephemeral.
  let turnoverOffset = $state(0)
  let showConfig = $state(false)
  const modes: SelectMode[] = ['top', 'recent', 'mix']

  let w = $state(0)
  let h = $state(0)

  // Live node positions, written by the simulation each tick.
  let positions = $state<Map<string, { x: number; y: number }>>(new Map())

  // Threads the user has mapped in (by thread root uri), and pinned nodes (by uri).
  const expanded = new SvelteSet<string>()
  const pinned = new SvelteSet<string>()

  // Merge optimistically-posted items (our own new posts/replies) with the feed,
  // then drop dismissed ones. buildGraph dedupes by uri.
  const allItems = $derived([...compose.injected, ...threads.posts, ...ancestors.posts, ...items])
  const visible = $derived(allItems.filter((i) => !read.isDismissed(i.post.uri)))
  const graph = $derived(buildGraph(visible, expanded))

  const total = $derived(graph.nodes.length)
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
      expanded,
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
    const innerW = Math.max(0, w - 2 * PAD_X)
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

  const edgeLines = $derived.by(() =>
    visibleEdges
      .map((e) => {
        const a = placedByUri.get(e.from)
        const b = placedByUri.get(e.to)
        if (!a || !b) return null
        return { id: e.id, x1: a.px, y1: a.py, x2: b.px, y2: b.py }
      })
      .filter((l): l is NonNullable<typeof l> => l !== null),
  )

  const hoveredCard = $derived.by(() => {
    if (!hovered) return null
    const p = placedByUri.get(hovered)
    if (!p) return null
    let x = p.px + p.size / 2 + 12
    if (x + CARD_W > w) x = p.px - p.size / 2 - 12 - CARD_W
    if (x < 8) x = 8
    let y = p.py - p.size / 2
    if (y < 8) y = 8
    if (y > h - 180) y = h - 180
    return { node: p.node, item: p.node.item, x, y }
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
    const t = targets
    const links = visibleEdges.map((e) => ({ source: e.from, target: e.to }))
    layout?.update(t, links, new Set(pinned))
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

  async function load(append: boolean) {
    if (loading) return
    loading = true
    error = undefined
    try {
      const page = await getTimeline(append ? cursor : undefined)
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

  /** Map (or un-map) a post's replies: reveal its thread, capped to the loudest. */
  function toggleMapReplies(item: FeedItem) {
    const root = rootUriOf(item)
    if (expanded.has(root)) {
      expanded.delete(root)
    } else {
      expanded.add(root)
      threads.ensure(root) // pull replies not already in the timeline
    }
  }
  function repliesMapped(item: FeedItem): boolean {
    return expanded.has(rootUriOf(item))
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

<div class="graph" bind:clientWidth={w} bind:clientHeight={h}>
  <div class="axis y-axis">louder ↑ · ↓ quieter</div>
  <div class="axis x-axis">← older · newer →</div>
  <div class="axis legend"><span class="dot"></span> size = replies</div>

  <svg class="edges" width={w} height={h}>
    {#each edgeLines as line (line.id)}
      <line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />
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
      onhover={(uri) => (uri ? setHovered(uri) : scheduleClear())}
      onclick={onNodeClick}
      ondblclick={onNodeDblClick}
      ondismiss={dismiss}
    />
  {/each}

  {#if hoveredCard}
    <PostCard
      item={hoveredCard.item}
      x={hoveredCard.x}
      y={hoveredCard.y}
      canMapReplies={hoveredCard.node.isThreadRoot || (hoveredCard.item.post.replyCount ?? 0) > 0}
      repliesMapped={repliesMapped(hoveredCard.item)}
      onreply={(it) => compose.openReply(it)}
      onquote={(it) => compose.openQuote(it)}
      onmapreplies={toggleMapReplies}
      onkeep={() => setHovered(hoveredCard.item.post.uri)}
      onleave={scheduleClear}
    />
  {/if}

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
            ? 'The loudest posts by engagement.'
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
      </div>
    {/if}
  </div>

  <div class="hud">
    {#if read.dismissed.size > 0}
      <span class="dismissed-count">{read.dismissed.size} dismissed</span>
    {/if}
    <button class="load-more" onclick={() => load(true)} disabled={loading || !cursor}>
      {loading ? 'Loading…' : 'Load more'}
    </button>
  </div>
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
  .edges line {
    stroke: var(--border);
    stroke-width: 1.5;
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
  .err-toast {
    position: absolute;
    left: 16px;
    bottom: 16px;
    color: var(--danger);
    font-size: 0.8rem;
  }
</style>
