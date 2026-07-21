import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import type { FeedItem } from '../api/timeline'
import { reposterProfile } from '../api/post'
import { archive, KIND_RANK, type AppearanceKind, type FeedSnapshot, type StoredProfile } from './archive'

/**
 * Rebuild the feed a snapshot captured: post content from `posts`, and — for
 * entries that surfaced as a repost — the reposter attribution grafted back
 * onto a reconstructed `reason` from `profiles` (the feed-level reason isn't
 * stored on the post). Entries whose post is missing (evicted) are skipped, so
 * the restored feed is only ever as complete as the local corpus. Pure, so the
 * reconstruction is testable apart from IndexedDB.
 */
export function reconstructFeedItems(
  snap: FeedSnapshot,
  posts: Map<string, FeedItem>,
  profiles: Map<string, StoredProfile>,
): FeedItem[] {
  const out: FeedItem[] = []
  for (const e of snap.entries) {
    const base = posts.get(e.uri)
    if (!base) continue
    const p = e.reposterDid ? profiles.get(e.reposterDid) : undefined
    if (p) {
      out.push({
        ...base,
        reason: {
          $type: 'app.bsky.feed.defs#reasonRepost',
          by: { did: p.did, handle: p.handle, displayName: p.displayName, avatar: p.avatar },
          indexedAt: new Date(snap.t).toISOString(),
        },
      } as FeedItem)
    } else {
      out.push(base)
    }
  }
  return out
}

/**
 * The reactive in-memory mirror of the local corpus (archive-first, PLAN §8
 * phase 2). ONE funnel every fetched post flows through: it updates a reactive
 * index the graph derives its view from AND writes through to the archive, so
 * the two never drift. Rehydrated from the archive on open, so a reload has the
 * corpus in memory before the network answers.
 *
 * The corpus is the raw SUPERSET — every post ever fetched, with its provenance
 * (timeline / repost / context). The graph's filtering (reposts off, follows-
 * only, unfollowed pruning) is a derivation OVER this, not baked in here: the
 * corpus records what was seen; the view decides what to show.
 */
class Corpus {
  #byUri = new SvelteMap<string, FeedItem>()
  #kind = new SvelteMap<string, AppearanceKind>()
  // URIs that have EVER served as thread/ancestor context. Tracked separately
  // from #kind (strongest provenance) because the two roles are orthogonal: a
  // post can be a hidden repost (filtered out of the feed) yet still be needed
  // as a reply-chain ancestor — it must show as context even though its
  // strongest provenance is primary. #kind decides primary-vs-context ranking;
  // #context decides structural inclusion.
  #context = new SvelteSet<string>()

  /** All corpus posts (reactive). Insertion order = first-seen order. */
  get items(): FeedItem[] {
    return [...this.#byUri.values()]
  }

  /** Posts that have served as thread/ancestor context — what the graph pulls
   * in beyond the primary feed to complete chains. */
  get contextItems(): FeedItem[] {
    const out: FeedItem[] = []
    for (const item of this.#byUri.values()) if (this.#context.has(item.post.uri)) out.push(item)
    return out
  }
  hasContext(uri: string): boolean {
    return this.#context.has(uri)
  }
  /** Count of posts with a context role — a cheap reactive signal (no array
   * build) for effects that must re-arm when context grows. */
  get contextCount(): number {
    return this.#context.size
  }

  /** Strongest provenance recorded for a uri (primary > context), or undefined
   * if unseen. A post is PRIMARY (in your feed) when this isn't 'context'. */
  kindOf(uri: string): AppearanceKind | undefined {
    return this.#kind.get(uri)
  }
  isPrimary(uri: string): boolean {
    const k = this.#kind.get(uri)
    return k !== undefined && k !== 'context'
  }
  has(uri: string): boolean {
    return this.#byUri.has(uri)
  }
  get size(): number {
    return this.#byUri.size
  }

  /** Update the in-memory mirror ONLY (no archive write). For posts already
   * persisted — reload-paint restoring context from disk — so a restore doesn't
   * append a phantom 'surfaced now' appearance to the diachronic record. Returns
   * the posts newly added to the mirror. */
  ingest(items: FeedItem[], forceKind?: AppearanceKind): FeedItem[] {
    const added: FeedItem[] = []
    for (const item of items) if (this.#mergeOne(item, forceKind)) added.push(item)
    return added
  }

  /** Record posts into the mirror AND the archive. `forceKind` overrides the
   * per-item timeline/repost inference — pass 'context' for posts pulled in only
   * to complete a thread or ancestor chain. `feed` names the feed that surfaced
   * them (a generator uri or the `FOLLOWING` sentinel), recorded as per-feed
   * provenance on the archive appearance (PLAN §6.5); omit for context writes.
   * Returns the posts that were newly added to the mirror (not seen before),
   * for callers that want the delta. */
  record(items: FeedItem[], forceKind?: AppearanceKind, feed?: string): FeedItem[] {
    const added = this.ingest(items, forceKind)
    void archive.record(items, forceKind, feed)
    return added
  }

  /** Merge one post; return true if its uri was new to the mirror. */
  #mergeOne(item: FeedItem, forceKind?: AppearanceKind): boolean {
    const uri = item.post.uri
    const kind = forceKind ?? (reposterProfile(item)?.did ? 'repost' : 'timeline')
    if (forceKind === 'context') this.#context.add(uri)
    const prevKind = this.#kind.get(uri)
    if (!prevKind || KIND_RANK[kind] > KIND_RANK[prevKind]) this.#kind.set(uri, kind)
    const existing = this.#byUri.get(uri)
    // Keep the richest copy: one that still carries a repost `reason` (so the
    // reposter attribution survives a later plain sighting), else the first.
    if (!existing) {
      this.#byUri.set(uri, item)
      return true
    }
    if (reposterProfile(item) && !reposterProfile(existing)) this.#byUri.set(uri, item)
    return false
  }

  /** Persist to the archive any mirror posts fetched before the DB opened (the
   * write-through no-ops while closed). Idempotent — the archive upserts and
   * dedups appearances — so re-persisting an already-archived post is harmless.
   * Each post is recorded under every role it holds (primary AND context). */
  async flushToArchive(): Promise<void> {
    const timeline: FeedItem[] = []
    const reposts: FeedItem[] = []
    const context: FeedItem[] = []
    for (const item of this.#byUri.values()) {
      const uri = item.post.uri
      if (this.#kind.get(uri) === 'repost') reposts.push(item)
      else if (this.#kind.get(uri) === 'timeline') timeline.push(item)
      if (this.#context.has(uri)) context.push(item)
    }
    await archive.record(timeline, 'timeline')
    await archive.record(reposts, 'repost')
    await archive.record(context, 'context')
  }

  /** Load the archived corpus into the mirror (call once the DB is open). Posts
   * come back without their feed-level repost reason (not stored); provenance
   * is reconstructed from the appearances log. Live records this session then
   * overlay the richer copies. */
  async rehydrate(): Promise<void> {
    const [posts, provenance] = await Promise.all([archive.getAllPosts(), archive.getProvenance()])
    for (const item of posts) {
      const uri = item.post.uri
      if (!this.#byUri.has(uri)) this.#byUri.set(uri, item)
      const kind = provenance.get(uri) ?? 'context'
      if (kind === 'context') this.#context.add(uri)
      const prevKind = this.#kind.get(uri)
      if (!prevKind || KIND_RANK[kind] > KIND_RANK[prevKind]) this.#kind.set(uri, kind)
    }
  }

  clear(): void {
    this.#byUri.clear()
    this.#kind.clear()
    this.#context.clear()
  }
}

export const corpus = new Corpus()
export { Corpus }
