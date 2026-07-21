<script lang="ts">
  import { digest } from '../state/digest.svelte'
  import { deploy } from '../state/deploy.svelte'
  import { digestConsent } from '../state/digestConsent.svelte'
  import { convoColor, exemplars, MODELS, type Conversation } from '../api/llm'
  import { formatSize } from '../api/ollama'
  import { reposter } from '../api/post'
  import type { FeedItem } from '../api/timeline'
  import { AppBskyFeedPost } from '@atproto/api'

  interface Props {
    /** The feed items currently in the graph, for exemplar lookup. */
    items: FeedItem[]
    onclose: () => void
    onsummarize: () => void
    onfocus: (uri: string) => void
  }
  const { items, onclose, onsummarize, onfocus }: Props = $props()

  const byUri = $derived(new Map(items.map((i) => [i.post.uri, i])))
  const convos = $derived(digest.digest?.conversations ?? [])
  // Declining consent used to disable the digest silently and permanently: every
  // attempt threw, was caught as a non-error, and the panel just said "press
  // Summarize" at a button that did nothing. Surface it, and offer the way back.
  const consentBlocked = $derived(digestConsent.blocks(digest.provider, digest.ollamaUrl))
  // Config folds away once there's a digest, so the results get the room.
  let showConfig = $state(digest.digest == null)
  const actionLabel = $derived(
    digest.loading
      ? digest.continuous
        ? 'Updating…'
        : 'Reading…'
      : digest.continuous
        ? 'Update digest'
        : digest.digest
          ? 'Re-summarize'
          : 'Summarize',
  )
  const originHint = typeof location !== 'undefined' ? location.origin : 'http://localhost:1997'
  // Label mode doesn't stream a single response (it's many tiny labels), so the
  // raw stream stays empty; kept for the (currently-disabled) cluster path.
  const liveStream = $derived(digest.streamText)

  function text(item: FeedItem): string {
    const rec = item.post.record
    return AppBskyFeedPost.isRecord(rec) ? rec.text : ''
  }
  const statusMark: Record<Conversation['status'], string> = {
    heating: '▲',
    cooling: '▼',
    steady: '■',
  }
  // When the Ollama provider becomes active, query its installed models once so
  // the picker is populated and the smallest is auto-chosen. URL edits re-query
  // on blur (below) — NOT per keystroke, which would spam fetches to partial
  // URLs and blank the list mid-type.
  let queried = false
  $effect(() => {
    if (digest.provider !== 'ollama') {
      queried = false
      return
    }
    if (!queried) {
      queried = true
      digest.refreshOllamaModels()
    }
  })

  // Elapsed timer while a summary is in flight — the point of the raw stream is
  // to see how fast this actually is.
  let elapsed = $state(0)
  $effect(() => {
    if (!digest.loading) return
    const start = Date.now()
    elapsed = 0
    const id = setInterval(() => (elapsed = (Date.now() - start) / 1000), 100)
    return () => clearInterval(id)
  })

  // Swipe the panel back out to the right, the way it came in. Touch only:
  // with a mouse the close button is already an easy target, and a click-drag
  // that dismisses would fight text selection.
  let panelEl = $state<HTMLElement | null>(null)
  let dragX = $state(0)
  let dragging = $state(false)
  let startX = 0
  let startY = 0
  let axis: 'x' | 'y' | null = null
  let pointer = -1

  const DISMISS_PX = 90 // far enough that a lazy sideways scroll doesn't close

  function reset() {
    dragX = 0
    dragging = false
    axis = null
    pointer = -1
  }

  function down(e: PointerEvent) {
    if (e.pointerType === 'mouse') return
    startX = e.clientX
    startY = e.clientY
    axis = null
    pointer = e.pointerId
  }

  function move(e: PointerEvent) {
    if (e.pointerId !== pointer) return
    const dx = e.clientX - startX
    const dy = e.clientY - startY
    if (!axis) {
      // Wait for a decisive direction before claiming the gesture, so a
      // vertical scroll through the conversation list is never stolen.
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      if (axis === 'x') {
        // Keep receiving moves once the finger leaves the panel. Throws if the
        // pointer is already gone; that just means there is nothing to capture.
        try {
          panelEl?.setPointerCapture(e.pointerId)
        } catch {
          /* pointer released mid-gesture */
        }
      }
    }
    if (axis !== 'x') return
    dragging = true
    dragX = Math.max(0, dx) // rightward only; leftward has nowhere to go
  }

  function up() {
    if (axis === 'x' && dragX > DISMISS_PX) {
      reset()
      onclose()
      return
    }
    reset()
  }
</script>

{#snippet info(text: string)}
  <span class="info" title={text} aria-label={text}>ⓘ</span>
{/snippet}

<aside
  class="panel"
  class:dragging
  bind:this={panelEl}
  style="transform: translateX({dragX}px)"
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={reset}
>
  <header>
    <strong>Conversations</strong>
    <div class="head-actions">
      {#if digest.digest || digest.engine.clusters.length}
        <button class="reset" onclick={() => digest.clear()} title="Clear conversations and re-establish from scratch">
          Reset
        </button>
      {/if}
      <button class="x" onclick={onclose} title="Close">✕</button>
    </div>
  </header>

  <div class="actionbar">
    <button
      class="go wide"
      onclick={() => (consentBlocked ? digestConsent.ask(digest.provider, digest.ollamaUrl) : onsummarize())}
      disabled={digest.loading || items.length === 0}
    >
      {consentBlocked ? 'Turn on topic grouping' : actionLabel}
    </button>
    <button
      class="cfg-toggle"
      class:on={showConfig}
      onclick={() => (showConfig = !showConfig)}
      title="Digest settings"
      aria-label="Digest settings"
    >
      ⚙
    </button>
  </div>

  {#if digest.continuous && !showConfig}
    <p class="engine-status slim">
      {#if digest.loading}
        labeling posts…
      {:else if convos.length}
        {convos.length} conversations · auto-updating
      {:else}
        auto-updating…
      {/if}
    </p>
  {/if}

  {#if showConfig}
  <div class="controls">
    {#if deploy.locked}
      <p class="note">This instance runs a shared model — nothing to configure; the digest runs by itself.</p>
    {:else if !deploy.hideOllama}
      <!-- Provider toggle retired with the Anthropic option: Ollama is the only
           one left, so a one-button segmented control would be noise. Restore
           this block (and the two lines in digest.svelte.ts) to bring a choice
           back — ideally as a generic OpenAI-compatible endpoint, not a vendor. -->
      <p class="note">The digest runs on a local model via Ollama.</p>
    {/if}

    <div class="row window">
      <span>Posts</span>
      <input type="range" min="20" max="120" step="10" bind:value={digest.window} />
      <span class="wval">{digest.window}</span>
    </div>

    <label class="row toggle">
      <input type="checkbox" bind:checked={digest.continuous} onchange={() => (digest.continuousSet = true)} />
      <span>Auto-update</span>
      {@render info(
        'Re-labels new posts automatically as the feed flows (turn on Live in the graph settings). Cheap — only genuinely new posts get sent to the model.',
      )}
    </label>

    <!-- Cluster mode disabled for now — label mode is the only path. The
         "Label each post" and "Cluster on originals only" toggles are hidden;
         restore them (and the store's labelMode restore) to bring it back. -->

    {#if digest.labelMode}
      <div class="row window sub">
        <span>
          Merge
          {@render info(
            'How alike two topics must be (by meaning) to merge into one conversation. Lower = more merging (fewer, broader topics); higher = stricter (more one-off captions).',
          )}
        </span>
        <input
          type="range"
          min="0.4"
          max="0.9"
          step="0.02"
          bind:value={digest.mergeThreshold}
          oninput={() => digest.regroupLabels()}
        />
        <span class="wval">{digest.mergeThreshold.toFixed(2)}</span>
      </div>
    {/if}

    {#if digest.continuous}
      <p class="engine-status">
        {digest.loading ? 'labeling new posts…' : `${convos.length} conversations · auto-updating`}
      </p>
    {/if}

    {#if deploy.locked}
      <!-- Model/provider/URL are fixed by the deployment — no controls. -->
    {:else if digest.provider === 'anthropic'}
      <label class="field">
        <span>
          Anthropic key
          {@render info(
            `Sends up to ${digest.window} posts to Anthropic (fetches more if needed). The key stays in this tab's memory only (re-enter next session); without one, a demo digest is shown.`,
          )}
        </span>
        <input
          type="password"
          placeholder="sk-ant-… (kept in memory only)"
          bind:value={digest.apiKey}
          autocomplete="off"
        />
      </label>
      <div class="row">
        <select bind:value={digest.model}>
          {#each MODELS as m}
            <option value={m.id}>{m.label}</option>
          {/each}
        </select>
      </div>
    {:else}
      <!-- One model field: label mode is the only path, so this IS the label
           model (a tiny model is ideal — one short prompt per post). -->
      <label class="field">
        <span>
          Model
          {#if digest.ollamaModels.length}
            <span class="model-meta">
              · {digest.ollamaModels.length} installed{digest.ollamaLabelModelPinned ? '' : ' · smallest auto-picked'}
            </span>
          {/if}
        </span>
        <input
          list="ollama-models"
          value={digest.ollamaLabelModel || digest.ollamaModel}
          oninput={(e) => digest.chooseLabelModel(e.currentTarget.value)}
          placeholder="type or pick a model"
          autocomplete="off"
        />
        <datalist id="ollama-models">
          {#each digest.ollamaModels as m}
            <option value={m.name}>{formatSize(m.size)}</option>
          {/each}
        </datalist>
      </label>
      <label class="field">
        <span>Ollama URL</span>
        <input
          bind:value={digest.ollamaUrl}
          onblur={() => digest.refreshOllamaModels()}
          placeholder="http://localhost:11434"
          autocomplete="off"
        />
      </label>
      {#if digest.ollamaModels.length === 0}
        <!-- Not connected: show the setup instructions they need right now. -->
        <p class="note">
          No models found — is Ollama running at this URL? Start it with the app's origin allowed
          (<code>OLLAMA_ORIGINS={originHint} ollama serve</code>) and pull a model
          (<code>ollama pull {digest.ollamaModel || 'qwen3.5:4b-mlx'}</code>). Only works over
          http://localhost — a deployed https page can't reach local Ollama.
        </p>
      {:else}
        <p class="note connected">
          {digest.ollamaModels.length} models · runs locally, nothing leaves your machine
          {@render info(
            'Bigger windows read more of the feed but wait longer before the first token. Only works over http://localhost — a deployed https page can’t reach local Ollama.',
          )}
        </p>
      {/if}
    {/if}
  </div>
  {/if}

  {#if digest.error}
    <p class="err">{digest.error}</p>
  {/if}

  {#if digest.loading}
    <div class="stream-wrap">
      <div class="stream-head">
        <span>labeling posts…</span>
        <span class="clock">{elapsed.toFixed(1)}s</span>
      </div>
      {#if liveStream}
        <pre class="stream">{liveStream}</pre>
      {/if}
    </div>
  {:else if consentBlocked}
    <p class="empty">
      Topic grouping is off — you chose not to send post text to the model. Nothing else in
      Mothtrap is affected. Use the button above to change that.
    </p>
  {:else if convos.length === 0}
    <p class="empty">No digest yet — press Summarize.</p>
  {/if}

  {#if !digest.loading}
    <ul class="convos">
      {#each convos as c (c.id)}
        <li>
          <div class="head" style="--c: {convoColor(c.id)}">
            <span class="swatch"></span>
            <span class="title">{c.label}</span>
            <span class="status {c.status}" title={c.status}>{statusMark[c.status]}</span>
            <span class="count">{c.postUris.length}</span>
          </div>
          <p class="summary">{c.summary}</p>
          <ul class="exemplars">
            {#each exemplars(c, byUri) as ex (ex.post.uri)}
              <li>
                <button class="ex" onclick={() => onfocus(ex.post.uri)}>
                  <span class="who">@{ex.post.author.handle}{reposter(ex) ? ' ↻' : ''}</span>
                  <span class="body">{text(ex).slice(0, 120)}</span>
                </button>
              </li>
            {/each}
          </ul>
        </li>
      {/each}
    </ul>
  {/if}
</aside>

<style>
  .panel {
    position: absolute;
    top: 0;
    right: 0;
    /* Runs to the floor and sits ABOVE the bottom bar (z-index 30), rather
       than stopping at the bar's measured top. Two earlier attempts tried to
       end the panel exactly where the bar begins; both measured flush in a
       browser and both still leaked a strip of graph on the device, because
       the container being measured extends under the home indicator. Covering
       the bar removes the seam entirely instead of positioning against it.
       Nothing is lost: the bar's controls act on the graph behind the panel,
       so they have nothing to do while it is open. Close with the ✕ or by
       swiping right. */
    bottom: 0;
    width: 340px;
    max-width: 88vw;
    background: var(--bg-elev);
    border-left: 1px solid var(--border);
    box-shadow: -10px 0 30px rgba(0, 0, 0, 0.35);
    display: flex;
    flex-direction: column;
    z-index: 40; /* over the bottom bar (30) — see above */
    font-size: 0.85rem;
    touch-action: pan-y; /* leave vertical scrolling to the list */
    transition: transform 0.18s ease;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.8rem 0.9rem;
    border-bottom: 1px solid var(--border);
  }
  .x {
    display: grid;
    place-items: center;
    /* 44px is Apple's minimum comfortable touch target; the old button was a
       bare glyph roughly a third of that. */
    min-width: 44px;
    min-height: 44px;
    margin: -0.4rem -0.4rem -0.4rem 0; /* grow the target, not the header */
    background: transparent;
    border: none;
    border-radius: 8px;
    color: var(--text-dim);
    font-size: 1.05rem;
    cursor: pointer;
  }
  .x:active {
    background: var(--bg);
  }
  /* While a swipe is in progress the panel tracks the finger exactly; easing
     it would lag behind the gesture. The transition returns for the release. */
  .panel.dragging {
    transition: none;
  }
  .head-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .reset {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-dim);
    font-size: 0.7rem;
    padding: 0.2rem 0.5rem;
    cursor: pointer;
  }
  .reset:hover {
    border-color: var(--danger, #e0684f);
    color: var(--danger, #e0684f);
  }
  .actionbar {
    display: flex;
    gap: 0.5rem;
    padding: 0.7rem 0.9rem;
  }
  .cfg-toggle {
    flex: none;
    width: 2.1rem;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 7px;
    color: var(--text-dim);
    font-size: 0.9rem;
    cursor: pointer;
  }
  .cfg-toggle:hover {
    color: var(--text);
    border-color: var(--accent);
  }
  .cfg-toggle.on {
    color: var(--accent);
    border-color: var(--accent);
  }
  .engine-status.slim {
    margin: 0;
    padding: 0 0.9rem 0.6rem;
  }
  .controls {
    padding: 0.2rem 0.9rem 0.8rem;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .field span {
    color: var(--text-dim);
    font-size: 0.72rem;
  }
  .model-meta {
    font-size: 0.62rem;
    opacity: 0.8;
  }
  .field input,
  select {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 0.35rem 0.5rem;
    color: var(--text);
    font-size: 0.8rem;
  }
  .row {
    display: flex;
    gap: 0.5rem;
  }
  .row select {
    flex: 1 1 0;
    min-width: 0;
  }
  .window span:first-child {
    color: var(--text-dim);
    font-size: 0.72rem;
    min-width: 3em;
  }
  .window.sub {
    padding-left: 1.5rem;
    align-items: center;
  }
  .window.sub span:first-child {
    min-width: 3.5em;
    font-size: 0.68rem;
  }
  .window input[type='range'] {
    flex: 1 1 0;
    min-width: 0;
    accent-color: var(--accent);
  }
  .wval {
    color: var(--text);
    font-variant-numeric: tabular-nums;
    min-width: 2em;
    text-align: right;
  }
  .toggle {
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
  }
  .toggle span {
    color: var(--text-dim);
    font-size: 0.78rem;
  }
  .engine-status {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.72rem;
    font-style: italic;
  }
  /* Parked with the provider toggle above — restore together. Kept rather than
     deleted so bringing a provider choice back is one edit, not a re-style. */
  /*
  .seg {
    display: flex;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .seg button {
    flex: 1 1 0;
    border: none;
    border-radius: 0;
    background: transparent;
    padding: 0.35rem 0.5rem;
    font-size: 0.78rem;
    color: var(--text-dim);
    cursor: pointer;
  }
  .seg button.on {
    background: var(--accent);
    color: #fff;
  }
  */
  .go {
    flex: none;
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 7px;
    padding: 0.35rem 0.8rem;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .go.wide {
    flex: 1 1 0;
  }
  .note code {
    background: var(--bg);
    border-radius: 4px;
    padding: 0 0.25rem;
    font-size: 0.66rem;
    word-break: break-all;
  }
  .go:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .note {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.68rem;
    line-height: 1.4;
  }
  /* Compact info affordance — the description rides in its title tooltip so the
     panel stays short. */
  .info {
    cursor: help;
    color: var(--text-dim);
    opacity: 0.55;
    font-size: 0.7rem;
    user-select: none;
  }
  .info:hover {
    opacity: 1;
    color: var(--accent);
  }
  .note.sub {
    margin-top: -0.2rem;
    padding-left: 1.5rem;
    font-size: 0.62rem;
  }
  .err {
    margin: 0;
    padding: 0.6rem 0.9rem;
    color: var(--danger);
    font-size: 0.75rem;
  }
  .empty {
    padding: 1rem 0.9rem;
    color: var(--text-dim);
  }
  .stream-wrap {
    padding: 0.7rem 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    min-height: 0;
    flex: 1 1 0;
  }
  .stream-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--text-dim);
    font-size: 0.72rem;
  }
  .clock {
    font-variant-numeric: tabular-nums;
  }
  .stream {
    margin: 0;
    padding: 0.5rem 0.6rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 7px;
    font-size: 0.68rem;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-y: auto;
    flex: 1 1 0;
    color: var(--text-dim);
  }
  .convos {
    list-style: none;
    margin: 0;
    padding: 0;
    /* The panel runs to the floor (bottom: 0) and paints over the home
       indicator, so pad the scroll list's tail to keep the last conversation
       reachable above it. Zero on desktop / non-standalone. */
    padding-bottom: env(safe-area-inset-bottom, 0px);
    overflow-y: auto;
    flex: 1 1 0;
  }
  .convos > li {
    padding: 0.7rem 0.9rem;
    border-bottom: 1px solid var(--border);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .swatch {
    width: 10px;
    height: 10px;
    border-radius: 3px;
    background: var(--c);
    flex: none;
  }
  .title {
    font-weight: 600;
    flex: 1 1 0;
    min-width: 0;
  }
  .status {
    font-size: 0.7rem;
  }
  .status.heating {
    color: var(--danger, #e0684f);
  }
  .status.cooling {
    color: var(--text-dim);
  }
  .status.steady {
    color: var(--text-dim);
  }
  .count {
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
    font-size: 0.75rem;
  }
  .summary {
    margin: 0.3rem 0 0.4rem;
    color: var(--text);
    line-height: 1.4;
  }
  .exemplars {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .ex {
    display: block;
    width: 100%;
    text-align: left;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 0.35rem 0.5rem;
    cursor: pointer;
    color: var(--text);
  }
  .ex:hover {
    border-color: var(--accent);
  }
  .ex .who {
    display: block;
    color: var(--text-dim);
    font-size: 0.7rem;
    margin-bottom: 0.1rem;
  }
  .ex .body {
    display: block;
    font-size: 0.75rem;
    line-height: 1.35;
  }

  /* Narrow screens: the drawer takes the full width — a 150px graph sliver
     behind it is dead space, and edge-tapping to dismiss stays available via
     the panel's own close control. */
  @media (max-width: 600px) {
    .panel {
      width: 100vw;
      max-width: 100vw;
      border-left: none;
    }
  }
</style>
