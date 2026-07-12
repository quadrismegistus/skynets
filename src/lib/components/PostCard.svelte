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
    onkeep: () => void
    onleave: () => void
  }
  let { item, x, y, onreply, onkeep, onleave }: Props = $props()

  const rt = $derived(reposter(item))
  const liked = $derived(interactions.liked(item))
  const reposted = $derived(interactions.reposted(item))
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
    <button class="act reply" title="Reply" onclick={() => onreply(item)}>
      💬 <span>{item.post.replyCount ?? 0}</span>
    </button>
    <button
      class="act repost"
      class:on={reposted}
      title={reposted ? 'Undo repost' : 'Repost'}
      onclick={() => interactions.toggleRepost(item)}
    >
      🔁 <span>{interactions.repostCount(item)}</span>
    </button>
    <button
      class="act like"
      class:on={liked}
      title={liked ? 'Unlike' : 'Like'}
      onclick={() => interactions.toggleLike(item)}
    >
      {liked ? '❤️' : '🤍'} <span>{interactions.likeCount(item)}</span>
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
  .act {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    padding: 0.3rem 0.4rem;
    font-size: 0.8rem;
    background: transparent;
    border-color: transparent;
    color: var(--text-dim);
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
  .act.repost.on {
    color: #4caf7d;
  }
</style>
