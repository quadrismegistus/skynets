<script lang="ts">
  import { REPORT_REASONS, type ReportReason } from '../api/moderation'
  import { moderation } from '../state/moderation.svelte'
  import { report } from '../state/report.svelte'
  import { authorName, postText } from '../api/post'

  let reason = $state<ReportReason | undefined>(undefined)
  let detail = $state('')
  let sending = $state(false)
  let sent = $state(false)
  let error = $state<string | undefined>(undefined)

  const item = $derived(report.item)
  const scope = $derived(report.scope)

  function close() {
    report.close()
    // Reset for the next post — a stale reason carried over would be worse than
    // making the user pick again.
    reason = undefined
    detail = ''
    sending = false
    sent = false
    error = undefined
  }

  async function submit() {
    if (!item || !reason || sending) return
    sending = true
    error = undefined
    try {
      if (scope === 'account') await moderation.reportAccount(item.post.author, reason, detail)
      else await moderation.reportPost(item, reason, detail)
      sent = true
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not send the report'
    } finally {
      sending = false
    }
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (report.open && e.key === 'Escape') close()
  }}
/>

{#if item}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={close}>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label="Report"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      {#if sent}
        <h2>Report sent</h2>
        <p class="blurb">
          It's gone to the moderation service for {item.post.author.handle}'s server and to any
          labellers you subscribe to. Mothtrap doesn't review reports itself.
        </p>
        <p class="blurb">
          Reporting doesn't hide anything on its own — you can also mute or block this account from
          the post's ⋯ menu.
        </p>
        <div class="row">
          <button class="primary" onclick={close}>Done</button>
        </div>
      {:else}
        <h2>Report {scope === 'account' ? 'account' : 'post'}</h2>
        <p class="subject">
          {scope === 'account' ? '' : '“'}{scope === 'account'
            ? `${authorName(item)} · @${item.post.author.handle}`
            : postText(item).slice(0, 140) + (postText(item).length > 140 ? '…' : '')}{scope ===
          'account'
            ? ''
            : '”'}
        </p>

        <fieldset>
          <legend>What's wrong with it?</legend>
          {#each REPORT_REASONS as r}
            <label class="reason" class:picked={reason === r.value}>
              <input type="radio" name="reason" value={r.value} bind:group={reason} />
              <span class="r-label">{r.label}</span>
              <span class="r-hint">{r.hint}</span>
            </label>
          {/each}
        </fieldset>

        <label class="detail">
          <span>Anything else? (optional)</span>
          <textarea bind:value={detail} rows="3" maxlength="2000" placeholder="Context for whoever reviews this"></textarea>
        </label>

        {#if error}<p class="error">{error}</p>{/if}

        <div class="row">
          <button onclick={close}>Cancel</button>
          <button class="primary" disabled={!reason || sending} onclick={submit}>
            {sending ? 'Sending…' : 'Send report'}
          </button>
        </div>
      {/if}
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
    z-index: 1000;
    padding: 1rem;
  }
  .modal {
    width: min(440px, 100%);
    max-height: 90vh;
    overflow-y: auto;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.1rem 1.2rem;
  }
  h2 {
    margin: 0 0 0.5rem;
    font-size: 1rem;
  }
  .blurb {
    margin: 0 0 0.7rem;
    font-size: 0.84rem;
    line-height: 1.45;
    color: var(--text-dim);
  }
  .subject {
    margin: 0 0 0.9rem;
    font-size: 0.84rem;
    line-height: 1.4;
    color: var(--text-dim);
    overflow-wrap: anywhere;
  }
  fieldset {
    border: none;
    padding: 0;
    margin: 0 0 0.9rem;
  }
  legend {
    padding: 0;
    margin-bottom: 0.45rem;
    font-size: 0.84rem;
    font-weight: 600;
  }
  .reason {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0 0.5rem;
    align-items: baseline;
    padding: 0.4rem 0.5rem;
    border-radius: 6px;
    cursor: pointer;
  }
  .reason:hover,
  .reason.picked {
    background: var(--bg);
  }
  .reason input {
    grid-row: span 2;
    align-self: center;
    margin: 0;
  }
  .r-label {
    font-size: 0.88rem;
  }
  .r-hint {
    grid-column: 2;
    font-size: 0.76rem;
    color: var(--text-dim);
  }
  .detail {
    display: block;
    margin-bottom: 0.9rem;
    font-size: 0.84rem;
  }
  .detail textarea {
    width: 100%;
    margin-top: 0.35rem;
    padding: 0.45rem 0.55rem;
    font: inherit;
    font-size: 0.85rem;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    resize: vertical;
  }
  .error {
    margin: 0 0 0.7rem;
    font-size: 0.82rem;
    color: var(--danger);
  }
  .row {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
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
  .row button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
