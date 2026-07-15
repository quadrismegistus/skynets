import { SvelteMap } from 'svelte/reactivity'
import { getProfileDetail, type ProfileDetail } from '../api/actors'

/**
 * On-demand cache of fuller author profiles (bio + counts) for the hover
 * preview. Fetched once per did the first time an avatar is hovered; the
 * reactive map lets the open preview fill in when the request lands.
 *
 * A FAILED fetch is not cached as a permanent miss — that used to poison a did
 * forever after a single transient 429/blip (stuck "Loading…"). Instead we
 * record the failure time and allow a retry after a short cooldown.
 */
const RETRY_MS = 15_000
const MAX = 500

class Profiles {
  #map = new SvelteMap<string, ProfileDetail>()
  #inflight = new Set<string>()
  #failedAt = new Map<string, number>()

  get(did: string): ProfileDetail | undefined {
    return this.#map.get(did)
  }

  /** Fetch this profile once; concurrent/repeat calls are no-ops while in flight
   * or cached. A failure is retried after RETRY_MS rather than cached forever. */
  ensure(did: string) {
    if (!did || this.#map.has(did) || this.#inflight.has(did)) return
    const failed = this.#failedAt.get(did)
    if (failed && Date.now() - failed < RETRY_MS) return
    this.#inflight.add(did)
    getProfileDetail(did)
      .then((p) => {
        if (p) {
          this.#map.set(did, p)
          this.#failedAt.delete(did)
          this.#cap()
        } else {
          this.#failedAt.set(did, Date.now())
        }
      })
      .catch(() => this.#failedAt.set(did, Date.now()))
      .finally(() => this.#inflight.delete(did))
  }

  /** Keep the cache bounded over a long session — evict oldest (insertion order). */
  #cap() {
    for (const k of this.#map.keys()) {
      if (this.#map.size <= MAX) break
      this.#map.delete(k)
    }
  }
}

export const profiles = new Profiles()
