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

/** A per-author roll-up of reactions, for the "who to unfollow" view. */
export interface AuthorTally {
  did: string
  up: number
  down: number
  /** up − down. Negative = a net-disliked account (an unfollow candidate). */
  net: number
  total: number
}

/**
 * Group reactions by author DID and rank them. Sorted **most-negative net
 * first** — the top of the list is the strongest unfollow candidate; the
 * valued accounts are the same list read from the bottom. Ties (equal net) go
 * to the higher-volume author, so a −3 from six thumbs outranks a −3 from
 * three. Pure over a snapshot of rows so it's trivially testable; the author
 * `did` on every row makes this a direct group-by with no post-load join.
 */
export function tallyByAuthor(rows: Iterable<Reaction>): AuthorTally[] {
  const by = new Map<string, AuthorTally>()
  for (const r of rows) {
    const t = by.get(r.did) ?? { did: r.did, up: 0, down: 0, net: 0, total: 0 }
    if (r.reaction === 'up') t.up++
    else t.down++
    t.net = t.up - t.down
    t.total = t.up + t.down
    by.set(r.did, t)
  }
  return [...by.values()].sort((a, b) => a.net - b.net || b.total - a.total)
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

  /** Reactive per-author ranking for the aggregation view (#69). Iterating the
   * SvelteMap subscribes, so this recomputes as reactions change. */
  get byAuthor(): AuthorTally[] {
    return tallyByAuthor(this.byUri.values())
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
