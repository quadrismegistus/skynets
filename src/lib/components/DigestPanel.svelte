<script lang="ts">
  import { digest } from '../state/digest.svelte'
  import { convoColor, exemplars, MODELS, OLLAMA_MODELS, type Conversation } from '../api/llm'
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
  // Streamed raw text comes from the engine in continuous mode, else the store.
  const liveStream = $derived(digest.continuous ? digest.engine.streamText : digest.streamText)

  function text(item: FeedItem): string {
    const rec = item.post.record
    return AppBskyFeedPost.isRecord(rec) ? rec.text : ''
  }
  const statusMark: Record<Conversation['status'], string> = {
    heating: '▲',
    cooling: '▼',
    steady: '■',
  }
  const phaseLabel: Record<string, string> = {
    embedding: 'embedding new posts…',
    establishing: 'establishing conversations…',
    rolling: 'rolling in new posts…',
    skipped: 'nothing new — skipped',
  }

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
</script>

<aside class="panel">
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
    <button class="go wide" onclick={onsummarize} disabled={digest.loading || items.length === 0}>
      {actionLabel}
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
        {phaseLabel[digest.engine.phase] ?? 'working…'}
      {:else if digest.engine.clusters.length}
        {digest.engine.clusters.length} conversations tracked · auto-updating
      {:else}
        starting the rolling digest…
      {/if}
    </p>
  {/if}

  {#if showConfig}
  <div class="controls">
    <div class="seg">
      <button class:on={digest.provider === 'anthropic'} onclick={() => (digest.provider = 'anthropic')}>
        Anthropic
      </button>
      <button class:on={digest.provider === 'ollama'} onclick={() => (digest.provider = 'ollama')}>
        Ollama (local)
      </button>
    </div>

    <div class="row window">
      <span>Posts</span>
      <input type="range" min="20" max="120" step="10" bind:value={digest.window} />
      <span class="wval">{digest.window}</span>
    </div>

    <label class="row toggle">
      <input type="checkbox" bind:checked={digest.continuous} />
      <span>Continuous (rolling)</span>
    </label>

    <label class="row toggle">
      <input type="checkbox" bind:checked={digest.opsOnly} />
      <span>Cluster on originals only</span>
    </label>
    <p class="note sub">
      Feeds the classifier each thread's original post, not the replies — reply text is noisy and
      tends to muddy the conversations.
    </p>

    <label class="row toggle">
      <input type="checkbox" bind:checked={digest.labelMode} />
      <span>Label each post</span>
    </label>
    <p class="note sub">
      Tags every original post with its own short topic (many tiny prompts instead of one big
      one), then groups shared topics into conversations. A one-off topic sits as a caption under
      its post rather than getting its own pill.
    </p>

    {#if digest.labelMode}
      <div class="row window sub">
        <span>Merge</span>
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
      <p class="note sub">
        How alike two topics must be (by meaning) to merge into one conversation. Lower = more
        merging (fewer, broader topics); higher = stricter (more one-off captions).
      </p>
    {/if}

    {#if digest.continuous}
      <p class="engine-status">
        {#if digest.loading}
          {phaseLabel[digest.engine.phase] ?? 'working…'}
        {:else if digest.engine.lastGate && !digest.engine.lastGate.shouldRoll}
          nothing new last check ({digest.engine.bufferedCount} buffered)
        {:else if digest.engine.clusters.length}
          {digest.engine.clusters.length} conversations tracked · auto-updating
        {:else}
          starting the rolling digest…
        {/if}
      </p>
      <p class="note">
        Updates automatically as new posts arrive (turn on <b>Live</b> in the graph settings to keep
        the feed flowing). Most checks are free — the LLM only runs when something new appears.
      </p>
    {/if}

    {#if digest.provider === 'anthropic'}
      <label class="field">
        <span>Anthropic key</span>
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
      <p class="note">
        Sends up to {digest.window} posts to Anthropic (fetches more if needed). The key stays in
        this tab's memory only (re-enter next session); without one, a demo digest is shown.
      </p>
    {:else}
      <label class="field">
        <span>Model</span>
        <input list="ollama-models" bind:value={digest.ollamaModel} placeholder="llama3.1:8b" autocomplete="off" />
        <datalist id="ollama-models">
          {#each OLLAMA_MODELS as m}
            <option value={m.id}>{m.label}</option>
          {/each}
        </datalist>
      </label>
      <label class="field">
        <span>Ollama URL</span>
        <input bind:value={digest.ollamaUrl} placeholder="http://localhost:11434" autocomplete="off" />
      </label>
      <p class="note">
        Runs locally on up to {digest.window} posts — nothing leaves your machine. Start Ollama with
        the app's origin allowed (<code>OLLAMA_ORIGINS={originHint} ollama serve</code>) and pull the
        model first (<code>ollama pull {digest.ollamaModel || 'qwen3.5:4b-mlx'}</code>). Only works
        when Skynets is served over http://localhost — a deployed https page can't reach local Ollama.
        Bigger windows read more of the feed but wait longer before the first token.
      </p>
    {/if}
  </div>
  {/if}

  {#if digest.error}
    <p class="err">{digest.error}</p>
  {/if}

  {#if digest.loading}
    <div class="stream-wrap">
      <div class="stream-head">
        <span>{liveStream ? 'streaming…' : 'waiting for first token…'}</span>
        <span class="clock">{elapsed.toFixed(1)}s · {liveStream.length} chars</span>
      </div>
      {#if liveStream}
        <pre class="stream">{liveStream}</pre>
      {/if}
    </div>
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
    bottom: 0;
    width: 340px;
    max-width: 88vw;
    background: var(--bg-elev);
    border-left: 1px solid var(--border);
    box-shadow: -10px 0 30px rgba(0, 0, 0, 0.35);
    display: flex;
    flex-direction: column;
    z-index: 20;
    font-size: 0.85rem;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.8rem 0.9rem;
    border-bottom: 1px solid var(--border);
  }
  .x {
    background: transparent;
    border: none;
    color: var(--text-dim);
    font-size: 0.9rem;
    cursor: pointer;
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
</style>
