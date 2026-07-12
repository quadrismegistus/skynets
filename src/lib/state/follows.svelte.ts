import { SvelteMap } from 'svelte/reactivity'
import { followUser, unfollowUser } from '../api/interactions'

interface FollowState {
  following: boolean
  followUri?: string
}

interface Author {
  did: string
  viewer?: { following?: string }
}

/**
 * Optimistic follow state, overlaid by DID. Falls back to the author's own
 * `viewer.following` (a follow-record uri if you already follow them) until you
 * interact. Since the timeline is your *following* feed you'll already follow
 * most authors; this matters for reposts and pulled-in reply parents.
 */
class Follows {
  #map = new SvelteMap<string, FollowState>()

  following(author: Author): boolean {
    return this.#map.get(author.did)?.following ?? !!author.viewer?.following
  }

  async toggle(author: Author) {
    const did = author.did
    const cur = this.#map.get(did) ?? {
      following: !!author.viewer?.following,
      followUri: author.viewer?.following,
    }
    if (cur.following) {
      const del = cur.followUri
      this.#map.set(did, { following: false, followUri: undefined })
      if (del) await unfollowUser(del).catch(() => this.#map.set(did, cur))
    } else {
      this.#map.set(did, { following: true, followUri: cur.followUri })
      try {
        const res = await followUser(did)
        this.#map.set(did, { following: true, followUri: res.uri })
      } catch {
        this.#map.set(did, cur)
      }
    }
  }
}

export const follows = new Follows()
