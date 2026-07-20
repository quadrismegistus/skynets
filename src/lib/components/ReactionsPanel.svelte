<script lang="ts">
  import { untrack } from 'svelte'
  import { reactions } from '../state/reactions.svelte'
  import { profiles } from '../state/profiles.svelte'
  import { follows } from '../state/follows.svelte'

  interface Props {
    onclose: () => void
  }
  let { onclose }: Props = $props()

  // Ranked most-disliked first (reactive: recomputes as thumbs change).
  const ranked = $derived(reactions.byAuthor)

  // Two independent resolves for the dids on screen, both batched/deduped/cached:
  // `follows.verify` for authoritative follow state (so the Unfollow button is
  // right), `profiles.ensure` for the avatar/handle to show.
  //
  // untrack() is load-bearing: this effect must depend ONLY on the did *set*
  // (`ranked`), never on the stores' internal maps. profiles.ensure() reads
  // `#map.has(did)` on a SvelteMap — tracked — so without untrack the effect
  // would subscribe to the profile cache, and its LRU eviction (>500 profiles
  // across the whole session) would retrigger the effect → re-fetch the evicted
  // did → evict another → a rolling fetch loop that never settles while open.
  // Rows still update as profiles land: the TEMPLATE reads profiles.get().
  $effect(() => {
    const dids = ranked.map((t) => t.did)
    untrack(() => {
      follows.verify(dids.map((did) => ({ did })))
      for (const did of dids) profiles.ensure(did)
    })
  })

  // Pair a did with its resolved viewer so follows.following/toggle respect both
  // the optimistic overlay and the authoritative profile record.
  function authorOf(did: string) {
    return { did, viewer: profiles.get(did)?.viewer }
  }
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
      <ul class="rows">
        {#each ranked as t (t.did)}
          {@const p = profiles.get(t.did)}
          {@const author = authorOf(t.did)}
          {@const following = follows.following(author)}
          <li class:disliked={t.net < 0} class:liked={t.net > 0}>
            <a class="who" href={profileUrl(t.did)} target="_blank" rel="noreferrer">
              <span class="avatar">
                {#if p?.avatar}
                  <img src={p.avatar} alt="" />
                {:else}
                  <span class="ini">{(p?.displayName ?? p?.handle ?? '?').charAt(0).toUpperCase()}</span>
                {/if}
              </span>
              <span class="names">
                <span class="name">{p?.displayName ?? p?.handle ?? t.did}</span>
                <span class="handle">{p ? '@' + p.handle : 'resolving…'}</span>
              </span>
            </a>

            <span class="tally">
              <span class="up" title="{t.up} liked">👍 {t.up}</span>
              <span class="down" title="{t.down} disliked">👎 {t.down}</span>
              <span class="net" title="net score">{t.net > 0 ? '+' + t.net : t.net}</span>
            </span>

            <span class="act">
              {#if following}
                <button class="unfollow" onclick={() => follows.toggle(author)}>Unfollow</button>
              {:else if follows.knownUnfollowed(t.did)}
                <button class="refollow" onclick={() => follows.toggle(author)}>Follow</button>
              {:else if p}
                <!-- Only assert "not following" once the profile is resolved.
                     Otherwise a followed author (the common case — this is your
                     following feed) flashes "Not following" on first paint. -->
                <span class="muted">Not following</span>
              {:else}
                <span class="muted">…</span>
              {/if}
            </span>
          </li>
        {/each}
      </ul>
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
