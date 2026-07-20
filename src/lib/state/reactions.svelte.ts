import { del, get, set } from 'idb-keyval'
import { SvelteMap } from 'svelte/reactivity'

export type ReactionKind = 'up' | 'down'

/** One private judgment on a post. The author `did` is stored ALONGSIDE the
 * post uri so a later "posters you like/dislike most" view is a direct
 * group-by — no post-load join to recover who wrote it once the post itself
 * has aged out of the loaded set. `t` (epoch ms) keeps them orderable. */
export interface Reaction {
  uri: string
  did: string
  reaction: ReactionKind
  t: number
}

/**
 * Locally-persisted private thumbs-up / thumbs-down. Unlike a Bluesky like, a
 * reaction is NEVER sent to the network — it lives on-device in IndexedDB
 * purely as a personal signal, so a future view can rank posters by net
 * reaction and surface unfollow candidates. It "does not leave the archive."
 *
 * Mirrors the shape of the `read`/dismiss store (idb-keyval + a reactive
 * collection) but keeps rich rows instead of a bare set. Keyed per-user DID so
 * one account's judgments never leak into another's. The `SvelteMap` is deeply
 * reactive, so a node's reaction affordance recomputes on press.
 */
class Reactions {
  byUri = new SvelteMap<string, Reaction>()
  #did: string | undefined

  #key(did: string) {
    return `skynets:reactions:${did}` // skynets prefix matches the other local stores — do not change
  }

  /** Load this user's reactions. Call on login. */
  async load(did: string) {
    this.#did = did
    const stored = (await get<Reaction[]>(this.#key(did))) ?? []
    this.byUri.clear()
    for (const r of stored) this.byUri.set(r.uri, r)
  }

  /** Reactive lookup for a node/card affordance. */
  reactionOf(uri: string): ReactionKind | undefined {
    return this.byUri.get(uri)?.reaction
  }

  /**
   * Apply a reaction to a post by its author. Pressing the same reaction again
   * clears it (toggle off); pressing the opposite flips it. Returns the
   * resulting reaction, or undefined once cleared.
   */
  async react(uri: string, did: string, reaction: ReactionKind): Promise<ReactionKind | undefined> {
    if (!this.#did) return undefined
    const cur = this.byUri.get(uri)
    if (cur?.reaction === reaction) {
      this.byUri.delete(uri)
    } else {
      this.byUri.set(uri, { uri, did, reaction, t: Date.now() })
    }
    await this.#persist()
    return this.byUri.get(uri)?.reaction
  }

  /** Drop in-memory state on logout (does not delete what's persisted). */
  reset() {
    this.#did = undefined
    this.byUri.clear()
  }

  /** Delete this user's persisted reactions AND clear memory — for the local-
   * data wipe, which promises "everything this device stored is gone." Unlike
   * reset() (logout, memory-only), this actually removes the on-disk key. Runs
   * before reset() nulls #did, so the key is still resolvable. */
  async purge() {
    if (this.#did) await del(this.#key(this.#did))
    this.reset()
  }

  async #persist() {
    if (!this.#did) return
    await set(this.#key(this.#did), [...this.byUri.values()])
  }
}

export const reactions = new Reactions()
export { Reactions }
