import {
  DEFAULT_MODEL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  summarizeFeed,
  type Digest,
  type Provider,
  type SummarizeOpts,
} from '../api/llm'
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
          }
          localStorage.setItem(KEY, JSON.stringify(data))
        })
      })
    }
  }

  #opts(previous?: Digest): SummarizeOpts {
    return {
      provider: this.provider,
      model: this.provider === 'ollama' ? this.ollamaModel : this.model,
      apiKey: this.apiKey,
      ollamaUrl: this.ollamaUrl,
      previous,
    }
  }

  async summarize(items: FeedItem[]) {
    if (this.loading || items.length === 0) return
    this.loading = true
    this.error = undefined
    this.streamText = ''
    try {
      if (this.continuous) {
        // Rolling engine: embed → gate → establish/roll/skip. It maintains its
        // own clusters across calls; we surface them as the digest.
        await this.engine.ingest(items, this.#opts())
        if (this.engine.error) this.error = this.engine.error
        this.digest = this.engine.toDigest()
      } else {
        this.digest = await summarizeFeed(items, this.#opts(this.digest), (raw) => (this.streamText = raw))
      }
      this.ranAt = Date.now()
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Summary failed'
    } finally {
      this.loading = false
      this.streamText = ''
    }
  }

  clear() {
    this.digest = undefined
    this.error = undefined
    this.ranAt = undefined
    this.engine.reset()
  }
}

export const digest = new DigestState()
