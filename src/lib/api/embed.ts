import { isDemo } from './demo'
import { DEFAULT_OLLAMA_URL } from './llm'

/**
 * Local text embeddings via Ollama's `/api/embed`. Used as the always-on cheap
 * signal for the continuous digest's novelty gate (PLAN §7): decide *when* the
 * LLM should (re)run, never to assign posts to clusters (per-post embedding
 * routing is too noisy — the gate is a batch-aggregate judgment only).
 *
 * all-minilm (MiniLM-L6, ~45MB) benchmarked best for this — better than the
 * larger mxbai, whose compressed cosine range hurts discrimination. Runs through
 * the same Ollama the LLM uses, so the whole pipeline stays local and $0.
 */
export const DEFAULT_EMBED_MODEL = 'all-minilm'

export interface EmbedOpts {
  ollamaUrl?: string
  model?: string
}

export function norm(v: number[]): number[] {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return v.map((x) => x / n)
}

export function cosine(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i]
  return s
}

/** Mean of unit vectors, re-normalized — a cluster centroid. Vectors whose
 * dimension doesn't match the first (a stale vector from a different embed
 * model, or a demo/real mix) are skipped rather than poisoning the mean with
 * NaN. */
export function centroid(vectors: number[][]): number[] {
  if (vectors.length === 0) return []
  const d = vectors[0].length
  const c = new Array(d).fill(0)
  let n = 0
  for (const v of vectors) {
    if (v.length !== d) continue
    for (let k = 0; k < d; k++) c[k] += v[k]
    n++
  }
  if (n === 0) return []
  for (let k = 0; k < d; k++) c[k] /= n
  return norm(c)
}

/** A stable pseudo-embedding for demo/offline mode: hashes the text into a small
 * unit vector so gate/merge logic is exercised deterministically without Ollama. */
function demoEmbed(text: string, d = 32): number[] {
  const v = new Array(d).fill(0)
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    v[c % d] += 1
    v[(c * 7 + i) % d] += 0.5
  }
  return norm(v)
}

/** Embed a batch of texts to unit vectors. Order matches the input. */
export async function embedTexts(texts: string[], opts: EmbedOpts = {}): Promise<number[][]> {
  if (texts.length === 0) return []
  if (isDemo()) return texts.map((t) => demoEmbed(t))
  const base = (opts.ollamaUrl || DEFAULT_OLLAMA_URL).replace(/\/$/, '')
  let res: Response
  try {
    res = await fetch(`${base}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: opts.model || DEFAULT_EMBED_MODEL, input: texts }),
    })
  } catch {
    throw new Error(
      `Could not reach Ollama at ${base} for embeddings. Is it running, and is the model pulled (ollama pull ${opts.model || DEFAULT_EMBED_MODEL})?`,
    )
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Ollama embed ${res.status}: ${detail.slice(0, 160) || res.statusText}`)
  }
  const data = (await res.json()) as { embeddings?: number[][] }
  const out = (data.embeddings ?? []).map(norm)
  // A 200 with a missing/short embeddings array (wrong or unpulled model) must
  // NOT pass silently — callers rely on 1:1 alignment with `texts`, and a
  // partial result would misalign vectors or wipe out grouping. Fail loudly so
  // the caller's fallback (e.g. token grouping) can take over.
  if (out.length !== texts.length) {
    throw new Error(
      `Ollama embed returned ${out.length} vectors for ${texts.length} inputs (is "${opts.model || DEFAULT_EMBED_MODEL}" pulled?).`,
    )
  }
  return out
}

/**
 * The novelty gate: given new posts' vectors and the existing clusters'
 * centroids, what fraction of the batch sits far from every centroid? A
 * high fraction means genuinely-new content (→ run the LLM); a low fraction
 * means continuations/nothing-new (→ skip and buffer). Aggregate only — never
 * used to route individual posts.
 *
 * `nearThreshold` (~0.30) is the per-post "is this near any cluster" line;
 * `rollFraction` (~0.4) is the batch decision. Both from PLAN §7 measurements.
 */
export interface GateResult {
  novelCount: number
  total: number
  novelFraction: number
  shouldRoll: boolean
}

export function noveltyGate(
  newVectors: number[][],
  centroids: number[][],
  nearThreshold = 0.3,
  rollFraction = 0.4,
): GateResult {
  const total = newVectors.length
  if (total === 0) return { novelCount: 0, total: 0, novelFraction: 0, shouldRoll: false }
  // With no existing clusters yet, everything is novel → must establish.
  if (centroids.length === 0) return { novelCount: total, total, novelFraction: 1, shouldRoll: true }
  let novel = 0
  for (const v of newVectors) {
    const best = Math.max(...centroids.map((c) => cosine(v, c)))
    if (best < nearThreshold) novel++
  }
  const frac = novel / total
  return { novelCount: novel, total, novelFraction: frac, shouldRoll: frac >= rollFraction }
}
