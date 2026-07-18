import { AppBskyFeedPost } from '@atproto/api'
import type { FeedItem } from '../api/timeline'
import {
  rollFeed,
  summarizeFeed,
  type ConvoStatus,
  type Digest,
  type SummarizeOpts,
} from '../api/llm'
import { centroid, cosine, embedTexts, noveltyGate, type GateResult } from '../api/embed'
import { ConsentRequired } from './digestConsent.svelte'
import { archive } from './archive'

/** Force a roll once this many posts have buffered, even if the gate keeps
 * saying "skip" — so a slow trickle of near-cluster posts still gets folded in
 * eventually rather than buffering forever. */
const BUFFER_FLUSH = 15
/** Two cluster centroids closer than this are the same conversation under
 * different labels → merge (the 4b sometimes re-creates a cluster it should
 * continue). Distinct clusters sit ~0.2; same-topic ~0.7 (all-minilm). */
const DEDUP_SIM = 0.5

export type EnginePhase = 'idle' | 'embedding' | 'establishing' | 'rolling' | 'skipped' | 'error'

interface EngineCluster {
  id: string
  label: string
  summary: string
  status: ConvoStatus
  uris: string[]
  centroid: number[]
}

function textOf(item: FeedItem): string {
  const rec = item.post.record
  return AppBskyFeedPost.isRecord(rec) ? rec.text : ''
}
function ageHours(item: FeedItem): number {
  const rec = item.post.record
  const created = AppBskyFeedPost.isRecord(rec) ? rec.createdAt : undefined
  return (Date.now() - Date.parse(created ?? item.post.indexedAt)) / 3_600_000
}
function statusOf(items: FeedItem[]): ConvoStatus {
  if (items.length === 0) return 'steady'
  const newest = Math.min(...items.map(ageHours))
  if (newest < 3) return 'heating'
  if (newest > 12) return 'cooling'
  return 'steady'
}
function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'c'
}

/**
 * The continuous digest engine (PLAN §7). Feed it new posts as they arrive; it
 * embeds them locally, and the aggregate novelty gate decides whether to spend
 * the LLM: establish clusters when there are none, roll new posts into existing
 * conversations when there's genuinely new content, or SKIP and buffer when
 * there isn't. Embeddings only ever gate and dedup — never route posts per-post.
 */
export class DigestEngine {
  clusters = $state<EngineCluster[]>([])
  phase = $state<EnginePhase>('idle')
  error = $state<string | undefined>(undefined)
  lastGate = $state<GateResult | undefined>(undefined)
  lastRunAt = $state<number | undefined>(undefined)
  /** Raw model text while a roll/establish streams (for the panel). */
  streamText = $state('')

  #buffer: FeedItem[] = []
  #vec = new Map<string, number[]>()
  #item = new Map<string, FeedItem>()
  #busy = false

  bufferedCount = $state(0)

  /** A post the engine has ingested (kept in memory; also survives reload after
   * rehydrate) — used to revive off-window posts a rolling digest references. */
  getItem(uri: string): FeedItem | undefined {
    return this.#item.get(uri)
  }

  /** Restore clusters + vectors + member posts from the archive (Phase A) so the
   * rolling digest survives reloads and keeps its whole history. */
  async rehydrate(): Promise<void> {
    if (this.clusters.length > 0) return
    const persisted = await archive.getDigest()
    if (persisted.length === 0) return
    const uris = [...new Set(persisted.flatMap((c) => c.uris))]
    const [posts, vecs] = await Promise.all([archive.getPosts(uris), archive.getVectors(uris)])
    for (const [u, it] of posts) this.#item.set(u, it)
    for (const [u, v] of vecs) this.#vec.set(u, v)
    this.clusters = persisted.map((c) => ({
      id: c.id,
      label: c.label,
      summary: c.summary,
      status: (c.status as ConvoStatus) ?? 'steady',
      uris: c.uris,
      // Prefer the centroid stored with the cluster; only recompute from the
      // vectors store for older digests that predate the stored centroid.
      centroid: c.centroid?.length ? c.centroid : this.#centroidOf(c.uris),
    }))
  }

  #persist() {
    // Snapshot out of $state — IndexedDB can't structured-clone a Svelte proxy.
    const plain = $state.snapshot(this.clusters) as {
      id: string; label: string; summary: string; status: string; uris: string[]; centroid: number[]
    }[]
    void archive
      .putDigest(
        plain.map((c) => ({
          id: c.id,
          label: c.label,
          summary: c.summary,
          status: c.status,
          uris: c.uris,
          centroid: c.centroid, // persisted with the cluster, not the separate vectors store
        })),
      )
      .catch(() => {})
  }

  /** The digest as the panel/graph consume it. */
  toDigest(): Digest {
    return {
      conversations: this.clusters.map((c) => ({
        id: c.id,
        label: c.label,
        summary: c.summary,
        status: c.status,
        postUris: c.uris,
      })),
    }
  }

  /** Clear the rolling clusters (in memory AND persisted) so the next run
   * re-establishes from scratch. Keeps the archive's posts/vectors — only the
   * cluster labels/assignments are discarded. */
  reset() {
    this.clusters = []
    this.#buffer = []
    this.bufferedCount = 0
    this.#vec.clear()
    this.#item.clear()
    this.phase = 'idle'
    this.error = undefined
    this.lastGate = undefined
    void archive.putDigest([]).catch(() => {})
  }

  /** A cluster id unique within `taken` (mutated) — two labels that slug the
   * same ("AI!" and "AI?" → "ai") would otherwise collide and break Svelte's
   * keyed {#each} and id-keyed lookups. */
  #uniqueId(base: string, taken: Set<string>): string {
    const b = base || 'c'
    let id = b
    let n = 2
    while (taken.has(id)) id = `${b}-${n++}`
    taken.add(id)
    return id
  }

  #centroidOf(uris: string[]): number[] {
    const vs = uris.map((u) => this.#vec.get(u)).filter((v): v is number[] => v != null)
    return centroid(vs)
  }
  #itemsOf(uris: string[]): FeedItem[] {
    return uris.map((u) => this.#item.get(u)).filter((i): i is FeedItem => i != null)
  }
  #recompute(c: EngineCluster) {
    c.centroid = this.#centroidOf(c.uris)
    c.status = statusOf(this.#itemsOf(c.uris))
  }
  #addUris(c: EngineCluster, uris: string[]) {
    const set = new Set(c.uris)
    for (const u of uris) set.add(u)
    c.uris = [...set]
    this.#recompute(c)
  }

  /**
   * Ingest a batch of feed items. Embeds the fresh ones, runs the gate, and
   * either establishes / rolls / skips accordingly. Safe to call repeatedly
   * (e.g. from the live poll); overlapping calls are coalesced via #busy.
   */
  async ingest(items: FeedItem[], opts: SummarizeOpts): Promise<void> {
    if (this.#busy) return
    const fresh = items.filter((i) => !this.#item.has(i.post.uri))
    if (fresh.length === 0) return
    this.#busy = true
    this.error = undefined
    try {
      this.phase = 'embedding'
      const vecs = await embedTexts(
        fresh.map(textOf),
        { ollamaUrl: opts.ollamaUrl },
      )
      // Cache vectors up front (needed to compute centroids), but DON'T mark the
      // posts as seen yet — that happens only after a path below succeeds, so a
      // failing LLM call leaves them to be re-ingested rather than silently
      // dropped.
      fresh.forEach((it, k) => {
        if (vecs[k]) this.#vec.set(it.post.uri, vecs[k])
      })
      // Cache the fresh vectors so a reload doesn't re-embed the whole feed.
      // `vec` is a plain array (from embedTexts); `uri` a string — both cloneable.
      void archive
        .putVectors(fresh.map((it, k) => ({ uri: it.post.uri, vec: vecs[k] })).filter((e) => e.vec))
        .catch(() => {})

      const gate = noveltyGate(vecs, this.clusters.map((c) => c.centroid))
      this.lastGate = gate

      if (this.clusters.length === 0) {
        await this.#establish([...this.#buffer, ...fresh], opts)
        this.#clearBuffer()
      } else if (gate.shouldRoll || this.#buffer.length + fresh.length >= BUFFER_FLUSH) {
        await this.#roll([...this.#buffer, ...fresh], opts)
        this.#clearBuffer()
      } else {
        // Not much new — skip the LLM, buffer for a later roll.
        this.#buffer.push(...fresh)
        this.bufferedCount = this.#buffer.length
        this.phase = 'skipped'
      }
      // A path succeeded — NOW mark these seen so they're not re-processed.
      for (const it of fresh) this.#item.set(it.post.uri, it)
    } catch (err) {
      if (err instanceof ConsentRequired) {
        // Not a failure — the consent dialog is up. Showing a red error in the
        // panel while we're asking permission would be exactly wrong, and the
        // posts stay un-ingested so they're retried once the user says yes.
        this.phase = 'idle'
        this.error = undefined
      } else {
        this.phase = 'error'
        this.error = err instanceof Error ? err.message : 'Digest engine failed'
      }
    } finally {
      this.streamText = ''
      this.#busy = false
    }
  }

  #clearBuffer() {
    this.#buffer = []
    this.bufferedCount = 0
  }

  async #establish(items: FeedItem[], opts: SummarizeOpts) {
    this.phase = 'establishing'
    const d = await summarizeFeed(items, opts, (t) => (this.streamText = t))
    const taken = new Set<string>()
    this.clusters = d.conversations.map((c) => ({
      id: this.#uniqueId(c.id, taken),
      label: c.label,
      summary: c.summary,
      status: c.status,
      uris: c.postUris,
      centroid: this.#centroidOf(c.postUris),
    }))
    this.#persist()
    this.lastRunAt = Date.now()
    this.phase = 'idle'
  }

  async #roll(items: FeedItem[], opts: SummarizeOpts) {
    this.phase = 'rolling'
    const updates = await rollFeed(
      items,
      this.clusters.map((c) => ({ label: c.label, summary: c.summary })),
      opts,
      (t) => (this.streamText = t),
    )
    const taken = new Set(this.clusters.map((c) => c.id))
    for (const u of updates) {
      const match = this.clusters.find((c) => c.label.toLowerCase() === u.label.toLowerCase())
      if (match) {
        this.#addUris(match, u.uris)
        continue
      }
      // A "new" cluster — but dedup against existing centroids first (the model
      // sometimes re-creates a conversation it should have continued).
      const cent = this.#centroidOf(u.uris)
      let best: EngineCluster | undefined
      let bestSim = -1
      for (const c of this.clusters) {
        const s = cosine(cent, c.centroid)
        if (s > bestSim) {
          bestSim = s
          best = c
        }
      }
      if (best && bestSim >= DEDUP_SIM) {
        this.#addUris(best, u.uris)
      } else {
        this.clusters.push({
          id: this.#uniqueId(slug(u.label), taken),
          label: u.label,
          summary: '',
          status: statusOf(this.#itemsOf(u.uris)),
          uris: u.uris,
          centroid: cent,
        })
      }
    }
    // Reassign to trigger reactivity (mutated cluster objects in place above).
    this.clusters = [...this.clusters]
    this.#persist()
    this.lastRunAt = Date.now()
    this.phase = 'idle'
  }
}
