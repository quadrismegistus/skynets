<script lang="ts">
  import { AppBskyFeedPost } from '@atproto/api'
  import type { GraphNode } from '../state/graph'
  import { authorName, reposterProfile } from '../api/post'

  interface Props {
    node: GraphNode
    /** Center position + diameter in container px. */
    px: number
    py: number
    size: number
    hasReplies: boolean
    active: boolean
    pinned: boolean
    unfollowed: boolean
    onhover: (uri: string | null) => void
    onclick: (node: GraphNode) => void
    ondblclick: (node: GraphNode) => void
    ondismiss: (uri: string) => void
    ondragmove: (uri: string, clientX: number, clientY: number) => void
    ondragend: (uri: string) => void
  }
  let {
    node,
    px,
    py,
    size,
    hasReplies,
    active,
    pinned,
    unfollowed,
    onhover,
    onclick,
    ondblclick,
    ondismiss,
    ondragmove,
    ondragend,
  }: Props = $props()

  const avatar = $derived(node.item.post.author.avatar)
  const repost = $derived(reposterProfile(node.item))
  const isReply = $derived.by(() => {
    const rec = node.item.post.record
    return AppBskyFeedPost.isRecord(rec) && !!rec.reply
  })

  function dismiss(e: MouseEvent) {
    e.stopPropagation()
    ondismiss(node.uri)
  }

  // Drag to reposition: a press that moves ≥ 4px becomes a drag (and the
  // release must then not count as a click). Window-level listeners so the
  // drag survives the pointer leaving the node.
  let dragMoved = false
  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return
    dragMoved = false
    const startX = e.clientX
    const startY = e.clientY
    const move = (ev: PointerEvent) => {
      if (!dragMoved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return
      dragMoved = true
      ondragmove(node.uri, ev.clientX, ev.clientY)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (dragMoved) ondragend(node.uri)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
</script>

<div
  class="wrap"
  class:active
  class:pinned
  class:unfollowed
  class:thread={node.isThreadRoot}
  style="left: {px}px; top: {py}px; width: {size}px; height: {size}px;"
  role="group"
  onmouseenter={() => onhover(node.uri)}
  onmouseleave={() => onhover(null)}
  onpointerdown={onPointerDown}
>
  {#if repost}
    <span class="reposter" title="Reposted by {repost.name}">
      {#if repost.avatar}
        <img src={repost.avatar} alt="" draggable="false" />
      {:else}
        <span class="rp-initial">{repost.name.charAt(0).toUpperCase()}</span>
      {/if}
    </span>
  {/if}
  <button
    class="node"
    class:replies={hasReplies}
    aria-label={authorName(node.item)}
    onclick={() => !dragMoved && onclick(node)}
    ondblclick={() => !dragMoved && ondblclick(node)}
  >
    {#if avatar}
      <img src={avatar} alt={authorName(node.item)} draggable="false" />
    {:else}
      <span class="initial">{authorName(node.item).charAt(0).toUpperCase()}</span>
    {/if}
  </button>

  {#if isReply}
    <span class="reply-badge" title="This post is a reply">↩</span>
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
    touch-action: none; /* pointer-drag on touch devices */
  }
  .node {
    width: 100%;
    height: 100%;
    padding: 0;
    border-radius: 50%;
    cursor: grab;
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
  /* Accounts you don't follow (reposts, pulled-in reply parents): dashed + dimmed. */
  .wrap.unfollowed .node {
    border-style: dashed;
  }
  .wrap.unfollowed img,
  .wrap.unfollowed .initial {
    opacity: 0.8;
  }
  /* Repost: the reposter tucked behind the reposted post's top-left shoulder. */
  .reposter {
    position: absolute;
    width: 52%;
    height: 52%;
    left: -17%;
    top: -17%;
    border-radius: 50%;
    overflow: hidden;
    border: 2px solid var(--bg);
    background: var(--bg-elev);
    z-index: 0;
    display: grid;
    place-items: center;
  }
  .reposter img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .rp-initial {
    font-size: 0.6rem;
    font-weight: 700;
    color: var(--text-dim);
  }
  .node {
    position: relative;
    z-index: 1;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    -webkit-user-drag: none; /* belt-and-braces with draggable=false */
    user-select: none;
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
  /* Bottom-right marker that this post is a reply. */
  .reply-badge {
    position: absolute;
    bottom: -3px;
    right: -3px;
    width: 17px;
    height: 17px;
    display: grid;
    place-items: center;
    background: var(--bg-elev);
    color: var(--text-dim);
    border: 1.5px solid var(--border);
    border-radius: 50%;
    font-size: 0.62rem;
    line-height: 1;
    pointer-events: none;
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
