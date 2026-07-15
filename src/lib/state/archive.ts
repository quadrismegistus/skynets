import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { AppBskyFeedPost } from '@atproto/api'
import type { FeedItem } from '../api/timeline'
import { reposterProfile } from '../api/post'

/**
 * The local corpus (PLAN §6/§7 Phase A2). A normalized IndexedDB archive of the
 * timeline, so the continuous digest survives reloads and rolls over the whole
 * feed history — and so the feed becomes an object of diachronic study.
 *
 * Normalized deliberately: a post reaches you many times, and engagement counts
 * are point-in-time. Storing the whole post per encounter would either freeze or
 * overwrite the counts, so the layers are separate:
 *   posts       — one row per URI: the content + first/last seen.
 *   appearances — one row per surfacing (timeline / repost / context).
 *   counts      — engagement samples over time (watch a post heat up).
 *   follows     — periodic follows-list snapshots (network over time).
 *   vectors     — embedding cache (so a reload doesn't re-embed the feed).
 *   digest      — the rolling engine's cluster state.
 */

export type AppearanceKind = 'timeline' | 'repost' | 'context'

interface ArchivedPost {
  uri: string
  createdAt: number
  firstSeen: number
  lastSeen: number
  post: FeedItem['post']
}
interface Appearance {
  uri: string
  kind: AppearanceKind
  reposterDid?: string
  seenAt: number
}
interface CountSample {
  uri: string
  t: number
  likes: number
  reposts: number
  replies: number
}
interface FollowSnapshot {
  t: number
  dids: string[]
}
interface StoredVector {
  uri: string
  vec: number[]
}
export interface PersistedCluster {
  id: string
  label: string
  summary: string
  status: string
  uris: string[]
  /** The cluster's centroid, stored ALONGSIDE the cluster (same put) so a reload
   * never depends on the separate vectors store having landed — otherwise a
   * cluster could rehydrate with an empty centroid and silently break the gate/
   * dedup. Optional for digests persisted before this field existed. */
  centroid?: number[]
}
interface DigestStateRow {
  id: 'current'
  clusters: PersistedCluster[]
  updatedAt: number
}

interface ArchiveSchema extends DBSchema {
  posts: { key: string; value: ArchivedPost; indexes: { createdAt: number } }
  appearances: { key: number; value: Appearance; indexes: { uri: string; seenAt: number } }
  counts: { key: number; value: CountSample; indexes: { uri: string; t: number } }
  follows: { key: number; value: FollowSnapshot; indexes: { t: number } }
  vectors: { key: string; value: StoredVector }
  digest: { key: string; value: DigestStateRow }
}

type DB = IDBPDatabase<ArchiveSchema>

function createdAtMs(item: FeedItem): number {
  const rec = item.post.record
  const s = AppBskyFeedPost.isRecord(rec) ? rec.createdAt : undefined
  return Date.parse(s ?? item.post.indexedAt) || Date.now()
}
function appearanceKind(item: FeedItem): { kind: AppearanceKind; reposterDid?: string } {
  const rp = reposterProfile(item)
  if (rp?.did) return { kind: 'repost', reposterDid: rp.did }
  return { kind: 'timeline' }
}

/**
 * Per-user archive. One IndexedDB database per DID so switching accounts doesn't
 * mix corpora. Idempotent writes: re-recording the same feed only bumps
 * lastSeen, appends an appearance once per (uri,kind) per session, and samples
 * counts only when they actually change.
 */
export class Archive {
  #db: DB | undefined
  #did = 'anon'
  #seenAppearance = new Set<string>()
  #lastCounts = new Map<string, string>()

  async open(did: string): Promise<void> {
    if (this.#db && this.#did === did) return
    this.#did = did || 'anon'
    this.#db = await openDB<ArchiveSchema>(`skynets-archive-${this.#did}`, 1, {
      upgrade(db) {
        const posts = db.createObjectStore('posts', { keyPath: 'uri' })
        posts.createIndex('createdAt', 'createdAt')
        const app = db.createObjectStore('appearances', { autoIncrement: true })
        app.createIndex('uri', 'uri')
        app.createIndex('seenAt', 'seenAt')
        const counts = db.createObjectStore('counts', { autoIncrement: true })
        counts.createIndex('uri', 'uri')
        counts.createIndex('t', 't')
        const follows = db.createObjectStore('follows', { autoIncrement: true })
        follows.createIndex('t', 't')
        db.createObjectStore('vectors', { keyPath: 'uri' })
        db.createObjectStore('digest', { keyPath: 'id' })
      },
    })
    // Best-effort: ask the browser not to evict the corpus under pressure.
    try {
      await navigator.storage?.persist?.()
    } catch {
      /* not available (e.g. tests) — fine */
    }
  }

  get ready(): boolean {
    return this.#db !== undefined
  }

  /** Upsert posts, append new appearances, and sample counts on change. */
  async record(items: FeedItem[]): Promise<void> {
    const db = this.#db
    if (!db || items.length === 0) return
    const t = Date.now()
    const tx = db.transaction(['posts', 'appearances', 'counts'], 'readwrite')
    const posts = tx.objectStore('posts')
    const apps = tx.objectStore('appearances')
    const counts = tx.objectStore('counts')
    for (const item of items) {
      const uri = item.post.uri
      const existing = await posts.get(uri)
      await posts.put({
        uri,
        createdAt: createdAtMs(item),
        firstSeen: existing?.firstSeen ?? t,
        lastSeen: t,
        post: item.post,
      })
      const { kind, reposterDid } = appearanceKind(item)
      const akey = `${uri}|${kind}|${reposterDid ?? ''}`
      if (!this.#seenAppearance.has(akey)) {
        this.#seenAppearance.add(akey)
        await apps.add({ uri, kind, reposterDid, seenAt: t })
      }
      const likes = item.post.likeCount ?? 0
      const reposts = item.post.repostCount ?? 0
      const replies = item.post.replyCount ?? 0
      const sig = `${likes},${reposts},${replies}`
      if (this.#lastCounts.get(uri) !== sig) {
        this.#lastCounts.set(uri, sig)
        await counts.add({ uri, t, likes, reposts, replies })
      }
    }
    await tx.done
    this.#capMemory()
  }

  /** Bound the write-dedup caches so a long continuous session can't grow them
   * without limit. Eviction just risks an occasional duplicate row later (the
   * stores tolerate it), never data loss. */
  #capMemory() {
    const trim = (c: { size: number; keys(): IterableIterator<string>; delete(k: string): unknown }, max: number) => {
      if (c.size <= max) return
      for (const k of [...c.keys()]) {
        if (c.size <= max) break
        c.delete(k)
      }
    }
    trim(this.#seenAppearance, 50_000)
    trim(this.#lastCounts, 50_000)
  }

  /** Record a follows snapshot if it differs from the most recent one. Reads
   * only the newest row (cursor) rather than loading the whole history. */
  async recordFollows(dids: string[]): Promise<void> {
    const db = this.#db
    if (!db || dids.length === 0) return
    const sorted = [...new Set(dids)].sort()
    const cursor = await db.transaction('follows').store.openCursor(null, 'prev')
    const last = cursor?.value
    if (last && last.dids.length === sorted.length && last.dids.every((d, i) => d === sorted[i])) return
    await db.add('follows', { t: Date.now(), dids: sorted })
  }

  /** Resolve archived posts (as FeedItems) by URI — for reviving off-window
   * posts a rolling digest still references. */
  async getPosts(uris: string[]): Promise<Map<string, FeedItem>> {
    const out = new Map<string, FeedItem>()
    const db = this.#db
    if (!db) return out
    await Promise.all(
      uris.map(async (u) => {
        const row = await db.get('posts', u)
        if (row) out.set(u, { post: row.post } as FeedItem)
      }),
    )
    return out
  }

  /** How many of these URIs were already archived *before* `before` (i.e. in a
   * prior session). The backfill uses this to detect when it has paged back into
   * already-recorded history and can stop. */
  async countKnownBefore(uris: string[], before: number): Promise<number> {
    const db = this.#db
    if (!db) return 0
    let n = 0
    await Promise.all(
      uris.map(async (u) => {
        const row = await db.get('posts', u)
        if (row && row.firstSeen < before) n++
      }),
    )
    return n
  }

  async putVectors(entries: { uri: string; vec: number[] }[]): Promise<void> {
    const db = this.#db
    if (!db || entries.length === 0) return
    const tx = db.transaction('vectors', 'readwrite')
    for (const e of entries) await tx.store.put(e)
    await tx.done
  }
  async getVectors(uris: string[]): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>()
    const db = this.#db
    if (!db) return out
    await Promise.all(
      uris.map(async (u) => {
        const row = await db.get('vectors', u)
        if (row) out.set(u, row.vec)
      }),
    )
    return out
  }

  async putDigest(clusters: PersistedCluster[]): Promise<void> {
    if (!this.#db) return
    await this.#db.put('digest', { id: 'current', clusters, updatedAt: Date.now() })
  }
  async getDigest(): Promise<PersistedCluster[]> {
    if (!this.#db) return []
    return (await this.#db.get('digest', 'current'))?.clusters ?? []
  }

  async stats(): Promise<{ posts: number; appearances: number; counts: number; follows: number }> {
    const db = this.#db
    if (!db) return { posts: 0, appearances: 0, counts: 0, follows: 0 }
    return {
      posts: await db.count('posts'),
      appearances: await db.count('appearances'),
      counts: await db.count('counts'),
      follows: await db.count('follows'),
    }
  }

  /** Every archived post's creation time (ms) AND the time we first saw it, for
   * the coverage histogram. Read via a key-cursor on the createdAt index, so no
   * post JSON is loaded — cheap even for a large corpus. `firstSeen` lets the
   * view distinguish "posted then" from "captured then" (a gap between the two
   * is where backfill filled in vs. live capture). */
  async coverage(): Promise<{ createdAt: number; firstSeen: number }[]> {
    const db = this.#db
    if (!db) return []
    // The createdAt index only carries createdAt; firstSeen lives in the record,
    // so pull both from the full rows (still just two numbers we keep).
    const rows = await db.getAll('posts')
    return rows.map((r) => ({ createdAt: r.createdAt, firstSeen: r.firstSeen }))
  }

  /** Full JSON export — the corpus, portable to notebooks/pandas. */
  async exportJSON(): Promise<string> {
    const db = this.#db
    if (!db) return '{}'
    const [posts, appearances, counts, follows] = await Promise.all([
      db.getAll('posts'),
      db.getAll('appearances'),
      db.getAll('counts'),
      db.getAll('follows'),
    ])
    return JSON.stringify({ did: this.#did, exportedAt: Date.now(), posts, appearances, counts, follows })
  }
}

export const archive = new Archive()
