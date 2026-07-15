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

> **Status — 2026-07-15 (merged to `main`).** The corpus turn is largely built and
> shipped (PRs #13 → #15). Done:
> - **Phase A — Archive** ✅ (A0/A1/A2 all shipped): normalized IndexedDB
>   (`state/archive.ts`: posts/appearances/counts/follows/vectors/digest), engine
>   rehydration across reloads, off-window revive, gap-healing backfill (`state/backfill.ts`),
>   follows-over-time snapshots, archive stats UI + JSON export.
> - **Phase C — Embeddings** ✅ (in-scope parts): `all-minilm` via Ollama (`api/embed.ts`),
>   used as the novelty **gate** and for label-merge similarity. Document construction
>   (parent/quote/alt text) is inlined into the LLM prompt rather than a separate embedding
>   pipeline. transformers.js/WebGPU path NOT built — Ollama covers it locally.
> - **Phase D — Conversation detection** ✅ (via E, not embeddings): conversations come
>   from the LLM (cluster mode) or per-post labels + embedding merge (label mode), rendered
>   as topic pills/captions on the force graph. The standalone C/D clustering path was
>   demoted per the "skip if E is good enough" note — E is good enough.
> - **Phase E — LLM digest** ✅ **and extended**: single-shot + continuous rolling engine
>   (embed → novelty gate → establish/roll/skip), **per-post label mode**, auto-cadence,
>   Ollama model auto-picker (smallest / cluster-capability-floor / MLX-aware) + a separate
>   smaller **label model**. 130 unit + 30 e2e green.
>
> **Deferred (decided 2026-07-15, with data):** **Phase B (Jetstream).** The archive
> **coverage view** (PR #17) let us look at the real feed: capture uptime is near-continuous
> (2 empty hours vs. 101 empty *posted* hours — the app is open most of the time), and the
> diurnal dips are genuine network-quiet (the 06:00 UTC/BST trough = US asleep), NOT capture
> gaps. So Jetstream would have little to "fill." Its marginal value narrows to: **deletes**
> (the one thing backfill can't see) and **inter-poll completeness during the dense hours**
> (posts buried between 60s polls). Revisit only if those specifically matter.
>
> A second, stronger reason to keep **polling** central over Jetstream: **multi-feed support.**
> Jetstream captures posts *by your follows* (a `wantedDids` filter) and cannot reproduce an
> algorithmic/custom feed — Discover, "What's Hot", topical feed-generators are computed
> server-side and are ONLY reachable via `app.bsky.feed.getFeed(uri)` polling. The app is
> already feed-agnostic below the fetch (`getFeed` returns the same `FeedViewPost[]` as
> `getTimeline`), so a **feed picker** (read saved feeds from `getPreferences`, swap
> `getTimeline`→`getFeed`) is a small change with large research value: archive the broader
> cultural stream (Discover / topical feeds), not just your own network. This is a more
> promising direction than Jetstream, and the two are somewhat at odds. See §6.5 below.
>
> **Also open:** **Phase F (Tauri)** — only if capture-while-closed proves it's needed.
> Smaller follow-ups tracked inline: calibrate the label-mode merge-threshold default;
> size-vs-capability floor for the cluster model.

### Phase A — Archive foundation ✅ SHIPPED (PR #13)

Persist every timeline post locally so nothing is lost between sessions.

**Scoping (2026-07-14, after building the digest engine — do it in increments):**
The digest engine (`state/digestEngine.svelte.ts`) already retains every ingested
`FeedItem` and its embedding in memory (`#item`, `#vec`) and never evicts — so a lot of
Phase A's value is really about *persisting that across reloads*, not building it from
scratch. Three increments, smallest first:

- **A0 — off-window reveal (no persistence, ~½ day).** The reported "clicking a digest
  post does nothing when it's scrolled off" is fixable now: expose `engine.getItem(uri)`
  and have `Graph.focusPost` inject that held `FeedItem` as a context node when the uri
  isn't already on the graph. Fixes the click; does not survive reload.
- **A1 — persistent archive + engine rehydration (the real foundation, ~1–2 days).**
  A `posts` KV store (reuse `idb-keyval`, already a dep): `uri → {item, firstSeen, lastSeen}`,
  written on every timeline/poll/thread/ancestor fetch and every engine ingest. Persist
  the engine's cluster state (id/label/status/member-uris) and its vectors
  (`uri → Float32Array`, so no re-embed on load). On startup, rehydrate clusters +
  centroids from the store. `navigator.storage.persist()` to resist eviction. **This is
  what turns Continuous mode from "rolls over the current window" into "rolls over your
  whole feed history" and survives reloads.** A1's simple KV is forward-compatible with
  A2's normalized schema (A2 migrates it).
- **A2 — research corpus (later, multi-day).** Everything below: the normalized
  three-table schema via `idb` proper, gap-healing backfill, count snapshots, deletes
  (needs Phase B), follows-snapshots, export. The diachronic-corpus version.

Recommended: **A0 now** (quick, fixes the bug), **A1 next** (makes the continuous digest
persistent), **A2 when the corpus itself is the goal**. The rest of this section is A2.

1. **Schema — normalized, three tables (this is the load-bearing decision).** A single
   post reaches you many times (reposted by several follows, plus pulled in as thread
   context); storing the whole `FeedViewPost` JSON per encounter duplicates the content
   and, because engagement counts live *inside* that JSON, forces a bad either/or —
   freeze counts at `firstSeen` (no velocity history, stale queries) or overwrite (lose
   the snapshot). So separate the layers, all keyed per user DID:
   - **`posts`** — one row per post URI: the content (record text, embeds, author),
     `firstSeen`/`lastSeen`.
   - **`appearances`** — one row per *event* that surfaced a post: `(uri, kind:
     timeline|repost|context, reposterDid?, seenAt)`. This is the feed-item layer; it
     references `posts`, never re-stores it.
   - **`counts`** *(only if we want velocity history)* — samples `(uri, t, likes,
     reposts, replies)`. Skip this table and you still have a corpus; add it and you can
     watch a post heat up. Decide up front, because it changes the write path.
   Also decide (cheap to defer, but name it now): capture deletions (backfill can't see
   them, Jetstream can) and follows-list snapshots (who you followed *then*).
2. **IndexedDB store** — move from `idb-keyval` to `idb` proper for this database
   (need indexes on `indexedAt`/`firstSeen` for range queries). Request
   `navigator.storage.persist()` to resist eviction.
3. **Write path**: every poll/fetch/backfill upserts `posts` (dedup by URI, bump
   `lastSeen`), appends to `appearances`, and — if the `counts` table exists — samples
   counts. **Archive is its own layer, independent of triage:** a *dismissed* post stays
   in the corpus (it happened), even though it's filtered out of the graph. Dismiss-state
   and archive-state must never be conflated, or the corpus quietly loses everything you
   read.
4. **Gap-healing backfill on startup**: cursor-paginate `getTimeline` backwards until it
   overlaps what's archived. Caveats that make the stop-condition non-trivial: the
   timeline is a *personalized view*, not an append-only log — reposts surface at
   repost-time and the feed reorders, so "N consecutive already-known posts" can converge
   early (leaving a gap) or, on a churny feed, never (paging to the cap every startup).
   Make N and the page-depth cap **tunable**, and log when the cap is hit rather than
   pretending the heal was complete. Also **throttle**: aggressive backward pagination is
   exactly what Bluesky's rate limits punish (429) — backoff between pages, cap pages per
   startup. And document the hard limit: posts deleted while away are unrecoverable, and
   pagination depth is empirically deep but not contractually guaranteed.
5. **Archive UI**: stats in the config popover (posts, span, size on disk); an export
   button (JSON dump) early — it's cheap and makes the corpus portable to
   notebooks/pandas from day one.
6. Tests: upsert dedup, appearance-append, the (tunable) stop condition, gap-heal against
   a mocked paginated timeline, throttle/backoff.

### Phase B — Jetstream capture (backlog item, promoted) ⏸ DEFERRED (see the §6 status banner)

*Deferred: the coverage view showed near-continuous capture uptime and genuine network-quiet
dips, so Jetstream has little to fill; and it can't do multi-feed (Following-only). Kept here
for if deletes / inter-poll density ever justify it.*

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

### Phase C — Embedding layer ✅ SHIPPED (in-scope parts, via Ollama)

Client-side vectors as the always-on cheap signal. *Built as `all-minilm` through Ollama
(`api/embed.ts`) — the novelty gate + label-merge similarity. The transformers.js/WebGPU
in-browser path below was NOT built (Ollama covers local); revisit only if we want
embeddings without an Ollama dependency.*

1. **transformers.js** with a small model (bge-small or MiniLM class, ~25MB quantized),
   WebGPU with WASM fallback, lazy-loaded behind a setting (off by default — 25MB is
   rude to load unannounced).
2. **Document construction is the whole game** for short cryptic posts: embed post text
   *concatenated with* parent/root text, quoted-post text, link-card title/description,
   and image alt text. A reply inherits its conversation's topic; a "this." embeds as
   what it points at.
3. Embed incrementally on arrival; cache vectors in IndexedDB keyed by uri (384-dim
   float32 ≈ 1.5KB/post — 50k posts ≈ 75MB on disk). Never re-embed. Vectors live in
   IndexedDB and load **by time-window** for clustering — don't hold the whole 75MB
   resident; a day or a week of vectors at a time is what any live view needs.
4. Similarity utilities: cosine, top-k neighbors over a time window.

### Phase D — Conversation detection ✅ SHIPPED (via E, not standalone clustering)

"There are a few conversations in play today" made computable: a conversation is a
**semantic cluster × a time burst**. *Delivered through the LLM (E), not the embedding
clustering below: cluster mode (one LLM pass) or label mode (per-post label → embedding
merge). The standalone agglomerative/kNN path was demoted per §D.4's "skip if E is good
enough" — it is. The burst/time-decay dimension is approximated by the recency×engagement
axes + the rolling engine's novelty gate.*

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

### Phase E — LLM digest ✅ SHIPPED + EXTENDED (PRs #13, #15)

The interpreter. **Target: all-local, so it can run continuously for $0** (Ollama).
The BYO-cloud path below still works and is the best *quality* if a user opts in, but
local-first is the design goal. See **§7** for the full model/prompt/rolling investigation
that settled how to make the local path reliable — read it before building here.

~100 posts ≈ 10–15k input tokens ≈ a cent per call on a cloud model; on local it's free
but latency-bound (prefill dominates), which is what makes the rolling + gating in §7 matter.

1. **BYO Anthropic key** in the config popover. The browser calls Anthropic directly,
   which needs the `anthropic-dangerous-direct-browser-access: true` header — and the
   header is named "dangerous" for a real reason that bites *this* app specifically:
   Skynets renders rich user content (facets, quote-embeds, external link cards, images),
   which is a live XSS surface, and a key in `localStorage` is exfiltratable through any
   injection. Mitigations, in order of paranoia: keep the key in session memory only
   (re-enter per session), or `sessionStorage` (narrower than `localStorage`), or — the
   only real fix — a tiny proxy that holds the key server-side and never ships it to the
   page (the one place a backend earns its keep; see Phase F, whose SQLite/native store
   can hold the key out of the DOM entirely). Whatever we pick, say it plainly in the UI:
   what's stored, where, and the exposure. Model picker (default the cheapest current
   model). Demo mode stubs it.
2. **Incremental digest state**, not a long conversation: the app holds a compact JSON
   digest — `[{label, one-line summary, exemplar uris, status: heating|cooling}]`.
   Each call sends {previous digest + posts since last call} and returns the updated
   digest. A few hundred tokens of state regardless of session length; passing prior
   labels in is also what keeps labels stable call-to-call (the failure mode to test).
   **Validate every URI the model returns against the input set and drop any that
   weren't there** — models fabricate plausible-looking IDs, and an exemplar link that
   404s is worse than none. Referential integrity is not optional here.
3. The same call assigns posts to conversations — LLM-as-clusterer resolves the deixis
   and pragmatics that sink sentence embedders on cryptic posts (including the
   second-order-discourse case Phase D can't reach).
4. **Render**: a digest panel (the "while you were away" view, ranked by velocity
   score) + conversation labels annotating the graph clusters.
5. **Cadence**: a manual "Summarize" button first; auto-refresh every ~20–30 min later
   (never per-poll). If Phase C/D exist, the embedder gates the LLM: only call when a
   new cluster appears or an old one doubles.
6. Tests: digest-state round-trip with a mocked API; label stability across calls;
   URI-integrity (fabricated exemplar URIs are dropped).

### Phase F — Desktop wrap (Tauri) — only if needed ⏳ DEFERRED (do B first)

Browser limits for always-on capture: background tabs throttle timers (~1/min; sockets
usually survive), IndexedDB is evictable in principle. **Tauri** wraps the existing
Vite/Svelte app nearly unchanged — SQLite for the archive, tray residence, capture
while "closed" — and the web deployment stays the same codebase with archive features
degrading gracefully. Deliberately last: Phase A's backfill-on-open covers most of the
value, so build this only when capture-while-closed demonstrably matters.

### 6.5 Multi-feed capture (candidate — a better next step than B) 🔎 IDEA

Right now the app reads only "Following" (`getTimeline`). But **every other feed** — Discover,
"What's Hot", and the thousands of custom feed-generators — is fetched with
`app.bsky.feed.getFeed({ feed: <at-uri> })`, which returns the **same `FeedViewPost[]`** shape.
The whole app (graph, archive, digest, coverage) is already feed-agnostic below the fetch, so
this is a small, high-leverage change:

1. **Feed picker.** Read the user's saved/pinned feeds from `app.bsky.actor.getPreferences`
   (savedFeeds), list them, and let the graph source swap `getTimeline` → `getFeed(uri)`.
   "Following" stays the default (it's its own endpoint).
2. **Archive per feed.** Posts go in the same `posts` store (dedup by uri); note *which feed*
   surfaced a post in `appearances` (extend `kind` beyond timeline/repost/context to include a
   feed id). A post can appear via several feeds — that's signal, not duplication.
3. **Digest/coverage per feed or merged.** Probably a per-feed scope with a merged option.

**Why this beats Jetstream (Phase B):** Jetstream is Following-only (a `wantedDids` filter over
your follows) and *cannot* reproduce an algorithmic feed — Discover is computed server-side.
So polling `getFeed` is the ONLY route to non-Following feeds; the general archive path is
polling, not the firehose. **Research value:** archiving Discover / topical feeds captures the
broader cultural stream beyond your own network — for discourse/aesthetics work, potentially
much richer than the Following graph alone. Open questions: feed-generator rate limits and
pagination depth (same caveats as timeline backfill); whether the *graph* view is meaningful
for a fast-churning algorithmic feed (Discover has weaker thread structure than Following).

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

---

## 7. Investigation log: the all-local continuous digest (2026-07-14)

A long empirical session (on a real 100-post home feed, cached to a fixed set so runs
were comparable) to answer: **can the digest run all-local, continuously, for $0, and
stay cheap by updating incrementally?** Findings below are load-bearing — several
contradict earlier guesses in Phases C–E, and each cost real benchmark time, so don't
re-litigate them without new evidence.

### What shipped (MERGED to `main` — PRs #13, #14, #15)

E-minimal grew into the full pipeline. On `main` now:
- Digest panel (conversations list + graph topic **pills** for 2+-post topics, **captions**
  under one-off posts), Ollama **and** Anthropic providers, raw-token streaming + elapsed
  timer, tolerant JSON extraction, persisted window (default 70), `num_ctx` scaled to prompt.
- **Continuous rolling engine** (embed → novelty gate → establish/roll/skip+buffer →
  dedup-merge) with auto-cadence; **single-shot** mode too.
- **Per-post label mode**: label each OP with a tiny model, group by embedding cosine
  (tunable merge slider), replies anchored to their thread OP, parent/quote text inlined.
- **Ollama model auto-picker** (`api/ollama.ts`): lists installed models, auto-picks the
  smallest for labeling and the smallest ≥3GB for clustering, MLX-aware (preferred on Mac,
  excluded off), independently pinnable; a separate smaller **label model**.
- **Phase A archive** (persist/rehydrate/backfill) underneath it all.
- **130 unit + 30 e2e** green. `qwen3.5:4b-mlx` was the original local default; selection is
  now automatic from installed models. Reviewed twice adversarially; findings fixed.

### Model selection (local)

> **Addendum (2026-07-15): cluster model vs label model are different jobs.** The findings
> below are for **cluster mode** (one-shot JSON over the whole feed) — `4b-mlx` is the pick
> there, and `2b`/`1b` are rejected for exactly the instability seen. But **label mode**
> (one tiny prompt → a 2–4 word topic per post, grouping done by embeddings) is a far easier
> task, and a **sub-1B model** (`qwen3.5:0.8b-mlx`) is viable for it — low footprint, and
> quality is "good enough" once replies carry their parent context. Two real caveats at that
> size, both observed: (a) it **parrots concrete examples** put in the system prompt (had to
> strip an example that it copied verbatim onto unrelated posts) → keep label prompts
> example-free; (b) **inconsistent capitalization** (normalized in `cleanLabel`). The picker
> now defaults label mode to the smallest installed and clustering to the smallest ≥3GB, both
> overridable. Bottom line: **pick model size per task difficulty**, not one size for both.

- **`qwen3.5:4b-mlx` is the pick.** ~31 tok/s on Apple Silicon, ~13–28s for a full
  100-post digest, and it resolves real subtweets (an ICE-killing thread discussed via
  posts that never say "ICE"). Benchmarked head-to-head:
  - **9b-mlx**: richer clustering, reliable, but ~2× slower (17 tok/s) — and on wall-clock
    its rolling barely beats its own full digest, so the extra size doesn't pay off.
  - **2b-mlx**: unstable — two identical-input runs gave a 79-post mega-cluster vs 6
    scattered ones; also emitted schema-invalid JSON. Rejected.
  - **phi3.5 (3.8B GGUF)**: over-clusters (13 conversations, ignored the 2–6 cap), slow
    (66s full), *worse* rolling consistency (Rand 0.57). Rejected despite summary tuning.
  - **llama3.2:1b**: collapses everything into one bogus cluster. Floor confirmation only.
- **MLX ≥ GGUF on Apple Silicon for speed** — MLX is the native path, not a handicap. An
  earlier guess that GGUF would be faster was wrong.

### The MLX soft-schema gotcha (this caused most of the pain)

Ollama's `format` JSON-schema is a **hard grammar only on the llama.cpp/GGUF engine**. On
the **MLX engine it is soft** — the model *usually* follows it but can emit: ```json
fences, a bare `[…]` array without the wrapper object, a missing required field (`posts`
instead of `postIds`), a repetition loop, or — worst — **plain prose instead of JSON**.
Consequences and fixes:

- **The app parser must be tolerant** (shipped a balance-scanner; should upgrade to a JS
  `jsonrepair` lib + schema-validate, mirroring `largeliterarymodels/llm.py`).
  `json_repair` fixes malformed *JSON* but **cannot** rescue prose output.
- **KEEP THE SCHEMA LEAN — this is the single biggest local-reliability lever.** Measured
  on `4b-mlx` over three feed slices, 5 seeds each: a 5-required-field schema
  (`id,label,summary,status,postIds`) produced valid JSON **0/5 every time**; a 2-field
  schema (`label,postIds`) produced valid JSON **5/5 every time**. MLX's soft grammar chokes
  on heavy schemas and drops to prose. So **ask the local model for only what only it can
  do — group posts into `{label, postIds}` — and derive the rest client-side** (status from
  members' engagement velocity, id from a slug, summary via an optional cheap second pass or
  skip it). This mostly obviates retry; keep retry-until-valid as a cheap backstop anyway.
- A strict parser that silently returns empty **undercounts the model** — it reads as
  "model produced nothing" when the model produced a lot in the wrong shape. This
  contaminated an earlier "4b is unstable" conclusion.

### Two settings that are non-negotiable on local

- **`think: false`** — qwen3/deepseek thinking models spend *minutes* reasoning before the
  JSON for zero quality gain on this task (a >3min call drops to ~15s). Non-thinking models
  ignore the flag. Verified `message.thinking` is absent when off.
- **`num_ctx` scaled to the prompt** — Ollama's 2048 default (and even a fixed 8192)
  silently truncates a large feed from the left, dropping the oldest posts.

### The rolling digest: dead ends, then it works

Idea: instead of re-reading all posts each update, send a compact picture of existing
conversations (label + summary + a few exemplars) plus only the *new* posts, and ask
"continue an existing conversation or start a new one?" Prefill ≈ halves (2.5k vs 5.4k
tokens on 100 posts).

What we learned, in order:
1. **Assignments-only output (one entry per post) backfired** — verbose output ate the
   prefill savings. The compact *cluster-delta* form (one entry per changed/new cluster
   with a postId array) is the efficient one.
2. **Prompt framing controls granularity entirely.** Conservative language
   ("ignore one-offs, prefer existing, only genuinely new") → lazy under-clustering
   (misdiagnosed as a model limit). Encouraging + no cap → over-clustering (15 convs, many
   singletons). **The winning prompt applies the full-digest discipline to the rolling
   task: "2–6 conversations, merge related, ≥2 posts each, prefer extending an existing
   one."**
3. **Continuation is NOT the hard part** — the whole earlier "local can't continue"
   conclusion was wrong. Given a *clean* establish, `4b-mlx` continues 2–3 clusters
   consistently (4–11s) and `9b-mlx` continues 4–5. The "0 continuations" seen repeatedly
   was an artifact of the **establish step failing upstream** (prose/empty output), leaving
   no clusters to continue into — not a continuation failure.
4. **So the one real local defect is establish-step format reliability**, fixed by
   retry-until-valid (+ `json_repair`). Everything else works locally.
5. **Cloud (Haiku) is flawless** at all of this (reliable, 7.8s full / 2.5s rolling, Rand
   0.99) — useful as an oracle/comparison, but not the $0 target.

### Embeddings: a coarse gate, NOT a per-post continuer

Tested `all-minilm` (the MiniLM-L6 the app would run) and `mxbai-embed-large` against a
fixed LLM ground truth:
- **Assigning a known continuation to the right existing cluster: all-minilm ~82%** — the
  cheap model does this well. (mxbai *worse*, 64% — its compressed 0.45–0.67 cosine range
  hurts discrimination. Use all-minilm.)
- **But the continue-vs-novel *gate* has overlapping distributions** (true-continue sim
  0.19–0.81, novel 0.07–0.68; best F1 only 0.67). A post that continues a cluster via
  subtweet/multilingual reference embeds *far* from it; a novel post can embed near. So
  **embeddings cannot silently auto-assign per post** — the subtweet problem the LLM was
  chosen for is exactly where the embedder fails.
- **The aggregate signal is strong though** (continue mean 0.40 vs novel 0.20). Enough for
  the **coarse change-gate**: embed new posts cheaply as they arrive; only fire an LLM
  (re-)digest when enough of them sit far from every existing centroid. That's the high-
  value use — skip whole LLM runs when nothing changed — and it's robust to per-post noise.

### The corrected all-local architecture

**Validated end-to-end 2026-07-14** (`scratchpad/loop.py`): lean-schema establish on 40
posts → 3 rolling batches of 20 → a coherent 6-cluster digest, 43/100 placed, ~20s total,
all-local, $0. Establish reliable with the lean schema; rolling continues + spawns cleanly
at ~5s/step; exact-label matching kept continuations clean enough the dedup never fired.
The coarse gate's *skip* case is now **validated too** (`scratchpad/gate_skip.py`): with
`all-minilm` centroids, a batch of re-shown/established posts scores 0–2/12 "novel"
(mean-sim ~0.48) and a genuinely-new batch scores 9/12 (mean-sim ~0.29). Decision rule:
**skip the LLM roll when the novel-fraction is below ~0.4** (equivalently mean centroid-sim
above ~0.4). Per-post routing stays too noisy to use, but the batch-aggregate signal is
clean. So every piece of the loop — establish, roll, gate-skip, gate-roll — is proven.

1. **Establish / full re-digest** (occasional): `qwen3.5:4b-mlx`, **lean schema
   (`{label, postIds}`)** + retry-until-valid backstop (parse + `jsonrepair` + validate).
   Derive status/summary/id client-side. Produces the cluster set.
2. **Rolling continuation** (frequent): `qwen3.5:4b-mlx`, balanced prompt (full-digest
   discipline), compact cluster-delta output. Extends clusters + spawns new ones. Proven
   to work; ~50% cheaper prefill; 4–11s.
3. **Coarse embedder gate** (`all-minilm`, always-on, cheap): decide *when* to roll vs sit
   still, and when a full re-establish is warranted (drift / enough novelty).
4. **Periodic full re-establish** to reset drift (rolling never reconsiders old posts).

This mirrors the user's own `largeliterarymodels`: `SequentialTask`
(`build_state → format_context → format_passages → update_state → aggregate`, chunked
feedforward state, `prompt_version` cache-busting) *is* this rolling pattern, and
`llm.py`'s strip-fence → parse → bracket-match → `json_repair` → pydantic-validate is the
reliability layer the establish step needs. Port both patterns to TS.

### Methodology notes (so the next session doesn't repeat mistakes)

- **Cache a FIXED input set.** The live `getTimeline` drifts between fetches; every
  "single run" earlier used different posts, confounding all consistency claims. Fixed
  cache (`scratchpad/feed100.json`, no credentials) made results comparable.
- **Tolerant parsing before measuring** — a strict parser reports model failures that are
  really parser failures.
- **Repeat runs at fixed input** — single runs flipped conclusions twice; Rand-index over
  ≥3 identical-input runs is the real consistency signal (and watch coverage, not just
  Rand — empty runs trivially "agree").
