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

  /** For each reply uri (skipping ones already requested), fetch its full
   * ancestor chain and merge the results. */
  async ensure(replyUris: string[]) {
    const fresh = replyUris.filter((u) => !this.#requested.has(u))
    if (!fresh.length) return
    for (const u of fresh) this.#requested.add(u)
    const chains = await Promise.all(fresh.map((u) => fetchAncestors(u)))
    const have = new Set(this.posts.map((p) => p.post.uri))
    const add: FeedItem[] = []
    for (const item of chains.flat()) {
      if (!have.has(item.post.uri)) {
        have.add(item.post.uri)
        add.push(item)
      }
    }
    if (add.length) this.posts = [...this.posts, ...add]
  }

  reset() {
    this.posts = []
    this.#requested.clear()
  }
}

export const ancestors = new Ancestors()
