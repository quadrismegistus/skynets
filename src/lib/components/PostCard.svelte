<script lang="ts">
  import type { FeedItem } from '../api/timeline'
  import {
    authorName,
    fullDate,
    postExternal,
    postFacets,
    postImages,
    postQuote,
    postText,
    reposter,
    timeAgo,
    type QuotedPost,
  } from '../api/post'
  import { segments } from '../api/richtext'
  import { interactions } from '../state/interactions.svelte'
  import { follows } from '../state/follows.svelte'
  import { session } from '../state/session.svelte'

  interface Props {
    item: FeedItem
    /** Top-left position in container px. */
    x: number
    y: number
    canMapReplies: boolean
    repliesMapped: boolean
    onreply: (item: FeedItem) => void
    onquote: (item: FeedItem) => void
    onmapreplies: (item: FeedItem) => void
    onkeep: () => void
    onleave: () => void
  }
  let {
    item,
    x,
    y,
    canMapReplies,
    repliesMapped,
    onreply,
    onquote,
    onmapreplies,
    onkeep,
    onleave,
  }: Props = $props()

  const rt = $derived(reposter(item))
  const liked = $derived(interactions.liked(item))
  const reposted = $derived(interactions.reposted(item))
  const textSegs = $derived(segments(postText(item), postFacets(item)))
  const images = $derived(postImages(item))
  const quoted = $derived(postQuote(item))
  const external = $derived(postExternal(item))

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

  let repostMenu = $state(false)
  const isSelf = $derived(item.post.author.did === session.did)
  const following = $derived(follows.following(item.post.author))

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
  style="left: {x}px; top: {y}px;"
  onmouseenter={onkeep}
  onmouseleave={onleave}
>
  {#if rt}
    <div class="repost">🔁 reposted by {rt}</div>
  {/if}
  <div class="head">
    {#if item.post.author.avatar}
      <img class="avatar" src={item.post.author.avatar} alt="" />
    {/if}
    <div class="meta">
      <span class="name">{authorName(item)}</span>
      <span class="handle">@{item.post.author.handle}</span>
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
    <span class="time" title={fullDate(item)}>{timeAgo(item)}</span>
  </div>
  <div class="text">
    {#each textSegs as seg}{#if seg.href}<a
          href={seg.href}
          target="_blank"
          rel="noreferrer"
          onclick={(e) => e.stopPropagation()}>{seg.text}</a
        >{:else}{seg.text}{/if}{/each}
  </div>

  {#if images.length}
    <div class="images" data-n={Math.min(images.length, 4)}>
      {#each images.slice(0, 4) as img}
        <img src={img.thumb} alt={img.alt} title={img.alt} />
      {/each}
    </div>
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

  <div class="actions">
    <button class="act" title="Reply" onclick={() => onreply(item)}>
      <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d={REPLY} fill="currentColor" /></svg>
      <span>{item.post.replyCount ?? 0}</span>
    </button>

    <div class="repost-wrap">
      <button
        class="act"
        class:on={reposted}
        title="Repost or quote"
        onclick={() => (repostMenu = !repostMenu)}
      >
        <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d={REPOST} fill="currentColor" /></svg>
        <span>{interactions.repostCount(item)}</span>
      </button>
      {#if repostMenu}
        <div class="menu">
          <button
            onclick={() => {
              interactions.toggleRepost(item)
              repostMenu = false
            }}>{reposted ? 'Undo repost' : 'Repost'}</button
          >
          <button
            onclick={() => {
              onquote(item)
              repostMenu = false
            }}>Quote post</button
          >
        </div>
      {/if}
    </div>

    <button
      class="act like"
      class:on={liked}
      title={liked ? 'Unlike' : 'Like'}
      onclick={() => interactions.toggleLike(item)}
    >
      <svg class="ic" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d={HEART}
          fill={liked ? 'currentColor' : 'none'}
          stroke="currentColor"
          stroke-width={liked ? 0 : 1.8}
        />
      </svg>
      <span>{interactions.likeCount(item)}</span>
    </button>
  </div>

  {#if canMapReplies}
    <button class="map-replies" class:on={repliesMapped} onclick={() => onmapreplies(item)}>
      {repliesMapped ? 'Hide replies' : `Map replies${item.post.replyCount ? ` (${item.post.replyCount})` : ''}`}
    </button>
  {/if}
</div>

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
  .head {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-bottom: 0.45rem;
  }
  .follow {
    margin-left: auto;
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
    margin-left: auto;
    align-self: flex-start;
    color: var(--text-dim);
    font-size: 0.75rem;
    white-space: nowrap;
  }
  .avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    object-fit: cover;
  }
  .meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name {
    font-weight: 600;
    font-size: 0.9rem;
  }
  .handle {
    color: var(--text-dim);
    font-size: 0.78rem;
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
</style>
