# Skynets: Mastotron reborn as a Bluesky client

A planning document: what Mastotron was, what its essential spirit is, and how to rebuild
it — much smaller — as a Svelte web client for Bluesky.

---

## 1. What Mastotron is

[Mastotron](../mastotron) (~2,500 lines of Python + ~1,500 lines of hand-rolled jQuery/vis.js)
replaces the scrolling feed with a **network map of conversations**: posts are nodes
(author avatars), replies are edges, and the canvas is laid out semantically —
**y-axis = recency, x-axis = engagement score**. Instead of doomscrolling, you triage:
hover to read a post, expand its thread, or dismiss it permanently ("mark as read"),
trusting that dismissed posts never come back.

### Core features (the spirit to preserve)

| Feature | How it worked |
|---|---|
| **Graph-of-posts UI** | vis-network canvas; nodes = posts w/ avatar images, edges = reply/boost relations |
| **Semantic layout** | y = timestamp rank, x = engagement-score rank (geometric mean of boosts/likes/replies, optionally follower-weighted — borrowed from `mastodon_digest`) |
| **Read-state persistence** | dismiss a post (press `D`) → stored locally → never shown again |
| **The queue ("stack")** | backend streams posts to the frontend, which shows only N (~12) at a time; a timer "turns over" nodes — oldest node swaps out, next queued post swaps in. Pure frontend animation, no extra API calls |
| **Thread expansion** | right-click / `C` fetches a post's conversation context and force-pushes it into the graph |
| **Hover card** | full rendered HTML of the post floats next to the node |
| **Keyboard triage** | `D` dismiss, `N` next batch, `L` latest, `R` fetch 3 new, `C` context, `P` pause animation |
| **Live updates** | a streaming-API listener + a 60s polling "crawler" push new posts into the queue |

### Architecture (and why it was so heavy)

```
┌────────────────────────── desktop app (pywebview) ──────────────────────────┐
│  Flask + flask-socketio + gevent  ←── websockets ──→  jQuery + vis-network  │
│        │                                              (postnet.js, 900 loc) │
│  Mastodon.py (per-server OAuth apps, per-user tokens on disk)               │
│        │                                                                    │
│  SqliteDict caches (statuses, contexts, 5-min timeline buckets)             │
│  TinyDB + cogdb graph database (post URL ↔ URI identity resolution)         │
└──────────────────────────────────────────────────────────────────────────────┘
```

Three whole layers of the codebase exist **only because of Mastodon/fediverse problems**:

1. **Cross-server identity crisis** (`graphdb.py`, `db.py`, half of `post.py`):
   the same post has a different ID on every server. Relating a reply on server X to
   its parent on server Y required a local graph database (cogdb) with `IS_LOCAL_FOR`,
   `IS_BOOST_OF`, `IS_REPLY_TO` edges, plus heuristics and context-API spelunking to
   stitch identities together. This is the messiest and largest part of the app.
2. **Server-side Python + websocket plumbing** (`gui/app.py`, 475 loc): Flask sessions,
   socket.io events, gevent background threads (crawler + stream listener), and a
   pywebview/pyinstaller desktop wrapper — all because the Mastodon API calls and the
   cogdb store had to live in Python on your machine.
3. **Per-server OAuth app registration** (`mastotron.py`): dynamically registering a
   client app on every fediverse server encountered, secrets stored on disk.

The author's own README verdict: *"Now that I've typed this all out I can see it's a bit
over-complicated."*

---

## 2. Why Bluesky makes ~70% of this disappear

| Mastotron problem | Bluesky answer |
|---|---|
| Post identity differs per server | **AT-URIs are globally canonical** (`at://did:plc:…/app.bsky.feed.post/rkey`). The entire cogdb/graphdb layer — and `is_local_for`, `allcopies`, `source`, URL↔URI caches — is simply deleted. |
| Reply relations need cross-server detective work | Every post view carries its `reply.root` / `reply.parent` refs inline; `app.bsky.feed.getPostThread` returns the full thread in **one call**, from anywhere. |
| Python backend needed for API + local DB | The Bluesky API is CORS-enabled JSON over HTTPS; `@atproto/api` runs entirely in the browser. Read-state and caches go in IndexedDB. **No backend at all.** |
| Per-server app registration | One login: app password (v1) or OAuth via `@atproto/oauth-client-browser` (v2). |
| Streaming API listener thread | Poll `getTimeline` with a cursor every ~60s (identical UX to Mastotron's crawler), or later subscribe to Jetstream for real-time. |
| Engagement scores computed server-side | `likeCount`, `repostCount`, `replyCount` come inline on every `postView`; the author's `followersCount` via `getProfile`. Score math is ~10 lines of JS. |
| Flask/socket.io push channel | Unnecessary — the "backend" is a fetch call away in the same process. |

Concept mapping for the port: status → post, boost → repost (`reason: reasonRepost` on
feed items), favourite → like, `status_context` → `getPostThread`, home timeline →
`app.bsky.feed.getTimeline` (cursor-paginated — no more 5-minute-bucket caching hack).

One thing Bluesky does *not* give us: server-side read/dismissed state for arbitrary
timeline posts. That stays local (IndexedDB), exactly as Mastotron kept it — which was
a stated privacy feature anyway.

---

## 3. Proposed architecture: Skynets

A **pure client-side SPA**. No server, no desktop wrapper, no websockets of our own.
Deployable as static files (GitHub Pages / Netlify / localhost).

```
Vite + Svelte 5 (TypeScript)
│
├── src/lib/api/        agent.ts        – AtpAgent, login/session persistence
│                       timeline.ts     – cursor pagination, poll loop, dedup
│                       thread.ts       – getPostThread → nodes+edges
│
├── src/lib/state/      queue.svelte.ts – the post queue (Mastotron's DATA_STACK)
│                       graph.svelte.ts – nodes/edges currently on canvas, turnover logic
│                       read.ts         – dismissed-post store (IndexedDB, e.g. idb-keyval)
│                       score.ts        – engagement scoring (gmean, follower-weighted)
│
├── src/lib/components/ Canvas.svelte   – d3-force simulation + semantic x/y targeting
│                       PostNode.svelte – avatar node (a real DOM element, not canvas!)
│                       PostCard.svelte – hover/click card with embeds, images, facets
│                       Toolbar.svelte  – node-limit, turnover-speed, pause, dark mode
│                       Login.svelte    – handle + app password
│
└── src/routes/         single page
```

### Key design choices

- **Svelte 5 runes for all state.** Mastotron's tangle of globals (`DATA_STACK`, `SEEN`,
  `BUSY`, `PAUSE`, interval timers) becomes a handful of reactive stores. The
  queue-turnover animation is a `setInterval` mutating a `$state` array; the graph
  re-renders itself.
- **DOM nodes instead of canvas.** With only 10–40 visible posts, we don't need
  vis-network's canvas renderer. Render each node as an absolutely-positioned Svelte
  component. That makes avatars, hover cards, rich embeds, transitions, and
  accessibility trivially better than canvas hit-testing. Edges are one SVG layer
  underneath.
- **Anchored d3-force, in slow motion** — the semantic layout is Mastotron's soul, so
  force must *serve* it, not scramble it. Each node has a rank-based target
  (x = recency rank, y = engagement rank); the simulation uses `forceX(targetX)` +
  `forceY(targetY)` to pull nodes toward those targets, with `forceCollide` to stop
  avatars overlapping and a weak `forceLink` so replies drift toward their parents.
  Low `alphaDecay` + high `velocityDecay` make it *ease* into place over seconds rather
  than snapping — organic motion, meaning preserved. Free (unanchored) force would look
  livelier but would destroy the x=recency / y=engagement reading, so we don't use it.
  (Milestone-2 shipped with static rank positioning; the anchored simulation is the
  drop-in upgrade over the same targets.)
- **Auth = OAuth (preferred) + app password (fallback).** Both converge on one shared
  `Agent`. OAuth via `@atproto/oauth-client-browser` (loopback dev mode now; hosted
  client-metadata JSON for production). App password via `AtpAgent.login()`.
- **Persistence, three separate stores** — all local, no server:
  - *OAuth tokens + DPoP keys* → IndexedDB, managed by the OAuth library (loopback
    refresh tokens last ~1 day).
  - *App-password session* → `localStorage` (`skynets.session`), kept in sync by the
    agent's `persistSession` hook.
  - *Dismissed ("read") posts* → IndexedDB via `idb-keyval`, a set of post URIs keyed
    per-user DID (`skynets:dismissed:<did>`), filtered out of the graph on load. Bluesky
    has **no** server-side read-state for arbitrary timeline posts, so — as in Mastotron
    — this is deliberately local-only, which doubles as a privacy feature. A dismissed
    post never reappears; that's the whole point of the triage model.
- **Data flow** (Mastotron's step-4/5 logic, minus two layers): poll `getTimeline`
  (cursor) → filter out dismissed/seen → score → push into queue → turnover timer moves
  queue → graph under the node limit. Thread expansion calls `getPostThread` and
  force-pushes the subtree.

### Dependencies (all of them)

`@atproto/api`, `d3-force` (or nothing, if we keep pure rank-positioning),
`idb-keyval`, Svelte 5 + Vite. Compare with Mastotron's 20 Python packages + jQuery +
jQuery-UI + socket.io + vis-network.

---

## 4. Milestones

1. **Skeleton + auth** ✅ — Vite/Svelte scaffold; OAuth *and* app-password login; session
   resume; timeline fetch. (OAuth was pulled forward from milestone 5.)
2. **Static graph** ✅ — timeline posts as avatar nodes at semantic x/y positions,
   reply edges, hover card, Graph/List toggle. Dark mode.
3. **Triage loop** ✅ — dismiss/mark-read (✕ on node hover + `D` key, dismissing a post
   also dismisses its reply subtree) with IndexedDB persistence so dismissed posts never
   reappear; **anchored d3-force slow-motion layout**; **thread collapsing** (a thread
   with 2+ posts in view becomes one representative node with a "+N" badge, placed by the
   thread's latest activity + peak engagement; single-click unspools/re-collapses it,
   double-click opens on bsky.app); relative timestamp on the hover card; **node limit +
   selection modes** — show only N nodes chosen by Top (loudest) / Recent (newest) /
   Mix (loudest half + newest half); layout is re-ranked over just the *visible* set so
   it always fills the full x/y range; a gear **config popover** holds mode, count, and
   an opt-in auto-cycle (rotates the queued overflow through over time — replaced the
   awkward prominent play button); keyboard `R` load more, `N` next batch, `L` back to
   top, `D` dismiss, `Esc` close. The popover also has **Live**, **Connect** (edge
   replies), **Cluster** (force connected posts together, loosening the axes), and
   **Reposts** on/off. Pinned posts keep their card open; the hover card is wider with a
   height cap and carries a **Follow/Unfollow** button.
4. **Threads** ✅ — a **"Map replies"** button in the hover card fetches the conversation
   via `getPostThread` and adds **only the loudest N replies** (capped, so a post with
   hundreds of replies can't flood the graph). Single-click instead **pins** a node
   (fixes its position + keeps it on the map, immune to turnover/limit); double-click
   opens on bsky.app.
   - **Connect replies** ✅ (toggle, on by default): fetch the *parent* of each loaded
     reply via `getPosts` (batched, skipping dismissed, climbing to root), and render
     small threads as connected nodes instead of collapsing (`COLLAPSE_MIN = 3`) — so a
     reply that would look standalone is drawn linked to what it's replying to. Big
     threads still collapse. Dismissing never re-fetches a dismissed post as a parent,
     but does **not** mute future replies (thread-muting would be a separate action).
   - Edges are **directional** (arrow child →(replied to)→ parent), trimmed to node rims;
     accounts you **don't follow** (reposts, pulled-in parents) render **dashed + dimmed**
     to distinguish context from your actual follows; nodes have extra collision spacing.
   - Provenance so unfollowed content is never a mystery: a **repost** shows the
     reposter's avatar tucked behind-and-left of the reposted node; a **pulled-in
     reply-parent** is only shown while it's still attached to a post that's actually in
     your feed (conversations with no primary post of your own are dropped).
5. **Live + polish** ✅ (mostly) — **OAuth login**, **deployed** to GitHub Pages at
   ryanheuser.com/skynets/, **open-in-bsky.app** on double-click, and **60s live polling**
   that slides new posts into the graph (persisted toggle in the config popover). Still
   optional: Jetstream firehose instead of polling, follower-weighted scoring.

6. **Backlog (not critical)** — from Dan Abramov's atproto AMA (2026-07-13):
   - **Granular OAuth scopes**: replace the legacy `transition:generic` catch-all with
     the granular permission scopes (create/delete records for post/like/repost/follow,
     blob upload, feed reads) so the consent screen honestly describes what Skynets can
     do and a leaked browser token carries less blast radius.
   - **Jetstream live mode**: replace the 60s `getTimeline` poll with a Jetstream
     websocket subscription filtered by `wantedDids` (your ~600 follows fit its limits)
     so new posts slide into the graph the moment they're made — no polling, no auth
     needed for public data. Needs: subscribe, filter to `app.bsky.feed.post` commits,
     hydrate post views, refresh the did list when follows change. *(Absorbed into the
     roadmap below as Phase B.)*

Each milestone is a working app; 1–3 recreate the daily-driver experience.

- **Help/onboarding**: ✅ a "?" button in the top bar opens a Help dialog explaining the
  map (axes, size, threads), interactions, dismissing, keyboard shortcuts, and settings.

## 5. Open questions

- **Repo layout**: scaffold the SvelteKit/Vite app at the root of this repo? (Assumed yes.)
- **Feeds beyond home**: Bluesky's custom feed generators (Discover, etc.) come free via
  `getFeed` — worth a feed-picker in the toolbar early?
- **Notifications/mentions view**: Mastotron never had one; `listNotifications` would
  slot into the same graph metaphor nicely (later).
- **Posting/replying**: ✅ done — compose modal (new post + reply + **quote-post**),
  300-grapheme counter, optimistic insertion. **Likes & reposts** ✅ — SVG action row in
  the hover card (interactive, hover-persistent), optimistic with rollback. **Rich text**
  ✅ — outbound facet detection (links/@mentions post correctly) and inbound rendering
  (clickable links/mentions), plus **image embeds** in the card. (Mastotron was read-only;
  Skynets is not.) **Quote-embed cards** ✅ and **external link-preview cards** ✅ render
  inline in the hover card. **Image upload** ✅ — attach up to 4 images with per-image alt
  text, client-side downscale/compress. **Thread composer** ✅ — "+ Add post" writes a
  multi-post self-reply chain (each segment its own text + images); it lands in the graph
  as a collapsed thread node.

---

## 6. Roadmap: the corpus turn (archive → embeddings → LLM digest)

Skynets so far is a *live view*: it shows what the timeline serves right now and forgets
the rest. The next arc turns it into a **personal corpus with an interpreter** — the feed
persisted locally, organized into "conversations" (the few discourse-events in play on a
given day), and summarized on demand. Six phases; A is the foundation, E is the payoff,
and E-minimal can actually ship first (see ordering note at the end).

### Phase A — Archive foundation

Persist every timeline post locally so nothing is lost between sessions.

1. **Schema decision (do this first, it's load-bearing):** what is a record? Proposal:
   one row per *feed item* (post uri + optional repost attribution), storing the raw
   `FeedViewPost` JSON plus `firstSeen`/`lastSeen` timestamps, keyed per user DID.
   Decide explicitly whether to keep: engagement-count snapshots over time (enables
   velocity history; costs writes), deletions (timeline backfill can't see them;
   Jetstream can), and follows-list snapshots.
2. **IndexedDB store** — move from `idb-keyval` to `idb` proper for this database
   (need indexes on `indexedAt`/`firstSeen` for range queries). Request
   `navigator.storage.persist()` to resist eviction.
3. **Write path**: every poll/fetch/backfill also archives (dedup by key; update
   `lastSeen` + counts on re-encounter).
4. **Gap-healing backfill on startup**: cursor-paginate `getTimeline` backwards until
   overlapping already-archived items (stop after N consecutive known posts, with a
   page-depth safety cap). Caveat to document: the timeline is a view — posts deleted
   while away are unrecoverable, and pagination depth is empirically deep but not
   contractually guaranteed.
5. **Archive UI**: stats in the config popover (posts, span, size on disk); an export
   button (JSON dump) early — it's cheap and makes the corpus portable to
   notebooks/pandas from day one.
6. Tests: dedup, stop condition, gap-heal against a mocked paginated timeline.

### Phase B — Jetstream capture (backlog item, promoted)

Near-lossless capture while the app is open; replay heals short gaps.

1. Websocket to a public Jetstream instance, `wantedDids` = follows list (refreshed on
   follow/unfollow), filtered to `app.bsky.feed.post` + `app.bsky.feed.repost` commits
   (a followee's repost arrives as a repost record; hydrate the subject via `getPosts`).
2. **Replay cursor**: on reconnect, resume from the last-received event timestamp
   (public instances buffer on the order of a day). Longer gaps fall through to
   Phase A's timeline backfill.
3. Capture `delete` events into the archive (the one thing backfill can never see).
4. Polling remains the fallback when the socket is down; both funnel into the same
   archive write path.

### Phase C — Embedding layer

Client-side vectors as the always-on cheap signal.

1. **transformers.js** with a small model (bge-small or MiniLM class, ~25MB quantized),
   WebGPU with WASM fallback, lazy-loaded behind a setting (off by default — 25MB is
   rude to load unannounced).
2. **Document construction is the whole game** for short cryptic posts: embed post text
   *concatenated with* parent/root text, quoted-post text, link-card title/description,
   and image alt text. A reply inherits its conversation's topic; a "this." embeds as
   what it points at.
3. Embed incrementally on arrival; cache vectors in IndexedDB keyed by uri (384-dim
   float32 ≈ 1.5KB/post — 50k posts ≈ 75MB, fine). Never re-embed.
4. Similarity utilities: cosine, top-k neighbors over a time window.

### Phase D — Conversation detection

"There are a few conversations in play today" made computable: a conversation is a
**semantic cluster × a time burst**.

1. Reply threads are ground-truth conversations already; clustering's job is to *join
   threads and singletons* into discourse-events (greedy agglomerative over cosine, or
   connected components of a thresholded kNN graph — evaluate on real feed days, e.g.
   the Lindsey Graham day: first-order event posts should cluster trivially).
2. **Burst detection**: cluster density over time distinguishes "conversation of the
   day" from background topical similarity.
3. UI options (pick after prototyping, don't build all three): similarity edges feeding
   the existing cluster-mode force layout (cheapest, composes with what exists); cluster
   hulls/tints; a 1D semantic x-axis mode (topic left-right × recency up-down) —
   full 2D UMAP is explicitly rejected (unstable at n≈100, re-scrambles on every fetch,
   destroys the semantic axes).
4. **Known limit, by design**: second-order discourse (vague-posting *about* the
   reactions, no shared vocabulary with the event) will not cluster with its event.
   That's Phase E's job. If LLM clustering (E) proves good and cheap enough, C+D can
   be skipped or demoted to the offline-analysis path — decide after E-minimal ships.

### Phase E — LLM digest (BYO key)

The interpreter. ~100 posts ≈ 10–15k input tokens ≈ a cent per call on a small model;
cost is not the constraint.

1. **BYO Anthropic key** in the config popover: stored in localStorage, sent only to
   Anthropic (CORS direct-browser access), with a plain-language note on cost and
   storage. Model picker (default the cheapest current model). Demo mode stubs it.
2. **Incremental digest state**, not a long conversation: the app holds a compact JSON
   digest — `[{label, one-line summary, exemplar uris, status: heating|cooling}]`.
   Each call sends {previous digest + posts since last call} and returns the updated
   digest. A few hundred tokens of state regardless of session length; passing prior
   labels in is also what keeps labels stable call-to-call (the failure mode to test).
3. The same call assigns posts to conversations — LLM-as-clusterer resolves the deixis
   and pragmatics that sink sentence embedders on cryptic posts (including the
   second-order-discourse case Phase D can't reach).
4. **Render**: a digest panel (the "while you were away" view, ranked by velocity
   score) + conversation labels annotating the graph clusters.
5. **Cadence**: a manual "Summarize" button first; auto-refresh every ~20–30 min later
   (never per-poll). If Phase C/D exist, the embedder gates the LLM: only call when a
   new cluster appears or an old one doubles.
6. Tests: digest-state round-trip with a mocked API; label stability across calls.

### Phase F — Desktop wrap (Tauri) — only if needed

Browser limits for always-on capture: background tabs throttle timers (~1/min; sockets
usually survive), IndexedDB is evictable in principle. **Tauri** wraps the existing
Vite/Svelte app nearly unchanged — SQLite for the archive, tray residence, capture
while "closed" — and the web deployment stays the same codebase with archive features
degrading gracefully. Deliberately last: Phase A's backfill-on-open covers most of the
value, so build this only when capture-while-closed demonstrably matters.

### Ordering

Two valid paths through the graph:

- **Corpus-first** (A → B → C → D → E → F): archive is the foundation; nothing is lost
  starting from day one of the archive existing.
- **Digest-first** (E-minimal → A → …): a "Summarize this feed" button on the *live*
  feed needs no archive at all — key field, one API call, digest panel. Smallest
  possible slice of the payoff, and it road-tests the digest-state design before the
  heavy plumbing.

Recommended: **E-minimal, then A, then choose** between B (capture fidelity) and
full E (continuous digest) by which itch is stronger; C/D only if the LLM-only
clustering proves inadequate or the archive grows past what per-call LLM reading
can cheaply cover (the embedder's real advantage is re-clustering a month of vectors
instantly — an *analysis* feature more than a *triage* one).
