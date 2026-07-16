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
import { deploy } from './deploy.svelte'
import { listOllamaModels, pickClusterModel, pickDefaultModel, type OllamaModel } from '../api/ollama'

const KEY = 'skynets.llm' // legacy name from before the Mothtrap rename — do not change (users' digest state)

interface Persisted {
  provider: Provider
  model: string
  ollamaModel: string
  /** True once the user hand-picks a model — until then we auto-select the
   * smallest installed one. */
  ollamaModelPinned: boolean
  /** A separate (typically smaller) model for label mode — the per-post label
   * task is trivial, so a tiny model is ideal there while clustering keeps a
   * capable one. Empty falls back to `ollamaModel`. */
  ollamaLabelModel: string
  ollamaLabelModelPinned: boolean
  ollamaUrl: string
  window: number
  continuous: boolean
  /** True once the user toggles Auto-update — v1 blobs auto-persisted the old
   * default (false), so a bare `continuous` can't be trusted as a choice. */
  continuousSet?: boolean
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
  /** Models installed in the local Ollama (smallest first), fetched from
   * /api/tags for the picker. */
  ollamaModels = $state<OllamaModel[]>([])
  /** Set once the user manually chooses a model; before that we keep the
   * ollamaModel synced to the smallest installed one. */
  ollamaModelPinned = $state(false)
  /** Separate model for label mode (smaller is fine — it just tags one post).
   * Empty falls back to `ollamaModel`. Auto-synced to smallest until pinned. */
  ollamaLabelModel = $state('')
  ollamaLabelModelPinned = $state(false)
  ollamaUrl = $state(DEFAULT_OLLAMA_URL)
  window = $state(DEFAULT_WINDOW)
  /** Continuous mode: maintain a rolling digest via the engine (embed → gate →
   * establish/roll/skip) instead of a fresh full digest each press (PLAN §7). */
  continuous = $state(true) // Auto-update on by default; a user-made choice overrides
  continuousSet = $state(false)
  /** Feed only thread OPs to the classifier (a reply is anchored to its root),
   * not the replies themselves. Reply text ("lol yes", "exactly") is noise that
   * muddies clustering even with parent context inlined; the substantive OP is
   * the right unit of a "conversation". Replies fold back into their OP's
   * conversation structurally in the graph. */
  opsOnly = $state(true)
  /** Per-post labeling mode: label each OP individually (many tiny prompts),
   * then group shared labels into conversations (PLAN §7 variant). More robust
   * on a small local model than the one-shot clustering prompt.
   * NOTE: cluster mode is disabled for now — label mode is the only path (better
   * quality + far cheaper on a CPU box). Forced on below; the cluster code
   * (summarizeFeed / rollFeed / the rolling engine) is left intact to restore. */
  labelMode = $state(true)
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
  /** Which model produced the cached labels — if the user switches the label
   * model, the cache is invalidated so posts get re-labeled by the new model. */
  #labelModelUsed = ''
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
    if (typeof p.ollamaModelPinned === 'boolean') this.ollamaModelPinned = p.ollamaModelPinned
    if (typeof p.ollamaLabelModel === 'string') this.ollamaLabelModel = p.ollamaLabelModel
    if (typeof p.ollamaLabelModelPinned === 'boolean') this.ollamaLabelModelPinned = p.ollamaLabelModelPinned
    if (typeof p.ollamaUrl === 'string') this.ollamaUrl = p.ollamaUrl
    if (typeof p.window === 'number' && p.window > 0) this.window = p.window
    // Only honor a persisted `continuous` the user actually chose: the old
    // format wrote the then-default (false) on every load for everyone.
    if (typeof p.continuous === 'boolean' && p.continuousSet === true) {
      this.continuous = p.continuous
      this.continuousSet = true
    }
    if (typeof p.opsOnly === 'boolean') this.opsOnly = p.opsOnly
    // Cluster mode disabled for now — ignore any persisted labelMode:false so it
    // can't get stuck off. Re-enable by restoring this line + the panel toggle.
    // if (typeof p.labelMode === 'boolean') this.labelMode = p.labelMode
    if (typeof p.mergeThreshold === 'number') this.mergeThreshold = p.mergeThreshold

    if (typeof localStorage !== 'undefined') {
      $effect.root(() => {
        $effect(() => {
          // NOTE: this store still persists EVERY field on load (the settings
          // store's old v1 landmine) — before changing any default below,
          // either give it a user-set marker like `continuousSet` or move the
          // store to diff-persistence like settings.svelte.ts.
          const data: Persisted = {
            provider: this.provider,
            model: this.model,
            ollamaModel: this.ollamaModel,
            ollamaModelPinned: this.ollamaModelPinned,
            ollamaLabelModel: this.ollamaLabelModel,
            ollamaLabelModelPinned: this.ollamaLabelModelPinned,
            ollamaUrl: this.ollamaUrl,
            window: this.window,
            continuous: this.continuous,
            continuousSet: this.continuousSet,
            opsOnly: this.opsOnly,
            labelMode: this.labelMode,
            mergeThreshold: this.mergeThreshold,
          }
          localStorage.setItem(KEY, JSON.stringify(data))
        })

        // Apply the per-deployment config once it loads (overrides persisted +
        // auto-picked values, so a hosted instance pins its own model/provider).
        $effect(() => {
          const c = deploy.config
          if (!c) return
          if (c.provider === 'anthropic' || c.provider === 'ollama') this.provider = c.provider
          if (c.hideOllama && this.provider === 'ollama') this.provider = 'anthropic'
          if (typeof c.ollamaUrl === 'string') this.ollamaUrl = c.ollamaUrl
          if (typeof c.model === 'string') {
            if (this.provider === 'ollama') {
              this.ollamaModel = c.model
              this.ollamaLabelModel = c.model
              this.ollamaModelPinned = true
              this.ollamaLabelModelPinned = true
            } else {
              this.model = c.model
            }
          }
        })
      })
    }
  }

  /** Query the local Ollama for installed models. Until the user hand-picks a
   * model, keep `ollamaModel` synced to the smallest sensible one (MLX-preferred
   * on a Mac). Also re-syncs if the persisted model isn't actually installed. */
  async refreshOllamaModels() {
    const models = await listOllamaModels(this.ollamaUrl)
    this.ollamaModels = models
    if (models.length === 0) return
    // Clustering wants a capability floor; labeling is happy with the smallest.
    const clusterPick = pickClusterModel(models)
    const labelPick = pickDefaultModel(models)
    const has = (name: string) => models.some((m) => m.name === name)
    // Auto-pick when unpinned, OR when a pinned model has vanished (uninstalled)
    // — in the latter case drop the pin too, so it resumes auto-tracking rather
    // than claiming an auto value is user-pinned.
    if (clusterPick && (!this.ollamaModelPinned || !has(this.ollamaModel))) {
      this.ollamaModel = clusterPick
      this.ollamaModelPinned = false
    }
    if (labelPick && (!this.ollamaLabelModelPinned || !has(this.ollamaLabelModel))) {
      this.ollamaLabelModel = labelPick
      this.ollamaLabelModelPinned = false
    }
  }

  /** The user explicitly chose a model (typed or picked) — stop auto-selecting. */
  chooseModel(name: string) {
    this.ollamaModel = name
    this.ollamaModelPinned = true
  }
  chooseLabelModel(name: string) {
    this.ollamaLabelModel = name
    this.ollamaLabelModelPinned = true
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

  /** Opts for the per-post label task — same as #opts but with the (usually
   * smaller) label model on the Ollama path; falls back to the main model. */
  #labelOpts(postByUri?: Map<string, FeedItem>): SummarizeOpts {
    const o = this.#opts(undefined, postByUri)
    if (this.provider === 'ollama') o.model = this.ollamaLabelModel || this.ollamaModel
    return o
  }

  /** `contextByUri` resolves reply parents so their text is fed to the classifier. */
  async summarize(items: FeedItem[], contextByUri?: Map<string, FeedItem>) {
    if (this.loading || items.length === 0) return
    this.loading = true
    this.error = undefined
    this.streamText = ''
    try {
      if (this.labelMode) {
        await this.#labelIngest(items, contextByUri)
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
  async #labelIngest(items: FeedItem[], contextByUri?: Map<string, FeedItem>) {
    this.#lastLabelItems = items
    // If the label model changed, the cached labels (and their embeddings) are
    // from a different model — drop them so the new model re-labels.
    const model = this.provider === 'ollama' ? this.ollamaLabelModel || this.ollamaModel : this.model
    if (model !== this.#labelModelUsed) {
      this.#labels.clear()
      this.#labelVecs.clear()
      this.#labelModelUsed = model
    }
    const posts = () =>
      items.map((i) => ({ uri: i.post.uri, label: this.#labels.get(i.post.uri) ?? '' }))
    this.digest = groupByLabel(posts()) // reflect cached labels immediately
    const todo = items.filter((i) => !this.#labels.has(i.post.uri))
    if (todo.length) {
      await labelFeed(todo, this.#labelOpts(contextByUri), (uri, label) => {
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
