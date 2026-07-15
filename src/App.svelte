<script lang="ts">
  import { session } from './lib/state/session.svelte'
  import { compose } from './lib/state/compose.svelte'
  import Login from './lib/components/Login.svelte'
  import Timeline from './lib/components/Timeline.svelte'
  import Graph from './lib/components/Graph.svelte'
  import Compose from './lib/components/Compose.svelte'
  import Help from './lib/components/Help.svelte'

  type View = 'graph' | 'list'
  let view = $state<View>('graph')
  let showHelp = $state(false)

  session.init()
</script>

{#if session.status === 'loading'}
  <div class="center">Loading…</div>
{:else if session.status === 'logged-out'}
  <Login />
{:else}
  <div class="app">
    <header class="topbar">
      <div class="brand"><strong>Mothtrap</strong></div>
      <div class="tabs">
        <button class:on={view === 'graph'} onclick={() => (view = 'graph')}>Graph</button>
        <button class:on={view === 'list'} onclick={() => (view = 'list')}>List</button>
      </div>
      <div class="who">
        <button class="help" title="How Mothtrap works" aria-label="Help" onclick={() => (showHelp = true)}>?</button>
        <button class="compose-btn" onclick={() => compose.openNew()}>New post</button>
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
  <Compose />
  {#if showHelp}
    <Help onclose={() => (showHelp = false)} />
  {/if}
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
    padding: 0.7rem 1rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
    flex-shrink: 0;
    z-index: 10;
  }
  .brand {
    flex: 1;
  }
  .tabs {
    display: flex;
    gap: 0.25rem;
    flex-shrink: 0;
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
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.75rem;
    font-size: 0.9rem;
    color: var(--text-dim);
  }
  .who .help {
    width: 30px;
    height: 30px;
    padding: 0;
    border-radius: 50%;
    font-weight: 700;
    display: grid;
    place-items: center;
  }
  .who button {
    padding: 0.35rem 0.7rem;
    font-size: 0.85rem;
  }
  .who .compose-btn {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .who .compose-btn:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }
</style>
