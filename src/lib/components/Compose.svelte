<script lang="ts">
  import { compose, buildSelfPost } from '../state/compose.svelte'
  import { createPost, graphemeLength, MAX_GRAPHEMES } from '../api/posting'
  import { uploadImage } from '../api/upload'
  import { detectFacets } from '../api/richtext'
  import { authorName, postText } from '../api/post'

  const MAX_IMAGES = 4

  interface Attached {
    file: File
    url: string
    alt: string
  }

  let text = $state('')
  let attached = $state<Attached[]>([])
  let posting = $state(false)
  let error = $state<string | undefined>(undefined)
  let textarea = $state<HTMLTextAreaElement | undefined>(undefined)
  let fileInput = $state<HTMLInputElement | undefined>(undefined)

  // Reset each time the modal opens, and focus the textarea.
  $effect(() => {
    if (compose.open) {
      text = ''
      attached = []
      error = undefined
      queueMicrotask(() => textarea?.focus())
    }
  })

  const count = $derived(graphemeLength(text))
  const remaining = $derived(MAX_GRAPHEMES - count)
  const canPost = $derived(
    (text.trim().length > 0 || attached.length > 0) && remaining >= 0 && !posting,
  )

  function onFiles(e: Event) {
    const input = e.target as HTMLInputElement
    for (const f of Array.from(input.files ?? [])) {
      if (attached.length >= MAX_IMAGES) break
      if (!f.type.startsWith('image/')) continue
      attached = [...attached, { file: f, url: URL.createObjectURL(f), alt: '' }]
    }
    input.value = '' // allow re-picking the same file
  }

  function removeImage(i: number) {
    URL.revokeObjectURL(attached[i].url)
    attached = attached.filter((_, idx) => idx !== i)
  }

  function cancel() {
    for (const a of attached) URL.revokeObjectURL(a.url)
    compose.close()
  }

  async function submit() {
    if (!canPost) return
    posting = true
    error = undefined
    try {
      const reply = compose.reply
      const quote = compose.quote
        ? { uri: compose.quote.post.uri, cid: compose.quote.post.cid }
        : null
      const facets = await detectFacets(text)
      const uploaded = []
      for (const a of attached) uploaded.push(await uploadImage(a.file, a.alt))
      const { uri, cid } = await createPost(text, reply, quote, facets, uploaded)
      const previews = attached.map((a) => ({ thumb: a.url, alt: a.alt }))
      compose.inject(buildSelfPost(text, uri, cid, reply, previews))
      attached = [] // URLs now referenced by the injected post; don't revoke
      compose.close()
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to post'
    } finally {
      posting = false
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') cancel()
    else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit()
  }
</script>

{#if compose.open}
  <div
    class="backdrop"
    role="button"
    tabindex="-1"
    onclick={() => cancel()}
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
        <button class="close" aria-label="Close" onclick={() => cancel()}>✕</button>
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

      {#if attached.length}
        <div class="attachments">
          {#each attached as img, i (img.url)}
            <div class="att">
              <img src={img.url} alt="" />
              <button class="att-remove" aria-label="Remove image" onclick={() => removeImage(i)}
                >✕</button
              >
              <input
                class="att-alt"
                placeholder="Alt text — describe the image"
                bind:value={attached[i].alt}
              />
            </div>
          {/each}
        </div>
      {/if}

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <div class="foot">
        <button
          class="tool"
          title="Add image"
          disabled={attached.length >= MAX_IMAGES}
          onclick={() => fileInput?.click()}
        >
          🖼 Image
        </button>
        <input
          bind:this={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onchange={onFiles}
        />
        <span class="spacer"></span>
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
  .attachments {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
    margin-top: 0.7rem;
  }
  .att {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .att img {
    width: 100%;
    height: 110px;
    object-fit: cover;
    border-radius: 8px;
    border: 1px solid var(--border);
  }
  .att-remove {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 22px;
    height: 22px;
    padding: 0;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.6);
    border: none;
    color: #fff;
    font-size: 0.7rem;
    display: grid;
    place-items: center;
  }
  .att-alt {
    width: 100%;
    font-size: 0.75rem;
    padding: 0.35rem 0.5rem;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    margin-top: 0.7rem;
  }
  .spacer {
    flex: 1;
  }
  .tool {
    font-size: 0.82rem;
    padding: 0.4rem 0.7rem;
  }
  .tool:disabled {
    opacity: 0.5;
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
