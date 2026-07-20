<script lang="ts">
  import { onDestroy } from 'svelte'
  import type { FeedItem } from '../api/timeline'
  import {
    authorName,
    fullDate,
    postExternal,
    postFacets,
    postImages,
    postQuote,
    postText,
    reposterProfile,
    timeAgo,
    type QuotedPost,
    bskyUrl,
  } from '../api/post'
  import { segments } from '../api/richtext'
  import { interactions } from '../state/interactions.svelte'
  import { follows } from '../state/follows.svelte'
  import { profiles } from '../state/profiles.svelte'
  import { session } from '../state/session.svelte'
  import { settings } from '../state/settings.svelte'
  import { moderation } from '../state/moderation.svelte'
  import { report } from '../state/report.svelte'
  import ProfileHover from './ProfileHover.svelte'

  interface Props {
    item: FeedItem
    /** Anchor position (top-left) in container px. */
    x: number
    y: number
    /** Container height, so a tall card can be kept from clipping off the bottom. */
    boundsH: number
    canMapReplies: boolean
    repliesMapped: boolean
    /** Why this post is in the graph (pulled-in context); undefined for timeline posts. */
    context?: string
    onreply: (item: FeedItem) => void
    onquote: (item: FeedItem) => void
    onmapreplies: (item: FeedItem) => void
    onkeep: () => void
    onleave: () => void
    /** Touch: explicit close (hover-out doesn't exist there). */
    onclose?: () => void
    /** Touch: mark this post read and drop it from the graph — what the node's
     * hover ✕ does with a pointer. On touch that ✕ can't exist (see PostNode),
     * so the card carries the action instead. */
    ondismiss?: () => void
    /** Show that close button. Passed from the same JS check that decides the
     * tap behaviour, so the two can't disagree — a CSS-only @media rule left
     * the ✕ hidden on anything the media query and matchMedia read differently. */
    showClose?: boolean
    /** Contiguous self-reply run this card fronts (item = run[0]): the
     * continuation posts render as a scrollable sequence below the head. */
    run?: FeedItem[]
  }
  let {
    item,
    x,
    y,
    boundsH,
    canMapReplies,
    repliesMapped,
    context,
    onreply,
    onquote,
    onmapreplies,
    onkeep,
    onleave,
    onclose,
    ondismiss,
    showClose = false,
    run,
  }: Props = $props()

  // Keep the card fully on screen: shift its top up if its measured height would
  // run off the bottom of the container.
  let cardH = $state(0)
  const top = $derived(Math.max(8, Math.min(y, boundsH - cardH - 8)))

  const rt = $derived(reposterProfile(item))
  const rtFollowing = $derived(rt && rt.did ? follows.following(rt) : false)
  // Reposter shaped like a post author, so the same profile preview works.
  const rtAuthor = $derived(
    rt && rt.did
      ? { did: rt.did, handle: rt.handle, displayName: rt.name, avatar: rt.avatar, viewer: rt.viewer }
      : null,
  )
  let showRtProfile = $state(false)
  let rtHoverTimer: ReturnType<typeof setTimeout> | undefined
  let rtOpenTimer: ReturnType<typeof setTimeout> | undefined
  /** Open delay for the profile popovers. The avatar is itself only revealed on
   * hover, so an immediate popover fired while the pointer merely passed over a
   * post — this waits for a deliberate hover before opening (and before the
   * profile fetch). Cancelled by mouseleave. */
  const HOVER_OPEN_MS = 500
  /**
   * The profile popover is positioned FIXED, for the same reason the ⋯ menu
   * below is: the card is `overflow: hidden auto`, so an absolutely-positioned
   * popover is clipped by the card and scrolls it instead of overlaying it —
   * you had to scroll the card to read the bottom of a profile.
   *
   * Fixed needs the same flip: opening downward near the foot of the screen
   * runs the popover off it, and opening upward near the top puts it under the
   * topbar, which eats pointer events.
   */
  const POP_W = 240 // .profile-hover is 15rem
  type Anchor = { left: number; top: number; bottom: number }
  function anchorOf(e: MouseEvent): Anchor {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return { left: r.left, top: r.top, bottom: r.bottom }
  }
  /** MEASURED, not assumed — a profile with a long bio is taller than one
   * without, so a hardcoded height would flip at the wrong moment. */
  function popPos(a: Anchor | null, h: number) {
    if (typeof window === 'undefined' || !a) return { left: 0, top: 0 }
    const below = a.bottom + 6
    const top = below + h > window.innerHeight - 8 ? Math.max(TOPBAR_SAFE, a.top - 6 - h) : below
    const left = Math.min(Math.max(8, a.left), Math.max(8, window.innerWidth - 8 - POP_W))
    return { left, top }
  }
  let rtAnchor = $state<Anchor | null>(null)
  let rtPopH = $state(0)
  const rtPop = $derived(popPos(rtAnchor, rtPopH))

  function enterRt(e: MouseEvent) {
    if (!rtAuthor) return
    clearTimeout(rtHoverTimer)
    // Already open (the pointer crossed onto the popover, which runs this same
    // handler) — hold it; don't re-delay or re-anchor.
    if (showRtProfile) return
    clearTimeout(rtOpenTimer)
    // Capture the anchor + did synchronously; e.currentTarget is gone by the
    // time the timer fires.
    const anchor = anchorOf(e)
    const did = rtAuthor.did
    rtOpenTimer = setTimeout(() => {
      profiles.ensure(did)
      rtAnchor = anchor
      showRtProfile = true
    }, HOVER_OPEN_MS)
  }
  function leaveRt() {
    clearTimeout(rtOpenTimer)
    clearTimeout(rtHoverTimer)
    rtHoverTimer = setTimeout(() => (showRtProfile = false), 160)
  }
  // Cards mount/unmount constantly as the graph re-lays-out; don't let a pending
  // close-timer fire (and touch $state) on a torn-down component.
  onDestroy(() => {
    clearTimeout(hoverTimer)
    clearTimeout(rtHoverTimer)
    clearTimeout(profileOpenTimer)
    clearTimeout(rtOpenTimer)
  })
  function toggleReposter() {
    if (!rt || !rt.did) return
    follows.toggle(rt)
  }
  const textSegs = $derived(segments(postText(item), postFacets(item)))
  /** The run's continuation posts (the head renders as the main card body). */
  const continuation = $derived(run && run.length > 1 ? run.slice(1) : [])
  const images = $derived(postImages(item))
  const quoted = $derived(postQuote(item))
  const external = $derived(postExternal(item))
  // The head (who posted) and the action row stay visible even under a cover:
  // you need to be able to see whose post this is, and act on it, precisely
  // when it's the kind of post you'd want to act on.
  const cover = $derived(moderation.cover(item))
  /** A reply whose parent we will never draw: the server sends a contentless
   * stub for a blocked author, so the chain stops dead and the post looks like
   * a root. Say why rather than leaving a hole. */
  const silencedParent = $derived(moderation.silencedParent(item))

  function quoteUrl(q: QuotedPost): string {
    return `https://bsky.app/profile/${q.handle}/post/${q.uri.split('/').pop()}`
  }

  function hostOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return url
    }
  }

  /** Which post's repost menu is open (uri) — per-post, since a run card holds many. */
  let repostMenuFor = $state<string | null>(null)
  /** Same, for the ⋯ (report / mute / block) menu. */
  let moreMenuFor = $state<string | null>(null)
  /**
   * This menu is positioned FIXED rather than absolute, unlike the repost menu
   * just above it. The card is `overflow: hidden auto`, and four items are tall
   * enough to escape the card's top edge — where they're clipped away and can't
   * be clicked at all. The repost menu only has two items so it fits, which is
   * why the card has got away with clipping until now.
   *
   * Fixed also needs a flip: opening upward near the top of the screen puts the
   * menu under the topbar, which eats the pointer events.
   */
  /** Keep the menu clear of the topbar, which eats pointer events under it. */
  const TOPBAR_SAFE = 56
  let moreAnchor = $state<{ left: number; top: number; bottom: number } | null>(null)
  /** MEASURED, not assumed. This was a hardcoded 190px for a four-item menu, so
   * adding a fifth would have silently broken the flip and put items back under
   * the topbar. Binding the rendered height means it self-corrects for any
   * number of items — on the first frame the height is 0, so it opens upward
   * and immediately re-evaluates once measured. */
  let moreMenuH = $state(0)
  const moreMenuUp = $derived(!moreAnchor || moreAnchor.top - moreMenuH - 6 > TOPBAR_SAFE)
  const moreMenuPos = $derived(
    moreAnchor
      ? { left: moreAnchor.left, top: moreMenuUp ? moreAnchor.top - 6 : moreAnchor.bottom + 6 }
      : { left: 0, top: 0 },
  )
  function toggleMore(e: MouseEvent, uri: string) {
    if (moreMenuFor === uri) {
      moreMenuFor = null
      return
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    moreAnchor = { left: r.left + r.width / 2, top: r.top, bottom: r.bottom }
    moreMenuFor = uri
  }

  const muted = $derived(moderation.isMuted(item.post.author))
  const blocked = $derived(moderation.isBlocked(item.post.author))
  /** Mute and block are fire-and-forget from the card's point of view, but a
   * failure must not pass silently — the overlay rolls back and we say so. */
  let modError = $state<string | undefined>(undefined)
  async function runModAction(fn: () => Promise<void>) {
    modError = undefined
    moreMenuFor = null
    try {
      await fn()
    } catch (err) {
      modError = err instanceof Error ? err.message : 'That didn’t work'
    }
  }
  let copied = $state(false)
  const isSelf = $derived(item.post.author.did === session.did)
  const following = $derived(follows.following(item.post.author))
  const followsYou = $derived(follows.followsYou(item.post.author))

  // Avatar hover → profile preview. Opens on a deliberate-hover delay
  // (HOVER_OPEN_MS); the close keeps a tiny delay so the popover doesn't flicker
  // as the pointer crosses the small gap to it.
  let showProfile = $state(false)
  let hoverTimer: ReturnType<typeof setTimeout> | undefined
  let profileOpenTimer: ReturnType<typeof setTimeout> | undefined
  let profileAnchor = $state<Anchor | null>(null)
  let profilePopH = $state(0)
  const profilePop = $derived(popPos(profileAnchor, profilePopH))

  function enterAvatar(e: MouseEvent) {
    clearTimeout(hoverTimer)
    if (showProfile) return // already open (pointer moved onto the popover) — hold it
    clearTimeout(profileOpenTimer)
    const anchor = anchorOf(e)
    const did = item.post.author.did
    profileOpenTimer = setTimeout(() => {
      profiles.ensure(did)
      profileAnchor = anchor
      showProfile = true
    }, HOVER_OPEN_MS)
  }
  function leaveAvatar() {
    clearTimeout(profileOpenTimer)
    clearTimeout(hoverTimer)
    hoverTimer = setTimeout(() => (showProfile = false), 160)
  }

  const REPLY =
    'M12 4C6.9 4 3 7.2 3 11.2c0 2 1 3.9 2.7 5.2-.1 1.3-.7 2.6-1.7 3.6 1.6-.1 3.3-.7 4.6-1.6 1.1.3 2.2.5 3.4.5 5.1 0 9-3.2 9-7.3C21 7.2 17.1 4 12 4z'
  const REPOST =
    'M17 4l3.2 3.2-3.2 3.2V8.2H9A1.8 1.8 0 007.2 10v1.6H5.2V10A3.8 3.8 0 019 6.2h8V4zM7 20l-3.2-3.2L7 13.6v2.2h8a1.8 1.8 0 001.8-1.8v-1.6h2v1.6A3.8 3.8 0 0115 17.8H7V20z'
  const HEART =
    'M12 20.7l-1.3-1.2C6 15.3 3 12.6 3 9.2 3 6.5 5.1 4.5 7.8 4.5c1.5 0 3 .7 3.9 1.9.9-1.2 2.4-1.9 3.9-1.9C18.4 4.5 20.5 6.5 20.5 9.2c0 3.4-3 6.1-7.7 10.4L12 20.7z'
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="card"
  style="left: {x}px; top: {top}px;"
  bind:clientHeight={cardH}
  onmouseenter={onkeep}
  onmouseleave={onleave}
>
  {#if showClose && (ondismiss || onclose)}
    <!-- Dismiss, not close: tapping outside the card closes it and leaves the
         post alone, so the one button here is the one that does something. -->
    <button class="card-close" aria-label="Dismiss post" onclick={ondismiss ?? onclose}>✕</button>
  {/if}
  {#if rt}
    <div class="repost">
      🔁 reposted by
      {#if rtAuthor}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <span class="rt-name" onmouseenter={enterRt} onmouseleave={leaveRt}>
          {rt.name}
          {#if showRtProfile}
            <div
              class="profile-pop"
              style="left: {rtPop.left}px; top: {rtPop.top}px"
              bind:clientHeight={rtPopH}
              onmouseenter={enterRt}
              onmouseleave={leaveRt}
              role="tooltip"
            >
              <ProfileHover author={rtAuthor} />
            </div>
          {/if}
        </span>
      {:else}
        {rt.name}
      {/if}
      {#if rt.did && rt.did !== session.did}
        <button class="rt-follow" onclick={toggleReposter}>
          {rtFollowing ? 'unfollow' : 'follow'}
        </button>
      {/if}
    </div>
  {/if}
  {#if context}
    {#if settings.debugMode}
      <button
        class="why"
        title="Why this post is in the graph — click to copy its raw feed data"
        onclick={() => {
          const raw = JSON.stringify(item, null, 2)
          navigator.clipboard?.writeText(raw)
          console.log('[mothtrap] raw feed item\n' + raw)
          copied = true
          setTimeout(() => (copied = false), 1500)
        }}
      >
        🧭 {copied ? 'copied raw data ✓' : context}
      </button>
    {:else}
      <div class="repost">🧭 {context}</div>
    {/if}
  {/if}
  {#if silencedParent}
    <p class="silenced-parent">
      ↩ Replying to an account you've {silencedParent}.{silencedParent === 'blocked'
        ? " Their post can't be shown."
        : ''}
    </p>
  {/if}
  <div class="head">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="avatar-wrap"
      onmouseenter={enterAvatar}
      onmouseleave={leaveAvatar}
    >
      {#if item.post.author.avatar}
        <img class="avatar" src={item.post.author.avatar} alt="" />
      {:else}
        <div class="avatar avatar-blank"></div>
      {/if}
      {#if showProfile}
        <div
          class="profile-pop"
          style="left: {profilePop.left}px; top: {profilePop.top}px"
          bind:clientHeight={profilePopH}
          onmouseenter={enterAvatar}
          onmouseleave={leaveAvatar}
          role="tooltip"
        >
          <ProfileHover author={item.post.author} />
        </div>
      {/if}
    </div>
    <div class="meta">
      <span class="name">{authorName(item)}</span>
      <span class="handle">
        <span class="handle-text">@{item.post.author.handle}</span>{#if followsYou && !isSelf}<span
            class="follows-you">follows you</span
          >{/if}
      </span>
    </div>
    {#if !isSelf}
      <button
        class="follow"
        class:following
        onclick={() => follows.toggle(item.post.author)}
      >
        {following ? 'Following' : 'Follow'}
      </button>
    {/if}
    <a
      class="time"
      href={bskyUrl(item)}
      target="_blank"
      rel="noreferrer"
      title={fullDate(item)}
      onclick={(e) => e.stopPropagation()}>{timeAgo(item)}</a
    >
  </div>
  {#if cover.blur && !cover.media}
    <div class="cover">
      <span class="cover-why">⚠ {cover.reason}</span>
      {#if cover.canReveal}
        <button
          class="cover-show"
          onclick={(e) => {
            e.stopPropagation()
            moderation.reveal(item)
          }}>Show anyway</button
        >
      {/if}
    </div>
  {:else}
    <div class="text">
      {#each textSegs as seg}{#if seg.href}<a
            href={seg.href}
            target="_blank"
            rel="noreferrer"
            onclick={(e) => e.stopPropagation()}>{seg.text}</a
          >{:else}{seg.text}{/if}{/each}
    </div>

    {#if images.length}
      {#if cover.media}
        <button
          class="cover cover-media"
          disabled={!cover.canReveal}
          onclick={(e) => {
            e.stopPropagation()
            moderation.reveal(item)
          }}
        >
          <span class="cover-why">⚠ {cover.reason}</span>
          {#if cover.canReveal}<span class="cover-hint">Show</span>{/if}
        </button>
      {:else}
        <div class="images" data-n={Math.min(images.length, 4)}>
          {#each images.slice(0, 4) as img}
            <img src={img.thumb} alt={img.alt} title={img.alt} />
          {/each}
        </div>
      {/if}
    {/if}

    {#if external}
      <a
        class="external"
        href={external.uri}
        target="_blank"
        rel="noreferrer"
        onclick={(e) => e.stopPropagation()}
      >
        {#if external.thumb}<img class="ext-thumb" src={external.thumb} alt="" />{/if}
        <div class="ext-body">
          <span class="ext-host">{hostOf(external.uri)}</span>
          <span class="ext-title">{external.title}</span>
          {#if external.description}<span class="ext-desc">{external.description}</span>{/if}
        </div>
      </a>
    {/if}

    {#if quoted}
      <a
        class="quoted"
        href={quoteUrl(quoted)}
        target="_blank"
        rel="noreferrer"
        onclick={(e) => e.stopPropagation()}
      >
        <div class="q-head">
          {#if quoted.avatar}<img class="q-avatar" src={quoted.avatar} alt="" />{/if}
          <span class="q-name">{quoted.name}</span>
          <span class="q-handle">@{quoted.handle}</span>
        </div>
        <p class="q-text">{quoted.text}</p>
      </a>
    {/if}
  {/if}

  <!-- Actions sit with the post they act on: the head's bar directly under the
       head content, each run continuation with its own compact row — every post
       in a run is a separate likeable/repliable target on Bluesky. -->
  {@render actionRow(item, false)}

  {#if continuation.length}
    <div class="run-more">
      {#each continuation as c (c.post.uri)}
        {@const cc = moderation.cover(c)}
        <div class="run-post">
          <a
            class="run-time"
            href={bskyUrl(c)}
            target="_blank"
            rel="noreferrer"
            title={fullDate(c)}
            onclick={(e) => e.stopPropagation()}>{timeAgo(c)}</a
          >
          <!-- Every post in a run needs its own check. `cover` above is computed
               for the run HEAD only, so a run whose third post is labelled (or
               hits a muted word) was rendering that post's full text. Mute and
               block are uniform across a run — same author by construction — so
               what leaked here was specifically labels, muted words and hidden
               posts, the very things the module promises to cover. -->
          {#if cc.blur}
            <button
              class="cover cover-media"
              disabled={!cc.canReveal}
              onclick={(e) => {
                e.stopPropagation()
                moderation.reveal(c)
              }}
            >
              <span class="cover-why">⚠ {cc.reason}</span>
              {#if cc.canReveal}<span class="cover-hint">Show</span>{/if}
            </button>
          {:else}
            <div class="run-text">{postText(c)}</div>
          {/if}
          {@render actionRow(c, true)}
        </div>
      {/each}
    </div>
  {/if}

  {#if canMapReplies}
    <button class="map-replies" class:on={repliesMapped} onclick={() => onmapreplies(item)}>
      {repliesMapped ? 'Hide replies' : `Map replies${item.post.replyCount ? ` (${item.post.replyCount})` : ''}`}
    </button>
  {/if}
</div>

{#snippet actionRow(p: FeedItem, compact: boolean)}
  {@const pLiked = interactions.liked(p)}
  {@const pReposted = interactions.reposted(p)}
  <div class="actions" class:compact>
    <button class="act" title="Reply" onclick={() => onreply(p)}>
      <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d={REPLY} fill="currentColor" /></svg>
      <span>{p.post.replyCount ?? 0}</span>
    </button>

    <div class="repost-wrap">
      <button
        class="act"
        class:on={pReposted}
        title="Repost or quote"
        onclick={() => (repostMenuFor = repostMenuFor === p.post.uri ? null : p.post.uri)}
      >
        <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d={REPOST} fill="currentColor" /></svg>
        <span>{interactions.repostCount(p)}</span>
      </button>
      {#if repostMenuFor === p.post.uri}
        <div class="menu">
          <button
            onclick={() => {
              interactions.toggleRepost(p)
              repostMenuFor = null
            }}>{pReposted ? 'Undo repost' : 'Repost'}</button
          >
          <button
            onclick={() => {
              onquote(p)
              repostMenuFor = null
            }}>Quote post</button
          >
        </div>
      {/if}
    </div>

    <button
      class="act like"
      class:on={pLiked}
      title={pLiked ? 'Unlike' : 'Like'}
      onclick={() => interactions.toggleLike(p)}
    >
      <svg class="ic" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d={HEART}
          fill={pLiked ? 'currentColor' : 'none'}
          stroke="currentColor"
          stroke-width={pLiked ? 0 : 1.8}
        />
      </svg>
      <span>{interactions.likeCount(p)}</span>
    </button>

    <div class="more-wrap">
      <button
        class="act more"
        title="Report, mute or block"
        aria-label="More actions"
        onclick={(e) => toggleMore(e, p.post.uri)}>⋯</button
      >
      {#if moreMenuFor === p.post.uri}
        <div
          class="menu floating"
          class:up={moreMenuUp}
          bind:clientHeight={moreMenuH}
          style="left: {moreMenuPos.left}px; top: {moreMenuPos.top}px;"
        >
          <button
            onclick={() => {
              report.show(p)
              moreMenuFor = null
            }}>Report post</button
          >
          {#if !isSelf}
            <button onclick={() => runModAction(() => (muted ? moderation.unmute(p.post.author) : moderation.mute(p.post.author)))}>
              {muted ? 'Unmute' : 'Mute'} @{p.post.author.handle}
            </button>
            <button
              class="danger"
              onclick={() => runModAction(() => (blocked ? moderation.unblock(p.post.author) : moderation.block(p.post.author)))}
            >
              {blocked ? 'Unblock' : 'Block'} @{p.post.author.handle}
            </button>
            <button
              onclick={() => {
                report.show(p, 'account')
                moreMenuFor = null
              }}>Report account</button
            >
          {/if}
        </div>
      {/if}
    </div>
  </div>
  {#if modError && !compact}<p class="mod-error">{modError}</p>{/if}
{/snippet}

<style>
  .card {
    position: absolute;
    z-index: 100;
    width: 360px;
    max-width: 84vw;
    max-height: 72vh;
    overflow-y: auto;
    overflow-x: hidden;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 0.8rem 0.9rem;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
  }
  .repost {
    font-size: 0.72rem;
    color: var(--text-dim);
    margin-bottom: 0.45rem;
  }
  .rt-name {
    position: relative;
    cursor: pointer;
    text-decoration: underline;
    text-decoration-style: dotted;
    text-underline-offset: 2px;
  }
  /* Reposter follow/unfollow: deliberately small and muted — a pruning tool,
   * not a call to action. */
  .rt-follow {
    margin-left: 0.35rem;
    padding: 0.05rem 0.45rem;
    font-size: 0.68rem;
    border-radius: 999px;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-dim);
  }
  .rt-follow:hover {
    color: var(--text);
    border-color: var(--text-dim);
  }
  .why {
    display: block;
    padding: 0;
    border: none;
    background: transparent;
    text-align: left;
    font-size: 0.72rem;
    color: var(--text-dim);
    margin-bottom: 0.45rem;
    cursor: pointer;
  }
  .why:hover {
    color: var(--text);
  }
  .head {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-bottom: 0.45rem;
  }
  .follow {
    flex: none;
    align-self: center;
    padding: 0.2rem 0.6rem;
    font-size: 0.75rem;
    font-weight: 600;
    border-radius: 999px;
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    white-space: nowrap;
  }
  .follow:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }
  .follow.following {
    background: transparent;
    color: var(--text-dim);
    border-color: var(--border);
    font-weight: 500;
  }
  .time {
    flex: none;
    align-self: flex-start;
    color: var(--text-dim);
    font-size: 0.75rem;
    white-space: nowrap;
  }
  .avatar-wrap {
    position: relative;
    flex: none;
    cursor: pointer;
  }
  .avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    object-fit: cover;
    display: block;
  }
  .avatar-blank {
    background: var(--border);
  }
  /* Profile preview popover — hangs below-right of the avatar, above the card. */
  .profile-pop {
    /* Fixed, not absolute: see popPos. Absolute meant the card clipped it. */
    position: fixed;
    z-index: 60;
  }
  /* The name/handle column absorbs all the slack in the head, so the Follow
     button and timestamp are the only things against the right edge and land in
     the same place on every card. Previously .follow and .time BOTH had
     margin-left:auto, and flex splits free space equally between two auto
     margins — so the timestamp anchored right correctly but the button floated
     at "meta's end plus half the slack", drifting up to 45px with how long the
     author's name happened to be. */
  .meta {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .name {
    font-weight: 600;
    font-size: 0.9rem;
  }
  .handle {
    color: var(--text-dim);
    font-size: 0.78rem;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
  }
  /* The handle is what gives, so the badge never has to. Without this the flex
     children refuse to shrink, spill out of .handle's own (shrunken) box and
     paint on top of the Follow button — which is what "follows you" was doing
     under "Following" on any longish handle. */
  .handle-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .follows-you {
    padding: 0.05rem 0.3rem;
    font-size: 0.6rem;
    font-weight: 600;
    color: var(--text-dim);
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    border-radius: 0.3rem;
    white-space: nowrap;
    flex: none;
  }
  .silenced-parent {
    margin: 0 0 0.4rem;
    padding: 0.3rem 0.45rem;
    font-size: 0.75rem;
    color: var(--text-dim);
    background: var(--bg);
    border: 1px dashed var(--border);
    border-radius: 6px;
  }
  .text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.4;
    font-size: 0.9rem;
    margin-bottom: 0.5rem;
  }
  .text a {
    color: var(--accent);
  }
  /* Content warning. Stands in for the post body (or just its media), never
     for the head or the actions — you can always see who posted and act on it. */
  .cover {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    width: 100%;
    margin-bottom: 0.5rem;
    padding: 0.6rem 0.7rem;
    border: 1px dashed var(--border);
    border-radius: 8px;
    background: var(--bg);
    text-align: left;
  }
  .cover-why {
    font-size: 0.82rem;
    color: var(--text-dim);
  }
  .cover-show,
  .cover-hint {
    flex: none;
    font-size: 0.78rem;
    font-family: inherit;
    color: var(--accent);
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }
  .cover-show:hover,
  .cover-media:not(:disabled):hover .cover-hint {
    text-decoration: underline;
  }
  .cover-media {
    cursor: pointer;
  }
  .cover-media:disabled {
    cursor: default;
  }
  .images {
    display: grid;
    gap: 3px;
    margin-bottom: 0.5rem;
    border-radius: 10px;
    overflow: hidden;
  }
  .images[data-n='1'] {
    grid-template-columns: 1fr;
  }
  .images[data-n='2'],
  .images[data-n='3'],
  .images[data-n='4'] {
    grid-template-columns: 1fr 1fr;
  }
  .images img {
    width: 100%;
    height: 100%;
    max-height: 160px;
    object-fit: cover;
    display: block;
  }
  .external {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.5rem 0.6rem;
    margin-bottom: 0.5rem;
    color: inherit;
    text-decoration: none;
  }
  .external:hover {
    border-color: var(--accent);
    text-decoration: none;
  }
  .ext-thumb {
    width: 56px;
    height: 56px;
    border-radius: 8px;
    object-fit: cover;
    flex-shrink: 0;
  }
  .ext-body {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 0.1rem;
  }
  .ext-host {
    font-size: 0.72rem;
    color: var(--text-dim);
  }
  .ext-title {
    font-size: 0.83rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ext-desc {
    font-size: 0.76rem;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .quoted {
    display: block;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.5rem 0.6rem;
    margin-bottom: 0.5rem;
    color: inherit;
    text-decoration: none;
  }
  .quoted:hover {
    border-color: var(--accent);
    text-decoration: none;
  }
  .q-head {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin-bottom: 0.2rem;
  }
  .q-avatar {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    object-fit: cover;
  }
  .q-name {
    font-weight: 600;
    font-size: 0.8rem;
  }
  .q-handle {
    color: var(--text-dim);
    font-size: 0.75rem;
  }
  .q-text {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.35;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
  }
  /* Per-post row on run continuations: same targets, quieter presence. */
  .actions.compact {
    gap: 0.3rem;
    margin-top: 0.15rem;
  }
  .actions.compact .act {
    padding: 0.15rem 0.3rem;
    font-size: 0.7rem;
  }
  .actions.compact .ic {
    width: 13px;
    height: 13px;
  }
  .map-replies {
    width: 100%;
    margin-top: 0.5rem;
    font-size: 0.8rem;
    padding: 0.4rem;
    color: var(--text-dim);
  }
  .map-replies:hover {
    border-color: var(--accent);
    color: var(--text);
  }
  .map-replies.on {
    border-color: var(--accent);
    color: var(--accent);
  }
  .repost-wrap {
    position: relative;
    flex: 1;
    display: flex;
  }
  .more-wrap {
    position: relative;
    display: flex;
  }
  .act.more {
    font-size: 1rem;
    line-height: 1;
    letter-spacing: 0.05em;
  }
  /* Escapes the card's overflow clip — see toggleMore(). */
  .menu.floating {
    position: fixed;
    bottom: auto;
    z-index: 900; /* over the topbar and the graph, under the modals (1000) */
  }
  .menu.floating.up {
    transform: translate(-50%, -100%);
  }
  .menu button.danger {
    color: var(--danger);
  }
  .mod-error {
    margin: 0.35rem 0 0;
    font-size: 0.78rem;
    color: var(--danger);
  }
  .act {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    padding: 0.3rem 0.4rem;
    font-size: 0.8rem;
    line-height: 1;
    background: transparent;
    border-color: transparent;
    color: var(--text-dim);
  }
  .ic {
    width: 17px;
    height: 17px;
    display: block;
    flex-shrink: 0;
  }
  .act span {
    font-variant-numeric: tabular-nums;
  }
  .act:hover {
    background: var(--bg);
    border-color: var(--border);
  }
  .act.on {
    color: var(--text);
  }
  .act.like.on {
    color: var(--danger);
  }
  .repost-wrap:has(.on) .act,
  .act.on {
    color: var(--text);
  }
  .repost-wrap .act.on {
    color: #4caf7d;
  }
  .menu {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    padding: 0.25rem;
    z-index: 200;
  }
  .menu button {
    background: transparent;
    border: none;
    border-radius: 6px;
    text-align: left;
    white-space: nowrap;
    padding: 0.4rem 0.7rem;
    font-size: 0.82rem;
    color: var(--text);
  }
  .menu button:hover {
    background: var(--bg);
  }

  /* Touch: a real close button (hover-out doesn't exist). 44px Apple floor. */
  .card-close {
    display: grid;
    position: sticky;
    top: 0;
    float: right;
    width: 40px;
    height: 40px;
    margin: -0.35rem -0.45rem 0 0.4rem;
    padding: 0;
    place-items: center;
    border-radius: 50%;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text-dim);
    font-size: 1rem;
    z-index: 101;
  }

  /* Continuation posts of a self-reply run: a compact scrollable sequence.
     The card's own max-height + overflow handles long monologues. */
  .run-more {
    margin-top: 0.5rem;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
  }
  .run-post {
    padding: 0.45rem 0 0.35rem;
    border-bottom: 1px dashed var(--border);
  }
  .run-post:last-child {
    border-bottom: none;
  }
  .run-time {
    display: block;
    text-align: right;
    font-size: 0.7rem;
    color: var(--text-dim);
    text-decoration: none;
  }
  .run-time:hover,
  a.time:hover {
    color: var(--text);
    text-decoration: underline;
  }
  a.time {
    text-decoration: none;
  }
  .run-text {
    font-size: 0.85rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
