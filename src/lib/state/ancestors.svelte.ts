import { SvelteSet } from 'svelte/reactivity'
import { fetchPosts } from '../api/posts'
import type { FeedItem } from '../api/timeline'

/**
 * Reply parents pulled in on demand so a reply that shows up in the timeline can
 * be connected to the post it's replying to (an edge). Fetched posts are merged
 * into the graph's item pool; requesting climbs the chain toward the root as
 * each fetched parent reveals its own parent.
 */
class Ancestors {
  posts = $state<FeedItem[]>([])
  #requested = new SvelteSet<string>()

  /** Fetch these parent uris (skipping ones already requested), merge results. */
  async ensure(uris: string[]) {
    const fresh = uris.filter((u) => !this.#requested.has(u))
    if (!fresh.length) return
    for (const u of fresh) this.#requested.add(u)
    const fetched = await fetchPosts(fresh)
    if (!fetched.length) return
    const have = new Set(this.posts.map((p) => p.post.uri))
    const add = fetched.filter((f) => !have.has(f.post.uri))
    if (add.length) this.posts = [...this.posts, ...add]
  }

  reset() {
    this.posts = []
    this.#requested.clear()
  }
}

export const ancestors = new Ancestors()
