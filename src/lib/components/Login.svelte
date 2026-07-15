<script lang="ts">
  import { session } from '../state/session.svelte'

  let oauthHandle = $state('')
  let identifier = $state('')
  let password = $state('')
  let submitting = $state(false)
  let showAppPassword = $state(false)

  async function oauthSubmit(e: Event) {
    e.preventDefault()
    if (!oauthHandle) return
    submitting = true
    try {
      await session.loginWithOAuth(oauthHandle)
      // On success the browser navigates away; nothing more to do here.
    } catch {
      submitting = false
    }
  }

  async function appPasswordSubmit(e: Event) {
    e.preventDefault()
    if (!identifier || !password) return
    submitting = true
    try {
      await session.loginWithAppPassword(identifier, password)
    } catch {
      // error surfaced via session.error
    } finally {
      submitting = false
    }
  }
</script>

<div class="wrap">
  <div class="card">
    <h1>Mothtrap</h1>
    <p class="tagline">A network map for your Bluesky timeline.</p>

    <form onsubmit={oauthSubmit}>
      <label>
        <span>Handle</span>
        <input
          type="text"
          bind:value={oauthHandle}
          placeholder="you.bsky.social"
          autocomplete="username"
          autocapitalize="none"
          spellcheck="false"
        />
      </label>
      <button class="primary" type="submit" disabled={submitting || !oauthHandle}>
        {submitting ? 'Redirecting…' : 'Sign in with Bluesky'}
      </button>
    </form>

    <p class="hint">
      Sign in on Bluesky's own page — Mothtrap never sees your password.
    </p>

    {#if session.error}
      <p class="error">{session.error}</p>
    {/if}

    <button class="toggle" onclick={() => (showAppPassword = !showAppPassword)}>
      {showAppPassword ? 'Hide' : 'Use an app password instead'}
    </button>

    {#if showAppPassword}
      <form class="app-pw" onsubmit={appPasswordSubmit}>
        <label>
          <span>Handle</span>
          <input
            type="text"
            bind:value={identifier}
            placeholder="you.bsky.social"
            autocomplete="username"
            autocapitalize="none"
            spellcheck="false"
          />
        </label>
        <label>
          <span>App password</span>
          <input
            type="password"
            bind:value={password}
            placeholder="xxxx-xxxx-xxxx-xxxx"
            autocomplete="current-password"
          />
        </label>
        <p class="hint">
          Use an <a
            href="https://bsky.app/settings/app-passwords"
            target="_blank"
            rel="noreferrer">app password</a
          >, not your main password. Stored only in this browser.
        </p>
        <button type="submit" disabled={submitting || !identifier || !password}>
          {submitting ? 'Signing in…' : 'Sign in with app password'}
        </button>
      </form>
    {/if}
  </div>
</div>

<style>
  .wrap {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 1rem;
  }
  .card {
    width: 100%;
    max-width: 360px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 1.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }
  h1 {
    margin: 0;
    font-size: 1.9rem;
    letter-spacing: -0.02em;
  }
  .tagline {
    margin: 0 0 0.25rem;
    color: var(--text-dim);
    font-size: 0.9rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    font-size: 0.8rem;
    color: var(--text-dim);
  }
  .hint {
    font-size: 0.75rem;
    color: var(--text-dim);
    margin: 0;
    line-height: 1.4;
  }
  .error {
    color: var(--danger);
    font-size: 0.82rem;
    margin: 0;
  }
  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  button.primary:hover:not(:disabled) {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }
  .toggle {
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 0.8rem;
    padding: 0.2rem 0;
    align-self: flex-start;
    text-decoration: underline;
  }
  .toggle:hover {
    color: var(--text);
    border: none;
  }
  .app-pw {
    border-top: 1px solid var(--border);
    padding-top: 0.85rem;
  }
</style>
