import { SvelteSet } from 'svelte/reactivity'
import { fetchAncestors } from '../api/thread'
import type { FeedItem } from '../api/timeline'

/**
 * Reply parents pulled in on demand so a reply that shows up in the timeline can
 * be connected to the post it's replying to. Given a reply's uri, we fetch its
 * WHOLE ancestor chain to the root in one getPostThread call — so a deep chain
 * appears at once rather than climbing a level per poll.
 */
class Ancestors {
  posts = $state<FeedItem[]>([])
  #requested = new SvelteSet<string>()
  /** Reply uris whose chain fetch has COMPLETED (resolved or rejected). The
   * admissibility gate holds a conversation whose ancestry is still missing
   * ONLY until its fetch settles here — a deleted/blocked parent never arrives,
   * so a settled-but-still-missing reply is admitted rather than held forever. */
  #settled = new SvelteSet<string>()
  /** Reply uri → its in-flight getPostThread promise. Lets overlapping ensure()s
   * — or a uri repeated within one batch — share ONE request instead of firing
   * duplicate calls for the same chain. Each entry is dropped as its fetch
   * settles, so an error is never cached: a later ensure() can try again. */
  #inflight = new Map<string, Promise<FeedItem[]>>()

  /** Reactive view of which replies' ancestry fetches have finished. */
  get settledUris(): ReadonlySet<string> {
    return this.#settled
  }

  /** For each reply uri (skipping ones already requested), fetch its full
   * ancestor chain and merge the results. */
  async ensure(replyUris: string[]) {
    const fresh = replyUris.filter((u) => !this.#requested.has(u))
    if (!fresh.length) return
    for (const u of fresh) this.#requested.add(u)
    try {
      const chains = await Promise.all(fresh.map((u) => this.#fetch(u)))
      const have = new Set(this.posts.map((p) => p.post.uri))
      const add: FeedItem[] = []
      for (const item of chains.flat()) {
        if (!have.has(item.post.uri)) {
          have.add(item.post.uri)
          add.push(item)
        }
      }
      if (add.length) this.posts = [...this.posts, ...add]
    } finally {
      // Settled either way: a failed fetch must still release the gate.
      for (const u of fresh) this.#settled.add(u)
    }
  }

  /** Fetch a reply's ancestor chain, coalescing onto the in-flight promise if
   * one is already outstanding for this uri so overlapping/repeated requests
   * don't issue duplicate getPostThread calls. Dropped from #inflight once it
   * settles, so nothing (least of all an error) is cached beyond the request.
   *
   * Catch is PER fetch, not over the whole batch. A reply's parent that's been
   * deleted/blocked makes getPostThread 400 ("Post not found") — routine as a
   * feed ages. A bare Promise.all rejected on the first such 400, which threw
   * away every GOOD chain in the batch AND surfaced as an uncaught rejection in
   * the effect that called ensure(). One bad ancestor now yields [] and the rest
   * still merge; #requested keeps us from re-requesting the dead one. */
  #fetch(uri: string): Promise<FeedItem[]> {
    const existing = this.#inflight.get(uri)
    if (existing) return existing
    const chain = fetchAncestors(uri)
      .catch(() => [] as FeedItem[])
      .finally(() => this.#inflight.delete(uri))
    this.#inflight.set(uri, chain)
    return chain
  }

  reset() {
    this.posts = []
    this.#requested.clear()
    this.#settled.clear()
    this.#inflight.clear()
  }
}

export const ancestors = new Ancestors()
