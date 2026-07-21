<script lang="ts">
  import { archive } from '../state/archive'
  import { coverageBins, type Gran } from '../state/coverage'
  import { feeds } from '../state/feeds.svelte'
  import { FOLLOWING } from '../api/timeline'

  let { onclose }: { onclose: () => void } = $props()

  const GRANS: Gran[] = ['hour', 'day', 'week', 'month']

  let gran = $state<Gran | null>(null) // null = auto from the (trimmed) span
  let trim = $state(true) // focus the dense region; ancient context posts hidden
  // Which timestamp to bin by: when posts were written (content) vs when WE
  // archived them (our uptime — a dip here means we weren't capturing).
  let source = $state<'posted' | 'captured'>('posted')
  let rows = $state<{ createdAt: number; firstSeen: number }[]>([])
  let loading = $state(true)
  // Per-feed breakdown: how many DISTINCT archived posts each feed surfaced,
  // over the provenance recorded on each appearance (PLAN §6.5). Read-only.
  let feedRows = $state<{ feed: string; posts: number }[]>([])

  // Hover tooltip state (custom — native SVG <title> is slow/unreliable on thin bars).
  let svgW = $state(0)
  let hover = $state<{ i: number; px: number } | null>(null)

  $effect(() => {
    archive
      .coverage()
      .then((r) => (rows = r))
      .catch(() => (rows = []))
      .finally(() => (loading = false))
  })

  $effect(() => {
    archive
      .feedCoverage()
      .then((r) => (feedRows = r))
      .catch(() => (feedRows = []))
  })

  const sorted = $derived(rows.map((r) => (source === 'posted' ? r.createdAt : r.firstSeen)))
  const stats = $derived(coverageBins(sorted, gran, trim))
  const effGran = $derived<Gran>(stats?.gran ?? 'day')

  // Largest per-feed count, for scaling the breakdown bars (never 0).
  const feedPeak = $derived(Math.max(1, ...feedRows.map((f) => f.posts)))

  /** A readable name for a feed provenance key: the FOLLOWING sentinel becomes
   * "Following"; a pinned feed/list resolves to its loaded display name; any
   * other AT-uri falls back to its rkey (last path segment) — enough to tell
   * feeds apart without a live resolve. */
  function feedLabel(key: string): string {
    if (key === FOLLOWING) return 'Following'
    return feeds.list.find((f) => f.key === key)?.name || key.split('/').pop() || key
  }

  function onMove(e: MouseEvent) {
    if (!stats || !svgW) return
    const i = Math.min(stats.n - 1, Math.max(0, Math.floor((e.offsetX / svgW) * stats.n)))
    hover = { i, px: e.offsetX }
  }

  // Short date, for the summary/note (always day-level).
  const fmt = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })
  // Bin label at the current granularity — includes the hour when zoomed in, so
  // a dip can be read as a clock time (local; bins are UTC-aligned, which lines
  // up with local hours for whole-hour-offset zones like BST).
  function fmtBin(t: number, g: Gran): string {
    const d = new Date(t)
    if (g === 'hour') return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })
    if (g === 'month') return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="cov-backdrop" role="presentation" onclick={onclose}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="cov" role="presentation" onclick={(e) => e.stopPropagation()}>
    <header>
      <strong>Archive coverage</strong>
      <div class="grans src" title="Bin by when posts were written, or by when we archived them (our uptime)">
        <button class:on={source === 'posted'} onclick={() => (source = 'posted')}>posted</button>
        <button class:on={source === 'captured'} onclick={() => (source = 'captured')}>captured</button>
      </div>
      <div class="grans">
        {#each GRANS as g}
          <button class:on={effGran === g} onclick={() => (gran = g)}>{g}</button>
        {/each}
      </div>
      <button class="x" onclick={onclose} title="Close">✕</button>
    </header>

    {#if loading}
      <p class="msg">Reading the archive…</p>
    {:else if !stats}
      <p class="msg">Nothing archived yet. Posts accumulate as you browse (and via backfill).</p>
    {:else}
      <p class="summary">
        <b>{stats.shown.toLocaleString()}</b> posts · {fmt(stats.min)} → {fmt(stats.max)} ·
        <b>{stats.empties}</b> empty {effGran}{stats.empties === 1 ? '' : 's'}
        <span class="hint">(gaps — {source === 'captured' ? 'we were not capturing' : 'nothing posted / captured'})</span>
        {#if stats.hidden > 0}
          <button class="link" onclick={() => (trim = false)}>· +{stats.hidden} older hidden</button>
        {:else if !trim && sorted.length}
          <button class="link" onclick={() => (trim = true)}>· focus recent</button>
        {/if}
      </p>
      <!-- svelte-ignore a11y_no_static_element_interactions a11y_mouse_events_have_key_events -->
      <div class="chart" role="presentation" onmousemove={onMove} onmouseleave={() => (hover = null)}>
        <svg class="hist" viewBox="0 0 {stats.n} 100" preserveAspectRatio="none" bind:clientWidth={svgW}>
          {#each stats.counts as c, i}
            {#if c > 0}
              <rect
                class:hot={hover?.i === i}
                x={i + 0.1}
                y={100 - (c / stats.peak) * 100}
                width="0.8"
                height={(c / stats.peak) * 100}
              />
            {/if}
          {/each}
        </svg>
        {#if hover}
          <div class="tip" style="left: {hover.px}px">
            <b>{stats.counts[hover.i] ?? 0}</b> post{(stats.counts[hover.i] ?? 0) === 1 ? '' : 's'}
            <span>{fmtBin(stats.start + hover.i * stats.bucket, effGran)}</span>
          </div>
        {/if}
      </div>
      <div class="axis">
        <span>{fmtBin(stats.start, effGran)}</span>
        <span>{fmtBin(stats.start + Math.floor(stats.n / 2) * stats.bucket, effGran)}</span>
        <span>{fmtBin(stats.start + stats.n * stats.bucket, effGran)}</span>
      </div>
      <p class="note">
        {#if source === 'captured'}
          Bars are binned by when <em>we archived</em> each post — your capture uptime. A dip here
          means the app wasn't running/capturing then (vs. "posted", which is when content was
          written). Spikes are backfill catching up on open.
        {:else}
          Bars are archived posts binned by when they were <em>posted</em>. A dip can be the network
          asleep, you asleep, or the tab closed — flip to <b>captured</b> to see which was your
          doing. The gaps Jetstream (or longer backfill) would fill.
        {/if}
        Peak: {stats.peak.toLocaleString()}/{effGran}.{#if stats.hidden > 0}
          {' '}({stats.hidden} older — mostly pulled-in context — trimmed.){/if}
      </p>

      {#if feedRows.length}
        <div class="feeds">
          <div class="feeds-head">
            <strong>Per-feed coverage</strong>
            <span class="hint">distinct posts each feed surfaced — a post via two feeds counts in both</span>
          </div>
          {#each feedRows as f (f.feed)}
            <div class="feed-row" title={f.feed}>
              <span class="feed-bar" style="width: {(f.posts / feedPeak) * 100}%"></span>
              <span class="feed-name">{feedLabel(f.feed)}</span>
              <span class="feed-count">{f.posts.toLocaleString()}</span>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .cov-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
  }
  .cov {
    width: min(760px, 92vw);
    max-height: 86vh;
    overflow-y: auto;
    touch-action: pan-y; /* scroll under the graph's touch-action: none (#42) */
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    padding: 1rem 1.1rem 1.2rem;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    margin-bottom: 0.8rem;
  }
  header strong {
    font-size: 0.95rem;
  }
  .grans {
    display: flex;
    gap: 0.2rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .grans.src {
    margin-left: auto;
  }
  header .grans:not(.src) {
    margin-left: 0.4rem;
  }
  .grans button {
    border: none;
    background: transparent;
    color: var(--text-dim);
    font-size: 0.72rem;
    padding: 0.25rem 0.55rem;
    cursor: pointer;
  }
  .grans button.on {
    background: var(--accent);
    color: #fff;
  }
  .x {
    background: transparent;
    border: none;
    color: var(--text-dim);
    font-size: 0.9rem;
    cursor: pointer;
  }
  .summary {
    margin: 0 0 0.6rem;
    font-size: 0.8rem;
    color: var(--text);
  }
  .summary .hint {
    color: var(--text-dim);
    font-size: 0.72rem;
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    font-size: 0.72rem;
    cursor: pointer;
  }
  .chart {
    position: relative;
  }
  .hist {
    width: 100%;
    height: 200px;
    display: block;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .hist rect {
    fill: var(--accent);
  }
  .hist rect.hot {
    fill: var(--accent-hover, #5b9ff0);
  }
  .tip {
    position: absolute;
    top: -2px;
    transform: translate(-50%, -100%);
    pointer-events: none;
    white-space: nowrap;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.25rem 0.45rem;
    font-size: 0.72rem;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
    z-index: 2;
  }
  .tip span {
    color: var(--text-dim);
    margin-left: 0.35rem;
  }
  .axis {
    display: flex;
    justify-content: space-between;
    color: var(--text-dim);
    font-size: 0.66rem;
    margin: 0.3rem 0.1rem 0.7rem;
    font-variant-numeric: tabular-nums;
  }
  .note {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.7rem;
    line-height: 1.45;
  }
  .msg {
    padding: 2rem 0.5rem;
    text-align: center;
    color: var(--text-dim);
  }
  .feeds {
    margin-top: 0.9rem;
    border-top: 1px solid var(--border);
    padding-top: 0.7rem;
  }
  .feeds-head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
    flex-wrap: wrap;
  }
  .feeds-head strong {
    font-size: 0.82rem;
  }
  .feeds-head .hint {
    color: var(--text-dim);
    font-size: 0.68rem;
  }
  .feed-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.28rem 0.45rem;
    border-radius: 6px;
    overflow: hidden;
  }
  .feed-bar {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    background: var(--accent);
    opacity: 0.16;
    border-radius: 6px;
    pointer-events: none;
  }
  .feed-name {
    position: relative;
    flex: 1;
    min-width: 0;
    font-size: 0.78rem;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .feed-count {
    position: relative;
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
    color: var(--text-dim);
  }
</style>
