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

/** A clustering model wants some capability floor (the one-shot JSON task is
 * hard for tiny models); labeling one post does not. */
export const CLUSTER_MIN_BYTES = 3e9

/**
 * Default LABEL model: the SMALLEST installed build, preferring MLX on a Mac and
 * excluding MLX off a Mac (they won't run). Labeling one post is trivial, so
 * tiny is ideal. Undefined if nothing is installed.
 */
export function pickDefaultModel(models: OllamaModel[], mac: boolean = isMac()): string | undefined {
  if (models.length === 0) return undefined
  const preferred = models.filter((m) => (mac ? isMlxModel(m.name) : !isMlxModel(m.name)))
  const pool = preferred.length ? preferred : models
  return [...pool].sort((a, b) => a.size - b.size)[0]?.name
}

/**
 * Default CLUSTERING model: the smallest build that clears the capability floor
 * (the one-shot JSON task is hard for tiny models), else the largest available.
 * Unlike the label pick, the floor takes precedence over MLX — on a Mac the big
 * models are often plain GGUF, which still run fine there; MLX is only a
 * tiebreak among equally-sized candidates. Off a Mac, MLX is excluded.
 */
export function pickClusterModel(models: OllamaModel[], mac: boolean = isMac()): string | undefined {
  const runnable = mac ? models : models.filter((m) => !isMlxModel(m.name))
  if (runnable.length === 0) return undefined
  const sorted = [...runnable].sort(
    (a, b) => a.size - b.size || Number(isMlxModel(b.name)) - Number(isMlxModel(a.name)),
  )
  const aboveFloor = sorted.filter((m) => m.size >= CLUSTER_MIN_BYTES)
  return (aboveFloor[0] ?? sorted[sorted.length - 1]).name
}

/** Human-readable size, e.g. 1.9 GB. */
export function formatSize(bytes: number): string {
  if (!bytes) return ''
  const gb = bytes / 1e9
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${Math.round(bytes / 1e6)} MB`
}
