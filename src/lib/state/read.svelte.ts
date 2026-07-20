import { del, get, set } from 'idb-keyval'
import { SvelteSet } from 'svelte/reactivity'

/**
 * Locally-persisted set of dismissed ("read") post URIs. Bluesky has no
 * server-side read-state for arbitrary timeline posts, so — like Mastotron —
 * we keep it on-device in IndexedDB. A dismissed post never reappears in the
 * graph; that's the core of the triage model.
 *
 * Keyed per-user DID so switching accounts doesn't leak read-state between them.
 * The `SvelteSet` is deeply reactive, so anything that reads `isDismissed` (e.g.
 * the graph's visible-posts filter) recomputes automatically on dismiss.
 */
class ReadState {
  dismissed = new SvelteSet<string>()
  #did: string | undefined

  #key(did: string) {
    return `skynets:dismissed:${did}` // legacy prefix from before the Mothtrap rename — do not change (users' read state)
  }

  /** Load the dismissed set for a user. Call on login. */
  async load(did: string) {
    this.#did = did
    const stored = (await get<string[]>(this.#key(did))) ?? []
    this.dismissed.clear()
    for (const uri of stored) this.dismissed.add(uri)
  }

  isDismissed(uri: string): boolean {
    return this.dismissed.has(uri)
  }

  /** Mark a post read and persist. No-op if already dismissed. */
  async dismiss(uri: string) {
    if (!this.#did || this.dismissed.has(uri)) return
    this.dismissed.add(uri)
    await this.#persist()
  }

  /** Mark several posts read in one persist (e.g. a post and its replies). */
  async dismissMany(uris: Iterable<string>) {
    if (!this.#did) return
    let changed = false
    for (const uri of uris) {
      if (!this.dismissed.has(uri)) {
        this.dismissed.add(uri)
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
    await set(this.#key(this.#did), [...this.dismissed])
  }
}

export const read = new ReadState()
