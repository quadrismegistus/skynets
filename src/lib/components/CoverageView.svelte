<script lang="ts">
  import { archive } from '../state/archive'

  let { onclose }: { onclose: () => void } = $props()

  type Gran = 'hour' | 'day' | 'week' | 'month'
  const GRANS: Gran[] = ['hour', 'day', 'week', 'month']
  const BUCKET_MS: Record<Gran, number> = {
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: 2_592_000_000, // ~30 days; a rough month is fine for a histogram
  }

  let gran = $state<Gran>('day')
  let rows = $state<{ createdAt: number; firstSeen: number }[]>([])
  let loading = $state(true)

  $effect(() => {
    archive
      .coverage()
      .then((r) => (rows = r))
      .catch(() => (rows = []))
      .finally(() => (loading = false))
  })

  const stats = $derived.by(() => {
    const times = rows.map((r) => r.createdAt).filter((t) => t > 0)
    if (times.length === 0) return null
    const b = BUCKET_MS[gran]
    let min = Infinity
    let max = -Infinity
    for (const t of times) {
      if (t < min) min = t
      if (t > max) max = t
    }
    const start = Math.floor(min / b) * b
    const n = Math.min(Math.floor((max - start) / b) + 1, 4000) // cap the bar count
    const counts = new Array(n).fill(0)
    for (const t of times) {
      const i = Math.floor((t - start) / b)
      if (i >= 0 && i < n) counts[i]++
    }
    let peak = 1
    let empties = 0
    for (const c of counts) {
      if (c > peak) peak = c
      if (c === 0) empties++
    }
    return { counts, start, bucket: b, n, peak, empties, total: times.length, min, max }
  })

  const fmt = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="cov-backdrop" role="presentation" onclick={onclose}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="cov" role="presentation" onclick={(e) => e.stopPropagation()}>
    <header>
      <strong>Archive coverage</strong>
      <div class="grans">
        {#each GRANS as g}
          <button class:on={gran === g} onclick={() => (gran = g)}>{g}</button>
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
        <b>{stats.total.toLocaleString()}</b> posts · {fmt(stats.min)} → {fmt(stats.max)} ·
        <b>{stats.empties}</b> empty {gran}{stats.empties === 1 ? '' : 's'}
        <span class="hint">(gaps — periods with nothing captured)</span>
      </p>
      <svg class="hist" viewBox="0 0 {stats.n} 100" preserveAspectRatio="none">
        {#each stats.counts as c, i}
          {#if c > 0}
            <rect
              x={i + 0.1}
              y={100 - (c / stats.peak) * 100}
              width="0.8"
              height={(c / stats.peak) * 100}
            >
              <title>{fmt(stats.start + i * stats.bucket)} · {c} post{c === 1 ? '' : 's'}</title>
            </rect>
          {/if}
        {/each}
      </svg>
      <div class="axis">
        <span>{fmt(stats.start)}</span>
        <span>{fmt(stats.start + (stats.n / 2) * stats.bucket)}</span>
        <span>{fmt(stats.start + stats.n * stats.bucket)}</span>
      </div>
      <p class="note">
        Bars are archived posts binned by when they were <em>posted</em>. Flat/empty stretches are
        where we captured little or nothing — the gaps Jetstream (or longer backfill) would fill.
        Peak: {stats.peak} posts/{gran}.
      </p>
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
    margin-left: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
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
</style>
