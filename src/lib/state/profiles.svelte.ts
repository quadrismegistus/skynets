import { SvelteMap } from 'svelte/reactivity'
import { getProfileDetail, type ProfileDetail } from '../api/actors'

/**
 * On-demand cache of fuller author profiles (bio + counts) for the hover
 * preview. Fetched once per did the first time an avatar is hovered; the
 * reactive map lets the open preview fill in when the request lands.
 */
class Profiles {
  #map = new SvelteMap<string, ProfileDetail | null>()
  #inflight = new Set<string>()

  get(did: string): ProfileDetail | undefined {
    const p = this.#map.get(did)
    return p ?? undefined
  }

  /** Fetch this profile once; subsequent calls are no-ops. `null` is cached on
   * failure so we don't hammer a bad did. */
  ensure(did: string) {
    if (!did || this.#map.has(did) || this.#inflight.has(did)) return
    this.#inflight.add(did)
    getProfileDetail(did)
      .then((p) => this.#map.set(did, p ?? null))
      .catch(() => this.#map.set(did, null))
      .finally(() => this.#inflight.delete(did))
  }
}

export const profiles = new Profiles()
