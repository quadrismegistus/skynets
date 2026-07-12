<script lang="ts">
  import type { GraphNode } from '../state/graph'
  import { authorName } from '../api/post'

  interface Props {
    node: GraphNode
    /** Center position + diameter in container px. */
    px: number
    py: number
    size: number
    hasReplies: boolean
    active: boolean
    pinned: boolean
    onhover: (uri: string | null) => void
    onclick: (node: GraphNode) => void
    ondblclick: (node: GraphNode) => void
    ondismiss: (uri: string) => void
  }
  let {
    node,
    px,
    py,
    size,
    hasReplies,
    active,
    pinned,
    onhover,
    onclick,
    ondblclick,
    ondismiss,
  }: Props = $props()

  const avatar = $derived(node.item.post.author.avatar)

  function dismiss(e: MouseEvent) {
    e.stopPropagation()
    ondismiss(node.uri)
  }
</script>

<div
  class="wrap"
  class:active
  class:pinned
  class:thread={node.isThreadRoot}
  style="left: {px}px; top: {py}px; width: {size}px; height: {size}px;"
  role="group"
  onmouseenter={() => onhover(node.uri)}
  onmouseleave={() => onhover(null)}
>
  <button
    class="node"
    class:replies={hasReplies}
    aria-label={authorName(node.item)}
    onclick={() => onclick(node)}
    ondblclick={() => ondblclick(node)}
  >
    {#if avatar}
      <img src={avatar} alt={authorName(node.item)} />
    {:else}
      <span class="initial">{authorName(node.item).charAt(0).toUpperCase()}</span>
    {/if}
  </button>

  {#if pinned}
    <span class="pin" aria-hidden="true">📌</span>
  {/if}

  {#if node.collapsedCount > 0}
    <span class="badge" title="{node.collapsedCount} more in thread — click to expand"
      >+{node.collapsedCount}</span
    >
  {/if}

  <button class="dismiss" title="Mark as read (dismiss)" aria-label="Dismiss" onclick={dismiss}>
    ✕
  </button>
</div>

<style>
  .wrap {
    position: absolute;
    transform: translate(-50%, -50%);
  }
  .node {
    width: 100%;
    height: 100%;
    padding: 0;
    border-radius: 50%;
    border: 2px solid var(--border);
    background: var(--bg-elev);
    overflow: hidden;
    display: grid;
    place-items: center;
    transition:
      box-shadow 0.15s,
      border-color 0.15s;
  }
  .node:hover {
    border-color: var(--accent);
  }
  .node.replies {
    border-color: var(--accent-hover);
  }
  /* Thread representative: a distinct double-ring so it reads as expandable. */
  .wrap.thread .node {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent);
  }
  .wrap.active {
    z-index: 50;
  }
  .wrap.active .node {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(74, 144, 226, 0.35);
  }
  .wrap.pinned .node {
    border-color: #e0a838;
    box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px #e0a838;
  }
  .pin {
    position: absolute;
    top: -8px;
    left: -6px;
    font-size: 0.7rem;
    z-index: 55;
    pointer-events: none;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .initial {
    font-weight: 700;
    color: var(--text-dim);
  }
  .badge {
    position: absolute;
    bottom: -6px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--accent);
    color: #fff;
    font-size: 0.68rem;
    font-weight: 700;
    line-height: 1;
    padding: 2px 6px;
    border-radius: 999px;
    border: 1.5px solid var(--bg);
    pointer-events: none;
    white-space: nowrap;
  }
  .dismiss {
    position: absolute;
    top: -7px;
    right: -7px;
    width: 20px;
    height: 20px;
    padding: 0;
    border-radius: 50%;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text-dim);
    font-size: 0.7rem;
    line-height: 1;
    display: none;
    place-items: center;
    z-index: 60;
  }
  .wrap:hover .dismiss {
    display: grid;
  }
  .dismiss:hover {
    color: #fff;
    background: var(--danger);
    border-color: var(--danger);
  }
</style>
