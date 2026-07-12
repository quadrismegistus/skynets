<script lang="ts">
  import type { FeedItem } from '../api/timeline'
  import { authorName, fullDate, postText, reposter, timeAgo } from '../api/post'
  import { interactions } from '../state/interactions.svelte'

  interface Props {
    item: FeedItem
    /** Top-left position in container px. */
    x: number
    y: number
    onreply: (item: FeedItem) => void
    onquote: (item: FeedItem) => void
    onkeep: () => void
    onleave: () => void
  }
  let { item, x, y, onreply, onquote, onkeep, onleave }: Props = $props()

  const rt = $derived(reposter(item))
  const liked = $derived(interactions.liked(item))
  const reposted = $derived(interactions.reposted(item))

  let repostMenu = $state(false)

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
    <span class="time" title={fullDate(item)}>{timeAgo(item)}</span>
  </div>
  <div class="text">{postText(item)}</div>

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
</div>

<style>
  .card {
    position: absolute;
    z-index: 100;
    width: 300px;
    max-width: 80vw;
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
  .actions {
    display: flex;
    gap: 0.5rem;
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
