<script lang="ts">
  import { profiles } from '../state/profiles.svelte'
  import { follows } from '../state/follows.svelte'
  import { session } from '../state/session.svelte'

  interface Author {
    did: string
    handle: string
    displayName?: string
    avatar?: string
    viewer?: { following?: string; followedBy?: string }
  }
  let { author }: { author: Author } = $props()

  const detail = $derived(profiles.get(author.did))
  const following = $derived(follows.following(author))
  const followsYou = $derived(follows.followsYou(author))
  const isSelf = $derived(author.did === session.did)
  const name = $derived(detail?.displayName || author.displayName || author.handle)
  const avatar = $derived(detail?.avatar || author.avatar)

  const fmt = (n?: number) => (n == null ? '—' : Intl.NumberFormat('en', { notation: 'compact' }).format(n))
</script>

<div class="profile-hover" role="tooltip">
  <div class="ph-head">
    {#if avatar}<img class="ph-avatar" src={avatar} alt="" />{/if}
    <div class="ph-id">
      <span class="ph-name">{name}</span>
      <span class="ph-handle">@{author.handle}</span>
    </div>
    {#if followsYou && !isSelf}<span class="ph-badge">Follows you</span>{/if}
  </div>

  <div class="ph-stats">
    <span><b>{fmt(detail?.followersCount)}</b> followers</span>
    <span><b>{fmt(detail?.followsCount)}</b> following</span>
    <span><b>{fmt(detail?.postsCount)}</b> posts</span>
  </div>

  {#if detail?.description}
    <p class="ph-bio">{detail.description}</p>
  {:else if !detail}
    <p class="ph-bio dim">Loading profile…</p>
  {/if}

  {#if !isSelf}
    <button
      class="ph-follow"
      class:following
      onclick={() => follows.toggle(author)}
    >
      {following ? 'Following' : 'Follow'}
    </button>
  {/if}
</div>

<style>
  .profile-hover {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 15rem;
    padding: 0.7rem;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 0.6rem;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    color: var(--text);
  }
  .ph-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .ph-avatar {
    width: 2.4rem;
    height: 2.4rem;
    border-radius: 50%;
    object-fit: cover;
    flex: none;
  }
  .ph-id {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .ph-name {
    font-weight: 600;
    font-size: 0.85rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ph-handle {
    color: var(--text-dim);
    font-size: 0.72rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ph-badge {
    margin-left: auto;
    flex: none;
    align-self: flex-start;
    padding: 0.1rem 0.35rem;
    font-size: 0.6rem;
    font-weight: 600;
    color: var(--text-dim);
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    border-radius: 0.3rem;
    white-space: nowrap;
  }
  .ph-stats {
    display: flex;
    gap: 0.7rem;
    font-size: 0.68rem;
    color: var(--text-dim);
  }
  .ph-stats b {
    color: var(--text);
  }
  .ph-bio {
    margin: 0;
    font-size: 0.74rem;
    line-height: 1.35;
    color: var(--text);
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .ph-bio.dim {
    color: var(--text-dim);
  }
  .ph-follow {
    align-self: flex-start;
    padding: 0.25rem 0.7rem;
    font-size: 0.72rem;
    font-weight: 600;
    color: #fff;
    background: var(--accent);
    border: none;
    border-radius: 0.4rem;
    cursor: pointer;
  }
  .ph-follow.following {
    color: var(--text-dim);
    background: transparent;
    border: 1px solid var(--border);
  }
</style>
