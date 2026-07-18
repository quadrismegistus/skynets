<script lang="ts">
  import { digestConsent } from '../state/digestConsent.svelte'
  import { digest } from '../state/digest.svelte'

  const base = import.meta.env.BASE_URL ?? '/'
  const cloud = $derived(digestConsent.destination === 'cloud')

  // Escape closes without answering, like the backdrop — never a silent decline.
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && digestConsent.pending) digestConsent.dismiss()
  }
</script>

<svelte:window onkeydown={onKey} />

{#if digestConsent.pending}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={() => digestConsent.dismiss()}>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label="Topic grouping"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      <h2>Group your feed into topics?</h2>

      <p>
        Mothtrap can read your timeline and sort it into the handful of conversations actually in
        play, labelling each one. Doing that needs a language model, and the model isn't on your
        device.
      </p>

      <p class="what">To label your feed, these are sent {cloud ? 'to a third-party AI provider' : 'to the Mothtrap server'}:</p>
      <ul>
        <li>the text of the posts on screen</li>
        <li>for a reply or quote, the text of the post it responds to</li>
      </ul>
      <p class="fine">
        <strong>No names or handles</strong> — labelling is a summary of what a post is about, so
        who wrote it is never sent. Each post is sent once; its label is then cached on your device.
      </p>

      {#if cloud}
        <p class="note">
          You've configured a cloud provider, so this goes to them under your own API key and their
          terms apply.
        </p>
      {:else}
        <p class="note">
          It's used to answer that one request and then discarded — not stored, not logged, not used
          for training, never passed on. The model is self-hosted, so nothing reaches a commercial AI
          company.
        </p>
      {/if}

      <p class="fine">
        Say no and everything else works exactly as it does now; you just won't get topic labels. You
        can change your mind either way in Settings. Full detail on the
        <a href="{base}privacy.html" target="_blank" rel="noreferrer">privacy page</a>.
      </p>

      <div class="row">
        <button onclick={() => digestConsent.decline()}>No thanks</button>
        <button class="primary" onclick={() => digestConsent.grant(digest.provider, digest.ollamaUrl)}>Group my feed</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: grid;
    place-items: center;
    /* Above the other modals (1000), because this one is raised BY them: the
       Settings view's "Turn on" summons it, and Settings mounts later in
       App.svelte, so at equal z-index Settings painted over the dialog it had
       just opened — leaving the way back visible but unclickable. */
    z-index: 1100;
    padding: 1rem;
  }
  .modal {
    width: min(420px, 100%);
    max-height: 90vh;
    overflow-y: auto;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.1rem 1.2rem;
  }
  h2 {
    margin: 0 0 0.6rem;
    font-size: 1rem;
  }
  p {
    margin: 0 0 0.7rem;
    font-size: 0.86rem;
    line-height: 1.5;
  }
  .what {
    margin-bottom: 0.3rem;
  }
  ul {
    margin: 0 0 0.7rem;
    padding-left: 1.1rem;
    font-size: 0.86rem;
    line-height: 1.5;
  }
  li {
    margin-bottom: 0.15rem;
  }
  .note {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.6rem 0.7rem;
    color: var(--text-dim);
  }
  .fine {
    color: var(--text-dim);
    font-size: 0.8rem;
  }
  .fine a {
    color: var(--accent);
  }
  .row {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.9rem;
  }
  .row button {
    padding: 0.4rem 0.8rem;
    font: inherit;
    font-size: 0.85rem;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
  }
  .row button.primary {
    color: #fff;
    background: var(--accent);
    border-color: var(--accent);
  }
</style>
