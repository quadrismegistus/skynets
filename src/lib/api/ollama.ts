import { DEFAULT_OLLAMA_URL } from './llm'

export interface OllamaModel {
  name: string
  /** Size on disk in bytes (0 if unknown). */
  size: number
}

/** List the models installed in the local Ollama (`/api/tags`), smallest first.
 * Returns [] on any error (Ollama not running, wrong origin) so the UI can fall
 * back to free-text entry. */
export async function listOllamaModels(ollamaUrl?: string): Promise<OllamaModel[]> {
  const base = (ollamaUrl || DEFAULT_OLLAMA_URL).replace(/\/$/, '')
  try {
    const res = await fetch(`${base}/api/tags`)
    if (!res.ok) return []
    const data = (await res.json()) as { models?: { name?: string; model?: string; size?: number }[] }
    return (data.models ?? [])
      .map((m) => ({ name: m.name || m.model || '', size: m.size ?? 0 }))
      .filter((m) => m.name)
      .sort((a, b) => a.size - b.size)
  } catch {
    return []
  }
}

/** Whether we're on a Mac (Apple Silicon likely) — MLX builds only run there,
 * so off-Mac we must avoid them. */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  const s = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`
  return /mac|iphone|ipad/i.test(s)
}

export function isMlxModel(name: string): boolean {
  return /mlx/i.test(name)
}

/**
 * Pick a sensible default model from what's installed: the SMALLEST, preferring
 * MLX builds on a Mac and excluding MLX off a Mac (they won't run). Falls back
 * to the smallest overall if the preferred pool is empty. Undefined if nothing
 * is installed.
 */
export function pickDefaultModel(models: OllamaModel[], mac: boolean = isMac()): string | undefined {
  if (models.length === 0) return undefined
  const preferred = models.filter((m) => (mac ? isMlxModel(m.name) : !isMlxModel(m.name)))
  const pool = preferred.length ? preferred : models
  return [...pool].sort((a, b) => a.size - b.size)[0]?.name
}

/** Human-readable size, e.g. 1.9 GB. */
export function formatSize(bytes: number): string {
  if (!bytes) return ''
  const gb = bytes / 1e9
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${Math.round(bytes / 1e6)} MB`
}
