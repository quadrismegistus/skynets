import {
  DEFAULT_MODEL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  labelFeed,
  summarizeFeed,
  type Digest,
  type Provider,
  type SummarizeOpts,
} from '../api/llm'
import { DEFAULT_MERGE_THRESHOLD, groupByEmbedding, groupByLabel } from '../api/labelGroup'
import { embedTexts } from '../api/embed'
import type { FeedItem } from '../api/timeline'
import { DigestEngine } from './digestEngine.svelte'

const KEY = 'skynets.llm'

interface Persisted {
  provider: Provider
  model: string
  ollamaModel: string
  ollamaUrl: string
  window: number
  continuous: boolean
  opsOnly: boolean
  labelMode: boolean
  mergeThreshold: number
}

/** How many posts to send to the digest. ~70 was the sweet spot in testing:
 * enough for conversations to coalesce (the real "ICE killing" thread only
 * emerged past ~30 posts) without the prefill wait a 100-post prompt incurs. */
export const DEFAULT_WINDOW = 70

function load(): Partial<Persisted> {
  if (typeof localStorage === 'undefined') return {}
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Persisted>
  } catch {
    return {}
  }
}

/**
 * LLM digest state (PLAN §6 Phase E, minimal slice). The Anthropic API key is
 * held in memory only — never persisted — the safe default given the app's
 * rich-content XSS surface; re-enter per session. Everything non-sensitive
 * (provider choice, model names, the Ollama URL) IS persisted. The digest is
 * kept as `previous` and fed back on the next call so labels stay stable.
 */
class DigestState {
  apiKey = $state('')
  provider = $state<Provider>('anthropic')
  model = $state(DEFAULT_MODEL)
  ollamaModel = $state(DEFAULT_OLLAMA_MODEL)
  ollamaUrl = $state(DEFAULT_OLLAMA_URL)
  window = $state(DEFAULT_WINDOW)
  /** Continuous mode: maintain a rolling digest via the engine (embed → gate →
   * establish/roll/skip) instead of a fresh full digest each press (PLAN §7). */
  continuous = $state(false)
  /** Feed only thread OPs to the classifier (a reply is anchored to its root),
   * not the replies themselves. Reply text ("lol yes", "exactly") is noise that
   * muddies clustering even with parent context inlined; the substantive OP is
   * the right unit of a "conversation". Replies fold back into their OP's
   * conversation structurally in the graph. */
  opsOnly = $state(true)
  /** Per-post labeling mode: label each OP individually (many tiny prompts),
   * then group shared labels into conversations (PLAN §7 variant). More robust
   * on a small local model than the one-shot clustering prompt. */
  labelMode = $state(false)
  /** Cosine cutoff for merging two labels into one topic (label mode). Tunable
   * because it's the one knob that wants per-feed calibration. */
  mergeThreshold = $state(DEFAULT_MERGE_THRESHOLD)
  /** uri → label cache, so continuous re-labeling only touches new posts. */
  #labels = new Map<string, string>()
  /** label → embedding cache, so re-grouping (e.g. threshold slider) is free. */
  #labelVecs = new Map<string, number[]>()
  /** The OP set from the last label pass, so a threshold change can re-group
   * without re-labeling. */
  #lastLabelItems: FeedItem[] = []
  digest = $state<Digest | undefined>(undefined)
  loading = $state(false)
  error = $state<string | undefined>(undefined)
  /** Raw model text as it streams in (Ollama), shown until the parse replaces it. */
  streamText = $state('')
  /** When the last digest was produced, for the panel's "as of" note. */
  ranAt = $state<number | undefined>(undefined)
  /** The rolling engine (used in continuous mode). */
  engine = new DigestEngine()

  constructor() {
    const p = load()
    if (p.provider === 'anthropic' || p.provider === 'ollama') this.provider = p.provider
    if (typeof p.model === 'string') this.model = p.model
    if (typeof p.ollamaModel === 'string') this.ollamaModel = p.ollamaModel
    if (typeof p.ollamaUrl === 'string') this.ollamaUrl = p.ollamaUrl
    if (typeof p.window === 'number' && p.window > 0) this.window = p.window
    if (typeof p.continuous === 'boolean') this.continuous = p.continuous
    if (typeof p.opsOnly === 'boolean') this.opsOnly = p.opsOnly
    if (typeof p.labelMode === 'boolean') this.labelMode = p.labelMode
    if (typeof p.mergeThreshold === 'number') this.mergeThreshold = p.mergeThreshold

    if (typeof localStorage !== 'undefined') {
      $effect.root(() => {
        $effect(() => {
          const data: Persisted = {
            provider: this.provider,
            model: this.model,
            ollamaModel: this.ollamaModel,
            ollamaUrl: this.ollamaUrl,
            window: this.window,
            continuous: this.continuous,
            opsOnly: this.opsOnly,
            labelMode: this.labelMode,
            mergeThreshold: this.mergeThreshold,
          }
          localStorage.setItem(KEY, JSON.stringify(data))
        })
      })
    }
  }

  #opts(previous?: Digest, postByUri?: Map<string, FeedItem>): SummarizeOpts {
    return {
      provider: this.provider,
      model: this.provider === 'ollama' ? this.ollamaModel : this.model,
      apiKey: this.apiKey,
      ollamaUrl: this.ollamaUrl,
      previous,
      postByUri,
    }
  }

  /** `contextByUri` resolves reply parents so their text is fed to the classifier. */
  async summarize(items: FeedItem[], contextByUri?: Map<string, FeedItem>) {
    if (this.loading || items.length === 0) return
    this.loading = true
    this.error = undefined
    this.streamText = ''
    try {
      if (this.labelMode) {
        await this.#labelIngest(items)
      } else if (this.continuous) {
        // Rolling engine: embed → gate → establish/roll/skip. It maintains its
        // own clusters across calls; we surface them as the digest.
        await this.engine.ingest(items, this.#opts(undefined, contextByUri))
        if (this.engine.error) this.error = this.engine.error
        this.digest = this.engine.toDigest()
      } else {
        this.digest = await summarizeFeed(items, this.#opts(this.digest, contextByUri), (raw) => (this.streamText = raw))
      }
      this.ranAt = Date.now()
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Summary failed'
    } finally {
      this.loading = false
      this.streamText = ''
    }
  }

  /** Per-post labeling: label the OPs we haven't seen, then group by embedding
   * similarity. The uri→label and label→vector caches persist across calls, so
   * continuous ticks only pay for genuinely new posts. During labeling the fast
   * token-merge grouping gives live feedback; once labels are in, an embedding
   * pass re-groups more accurately (merging topics that share no literal word).
   * The digest is rebuilt over the CURRENT window so posts that scrolled off
   * drop out. */
  async #labelIngest(items: FeedItem[]) {
    this.#lastLabelItems = items
    const posts = () =>
      items.map((i) => ({ uri: i.post.uri, label: this.#labels.get(i.post.uri) ?? '' }))
    this.digest = groupByLabel(posts()) // reflect cached labels immediately
    const todo = items.filter((i) => !this.#labels.has(i.post.uri))
    if (todo.length) {
      await labelFeed(todo, this.#opts(), (uri, label) => {
        this.#labels.set(uri, label)
        this.digest = groupByLabel(posts()) // fast live grouping while streaming
      })
      // Record an ATTEMPT for every post we tried, even ones the model gave no
      // usable label for — otherwise `todo` re-sends them to the model on every
      // continuous tick forever. Empty-labeled posts are dropped from grouping
      // but not re-requested.
      for (const it of todo) if (!this.#labels.has(it.post.uri)) this.#labels.set(it.post.uri, '')
    }
    this.#capCaches()
    await this.#embedRegroup(posts().filter((p) => p.label))
  }

  /** Bound the label/vector caches so a long continuous session can't grow them
   * without limit. Oldest entries (Map insertion order) are evicted first. */
  #capCaches() {
    const cap = (m: Map<string, unknown>, max: number) => {
      for (const k of m.keys()) {
        if (m.size <= max) break
        m.delete(k)
      }
    }
    cap(this.#labels, 5000)
    cap(this.#labelVecs, 2000)
  }

  /** Embed any not-yet-embedded labels (cached), then group by cosine. Falls
   * back to the token merge if embeddings are unavailable (e.g. no Ollama). */
  async #embedRegroup(posts: { uri: string; label: string }[]) {
    const labels = [...new Set(posts.map((p) => p.label))]
    const need = labels.filter((l) => !this.#labelVecs.has(l))
    try {
      if (need.length) {
        const vecs = await embedTexts(need, { ollamaUrl: this.ollamaUrl })
        need.forEach((l, i) => vecs[i] && this.#labelVecs.set(l, vecs[i]))
      }
      this.digest = groupByEmbedding(posts, this.#labelVecs, this.mergeThreshold)
    } catch {
      this.digest = groupByLabel(posts) // no embeddings → keep token grouping
    }
  }

  /** Re-group the already-labeled posts at the current threshold, using cached
   * label vectors — no re-labeling or re-embedding. Drives the merge slider. */
  regroupLabels() {
    if (!this.labelMode || !this.#lastLabelItems.length) return
    const posts = this.#lastLabelItems
      .map((i) => ({ uri: i.post.uri, label: this.#labels.get(i.post.uri) ?? '' }))
      .filter((p) => p.label)
    this.digest = groupByEmbedding(posts, this.#labelVecs, this.mergeThreshold)
  }

  clear() {
    this.digest = undefined
    this.error = undefined
    this.ranAt = undefined
    this.#labels.clear()
    this.#labelVecs.clear()
    this.#lastLabelItems = []
    this.engine.reset()
  }
}

export const digest = new DigestState()
