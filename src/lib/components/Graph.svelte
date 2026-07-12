<script lang="ts">
  import { getTimeline, type FeedItem } from '../api/timeline'
  import { bskyUrl } from '../api/post'
  import { buildGraph, threadDescendants, type GraphNode } from '../state/graph'
  import { ForceLayout, type Target } from '../state/forceLayout'
  import { read } from '../state/read.svelte'
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

  let w = $state(0)
  let h = $state(0)

  // Live node positions, written by the simulation each tick.
  let positions = $state<Map<string, { x: number; y: number }>>(new Map())

  // Threads the user has unspooled (by thread root uri).
  const expanded = new SvelteSet<string>()

  // Posts still visible: not dismissed. Reactive on read.dismissed.
  const visible = $derived(items.filter((i) => !read.isDismissed(i.post.uri)))
  const graph = $derived(buildGraph(visible, expanded))

  const edgeCount = $derived.by(() => {
    const c = new Map<string, number>()
    for (const e of graph.edges) c.set(e.to, (c.get(e.to) ?? 0) + 1)
    return c
  })

  // Semantic targets (px) each node is pulled toward.
  const targets = $derived.by<Target[]>(() => {
    const innerW = Math.max(0, w - 2 * PAD_X)
    const innerH = Math.max(0, h - PAD_TOP - PAD_BOTTOM)
    return graph.nodes.map((n) => ({
      id: n.uri,
      tx: PAD_X + n.x * innerW,
      ty: PAD_TOP + n.y * innerH,
      r: (MIN_SIZE + n.sizeRank * (MAX_SIZE - MIN_SIZE)) / 2,
    }))
  })

  const nodeByUri = $derived(new Map(graph.nodes.map((n) => [n.uri, n])))

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
    graph.edges
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
    return { item: p.node.item, x, y }
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

  // Reheat whenever targets or links change (new data, resize, dismissal).
  $effect(() => {
    const t = targets
    const links = graph.edges.map((e) => ({ source: e.from, target: e.to }))
    layout?.update(t, links)
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

  function toggleThread(node: GraphNode) {
    if (expanded.has(node.rootUri)) expanded.delete(node.rootUri)
    else expanded.add(node.rootUri)
  }

  function dismiss(uri: string) {
    // Dismiss the post and every reply hanging off it, so clearing a thread
    // clears the whole thread rather than leaving orphaned replies behind.
    const all = [uri, ...threadDescendants(items, uri)]
    read.dismissMany(all)
    if (hovered && all.includes(hovered)) hovered = null
  }

  // Distinguish single click (expand/collapse a thread) from double click
  // (open on bsky.app): a lone click waits ~220ms for a possible double.
  let clickTimer: ReturnType<typeof setTimeout> | undefined
  function onNodeClick(node: GraphNode) {
    clearTimeout(clickTimer)
    clickTimer = setTimeout(() => {
      if (node.isThreadRoot) toggleThread(node)
    }, 220)
  }
  function onNodeDblClick(node: GraphNode) {
    clearTimeout(clickTimer)
    open(node)
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') hovered = null
    else if ((e.key === 'd' || e.key === 'D') && hovered) dismiss(hovered)
  }

  load(false)
</script>

<svelte:window onkeydown={onKey} />

<div class="graph" bind:clientWidth={w} bind:clientHeight={h}>
  <div class="axis y-axis">louder ↑ · ↓ quieter</div>
  <div class="axis x-axis">← older · newer →</div>

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
      onhover={(uri) => (hovered = uri)}
      onclick={onNodeClick}
      ondblclick={onNodeDblClick}
      ondismiss={dismiss}
    />
  {/each}

  {#if hoveredCard}
    <PostCard item={hoveredCard.item} x={hoveredCard.x} y={hoveredCard.y} />
  {/if}

  {#if items.length === 0 && !loading}
    <div class="empty">{error ?? 'No posts.'}</div>
  {/if}
  {#if loading && items.length === 0}
    <div class="empty">Loading timeline…</div>
  {/if}

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
  .empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--text-dim);
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
