<script lang="ts">
  import { session } from './lib/state/session.svelte'
  import Login from './lib/components/Login.svelte'
  import Timeline from './lib/components/Timeline.svelte'
  import Graph from './lib/components/Graph.svelte'

  type View = 'graph' | 'list'
  let view = $state<View>('graph')

  session.init()
</script>

{#if session.status === 'loading'}
  <div class="center">Loading…</div>
{:else if session.status === 'logged-out'}
  <Login />
{:else}
  <div class="app">
    <header class="topbar">
      <strong>Skynets</strong>
      <div class="tabs">
        <button class:on={view === 'graph'} onclick={() => (view = 'graph')}>Graph</button>
        <button class:on={view === 'list'} onclick={() => (view = 'list')}>List</button>
      </div>
      <div class="who">
        <span>@{session.handle}</span>
        <button onclick={() => session.logout()}>Sign out</button>
      </div>
    </header>
    <main class="content">
      {#if view === 'graph'}
        <Graph />
      {:else}
        <Timeline />
      {/if}
    </main>
  </div>
{/if}

<style>
  .center {
    min-height: 100vh;
    display: grid;
    place-items: center;
    color: var(--text-dim);
  }
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.7rem 1rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
    flex-shrink: 0;
    z-index: 10;
  }
  .tabs {
    display: flex;
    gap: 0.25rem;
  }
  .tabs button {
    padding: 0.3rem 0.8rem;
    font-size: 0.85rem;
    background: transparent;
  }
  .tabs button.on {
    background: var(--bg);
    border-color: var(--accent);
    color: var(--text);
  }
  .who {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.9rem;
    color: var(--text-dim);
  }
  .who button {
    padding: 0.35rem 0.7rem;
    font-size: 0.85rem;
  }
</style>
