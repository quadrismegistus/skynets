<script lang="ts">
  import { getTimeline, type FeedItem } from '../api/timeline'
  import { postText, reposter } from '../api/post'

  let items = $state<FeedItem[]>([])
  let cursor = $state<string | undefined>(undefined)
  let loading = $state(false)
  let error = $state<string | undefined>(undefined)

  async function loadMore() {
    if (loading) return
    loading = true
    error = undefined
    try {
      const page = await getTimeline(cursor)
      // Milestone 1 sanity check: see the raw shape in the console.
      console.log('[mothtrap] timeline page', page)
      items = [...items, ...page.items]
      cursor = page.cursor
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load timeline'
    } finally {
      loading = false
    }
  }

  // Kick off the first fetch.
  loadMore()
</script>

<div class="feed">
  {#each items as item (item.post.cid + (item.reason?.$type ?? ''))}
    {@const rt = reposter(item)}
    <article class="post">
      {#if rt}
        <div class="repost">🔁 reposted by {rt}</div>
      {/if}
      <div class="row">
        {#if item.post.author.avatar}
          <img class="avatar" src={item.post.author.avatar} alt="" />
        {:else}
          <div class="avatar placeholder"></div>
        {/if}
        <div class="body">
          <div class="meta">
            <span class="name">{item.post.author.displayName || item.post.author.handle}</span>
            <span class="handle">@{item.post.author.handle}</span>
          </div>
          <div class="text">{postText(item)}</div>
          <div class="stats">
            <span>💬 {item.post.replyCount ?? 0}</span>
            <span>🔁 {item.post.repostCount ?? 0}</span>
            <span>❤️ {item.post.likeCount ?? 0}</span>
          </div>
        </div>
      </div>
    </article>
  {/each}

  {#if error}
    <p class="error">{error}</p>
  {/if}

  <button class="more" onclick={loadMore} disabled={loading}>
    {loading ? 'Loading…' : cursor || items.length === 0 ? 'Load more' : 'No more posts'}
  </button>
</div>

<style>
  .feed {
    max-width: 600px;
    margin: 0 auto;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .post {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 0.9rem 1rem;
  }
  .repost {
    font-size: 0.75rem;
    color: var(--text-dim);
    margin-bottom: 0.5rem;
  }
  .row {
    display: flex;
    gap: 0.75rem;
  }
  .avatar {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    flex-shrink: 0;
    object-fit: cover;
  }
  .avatar.placeholder {
    background: var(--border);
  }
  .body {
    min-width: 0;
    flex: 1;
  }
  .meta {
    display: flex;
    gap: 0.4rem;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .name {
    font-weight: 600;
  }
  .handle {
    color: var(--text-dim);
    font-size: 0.85rem;
  }
  .text {
    margin: 0.25rem 0 0.5rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.4;
  }
  .stats {
    display: flex;
    gap: 1rem;
    font-size: 0.8rem;
    color: var(--text-dim);
  }
  .more {
    align-self: center;
    margin: 0.5rem 0 2rem;
  }
  .error {
    color: var(--danger);
    text-align: center;
  }
</style>
