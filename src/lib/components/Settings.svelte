<script lang="ts">
  import { archive } from '../state/archive'
  import { digest } from '../state/digest.svelte'
  import { digestConsent, destinationOf } from '../state/digestConsent.svelte'
  import { read } from '../state/read.svelte'
  import { reactions } from '../state/reactions.svelte'
  import { session } from '../state/session.svelte'
  import { terms } from '../state/terms.svelte'
  import { isNative } from '../api/platform'

  interface Props {
    onclose: () => void
  }
  let { onclose }: Props = $props()

  const base = import.meta.env.BASE_URL ?? '/'

  /**
   * Where the digest would send text, recomputed live — the deploy config and
   * the panel's URL field can both move it, and a stale reading here would
   * describe the wrong destination.
   */
  const destination = $derived(destinationOf(digest.provider, digest.ollamaUrl))
  const consentState = $derived(
    destination === 'local'
      ? 'local'
      : digestConsent.state === 'granted'
        ? 'granted'
        : digestConsent.state === 'declined'
          ? 'declined'
          : 'unasked',
  )

  let stats = $state<{ posts: number; appearances: number; counts: number; follows: number } | null>(null)
  let loading = $state(true)
  $effect(() => {
    archive
      .stats()
      .then((s) => (stats = s))
      .catch(() => (stats = null))
      .finally(() => (loading = false))
  })

  let confirmingWipe = $state(false)
  let wiping = $state(false)
  let wiped = $state(false)
  async function wipe() {
    wiping = true
    try {
      await archive.wipe()
      // purge() (not reset()) so the wipe actually deletes the on-disk read/
      // reaction keys — they live in a separate idb-keyval DB that archive.wipe
      // doesn't touch, and the UI promises "everything stored is gone."
      await read.purge()
      await reactions.purge()
      digest.clear()
      stats = null
      wiped = true
      confirmingWipe = false
    } finally {
      wiping = false
    }
  }

  async function exportArchive() {
    const json = await archive.exportJSON()
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `mothtrap-archive-${session.handle ?? 'export'}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose()
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onclose}>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-label="Settings"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
  >
    <header>
      <h2>Settings</h2>
      <button class="x" onclick={onclose} aria-label="Close">✕</button>
    </header>

    <section>
      <h3>Topic grouping</h3>
      {#if consentState === 'local'}
        <p class="state ok">On, and entirely on this device.</p>
        <p class="blurb">
          Your model runs at <code>{digest.ollamaUrl || 'localhost'}</code>, so nothing about your
          feed is sent anywhere. There is nothing to consent to.
        </p>
      {:else}
        <p class="state" class:ok={consentState === 'granted'} class:off={consentState !== 'granted'}>
          {consentState === 'granted' ? 'On' : consentState === 'declined' ? 'Off — you declined' : 'Not yet answered'}
        </p>
        <p class="blurb">
          Grouping your feed into topics sends the text of the posts on screen — and nothing else,
          <strong>no names or handles</strong> — to
          {destination === 'cloud' ? 'a third-party AI provider' : 'the Mothtrap server'}. It's used
          to answer that one request and discarded: not stored, not logged, never passed on. Full
          detail on the <a href="{base}privacy.html" target="_blank" rel="noreferrer">privacy page</a>.
        </p>
        <div class="actions">
          {#if consentState === 'granted'}
            <button class="danger" onclick={() => digestConsent.decline()}>Turn off</button>
          {:else}
            <button class="primary" onclick={() => digestConsent.ask(digest.provider, digest.ollamaUrl)}>
              Turn on
            </button>
          {/if}
        </div>
      {/if}
    </section>

    <section>
      <h3>Your data</h3>
      {#if wiped}
        <p class="state ok">Deleted.</p>
        <p class="blurb">Everything this device had stored for your account is gone.</p>
      {:else}
        <p class="blurb">
          Mothtrap keeps an archive of the posts your feed has shown you, in this browser only.
          There is no server-side copy, so deleting it here is permanent.
        </p>
        <dl class="stats">
          <div><dt>Posts</dt><dd>{loading ? '…' : (stats?.posts ?? 0).toLocaleString()}</dd></div>
          <div><dt>Appearances</dt><dd>{loading ? '…' : (stats?.appearances ?? 0).toLocaleString()}</dd></div>
          <div><dt>Dismissed</dt><dd>{read.dismissed.size.toLocaleString()}</dd></div>
        </dl>
        <div class="actions">
          <button onclick={exportArchive} disabled={!stats?.posts}>Export as JSON</button>
          {#if confirmingWipe}
            <button class="danger" disabled={wiping} onclick={wipe}>
              {wiping ? 'Deleting…' : 'Yes, delete everything'}
            </button>
            <button onclick={() => (confirmingWipe = false)}>Cancel</button>
          {:else}
            <button class="danger" disabled={!stats?.posts} onclick={() => (confirmingWipe = true)}>
              Delete stored data
            </button>
          {/if}
        </div>
      {/if}
    </section>

    <section>
      <h3>Account</h3>
      <p class="blurb">
        Signed in as <strong>@{session.handle}</strong> via {session.method === 'oauth'
          ? 'OAuth'
          : 'an app password'}. Your posts, follows, mutes and blocks live in your Bluesky account,
        not in Mothtrap.
      </p>
      <div class="actions">
        <button onclick={() => session.logout()}>Sign out</button>
      </div>
    </section>

    {#if isNative()}
      <section>
        <h3>Terms</h3>
        <p class="blurb">
          You agreed to version {terms.acceptedVersion} of the
          <a href="{base}terms.html" target="_blank" rel="noreferrer">terms of use</a>. Withdrawing
          takes effect immediately: the app returns to the agreement screen.
        </p>
        <div class="actions">
          <button class="danger" onclick={() => terms.reset()}>Withdraw agreement</button>
        </div>
      </section>
    {/if}

    <footer>
      <a href="{base}contact.html" target="_blank" rel="noreferrer">Contact</a>
      <span aria-hidden="true">·</span>
      <a href="{base}privacy.html" target="_blank" rel="noreferrer">Privacy</a>
      <span aria-hidden="true">·</span>
      <a href="{base}terms.html" target="_blank" rel="noreferrer">Terms</a>
    </footer>
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
    width: min(480px, 100%);
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
    margin-bottom: 0.4rem;
  }
  h2 {
    margin: 0;
    font-size: 1.05rem;
  }
  .x {
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 0.9rem;
    cursor: pointer;
    padding: 0.2rem 0.35rem;
  }
  section {
    padding: 0.9rem 0;
    border-top: 1px solid var(--border);
  }
  h3 {
    margin: 0 0 0.4rem;
    font-size: 0.9rem;
  }
  .state {
    margin: 0 0 0.35rem;
    font-size: 0.85rem;
    font-weight: 600;
  }
  .state.ok {
    color: #5fd08a;
  }
  .state.off {
    color: var(--text-dim);
  }
  .blurb {
    margin: 0 0 0.6rem;
    font-size: 0.83rem;
    line-height: 1.5;
    color: var(--text-dim);
  }
  .blurb a {
    color: var(--accent);
  }
  code {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.05rem 0.3rem;
    font-size: 0.9em;
  }
  .stats {
    display: flex;
    gap: 1.2rem;
    margin: 0 0 0.7rem;
  }
  .stats div {
    display: flex;
    flex-direction: column;
  }
  dt {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-dim);
  }
  dd {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .actions button {
    padding: 0.35rem 0.7rem;
    font: inherit;
    font-size: 0.82rem;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
  }
  .actions button.primary {
    color: #fff;
    background: var(--accent);
    border-color: var(--accent);
  }
  .actions button.danger {
    color: var(--danger);
    border-color: var(--danger);
  }
  .actions button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  footer {
    padding-top: 0.9rem;
    border-top: 1px solid var(--border);
    font-size: 0.8rem;
    color: var(--text-dim);
    display: flex;
    gap: 0.4rem;
  }
  footer a {
    color: var(--accent);
  }
</style>
