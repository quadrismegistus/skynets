<script lang="ts">
  import { compose, buildSelfPost } from '../state/compose.svelte'
  import { createPost, graphemeLength, MAX_GRAPHEMES } from '../api/posting'
  import { authorName, postText } from '../api/post'

  let text = $state('')
  let posting = $state(false)
  let error = $state<string | undefined>(undefined)
  let textarea = $state<HTMLTextAreaElement | undefined>(undefined)

  // Reset each time the modal opens, and focus the textarea.
  $effect(() => {
    if (compose.open) {
      text = ''
      error = undefined
      queueMicrotask(() => textarea?.focus())
    }
  })

  const count = $derived(graphemeLength(text))
  const remaining = $derived(MAX_GRAPHEMES - count)
  const canPost = $derived(text.trim().length > 0 && remaining >= 0 && !posting)

  async function submit() {
    if (!canPost) return
    posting = true
    error = undefined
    try {
      const reply = compose.reply
      const quote = compose.quote
        ? { uri: compose.quote.post.uri, cid: compose.quote.post.cid }
        : null
      const { uri, cid } = await createPost(text, reply, quote)
      compose.inject(buildSelfPost(text, uri, cid, reply))
      compose.close()
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to post'
    } finally {
      posting = false
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') compose.close()
    else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit()
  }
</script>

{#if compose.open}
  <div
    class="backdrop"
    role="button"
    tabindex="-1"
    onclick={() => compose.close()}
    onkeydown={onKeydown}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="head">
        <strong>{compose.reply ? 'Reply' : compose.quote ? 'Quote post' : 'New post'}</strong>
        <button class="close" aria-label="Close" onclick={() => compose.close()}>✕</button>
      </div>

      {#if compose.reply}
        <div class="context">
          <span class="to-label">Replying to {authorName(compose.reply.item)}</span>
          <p class="quote">{postText(compose.reply.item)}</p>
        </div>
      {/if}

      <textarea
        bind:this={textarea}
        bind:value={text}
        onkeydown={onKeydown}
        placeholder={compose.reply
          ? 'Write your reply…'
          : compose.quote
            ? 'Add a comment…'
            : "What's happening?"}
        rows="5"
      ></textarea>

      {#if compose.quote}
        <div class="context quoted">
          <span class="to-label">{authorName(compose.quote)} · @{compose.quote.post.author.handle}</span>
          <p class="quote">{postText(compose.quote)}</p>
        </div>
      {/if}

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <div class="foot">
        <span class="count" class:over={remaining < 0}>{remaining}</span>
        <button class="post" onclick={submit} disabled={!canPost}>
          {posting ? 'Posting…' : compose.reply ? 'Reply' : 'Post'}
        </button>
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
    place-items: start center;
    padding-top: 12vh;
    z-index: 1000;
  }
  .modal {
    width: 100%;
    max-width: 480px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 1rem 1.1rem 0.9rem;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.7rem;
  }
  .close {
    padding: 0.2rem 0.5rem;
    background: transparent;
    border: none;
    color: var(--text-dim);
  }
  .context {
    border-left: 2px solid var(--border);
    padding: 0.1rem 0 0.1rem 0.7rem;
    margin-bottom: 0.7rem;
  }
  .context.quoted {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.5rem 0.7rem;
    margin: 0.7rem 0 0;
  }
  .to-label {
    font-size: 0.75rem;
    color: var(--text-dim);
  }
  .quote {
    margin: 0.2rem 0 0;
    font-size: 0.85rem;
    color: var(--text-dim);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 4.5em;
    overflow: hidden;
  }
  textarea {
    width: 100%;
    resize: vertical;
    font: inherit;
    line-height: 1.4;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.7rem;
  }
  textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  .error {
    color: var(--danger);
    font-size: 0.82rem;
    margin: 0.5rem 0 0;
  }
  .foot {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.9rem;
    margin-top: 0.7rem;
  }
  .count {
    color: var(--text-dim);
    font-size: 0.82rem;
    font-variant-numeric: tabular-nums;
  }
  .count.over {
    color: var(--danger);
  }
  .post {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .post:hover:not(:disabled) {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }
</style>
