<script lang="ts">
  import { untrack } from 'svelte'
  import { read } from '../state/read.svelte'
  import { corpus } from '../state/corpus.svelte'
  import { profiles } from '../state/profiles.svelte'
  import { postText } from '../api/post'
  import type { FeedItem } from '../api/timeline'

  interface Props {
    onclose: () => void
  }
  let { onclose }: Props = $props()

  // uri → its corpus post while still in the local mirror (reactive: rebuilds as
  // the corpus grows). A dismissed post that has aged out of the corpus simply
  // won't be here, and its row degrades to handle/uri.
  const byUri = $derived.by(() => {
    const m = new Map<string, FeedItem>()
    for (const it of corpus.items) m.set(it.post.uri, it)
    return m
  })

  // The author DID that owns an at:// post uri: at://<did>/<collection>/<rkey>.
  function ownerDid(uri: string): string {
    return uri.startsWith('at://') ? uri.slice(5).split('/')[0] : ''
  }

  // DIDs of dismissed posts no longer in the corpus — a profile fetch is the
  // only way left to resolve a handle/avatar. Reads read.dismissed + corpus
  // ONLY (never profiles.get), so the resolver effect below can't entangle with
  // the profile cache's LRU eviction (the loop ReactionsPanel documents).
  const agedOutDids = $derived.by(() => {
    const out = new Set<string>()
    for (const uri of read.dismissed.keys()) {
      if (byUri.has(uri)) continue
      const did = ownerDid(uri)
      if (did) out.add(did)
    }
    return out
  })

  // Dismissed URIs, most-recent first (grow-only map → sort by dismissed-at
  // desc; legacy t=0 migrations sort oldest). Resolves author + snippet from the
  // corpus when the post is still around, else from the profile cache, else the
  // raw did/uri. This is a READ-ONLY log — no restore/un-dismiss affordance.
  const rows = $derived.by(() =>
    [...read.dismissed.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([uri, t]) => {
        const item = byUri.get(uri)
        const did = ownerDid(uri)
        const p = did ? profiles.get(did) : undefined
        const author = item?.post.author
        const handle = author?.handle ?? p?.handle
        return {
          uri,
          t,
          did,
          handle,
          avatar: author?.avatar ?? p?.avatar,
          name: author?.displayName || handle || p?.displayName || did || uri,
          snippet: item ? postText(item).replace(/\s+/g, ' ').trim() : '',
        }
      }),
  )

  // Fill in aged-out authors. untrack() is load-bearing (see ReactionsPanel):
  // depend on the DID set alone, never on profiles.get, or LRU eviction would
  // retrigger the effect → re-fetch → evict → a rolling fetch loop.
  $effect(() => {
    const dids = [...agedOutDids]
    untrack(() => {
      for (const did of dids) profiles.ensure(did)
    })
  })

  function profileUrl(r: { did: string; handle?: string }): string {
    return `https://bsky.app/profile/${r.handle ?? r.did}`
  }

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000_000],
    ['month', 2_592_000_000],
    ['week', 604_800_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ]
  function when(t: number): string {
    if (!t) return 'earlier' // legacy dismissal migrated with no timestamp
    const diff = t - Date.now()
    for (const [unit, ms] of UNITS) {
      if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit)
    }
    return 'just now'
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
    aria-label="Recently dismissed"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
  >
    <header>
      <h2>Recently dismissed</h2>
      <button class="x" onclick={onclose} aria-label="Close">✕</button>
    </header>

    <p class="blurb">
      What you've cleared from the graph, most recent first — a log to catch a fat-fingered dismiss.
      Dismissal is permanent and on-device: this is a read-only view, not a way to bring posts back.
    </p>

    {#if rows.length === 0}
      <p class="empty">
        Nothing dismissed yet. Swipe a card away, or press <kbd>n</kbd> on a post, and it shows up here.
      </p>
    {:else}
      <ul class="rows">
        {#each rows as r (r.uri)}
          <li>
            <a class="who" href={profileUrl(r)} target="_blank" rel="noreferrer">
              <span class="avatar">
                {#if r.avatar}
                  <img src={r.avatar} alt="" />
                {:else}
                  <span class="ini">{(r.name ?? '?').charAt(0).toUpperCase()}</span>
                {/if}
              </span>
              <span class="names">
                <span class="name">{r.name}</span>
                <span class="handle">{r.handle ? '@' + r.handle : r.did || r.uri}</span>
              </span>
            </a>

            <span class="body">
              {#if r.snippet}
                <span class="snippet">{r.snippet}</span>
              {:else}
                <span class="gone" title="This post has aged out of the local corpus.">post no longer cached</span>
              {/if}
              <span class="when">{when(r.t)}</span>
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
    /* Stick to the top so the ✕ stays reachable when the list scrolls. */
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
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.55rem 0.2rem;
    border-top: 1px solid var(--border);
  }
  li:first-child {
    border-top: none;
  }
  .who {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    flex: 0 0 auto;
    max-width: 45%;
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
  .body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    text-align: right;
  }
  .snippet {
    font-size: 0.82rem;
    color: var(--text-dim);
    /* Clamp to two lines — a log entry, not the whole post. */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .gone {
    font-size: 0.8rem;
    color: var(--text-dim);
    font-style: italic;
    opacity: 0.8;
  }
  .when {
    font-size: 0.72rem;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
    opacity: 0.75;
  }
</style>
