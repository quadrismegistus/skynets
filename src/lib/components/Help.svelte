<script lang="ts">
  interface Props {
    onclose: () => void
  }
  let { onclose }: Props = $props()

  /** '/' locally and on mothtrap.blue, '/mothtrap/' on GitHub Pages. */
  const base = import.meta.env.BASE_URL ?? '/'

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose()
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" role="button" tabindex="-1" onclick={onclose} onkeydown={onKey}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="modal" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => e.stopPropagation()}>
    <div class="head">
      <strong>How Mothtrap works</strong>
      <button class="close" aria-label="Close" onclick={onclose}>✕</button>
    </div>

    <p class="intro">
      Mothtrap shows your Bluesky timeline as a map of conversations instead of a scrolling
      feed — so you can triage, not doomscroll.
    </p>

    <div class="sections">
      <section>
        <h3>Reading the map</h3>
      <ul>
        <li><b>Left → right:</b> older → newer.</li>
        <li><b>Bottom → top:</b> quieter → louder (likes + reposts + replies).</li>
        <li><b>Node size:</b> number of replies (conversation size).</li>
        <li>A thread collapses to one node with a <b>+N</b> badge and a blue ring.</li>
      </ul>
    </section>

    <section>
      <h3>Interacting</h3>
      <ul>
        <li><b>Hover</b> a node to read it (on touch: <b>tap</b>) — the card has reply, repost / quote, and like.</li>
        <li><b>Click</b> a node to pin it (orange ring: it stays put, card stays open); click again to release. On touch the card simply stays open until its ✕ or a tap elsewhere.</li>
        <li><b>Drag</b> a node to nudge it around — it drifts back unless pinned.</li>
        <li><b>Map replies</b> on a card unspools the conversation around that post.</li>
        <li><b>Double-click</b> any node to open it on bsky.app.</li>
        <li><b>✕</b> (top-right of a node on hover) dismisses it.</li>
      </ul>
    </section>

    <section>
      <h3>Dismissing (“mark as read”)</h3>
      <ul>
        <li>A dismissed post is hidden for good — saved on this device, it never comes back.</li>
        <li>Dismissing a post also dismisses <b>all of its replies</b>.</li>
        <li>The graph refills from the queue, so the visible count stays steady.</li>
      </ul>
    </section>

    <section>
      <h3>Keyboard</h3>
      <dl class="keys">
        <div><kbd>D</kbd><span>Dismiss the hovered post (and its replies)</span></div>
        <div><kbd>R</kbd><span>Load more posts</span></div>
        <div><kbd>N</kbd><span>Next batch from the queue</span></div>
        <div><kbd>L</kbd><span>Jump back to the newest</span></div>
        <div><kbd>Esc</kbd><span>Close a card, popover, or dialog</span></div>
        <div><kbd>⌘/Ctrl</kbd><kbd>↵</kbd><span>Send, in the composer</span></div>
      </dl>
    </section>

    <section>
      <h3>Settings (⚙ bottom-left)</h3>
      <ul>
        <li><b>Count:</b> how many nodes are shown at once.</li>
        <li><b>Show:</b> Top (loudest), Recent (newest), or Mix of both.</li>
        <li><b>Auto-cycle:</b> rotate the queued posts through over time.</li>
        <li><b>Live:</b> pull in new posts every 60 seconds.</li>
      </ul>
    </section>

    <section class="legal">
      <!-- Static pages under public/, so they get real URLs a reviewer (or an
           App Store Connect field) can be pointed at. BASE_URL keeps them
           working under the GitHub Pages /mothtrap/ base as well as at root. -->
      <a href="{base}contact.html" target="_blank" rel="noreferrer">Contact</a>
      <span aria-hidden="true">·</span>
      <a href="{base}privacy.html" target="_blank" rel="noreferrer">Privacy</a>
    </section>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: grid;
    place-items: start center;
    padding: 8vh 1rem;
    z-index: 1000;
    overflow-y: auto;
  }
  .modal {
    width: 100%;
    max-width: 720px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 1.2rem 1.3rem 1rem;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }
  .head strong {
    font-size: 1.1rem;
  }
  .close {
    padding: 0.2rem 0.5rem;
    background: transparent;
    border: none;
    color: var(--text-dim);
  }
  .intro {
    margin: 0 0 0.5rem;
    color: var(--text-dim);
    font-size: 0.88rem;
    line-height: 1.45;
  }
  /* Flow the sections into as many columns as fit (2 on desktop, 1 on a phone),
     so the dialog reads wide-and-short instead of a tall single column. Each
     section stays whole. */
  .sections {
    column-width: 15rem;
    column-gap: 1.6rem;
    margin-top: 1rem;
  }
  section {
    break-inside: avoid;
    margin: 0 0 1rem;
  }
  /* No leading gap before the first section in each column. */
  .sections > section:first-child {
    margin-top: 0;
  }
  h3 {
    margin: 0 0 0.4rem;
    font-size: 0.82rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
  }
  ul {
    margin: 0;
    padding-left: 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.88rem;
    line-height: 1.4;
  }
  b {
    color: var(--text);
    font-weight: 600;
  }
  .keys {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .keys > div {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.88rem;
  }
  .keys span {
    color: var(--text-dim);
  }
  kbd {
    display: inline-block;
    min-width: 1.5rem;
    text-align: center;
    padding: 0.15rem 0.4rem;
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font-size: 0.78rem;
    font-family: inherit;
  }
  .legal {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    padding-top: 0.9rem;
    border-top: 1px solid var(--border);
    color: var(--text-dim);
    font-size: 0.8rem;
  }
  .legal a {
    color: var(--accent);
  }
</style>
