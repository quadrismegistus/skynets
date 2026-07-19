# Recurring issue: unfollowed nodes appearing "alone" + Map-replies scatter

Status: **root causes identified and fixed** (PR #12, 2026-07-13). The hypotheses
below (§"Why it likely still recurs") were written before the diagnosis; the actual
causes turned out to be code-review findable, not data gaps:

1. **`selectVisible` ranked pulled-in context alongside real posts.** A fetched
   reply-parent (usually a *loud* post — that's why someone replied to it) won a
   "top" slot on its own merits while the quiet followed reply that justified its
   presence didn't. Edges only draw between visible nodes → the unfollowed parent
   rendered alone and dashed. PR #10's orphan-drop worked at the group level inside
   `buildGraph`, but `selectVisible` dismembered the group downstream.
   **Fix:** nodes carry `primary`; only primary nodes compete for the window.
   Context appears solely via expansion or the connect-replies ancestor chain.
2. **The `MAX_THREAD_REPLIES` cap sliced by loudness, ignoring tree structure.**
   `others.sort(byScore).slice(0, 10)` kept the loudest replies wherever they sat;
   the quiet *bridge* replies connecting them to the root were cut, so survivors
   had no parent present → no edges → disconnected clumps placed by their own
   recency/engagement ranks (recent + quiet = bottom-right, far from the root).
   That is the "Map replies → scattered people elsewhere" symptom exactly.
   **Fix:** the cap now picks a *connected subtree* — each loud reply brings its
   not-yet-shown ancestors along within the budget.
3. **`threads.posts` counted as primary**, defeating orphan-drop for fetched
   threads. **Fix:** thread posts are context; expanded groups are kept regardless
   of primary so mapping a thread never makes it vanish.
4. (Polish) New sim nodes seeded at their semantic target, so mapped replies
   materialized across the canvas. **Fix:** a new node linked (via the reply
   chain) to an already-placed node seeds beside it and eases to its target.

Post-fix screenshots (2026-07-13, dev server) surfaced a second round, same PR:

5. **A collapsed conversation wore a stranger's face.** The representative of a
   collapsed group was the conversation's *top* post — when a followee replied
   deep in a stranger's thread (ancestors pulled in by Connect), the lone node
   displayed was the unfollowed root author, with the followee hidden in the
   "+N". **Fix:** the collapsed display rep is the earliest *primary* member.
6. **Map replies fetched the whole root thread** (`rootUriOf` + descendants),
   so "Map replies (1)" could unspool dozens of strangers from unrelated
   branches. **Fix:** fetch is scoped to the clicked post — its replies plus
   its ancestor chain (`parentHeight: 20`, `flattenThread` now climbs parents),
   no sibling branches; and the expanded-cap selection always seeds the clicked
   post + its path.
7. **Provenance labeling:** cards now say why a non-timeline post is present
   ("from a mapped thread" / "context — a post upstream of your timeline"), so
   an unfamiliar face is explainable in place.

Round three (the horse/Doctorow case) delivered the FINAL root cause, via the
click-to-copy raw JSON instrument + the official bsky.app feed:

**A followee (Stuart Semmel) had reposted posts of Doctorow's thread — the
feed item was legitimate and attributed. But the Reposts toggle filtered the
attributed copy out in `visible`, downstream of where `primaryUris` and
`timelineUris` were built (from raw `items`). The hidden repost leaked its uri
into the primary set; the bare `{post}` context copy fetched by
Connect/Map-replies (no `reason`, no `viewer.following`) then displayed as a
primary "in your timeline" post by an unfollowed stranger, with no repost
attribution — the recurring "unfollowed node, unexplained" in its final form.**

Fix: `feedItems` is the single filtered source of truth (Reposts + Follows-only
toggles apply there); primary status, provenance, and ancestor-fetching all
derive from it. With Reposts off, repost-only authors now vanish entirely;
with Reposts on, they show attributed (mini reposter avatar + card line).

Along the way (all real, all shipped): unfollow asks for confirmation; dashed
authors get authoritative `getProfiles` verification; every card carries a
click-to-copy provenance line; and a "Follows only" toggle gates the feed.

The original write-up follows for the record.

---

Original status: **still recurring** as of 2026-07-13 after PRs #9–#11. This doc captures the
symptom, what's already been fixed, remaining hypotheses, and next steps so work can
resume after a context compaction.

## Symptoms (reported by user, with screenshots)

1. An **unfollowed** person (e.g. Charles Logan, a quote-post author) appears as a
   **standalone dashed node** with no obvious reason for being there.
2. His card shows **"Map replies (1)"** (one direct reply).
3. Clicking **Map replies** makes **a bunch of people appear, disconnected from the
   original node, positioned elsewhere** in the graph — and often the **same author
   repeated** as several nodes (e.g. one person's avatar 3–4×) linked by arrows.

## What's already been done (merged + deployed)

- **PR #9** — group conversations by reply **connectivity** (union-find over
  `reply.parent` links) instead of `reply.root.uri`, because Bluesky thread data often
  has inconsistent root refs that fragmented one conversation into several "+N" nodes.
- **PR #10** — repost attribution avatar (reposter behind-left); **orphan-drop**:
  `buildGraph` drops any conversation group with no *primary* post (feed/own/mapped), so
  a pulled-in reply-parent never floats without an attached in-feed post.
- **PR #11** — **stable expand key**: expansion was keyed on the union-find group key,
  which *shifts* once fetched replies merge the group, so `expanded.has(rootUri)` went
  false and mapped threads stopped being recognized as expanded → scatter. Now keyed by
  **membership** (`node.expanded`, true if any member post uri was clicked). Also bumped
  the strict-mode link force (0.05→0.18) so mapped threads cohere near their source.

## Why it likely still recurs — hypotheses to check next

1. **Connectivity gaps in the fetched thread.** `fetchThread` = `getPostThread(root,
   depth:6, parentHeight:0)` → `flattenThread` **skips NotFound/Blocked nodes**. A gap in
   the middle of the reply tree means descendants reference a parent that isn't in our
   set, so union-find can't link them to the clicked node → they form **separate groups**
   → scattered, disconnected, and (if a sub-run ≥3) each collapses to its own "+N".
   - `src/lib/api/thread.ts` (flattenThread), `src/lib/state/graph.ts` (union-find).
2. **`parentHeight: 0`** means we fetch the clicked post + *descendants* only, not
   ancestors. If the clicked post is deep in a thread, the true root/ancestors aren't
   fetched, so the group's top is the clicked post — usually fine, but interacts with (1).
3. **Depth 6 cutoff** can truncate long threads (loses deep nodes; shouldn't disconnect).
4. **Positioning** — even when connected, strict-mode semantic axes still spread thread
   members. Link force was bumped but may need per-mapped-thread cohesion or positional
   anchoring near the clicked node.
5. **False "unfollowed" marks** — `unfollowed` relies on `author.viewer.following` being
   present in the timeline response. If `getTimeline` omits `viewer.following` for some
   authors, they render dashed even if you follow them. **Not yet verified against live
   data.** (`Graph.svelte` passes `unfollowed`; `follows.following` reads `viewer`.)

## Suggested next steps

- **Instrument** `fetchThread`: log the returned post uris + each post's
  `reply.parent.uri`/`reply.root.uri`, and how many NotFound/Blocked nodes were skipped,
  for the Charles post — confirm whether gaps are breaking connectivity.
- If gaps confirmed: **fallback-union fetched thread posts by `reply.root.uri`** (union
  every post sharing a root) so a gap can't fragment a fetched conversation, even though
  root refs are unreliable for the *primary* grouping.
- Consider `parentHeight: 10` and higher `depth` so the whole conversation is fetched.
- Consider **positionally anchoring** mapped-thread members near the clicked node (e.g.
  seed their sim positions around the anchor) rather than relying on link force alone.
- **Verify `viewer.following`** presence in a real `getTimeline` response; if unreliable,
  fetch follow-state via `getProfiles` for visible authors (batch, cached) like the
  earlier follower-weighting plan.

## Key files
- `src/lib/state/graph.ts` — grouping (union-find), collapse, orphan-drop, `expanded`.
- `src/lib/api/thread.ts` — `fetchThread` / `flattenThread`.
- `src/lib/state/ancestors.svelte.ts` — connect-replies parent fetching.
- `src/lib/components/Graph.svelte` — `toggleMapReplies`, `repliesMapped`, `unfollowed`,
  primary/allItems ordering.
- `src/lib/state/layout.ts` — the deterministic solver (was `forceLayout.ts`; the link
  force discussed above no longer exists — mapped-thread members are tidy-tree-grouped,
  and a pinned member anchors its conversation).
- `src/lib/state/follows.svelte.ts` — follow state (viewer.following fallback).
