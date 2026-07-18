import { isDemo } from './demo'
import { localEmbed } from './localEmbed'

/**
 * Text embeddings, computed ON THIS DEVICE (see ./localEmbed + the worker).
 *
 * Two jobs: merging topic labels that mean the same thing without sharing a
 * word, and — on the currently-parked cluster path — the novelty gate that
 * decides *when* the LLM should re-run. Aggregate judgments only; embeddings
 * never route individual posts (PLAN §7: per-post routing is too noisy).
 *
 * MiniLM-L6 benchmarked best here, better than the larger mxbai whose
 * compressed cosine range hurts discrimination. It used to run through Ollama,
 * which meant the text left the machine; it is now the same model running in a
 * worker, so the vectors are the same 384-dim space and nothing is sent.
 */
export const DEFAULT_EMBED_MODEL = 'all-MiniLM-L6-v2'

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

/**
 * Embed a batch of texts to unit vectors, ON THIS DEVICE. Order matches input.
 *
 * This used to POST to Ollama, which meant the text left the machine. It now
 * runs all-MiniLM-L6-v2 in a worker via transformers.js — the same model, so
 * vectors stay in the same 384-dim space and anything already cached (in the
 * archive, or in the digest's label→vector map) is still valid, as is the
 * road-tested 0.68 merge threshold.
 *
 * There is deliberately no network fallback. If the local model can't load, the
 * caller falls back to token-overlap grouping, which is worse but is also local
 * — degrading from "on-device" to "sends your text to a server" would be a
 * privacy regression triggered by a flaky download, which is not a trade anyone
 * opted into.
 */
export async function embedTexts(texts: string[], opts: EmbedOpts = {}): Promise<number[][]> {
  void opts // ollamaUrl is vestigial now; kept so callers need no change
  if (texts.length === 0) return []
  if (isDemo()) return texts.map((t) => demoEmbed(t))
  const out = (await localEmbed(texts)).map(norm)
  // Callers rely on 1:1 alignment with `texts` — a partial result would
  // misalign vectors and silently corrupt grouping. Fail loudly instead.
  if (out.length !== texts.length) {
    throw new Error(`Local embedding returned ${out.length} vectors for ${texts.length} inputs`)
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
