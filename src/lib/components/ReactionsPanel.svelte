<script lang="ts">
  import { untrack } from 'svelte'
  import { reactions } from '../state/reactions.svelte'
  import { profiles } from '../state/profiles.svelte'
  import { follows } from '../state/follows.svelte'

  interface Props {
    onclose: () => void
  }
  let { onclose }: Props = $props()

  type Tab = 'all' | 'following' | 'notFollowing'
  let tab = $state<Tab>('all')

  // Pure reaction ranking (depends on the reactions map ONLY) — this is what the
  // resolver effect keys off, so it can't get entangled with the profile cache.
  const ranked = $derived(reactions.byAuthor)

  // Ranked authors joined with their resolved profile + live follow state, for
  // rendering. Recomputes when reactions/profiles/follows change.
  const rows = $derived.by(() =>
    ranked.map((t) => {
      const p = profiles.get(t.did)
      const author = { did: t.did, viewer: p?.viewer }
      return { t, author, p, following: follows.following(author), resolved: !!p }
    }),
  )

  // Resolve profiles + authoritative follow state for EVERY ranked author (all
  // tabs, so switching tabs never refetches). `follows.verify` gives the real
  // follow bit; `profiles.ensure` the avatar/handle.
  //
  // untrack() is load-bearing: this effect must depend ONLY on the did *set*
  // (via `ranked`, which reads the reactions map alone), never on the profile
  // cache. It reads `ranked` — not `rows` — precisely so it takes no dependency
  // on profiles.get; and ensure()'s tracked `#map.has()` read is untracked here.
  // Otherwise the cache's LRU eviction (>500 profiles in a session) would
  // retrigger the effect → re-fetch the evicted did → evict another → a rolling
  // fetch loop. Rows still fill in as profiles land: the TEMPLATE reads them.
  $effect(() => {
    const dids = ranked.map((t) => t.did)
    untrack(() => {
      follows.verify(dids.map((did) => ({ did })))
      for (const did of dids) profiles.ensure(did)
    })
  })

  // Follow state resolves a beat after open, so an author is only placed in
  // Following / Not-following once known — until then it sits in All alone,
  // rather than being mis-bucketed (the same reason the row shows "…" not
  // "Not following").
  const followingRows = $derived(rows.filter((r) => r.following))
  const notFollowingRows = $derived(rows.filter((r) => !r.following && r.resolved))
  const shown = $derived(
    tab === 'following' ? followingRows : tab === 'notFollowing' ? notFollowingRows : rows,
  )

  function profileUrl(did: string) {
    return `https://bsky.app/profile/${profiles.get(did)?.handle ?? did}`
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onclose}>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-label="Your reactions"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
  >
    <header>
      <h2>Your reactions</h2>
      <button class="x" onclick={onclose} aria-label="Close">✕</button>
    </header>

    <p class="blurb">
      On-device only — these thumbs never left this browser. Ranked by net score, most-disliked
      first, to help you decide who to unfollow.
    </p>

    {#if ranked.length === 0}
      <p class="empty">
        No reactions yet. Hover a post and press <kbd>y</kbd> to privately like its author or
        <kbd>n</kbd> to dislike — the tally shows up here.
      </p>
    {:else}
      <div class="tabs" role="tablist" aria-label="Filter by follow state">
        <button role="tab" aria-selected={tab === 'all'} class:on={tab === 'all'} onclick={() => (tab = 'all')}>
          All <span class="count">{rows.length}</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === 'following'}
          class:on={tab === 'following'}
          onclick={() => (tab = 'following')}
        >
          Following <span class="count">{followingRows.length}</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === 'notFollowing'}
          class:on={tab === 'notFollowing'}
          onclick={() => (tab = 'notFollowing')}
        >
          Not following <span class="count">{notFollowingRows.length}</span>
        </button>
      </div>

      {#if shown.length === 0}
        <p class="empty">
          {#if tab === 'following'}
            None of the people you've reacted to are ones you follow.
          {:else}
            You follow everyone you've reacted to.
          {/if}
        </p>
      {:else}
        <ul class="rows">
          {#each shown as r (r.t.did)}
            <li class:disliked={r.t.net < 0} class:liked={r.t.net > 0}>
              <a class="who" href={profileUrl(r.t.did)} target="_blank" rel="noreferrer">
                <span class="avatar">
                  {#if r.p?.avatar}
                    <img src={r.p.avatar} alt="" />
                  {:else}
                    <span class="ini">{(r.p?.displayName ?? r.p?.handle ?? '?').charAt(0).toUpperCase()}</span>
                  {/if}
                </span>
                <span class="names">
                  <span class="name">{r.p?.displayName ?? r.p?.handle ?? r.t.did}</span>
                  <span class="handle">{r.p ? '@' + r.p.handle : 'resolving…'}</span>
                </span>
              </a>

              <span class="tally">
                <span class="up" title="{r.t.up} liked">👍 {r.t.up}</span>
                <span class="down" title="{r.t.down} disliked">👎 {r.t.down}</span>
                <span class="net" title="net score">{r.t.net > 0 ? '+' + r.t.net : r.t.net}</span>
              </span>

              <span class="act">
                {#if r.following}
                  <button class="unfollow" onclick={() => follows.toggle(r.author)}>Unfollow</button>
                {:else if follows.knownUnfollowed(r.t.did)}
                  <button class="refollow" onclick={() => follows.toggle(r.author)}>Follow</button>
                {:else if r.p}
                  <!-- Only assert "not following" once resolved, so a followed
                       author (the common case) doesn't flash "Not following". -->
                  <span class="muted">Not following</span>
                {:else}
                  <span class="muted">…</span>
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: grid;
    place-items: center;
    z-index: 1000;
    padding: 1rem;
  }
  .modal {
    width: min(540px, 100%);
    max-height: 88vh;
    overflow-y: auto;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1rem 1.2rem 1.2rem;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    /* Stick to the top so the ✕ stays reachable when the list is long enough to
       scroll. Opaque bg covers rows sliding underneath. */
    position: sticky;
    top: 0;
    background: var(--bg-elev);
    padding: 0.2rem 0 0.4rem;
    z-index: 1;
  }
  h2 {
    margin: 0;
    font-size: 1.05rem;
  }
  .x {
    width: 30px;
    height: 30px;
    padding: 0;
    border-radius: 50%;
    display: grid;
    place-items: center;
  }
  .blurb {
    color: var(--text-dim);
    font-size: 0.85rem;
    line-height: 1.4;
    margin: 0.2rem 0 0.8rem;
  }
  .tabs {
    display: flex;
    gap: 0.3rem;
    margin: 0 0 0.7rem;
  }
  .tabs button {
    flex: 1;
    font-size: 0.78rem;
    padding: 0.35rem 0.4rem;
    background: var(--bg);
    color: var(--text-dim);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    white-space: nowrap;
  }
  .tabs button.on {
    border-color: var(--accent);
    color: var(--text);
  }
  .tabs .count {
    font-variant-numeric: tabular-nums;
    font-size: 0.7rem;
    opacity: 0.65;
  }
  .empty {
    color: var(--text-dim);
    font-size: 0.9rem;
    line-height: 1.6;
    padding: 1rem 0.2rem;
  }
  kbd {
    font-family: inherit;
    font-size: 0.8em;
    padding: 0.05em 0.4em;
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: 4px;
    background: var(--bg);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  li {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.2rem;
    border-top: 1px solid var(--border);
  }
  li:first-child {
    border-top: none;
  }
  .who {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    flex: 1;
    min-width: 0;
    text-decoration: none;
    color: inherit;
  }
  .who:hover .name {
    text-decoration: underline;
  }
  .avatar {
    flex: 0 0 34px;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    overflow: hidden;
    background: var(--bg);
    display: grid;
    place-items: center;
  }
  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .ini {
    font-weight: 700;
    color: var(--text-dim);
  }
  .names {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name {
    font-size: 0.9rem;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .handle {
    font-size: 0.75rem;
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tally {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
    color: var(--text-dim);
    flex-shrink: 0;
  }
  .net {
    min-width: 2.2ch;
    text-align: right;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }
  .disliked .net {
    color: var(--danger);
  }
  .liked .net {
    color: #3fb950;
  }
  .act {
    flex: 0 0 auto;
    min-width: 84px;
    text-align: right;
  }
  .act button {
    font-size: 0.78rem;
    padding: 0.3rem 0.6rem;
  }
  .unfollow:hover {
    border-color: var(--danger);
    color: var(--danger);
  }
  .muted {
    font-size: 0.75rem;
    color: var(--text-dim);
  }
</style>
