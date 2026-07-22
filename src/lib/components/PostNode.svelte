<script lang="ts">
  import { AppBskyFeedPost } from '@atproto/api'
  import type { GraphNode } from '../state/graph'
  import { authorName, reposterProfile } from '../api/post'
  import { moderation } from '../state/moderation.svelte'

  interface Props {
    node: GraphNode
    /** Center position + diameter in container px. */
    px: number
    py: number
    size: number
    /** Pill mode: render avatar + the opening line of the post, at this fixed
     * w x h, instead of a bare avatar circle. */
    pill?: { w: number; h: number }
    /** Reader mode (focus lens): render the FULL post text in a card of this
     * w x h, so a thread reads without hovering. Overrides `pill` for size and
     * layout; media/quote get a flag chip that invites a hover for the embed. */
    reader?: { w: number; h: number }
    /** Newly on screen: animate it in from `enter` rather than appearing. */
    arriving?: boolean
    /** Offset to enter FROM, in container px. */
    enter?: { x: number; y: number }
    hasReplies: boolean
    active: boolean
    /** Fellow member of the hovered post's conversation — soft highlight so the
     * chain reads as one thing while you look at any of its posts. */
    related?: boolean
    pinned: boolean
    /** A dismissed ancestor resurrected for chain context — dimmed, no ✕. */
    ghost: boolean
    /** Private thumbs mark (#66), shown as a small corner badge when set. */
    reaction?: 'up' | 'down'
    /** Digest topic color — tints the border so neighbouring threads read apart. */
    accent?: string
    unfollowed: boolean
    onhover: (uri: string | null) => void
    onclick: (node: GraphNode) => void
    ondblclick: (node: GraphNode) => void
    /** Unfurl the collapsed thread behind the +N badge. */
    onexpand: (node: GraphNode) => void
    ondismiss: (uri: string) => void
    ondragmove: (uri: string, clientX: number, clientY: number) => void
    ondragend: (uri: string) => void
    /** Reader-lens inline actions (shown on hover; the card is the read surface,
     * so its actions live on it rather than on a popped card). */
    onreply?: (node: GraphNode) => void
    onquote?: (node: GraphNode) => void
    onrate?: (uri: string, kind: 'up' | 'down') => void
  }
  let {
    node,
    px,
    py,
    size,
    pill,
    reader,
    arriving = false,
    enter,
    hasReplies,
    active,
    related = false,
    pinned,
    ghost,
    reaction,
    accent,
    unfollowed,
    onhover,
    onclick,
    ondblclick,
    onexpand,
    ondismiss,
    ondragmove,
    ondragend,
    onreply,
    onquote,
    onrate,
  }: Props = $props()

  // Held at the entry offset for one frame, then released so CSS carries it
  // home. Two rAFs: one to let the offset paint, one to change it -- a single
  // frame is not reliably enough for the browser to register a transition.
  // Starts false and stays false until `arriving` turns on, because the graph
  // only learns a post is new AFTER the template has rendered it. Marking it
  // landed at mount meant the entrance was already over before it was flagged,
  // and nothing ever animated. The class needs `arriving` too, so a post that
  // is never flagged simply never enters.
  let landed = $state(false)
  $effect(() => {
    if (!arriving) return
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => (landed = true))
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  })

  const avatar = $derived(node.item.post.author.avatar)
  // The pill shows the opening of the post. CSS line-clamps to two lines, so
  // this only has to stop the DOM carrying a whole thread's worth of text.
  const preview = $derived.by(() => {
    const rec = node.item.post.record
    const text = AppBskyFeedPost.isRecord(rec) ? rec.text.trim() : ''
    return text.length > 160 ? text.slice(0, 160) + '…' : text
  })
  // Reader mode wants the whole post (Bluesky caps at 300); CSS line-clamps and
  // fades where a long one overruns the card, hinting "hover for the rest".
  const fullText = $derived.by(() => {
    const rec = node.item.post.record
    return AppBskyFeedPost.isRecord(rec) ? rec.text.trim() : ''
  })
  // What the reader card can't show inline — flagged so the reader knows to hover.
  // Matches the embed VIEW $type (recordWithMedia counts as a quote).
  const embedFlag = $derived.by(() => {
    const t = (node.item.post.embed as { $type?: string } | undefined)?.$type
    if (!t) return null
    return {
      image: t.includes('images'),
      video: t.includes('video'),
      quote: t.includes('record'),
      link: t.includes('external'),
    }
  })
  const hasEmbedFlag = $derived(
    !!embedFlag && (embedFlag.image || embedFlag.video || embedFlag.quote || embedFlag.link),
  )
  const repost = $derived(reposterProfile(node.item))
  // A node is too small to explain itself: it only signals "covered". The
  // reason and the way in live on the card, which has room for both.
  const cover = $derived(moderation.cover(node.item))
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
  // A contextmenu event cannot tell you what produced it -- a long-press on
  // touch fires the same event as a right-click -- so the pointer type is
  // recorded here. Dismissing a post someone was only trying to drag would be a
  // nasty surprise, and on touch the ✕ is already a single tap away.
  let lastPointerType = 'mouse'

  function onContextMenu(e: MouseEvent) {
    if (lastPointerType !== 'mouse') return
    e.preventDefault() // no browser menu over the graph
    e.stopPropagation()
    // Ghosts are ancestors resurrected for context and were already dismissed;
    // they carry no ✕ either.
    if (!ghost) ondismiss(node.uri)
  }

  function onPointerDown(e: PointerEvent) {
    lastPointerType = e.pointerType
    if (e.button !== 0) return
    dragMoved = false
    // Mouse only: drag to reposition. On touch a node does nothing on pointer-
    // down — a tap opens the card (onclick), and the triage swipe lives on the
    // CARD now (the node is covered by the card on a phone, and up/down there
    // fights scrolling a long post). See PostCard's horizontal swipe.
    if (e.pointerType !== 'mouse') return
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
  class:pill={!!pill || !!reader}
  class:reader={!!reader}
  class:arriving
  class:entering={arriving && !landed}
  class:active
  class:related
  class:pinned
  class:ghost
  class:unfollowed
  class:thread={node.isThreadRoot}
  style="left: {px}px; top: {py}px; width: {reader ? reader.w : pill ? pill.w : size}px; height: {reader ? reader.h : pill ? pill.h : size}px; --ex: {enter?.x ?? 0}px; --ey: {enter?.y ?? 0}px;{accent ? ` --accent-topic: ${accent};` : ''}"
  role="group"
  onpointerenter={(e) => e.pointerType === 'mouse' && onhover(node.uri)}
  onpointerleave={(e) => e.pointerType === 'mouse' && onhover(null)}
  onpointerdown={onPointerDown}
  oncontextmenu={onContextMenu}
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
    class:covered={cover.blur}
    aria-label={cover.blur ? `${authorName(node.item)} — ${cover.reason}` : authorName(node.item)}
    onclick={() => !dragMoved && onclick(node)}
    ondblclick={() => !dragMoved && ondblclick(node)}
  >
    <span class="face">
      {#if avatar}
        <img src={avatar} alt={authorName(node.item)} draggable="false" />
      {:else}
        <span class="initial">{authorName(node.item).charAt(0).toUpperCase()}</span>
      {/if}
      {#if cover.blur}
        <span class="cover-mark" title={cover.reason} aria-hidden="true">⚠</span>
      {/if}
    </span>
    {#if pill || reader}
      <span class="say">
        <span class="who">{authorName(node.item)}</span>
        <!-- Covered posts stay covered here too: the pill would otherwise print
             in plain text exactly what the blurred avatar is hiding. Reader mode
             shows the whole post; pill mode the opening line. -->
        <span class="text">{cover.blur ? cover.reason : reader ? fullText : preview}</span>
        {#if reader && !cover.blur && hasEmbedFlag && embedFlag}
          <span class="flags" aria-hidden="true">
            {#if embedFlag.image}<span class="flag">🖼 image</span>{/if}
            {#if embedFlag.video}<span class="flag">🎬 video</span>{/if}
            {#if embedFlag.quote}<span class="flag">❝ quote</span>{/if}
            {#if embedFlag.link}<span class="flag">🔗 link</span>{/if}
          </span>
        {/if}
      </span>
    {/if}
  </button>

  {#if isReply}
    <span class="reply-badge" title="This post is a reply">↩</span>
  {/if}

  {#if reaction}
    <span
      class="reaction-badge {reaction}"
      title={reaction === 'up' ? 'You thumbed this up (private)' : 'You thumbed this down (private)'}
      aria-hidden="true">{reaction === 'up' ? '👍' : '👎'}</span
    >
  {/if}

  {#if node.collapsedCount > 0}
    <button
      class="badge expand-badge"
      title="{node.collapsedCount} more in thread — click to expand"
      aria-label="Expand {node.collapsedCount} more posts in thread"
      onclick={() => !dragMoved && onexpand(node)}
      >+{node.collapsedCount}</button
    >
  {:else if node.run && node.run.length > 1}
    <span class="badge run-badge" title="{node.run.length} consecutive posts by this author — the card scrolls through them"
      >{node.run.length}≡</span
    >
  {/if}

  {#if !ghost}
    <button class="dismiss" title="Mark as read (dismiss)" aria-label="Dismiss" onclick={dismiss}>
      ✕
    </button>
  {/if}

  <!-- Reader-lens actions: the card IS the reading surface (no popped card for
       pure text), so reply/quote/rate live on it, revealed on hover. Media/quote
       cards keep popping the full card, which carries these already. -->
  {#if reader && !hasEmbedFlag && !ghost && !cover.blur}
    <div
      class="actions"
      role="toolbar"
      tabindex="-1"
      aria-label="Post actions"
      onpointerdown={(e) => e.stopPropagation()}
    >
      <button title="Reply" aria-label="Reply" onclick={(e) => { e.stopPropagation(); onreply?.(node) }}>↩</button>
      <button title="Quote" aria-label="Quote" onclick={(e) => { e.stopPropagation(); onquote?.(node) }}>❝</button>
      <button title="Thumb up (private)" aria-label="Thumb up" onclick={(e) => { e.stopPropagation(); onrate?.(node.uri, 'up') }}>👍</button>
      <button title="Thumb down (private)" aria-label="Thumb down" onclick={(e) => { e.stopPropagation(); onrate?.(node.uri, 'down') }}>👎</button>
    </div>
  {/if}
</div>

<style>
  .wrap {
    position: absolute;
    transform: translate(-50%, -50%);
    touch-action: none; /* pointer-drag on touch devices */
  }
  /* The transition lives ONLY on a node that is mid-arrival, and disappears with
     the class when the entrance ends. Left on every node permanently it made
     nothing ever "stable": Playwright waits for animations to finish before
     hovering, so every hover in the existing suite timed out -- in avatar mode
     too, which has no entrance at all.

     Only the entry offset is animated. left/top carry the simulation and are
     deliberately untransitioned; easing those would lag every tick. */
  .wrap.arriving {
    /* Duration comes from the "Post motion" slider via --arrive-dur (set on the
       graph root); 0.45s is the fallback / default. 0ms = snap, no fly-in. */
    transition:
      transform var(--arrive-dur, 0.45s) cubic-bezier(0.22, 0.61, 0.36, 1),
      opacity var(--arrive-dur, 0.45s) ease;
  }
  .wrap.entering {
    transform: translate(-50%, -50%) translate(var(--ex), var(--ey));
    opacity: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .wrap.arriving {
      transition: none;
    }
  }
  .node {
    width: 100%;
    height: 100%;
    padding: 0;
    border-radius: 50%;
    cursor: grab;
    /* Topic-tinted border when the digest has labeled this conversation;
       status styles (pinned/thread/active) below still override. */
    border: 2px solid var(--accent-topic, var(--border));
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
    border-color: var(--accent-topic, var(--accent-hover));
  }
  /* Thread representative: a distinct double-ring so it reads as expandable.
     The ring adopts the topic tint when labeled — the SHAPE is the signal. */
  .wrap.thread .node {
    border-color: var(--accent-topic, var(--accent));
    box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent-topic, var(--accent));
  }
  .wrap.active {
    z-index: 50;
  }
  /* Fellow members of the hovered post's conversation: a softer ring in the
     thread's topic colour (white fallback), dimmer than the gold active ring so
     the chain reads as context around the post you're actually on. */
  .wrap.related .node {
    border-color: var(--accent-topic, rgba(255, 255, 255, 0.75));
    box-shadow:
      0 0 0 2px var(--bg),
      0 0 0 4px var(--accent-topic, rgba(255, 255, 255, 0.45));
  }
  .wrap.pinned .node {
    border-color: #e0a838;
    box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px #e0a838;
  }
  /* The post whose card is showing: a bright gold ring so it's unmistakable
     which node you're reading (like — but brighter than — the pinned ring).
     Placed AFTER .pinned (equal specificity) so the DISPLAYED post always shows
     this ring even when it's also pinned — e.g. opened from the digest panel. */
  .wrap.active .node {
    border-color: #ffcf4a;
    box-shadow: 0 0 0 2px var(--bg), 0 0 0 5px #ffcf4a;
  }
  /* Content warning: the avatar is obscured but the node keeps its place, size
     and edges, so the conversation's shape survives intact. */
  .node.covered img,
  .node.covered .initial {
    filter: blur(7px);
  }
  .cover-mark {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-size: 0.85rem;
    line-height: 1;
    color: #fff;
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
    background: rgba(0, 0, 0, 0.28);
    pointer-events: none;
  }
  /* A dismissed ancestor shown only for chain context: strongly dimmed. */
  .wrap.ghost {
    opacity: 0.45;
  }
  .wrap.ghost:hover,
  .wrap.ghost.active {
    opacity: 0.9; /* readable when you engage with it */
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
  /* The avatar lives in its own box so the pill can set text beside it. In
     circle mode the box just fills the node, so nothing about it changes. */
  .face {
    position: relative;
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    overflow: hidden;
  }

  /* ---- Pill mode ---------------------------------------------------------
     Avatar left, the opening of the post right. Speculative: the graph becomes
     readable without hovering every node, at the cost of far fewer posts on
     screen at once. */
  .wrap.pill .node {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 9px;
    padding: 0 13px 0 7px;
    border-radius: 999px;
    text-align: left;
  }
  .wrap.pill .face {
    flex: 0 0 40px;
    width: 40px;
    height: 40px;
    border-radius: 50%;
  }
  /* The reposter chip is sized as a fraction of the node, which on a 212x56
     pill stretched it into an oval. Fixed px in pill mode. */
  .wrap.pill .reposter {
    width: 26px;
    height: 26px;
    left: -7px;
    top: -7px;
  }
  /* No double ring in pill mode: at this scale the outer ring reads as a heavy
     outline rather than a signal. Thread roots keep the accent border colour
     and the collapsed-count badge. Pinned keeps its ring -- that one marks a
     state the reader just created, and is worth the weight. */
  .wrap.pill.thread .node {
    box-shadow: none;
  }

  .say {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0; /* without this the text refuses to clamp and the pill bulges */
  }
  .who {
    font-size: 0.62rem;
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .say .text {
    font-size: 0.72rem;
    line-height: 1.25;
    color: var(--text);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* ---- Reader lens ------------------------------------------------------
     Inside the focus lens each node is a full-text card: read the thread
     without hovering. Rectangular (not a capsule), avatar top-left, text
     filling the box and clamping where a rare long post overruns. These rules
     follow .wrap.pill (equal specificity) so they win on source order. */
  .wrap.reader .node {
    align-items: flex-start;
    gap: 8px;
    padding: 9px 11px;
    border-radius: 14px;
  }
  .wrap.reader .face {
    flex: 0 0 30px;
    width: 30px;
    height: 30px;
    margin-top: 1px;
  }
  .wrap.reader .say {
    gap: 2px;
    overflow: hidden;
  }
  .wrap.reader .who {
    font-size: 0.66rem;
  }
  .wrap.reader .text {
    font-size: 0.75rem;
    line-height: 1.32;
    /* High enough that a full 300-char post fits at this card width rather than
       truncating; the fixed box height is the real bound. */
    -webkit-line-clamp: 10;
    line-clamp: 10;
  }
  .wrap.reader .flags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 3px;
  }
  .wrap.reader .flag {
    font-size: 0.56rem;
    line-height: 1.5;
    color: var(--text-dim);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0 6px;
    white-space: nowrap;
  }
  /* Inline action bar, revealed on hover in the bottom-right of a reader card. */
  .actions {
    position: absolute;
    bottom: 5px;
    right: 7px;
    display: none;
    gap: 1px;
    padding: 2px;
    border-radius: 999px;
    background: var(--bg);
    border: 1px solid var(--border);
    z-index: 40;
  }
  @media (hover: hover) {
    .wrap.reader:hover .actions {
      display: flex;
    }
  }
  .actions button {
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    background: transparent;
    border-radius: 50%;
    font-size: 0.72rem;
    line-height: 1;
    display: grid;
    place-items: center;
    cursor: pointer;
    color: var(--text-dim);
  }
  .actions button:hover {
    background: var(--bg-elev);
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
  .run-badge {
    background: var(--bg-elev);
    color: var(--text-dim);
    border: 1.5px solid var(--border);
  }
  .badge {
    position: absolute;
    z-index: 3; /* above the avatar circle (.node is z-index 1) */
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
  /* The +N badge really does expand on click (its tooltip says so). */
  .expand-badge {
    pointer-events: auto;
    cursor: pointer;
    font-family: inherit;
  }
  .expand-badge:hover {
    background: var(--accent-hover);
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
  /* Bottom-left corner: private thumbs mark. Clear of the reposter (top-left),
     dismiss ✕ (top-right) and reply badge (bottom-right). Mainly seen on a
     resurfaced ghost, since reacting also dismisses. */
  .reaction-badge {
    position: absolute;
    bottom: -4px;
    left: -4px;
    width: 17px;
    height: 17px;
    display: grid;
    place-items: center;
    background: var(--bg-elev);
    border: 1.5px solid var(--border);
    border-radius: 50%;
    font-size: 0.6rem;
    line-height: 1;
    pointer-events: none;
    z-index: 3;
  }
  .reaction-badge.up {
    border-color: #3fb950;
  }
  .reaction-badge.down {
    border-color: var(--danger);
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
  /* Only where hover is real. On touch, iOS treats the first tap on an element
     with hover-revealed content as the hover and swallows the click — which is
     why the first tap on a node produced a ✕ instead of the post. Touch gets
     its dismiss from the card's ✕ instead. */
  @media (hover: hover) {
    .wrap:hover .dismiss {
      display: grid;
    }
  }
  .dismiss:hover {
    color: #fff;
    background: var(--danger);
    border-color: var(--danger);
  }
</style>
