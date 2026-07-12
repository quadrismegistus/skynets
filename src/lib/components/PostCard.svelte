<script lang="ts">
  import type { FeedItem } from '../api/timeline'
  import { authorName, fullDate, postText, reposter, timeAgo } from '../api/post'

  interface Props {
    item: FeedItem
    /** Top-left position in container px. */
    x: number
    y: number
  }
  let { item, x, y }: Props = $props()

  const rt = $derived(reposter(item))
</script>

<div class="card" style="left: {x}px; top: {y}px;">
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
  <div class="stats">
    <span>💬 {item.post.replyCount ?? 0}</span>
    <span>🔁 {item.post.repostCount ?? 0}</span>
    <span>❤️ {item.post.likeCount ?? 0}</span>
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
    pointer-events: none;
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
  .stats {
    display: flex;
    gap: 0.9rem;
    font-size: 0.78rem;
    color: var(--text-dim);
  }
</style>
