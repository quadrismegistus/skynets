import type { Provider } from '../api/llm'

/**
 * Per-deployment config, fetched once at startup from `skynets.config.json` at
 * the app root. Each host drops a different file; the UI adapts. No file (dev /
 * localhost) → everything is unlocked and configurable, exactly as before.
 *
 *   // a hosted instance with a co-located, proxied Ollama (e.g. lltk.net):
 *   { "provider": "ollama", "ollamaUrl": "/ollama", "model": "qwen2.5:1.5b", "lock": true }
 *   // a cloud-only static deploy that can't reach any local Ollama:
 *   { "provider": "anthropic", "hideOllama": true }
 */
export interface DeployConfig {
  provider?: Provider
  /** Fixed Ollama endpoint (often a same-origin proxy like "/ollama"). */
  ollamaUrl?: string
  /** Fixed model — the deployment's one model; users can't change it. */
  model?: string
  /** Hide the provider/model/URL controls entirely (a locked, shared model). */
  lock?: boolean
  /** Hide the Ollama option (a static https deploy that can't reach localhost). */
  hideOllama?: boolean
}

class Deploy {
  config = $state<DeployConfig | null>(null)
  loaded = $state(false)

  /** Hide the model/provider/URL controls — the deployment fixed the model. */
  get locked(): boolean {
    return !!this.config?.lock
  }
  /** Hide the Ollama provider option (cloud-only deploy). */
  get hideOllama(): boolean {
    return !!this.config?.hideOllama
  }

  constructor() {
    // Browser only — skip under SSR / vitest (node), where there's no origin to
    // resolve the relative URL against.
    if (typeof window === 'undefined' || typeof fetch === 'undefined') {
      this.loaded = true
      return
    }
    const base = import.meta.env.BASE_URL ?? '/'
    fetch(`${base}skynets.config.json`, { cache: 'no-store' })
      .then((r) => (r.ok && r.headers.get('content-type')?.includes('json') ? (r.json() as Promise<DeployConfig>) : null))
      .then((c) => (this.config = c))
      .catch(() => {}) // no file / bad JSON → stay unlocked (dev default)
      .finally(() => (this.loaded = true))
  }
}

export const deploy = new Deploy()
