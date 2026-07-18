import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb'
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

/** Provenance strength: a primary sighting (in your feed, or a repost routed to
 * you) outranks a post pulled in only as thread/ancestor context. Shared by the
 * archive's provenance reduction and the in-memory corpus mirror. */
export const KIND_RANK: Record<AppearanceKind, number> = { timeline: 2, repost: 2, context: 1 }

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
/** A model-produced topic label for one post, so reloads never re-ask the
 * model for a post it has already labeled. Empty label = the model was asked
 * and gave nothing usable (kept so it isn't re-asked forever). */
export interface StoredLabel {
  uri: string
  label: string
  /** Which model produced it — labels from a different model are ignored. */
  model: string
  t: number
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
/** A cached account profile (author or reposter), keyed by DID. Lets a reload
 * reconstruct a repost's attribution — the feed-level `reason.by` isn't stored
 * on the post — and, more generally, show a known face without a live fetch. */
export interface StoredProfile {
  did: string
  handle: string
  displayName?: string
  avatar?: string
  t: number
}
/** The most recent on-screen feed, so a reload paints exactly it from local data
 * before the network answers. Ordered; each entry names the post and, when it
 * surfaced as a repost, who reposted it (fleshed out from `profiles` on
 * restore). The cursor lets "load more" resume where the session left off. */
export interface FeedSnapshot {
  id: 'current'
  entries: { uri: string; reposterDid?: string }[]
  /** URIs of the on-screen CONTEXT (fetched ancestors / thread posts) at snapshot
   * time. Restored alongside the feed so a reload paints edges + tree positions
   * with the nodes, instead of re-fetching ancestors and reflowing a beat later. */
  context?: string[]
  cursor?: string
  t: number
}

interface ArchiveSchema extends DBSchema {
  posts: { key: string; value: ArchivedPost; indexes: { createdAt: number } }
  appearances: { key: number; value: Appearance; indexes: { uri: string; seenAt: number } }
  counts: { key: number; value: CountSample; indexes: { uri: string; t: number } }
  follows: { key: number; value: FollowSnapshot; indexes: { t: number } }
  vectors: { key: string; value: StoredVector }
  digest: { key: string; value: DigestStateRow }
  labels: { key: string; value: StoredLabel; indexes: { t: number } }
  profiles: { key: string; value: StoredProfile }
  session: { key: string; value: FeedSnapshot }
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
/** The account profiles worth caching from one feed item: the author, and the
 * reposter when the item surfaced as a repost. */
function profilesOf(item: FeedItem, t: number): StoredProfile[] {
  const out: StoredProfile[] = []
  const a = item.post.author
  if (a?.did) out.push({ did: a.did, handle: a.handle ?? '', displayName: a.displayName, avatar: a.avatar, t })
  const reason = item.reason as { $type?: string; by?: { did?: string; handle?: string; displayName?: string; avatar?: string } } | undefined
  const by = reason?.$type === 'app.bsky.feed.defs#reasonRepost' ? reason.by : undefined
  if (by?.did) out.push({ did: by.did, handle: by.handle ?? '', displayName: by.displayName, avatar: by.avatar, t })
  return out
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
  #lastProfile = new Map<string, string>()

  async open(did: string): Promise<void> {
    if (this.#db && this.#did === did) return
    this.#did = did || 'anon'
    // DB name is the legacy pre-Mothtrap-rename one — do not change (users' local archives)
    this.#db = await openDB<ArchiveSchema>(`skynets-archive-${this.#did}`, 3, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
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
        }
        if (oldVersion < 2) {
          const labels = db.createObjectStore('labels', { keyPath: 'uri' })
          labels.createIndex('t', 't')
        }
        if (oldVersion < 3) {
          db.createObjectStore('profiles', { keyPath: 'did' })
          db.createObjectStore('session', { keyPath: 'id' })
        }
      },
    })
    // Best-effort: ask the browser not to evict the corpus under pressure.
    try {
      await navigator.storage?.persist?.()
    } catch {
      /* not available (e.g. tests) — fine */
    }
  }

  /** True once the per-DID DB is open. Label hydration/persistence must not
   * spend their one-shot markers against a closed DB (reads return [] then). */
  get ready(): boolean {
    return this.#db !== undefined
  }

  /**
   * Delete everything this device has stored for the current account, and leave
   * the archive closed.
   *
   * The privacy page tells people that clearing site storage erases the archive
   * permanently and that there is no server-side copy — so the app should be
   * able to do it directly, rather than making them dig through browser
   * settings to exercise a control we advertise.
   *
   * The in-memory dedup caches go too: keeping them would make a re-opened
   * archive silently skip re-recording posts it no longer holds.
   */
  async wipe(): Promise<void> {
    const name = `skynets-archive-${this.#did}`
    this.#db?.close()
    this.#db = undefined
    this.#seenAppearance.clear()
    this.#lastCounts.clear()
    this.#lastProfile.clear()
    await deleteDB(name)
  }

  /** Upsert posts, append new appearances, and sample counts on change.
   *
   * `forceKind` overrides the per-item timeline/repost inference — pass
   * `'context'` for posts pulled in only to complete a thread or ancestor
   * chain (they never surfaced in your feed on their own). A post can carry
   * BOTH a timeline and a context appearance over its life; provenance is the
   * union, so recording context never erases an earlier primary appearance. */
  async record(items: FeedItem[], forceKind?: AppearanceKind): Promise<void> {
    const db = this.#db
    if (!db || items.length === 0) return
    const t = Date.now()
    const tx = db.transaction(['posts', 'appearances', 'counts', 'profiles'], 'readwrite')
    const posts = tx.objectStore('posts')
    const apps = tx.objectStore('appearances')
    const counts = tx.objectStore('counts')
    const profiles = tx.objectStore('profiles')
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
      const { kind, reposterDid } = forceKind
        ? { kind: forceKind, reposterDid: forceKind === 'repost' ? reposterProfile(item)?.did : undefined }
        : appearanceKind(item)
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
      // Cache author + reposter profiles, re-writing only when a face changes,
      // so a reload can attribute a repost (whose reason isn't stored on the
      // post) and show known accounts before the network answers.
      for (const p of profilesOf(item, t)) {
        const psig = `${p.handle}|${p.displayName ?? ''}|${p.avatar ?? ''}`
        if (this.#lastProfile.get(p.did) !== psig) {
          this.#lastProfile.set(p.did, psig)
          await profiles.put(p)
        }
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
    trim(this.#lastProfile, 50_000)
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

  /** Cached profiles by DID (all, or a requested subset). */
  async getProfiles(dids?: string[]): Promise<Map<string, StoredProfile>> {
    const out = new Map<string, StoredProfile>()
    const db = this.#db
    if (!db) return out
    if (dids) {
      await Promise.all(
        dids.map(async (d) => {
          const row = await db.get('profiles', d)
          if (row) out.set(d, row)
        }),
      )
    } else {
      for (const p of await db.getAll('profiles')) out.set(p.did, p)
    }
    return out
  }

  /** Persist / read the most-recent on-screen feed (single row), for reload-paint. */
  async putFeedSnapshot(entries: FeedSnapshot['entries'], cursor?: string, context?: string[]): Promise<void> {
    if (!this.#db) return
    await this.#db.put('session', { id: 'current', entries, context, cursor, t: Date.now() })
  }
  async getFeedSnapshot(): Promise<FeedSnapshot | undefined> {
    if (!this.#db) return undefined
    return this.#db.get('session', 'current')
  }

  /** Every archived post as a FeedItem, for rehydrating the in-memory corpus on
   * reload. NOTE: the feed-level repost `reason` isn't stored, so a rehydrated
   * repost loses its reposter attribution — provenance kind is reconstructed
   * from `getProvenance()` instead, and full reason survives only for posts
   * (re)fetched live this session. */
  async getAllPosts(): Promise<FeedItem[]> {
    const db = this.#db
    if (!db) return []
    const rows = await db.getAll('posts')
    return rows.map((r) => ({ post: r.post }) as FeedItem)
  }

  /** Strongest provenance per uri from the appearances log (a timeline/repost
   * sighting wins over context), for reconstructing primary-vs-context when the
   * corpus is rehydrated from disk. */
  async getProvenance(): Promise<Map<string, AppearanceKind>> {
    const out = new Map<string, AppearanceKind>()
    const db = this.#db
    if (!db) return out
    const apps = await db.getAll('appearances')
    for (const a of apps) {
      const prev = out.get(a.uri)
      if (!prev || KIND_RANK[a.kind] > KIND_RANK[prev]) out.set(a.uri, a.kind)
    }
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

  /** Upsert per-post labels. Bounded: oldest rows are evicted past the cap. */
  async putLabels(rows: StoredLabel[]): Promise<void> {
    if (!this.#db || rows.length === 0) return
    const tx = this.#db.transaction('labels', 'readwrite')
    for (const r of rows) void tx.store.put(r)
    await tx.done
    // Cap the store; eviction only means a very old post might be re-asked.
    const CAP = 20_000
    const count = await this.#db.count('labels')
    if (count > CAP) {
      const del = this.#db.transaction('labels', 'readwrite')
      let cursor = await del.store.index('t').openCursor()
      let excess = count - CAP
      while (cursor && excess-- > 0) {
        void cursor.delete()
        cursor = await cursor.continue()
      }
      await del.done
    }
  }

  /** All stored labels (caller filters by model). */
  async getLabels(): Promise<StoredLabel[]> {
    if (!this.#db) return []
    return this.#db.getAll('labels')
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
