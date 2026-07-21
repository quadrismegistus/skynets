<script lang="ts">
  import { session } from './lib/state/session.svelte'
  import { compose } from './lib/state/compose.svelte'
  import { feeds } from './lib/state/feeds.svelte'
  import Login from './lib/components/Login.svelte'
  import Graph from './lib/components/Graph.svelte'
  import Compose from './lib/components/Compose.svelte'
  import Help from './lib/components/Help.svelte'
  import ReportDialog from './lib/components/ReportDialog.svelte'
  import Settings from './lib/components/Settings.svelte'
  import ReactionsPanel from './lib/components/ReactionsPanel.svelte'
  import RecentlyDismissed from './lib/components/RecentlyDismissed.svelte'
  import Terms from './lib/components/Terms.svelte'
  import { terms } from './lib/state/terms.svelte'
  import DigestConsent from './lib/components/DigestConsent.svelte'

  let showHelp = $state(false)
  let showSettings = $state(false)
  let showReactions = $state(false)
  let showDismissed = $state(false)

  session.init()

  // Load the account's pinned feeds (the tab bar) once signed in.
  let feedsLoaded = false
  $effect(() => {
    if (session.status === 'logged-in' && !feedsLoaded) {
      feedsLoaded = true
      feeds.load()
    }
  })
</script>

{#if terms.required}
  <!-- Before anything else, including Login: agreement should come before
       someone types a password into the app, not after. -->
  <Terms />
{:else if session.status === 'loading'}
  <div class="center">Loading…</div>
{:else if session.status === 'logged-out'}
  <Login />
{:else}
  <div class="app">
    <header class="topbar">
      <div class="brand"><strong>Mothtrap</strong></div>
      <div class="tabs" role="tablist" aria-label="Feeds">
        {#each feeds.list as f (f.key)}
          <button
            role="tab"
            aria-selected={feeds.active === f.key}
            class:on={feeds.active === f.key}
            onclick={() => feeds.setActive(f.key)}>{f.name}</button
          >
        {/each}
      </div>
      <div class="who">
        <button class="help" title="How Mothtrap works" aria-label="Help" onclick={() => (showHelp = true)}>?</button>
        <button
          class="reactions-btn"
          title="Your reactions — who to unfollow"
          aria-label="Your reactions"
          onclick={() => (showReactions = true)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <rect x="1" y="9" width="3.2" height="6" rx="0.6" />
            <rect x="6.4" y="5" width="3.2" height="10" rx="0.6" />
            <rect x="11.8" y="2" width="3.2" height="13" rx="0.6" />
          </svg>
        </button>
        <button
          class="dismissed-btn"
          title="Recently dismissed posts"
          aria-label="Recently dismissed"
          onclick={() => (showDismissed = true)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M8 2a6 6 0 1 1-5.2 3" stroke-linecap="round" />
            <path d="M2.4 2v2.6H5" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M8 5v3.2l2 1.2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button class="settings-btn" title="Settings" aria-label="Settings" onclick={() => (showSettings = true)}>⚙</button>
        <button class="compose-btn" onclick={() => compose.openNew()}
          ><span class="wide-only">New post</span><span class="narrow-only">Post</span></button
        >
        <span class="handle wide-only">@{session.handle}</span>
        <button onclick={() => session.logout()}
          ><span class="wide-only">Sign out</span><span class="narrow-only" title="Sign out" aria-hidden="true">⏻</span></button
        >
      </div>
    </header>
    <main class="content">
      <Graph />
    </main>
  </div>
  <Compose />
  <!-- Self-gating on the `report` store, like Compose: the post card that opens
       it is a hover affordance and closes the moment the pointer leaves. -->
  <ReportDialog />
  <!-- Raised by the network guard the first time a digest request would leave
       the device, so the ask lands in context rather than on the login screen. -->
  <DigestConsent />
  {#if showHelp}
    <Help onclose={() => (showHelp = false)} />
  {/if}
  {#if showSettings}
    <Settings onclose={() => (showSettings = false)} />
  {/if}
  {#if showReactions}
    <ReactionsPanel onclose={() => (showReactions = false)} />
  {/if}
  {#if showDismissed}
    <RecentlyDismissed onclose={() => (showDismissed = false)} />
  {/if}
{/if}

<style>
  .center {
    min-height: 100vh; /* fallback */
    min-height: 100dvh;
    display: grid;
    place-items: center;
    color: var(--text-dim);
  }
  .app {
    display: flex;
    flex-direction: column;
    /* 100dvh tracks the VISIBLE viewport (chrome shown/hidden), so the fixed
       bottom bar clears a mobile browser's toolbar instead of hiding behind it.
       100vh is the fallback for browsers without dvh. */
    height: 100vh;
    height: 100dvh;
  }
  .content {
    flex: 1;
    min-width: 0;
    min-height: 0;
    /* Clip rather than scroll. Nodes are clamped inside the canvas by the force
       sim, and a caption or pill straying past the edge should be cropped, not
       turn the graph into a scrollable pane. */
    overflow: hidden;
  }
  .topbar {
    display: flex;
    align-items: center;
    padding: 0.7rem 1rem;
    /* With viewport-fit=cover the bar paints up into the notch/status-bar area,
       so pull its contents clear of the safe-area insets. env() is 0 on desktop
       and in non-standalone browsers, so max() leaves the original padding. */
    padding-top: max(0.7rem, env(safe-area-inset-top, 0px));
    padding-left: max(1rem, env(safe-area-inset-left, 0px));
    padding-right: max(1rem, env(safe-area-inset-right, 0px));
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
    flex-shrink: 0;
    z-index: 10;
  }
  .brand {
    flex-shrink: 0;
  }
  /* The feed tabs take the middle and scroll horizontally when there are more
     than fit — so brand + actions never get squeezed (matters on mobile). */
  .tabs {
    flex: 1;
    min-width: 0;
    display: flex;
    gap: 0.25rem;
    overflow-x: auto;
    padding: 0 0.5rem;
    scrollbar-width: none; /* Firefox */
    -webkit-overflow-scrolling: touch;
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }
  .tabs button {
    flex-shrink: 0;
    white-space: nowrap;
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
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.75rem;
    font-size: 0.9rem;
    color: var(--text-dim);
  }
  .who .help,
  .who .reactions-btn,
  .who .dismissed-btn,
  .who .settings-btn {
    width: 30px;
    height: 30px;
    padding: 0;
    border-radius: 50%;
    font-weight: 700;
    display: grid;
    place-items: center;
  }
  .who .reactions-btn svg,
  .who .dismissed-btn svg {
    display: block;
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

  /* Narrow screens: the header must FIT — no horizontal overflow, ever.
     Compact labels, drop the handle, tighter gaps. */
  .narrow-only {
    display: none;
  }
  @media (max-width: 600px) {
    .app {
      overflow-x: clip;
    }
    .wide-only {
      display: none;
    }
    .narrow-only {
      display: inline;
    }
    .topbar {
      padding: 0.5rem 0.6rem;
      padding-top: max(0.5rem, env(safe-area-inset-top, 0px));
      padding-left: max(0.6rem, env(safe-area-inset-left, 0px));
      padding-right: max(0.6rem, env(safe-area-inset-right, 0px));
      gap: 0.35rem;
    }
    .brand {
      flex: 0 0 auto;
      font-size: 0.95rem;
      min-width: 0;
    }
    .tabs button {
      padding: 0.3rem 0.55rem;
    }
    .who {
      gap: 0.4rem;
      min-width: 0;
    }
    .who button {
      padding: 0.35rem 0.5rem;
    }
  }
</style>
