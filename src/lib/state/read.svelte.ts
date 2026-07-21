import { del, get, set } from 'idb-keyval'
import { SvelteMap } from 'svelte/reactivity'

/**
 * Locally-persisted map of dismissed ("read") post URIs → the epoch-ms moment
 * each was dismissed. Bluesky has no server-side read-state for arbitrary
 * timeline posts, so — like Mastotron — we keep it on-device in IndexedDB. A
 * dismissed post never reappears in the graph; that's the core of the triage
 * model. The timestamp powers the read-only "recently dismissed" view (#82) and
 * never gates dismissal, which stays permanent and grow-only (union merges, no
 * tombstones — a grow-only map is as clean a CRDT as the old grow-only set).
 *
 * Keyed per-user DID so switching accounts doesn't leak read-state between them.
 * The `SvelteMap` is deeply reactive, so anything that reads `isDismissed` (e.g.
 * the graph's visible-posts filter) recomputes automatically on dismiss.
 */
class ReadState {
  /** uri → dismissed-at (epoch ms). `.has()`/`.size` stand in for the old set,
   * so readers are unchanged; only the recency view reads the timestamps. */
  dismissed = new SvelteMap<string, number>()
  #did: string | undefined
  /** Fired after any persisted change, so cross-device sync can schedule a
   * debounced push (#83). Set by the sync module; null when sync is absent.
   * Only fires when a write actually changed the map, so a no-op merge on pull
   * doesn't spuriously trigger a push. */
  onChange: (() => void) | undefined

  #key(did: string) {
    return `skynets:dismissed:${did}` // legacy prefix from before the Mothtrap rename — do not change (users' read state)
  }

  /** Load the dismissed map for a user. Call on login. Back-compat: pre-#82 the
   * value persisted as a bare `string[]` of URIs (no timestamps); migrate each
   * to `t = 0` so old dismissals sort oldest in the recency view. The new shape
   * is `[uri, number][]`. */
  async load(did: string) {
    this.#did = did
    const stored = (await get<string[] | [string, number][]>(this.#key(did))) ?? []
    this.dismissed.clear()
    for (const entry of stored) {
      // Old shape: array of uri strings. New shape: array of [uri, t] pairs.
      if (typeof entry === 'string') this.dismissed.set(entry, 0)
      else this.dismissed.set(entry[0], entry[1])
    }
  }

  isDismissed(uri: string): boolean {
    return this.dismissed.has(uri)
  }

  /** Mark a post read at now, and persist. No-op if already dismissed — keeping
   * the first-seen dismiss time rather than restamping it. */
  async dismiss(uri: string) {
    if (!this.#did || this.dismissed.has(uri)) return
    this.dismissed.set(uri, Date.now())
    await this.#persist()
  }

  /** Mark several posts read in one persist (e.g. a post and its replies). All
   * share one timestamp — they were dismissed by the same action. */
  async dismissMany(uris: Iterable<string>) {
    if (!this.#did) return
    let changed = false
    const t = Date.now()
    for (const uri of uris) {
      if (!this.dismissed.has(uri)) {
        this.dismissed.set(uri, t)
        changed = true
      }
    }
    if (changed) await this.#persist()
  }

  /** Undo a dismissal (e.g. for an undo affordance). */
  async restore(uri: string) {
    if (!this.#did || !this.dismissed.has(uri)) return
    this.dismissed.delete(uri)
    await this.#persist()
  }

  /** Drop in-memory state on logout (does not delete what's persisted). */
  reset() {
    this.#did = undefined
    this.dismissed.clear()
  }

  /** Delete this user's persisted read-state AND clear memory — for the local-
   * data wipe, which promises "everything this device stored is gone." Unlike
   * reset() (logout, memory-only), this actually removes the on-disk key. Runs
   * before reset() nulls #did, so the key is still resolvable. */
  async purge() {
    if (this.#did) await del(this.#key(this.#did))
    this.reset()
  }

  async #persist() {
    if (!this.#did) return
    // Spreading a Map yields [uri, t] pairs — exactly the persisted shape.
    await set(this.#key(this.#did), [...this.dismissed])
    this.onChange?.()
  }
}

export const read = new ReadState()
export { ReadState }
