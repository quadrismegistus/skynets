import { centroid, cosine } from './embed'
import type { Digest } from './llm'

export interface LabeledPost {
  uri: string
  label: string
}

/** Default cosine cutoff for merging two labels' embeddings into one topic.
 * all-minilm on short phrases: same-topic pairs cluster well above this, most
 * different-topic pairs below. Exposed as a slider since it's the one knob that
 * wants tuning per-feed. */
export const DEFAULT_MERGE_THRESHOLD = 0.68

const STOP = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'and', 'is', 'it', 'for', 'with',
  'that', 'this', 'my', 'i', 'you', 'we', 'they', 'at', 'as', 'be', 'so', 'but',
  'vs', 'about', 're', 'over',
])

/** Content tokens of a label — lowercased, alnum, stopwords dropped, singularized
 * (naive trailing-s strip) so "tariff" and "tariffs" match. */
function tokens(label: string): Set<string> {
  return new Set(
    label
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .map((w) => w.replace(/s$/, ''))
      .filter((w) => w.length > 1 && !STOP.has(w)),
  )
}

/** Two labels belong together if one token set is a subset of the other, or
 * they overlap by at least half (Jaccard ≥ 0.5). Deterministic, no threshold to
 * tune per-feed and no embedding call — good enough to keep "Trump tariffs" and
 * "Trump tariff threats" from splitting. */
function related(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || !b.size) return false
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  if (inter === 0) return false
  if (inter === a.size || inter === b.size) return true // subset either way
  const union = a.size + b.size - inter
  return inter / union >= 0.5
}

function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'topic'
  )
}

interface Group {
  toks: Set<string>
  uris: string[]
  /** original label → count, to pick the canonical (most common) wording. */
  labels: Map<string, number>
}

/**
 * Group per-post labels into conversations. Posts whose labels are related
 * (see `related`) merge into one conversation; the canonical label is the most
 * common original wording (ties broken by shortest). Order is deterministic:
 * groups are seeded in input order, so a rebuild as labels stream in is stable.
 * Singletons are kept — a conversation of one post is valid (the graph renders
 * it as a caption under the post rather than a pill).
 */
export function groupByLabel(posts: LabeledPost[]): Digest {
  const groups: Group[] = []
  for (const { uri, label } of posts) {
    if (!label) continue
    const toks = tokens(label)
    // Match against each group's SEED token set (never grown). Growing the
    // vocabulary turned a group into an absorbing set — a later single-token
    // label matched any token that had ever entered the group, collapsing
    // unrelated conversations. An all-stopword label (empty token set) can only
    // join a group with the identical normalized label.
    const g = groups.find((grp) =>
      toks.size ? related(grp.toks, toks) : grp.labels.has(label),
    )
    if (g) {
      if (!g.uris.includes(uri)) g.uris.push(uri)
      g.labels.set(label, (g.labels.get(label) ?? 0) + 1)
    } else {
      groups.push({ toks, uris: [uri], labels: new Map([[label, 1]]) })
    }
  }

  const conversations = groups.map((g) => {
    const canonical = [...g.labels.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].length - b[0].length,
    )[0][0]
    return {
      id: slug(canonical),
      label: canonical,
      summary: '',
      status: 'steady' as const,
      postUris: g.uris,
    }
  })
  return { conversations }
}

interface VecCluster {
  vecs: number[][]
  centroid: number[]
  labels: Map<string, number>
  uris: string[]
}

/**
 * Group per-post labels by the cosine similarity of their embeddings — so
 * "Gaza ceasefire" and "Israel–Hamas truce" merge though they share no literal
 * token (which is exactly what the token-overlap grouping misses). Greedy
 * nearest-centroid assignment over unique labels, in first-seen order (stable
 * for a streaming rebuild). Labels with no vector fall back to their own
 * cluster. Canonical label = most common wording. Singletons kept.
 */
export function groupByEmbedding(
  posts: LabeledPost[],
  vecByLabel: Map<string, number[]>,
  threshold = DEFAULT_MERGE_THRESHOLD,
): Digest {
  const clusters: VecCluster[] = []
  const clusterOf = new Map<string, VecCluster>() // label → its cluster

  for (const { uri, label } of posts) {
    if (!label) continue
    let cluster = clusterOf.get(label)
    if (!cluster) {
      const v = vecByLabel.get(label)
      // Find the nearest existing cluster within threshold, else start a new one.
      if (v && v.length) {
        let best: VecCluster | undefined
        let bestSim = threshold
        for (const c of clusters) {
          if (!c.centroid.length) continue
          const s = cosine(v, c.centroid)
          // Strict `>` so ties go to the first-seen cluster — stable across a
          // streaming rebuild (a `>=` let the last-iterated cluster win).
          if (s > bestSim) {
            bestSim = s
            best = c
          }
        }
        if (best) {
          best.vecs.push(v)
          best.centroid = centroid(best.vecs)
          cluster = best
        }
      }
      if (!cluster) {
        cluster = { vecs: v && v.length ? [v] : [], centroid: v && v.length ? v : [], labels: new Map(), uris: [] }
        clusters.push(cluster)
      }
      clusterOf.set(label, cluster)
    }
    if (!cluster.uris.includes(uri)) cluster.uris.push(uri)
    cluster.labels.set(label, (cluster.labels.get(label) ?? 0) + 1)
  }

  const conversations = clusters.map((c) => {
    const canonical = [...c.labels.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].length - b[0].length,
    )[0][0]
    return {
      id: slug(canonical),
      label: canonical,
      summary: '',
      status: 'steady' as const,
      postUris: c.uris,
    }
  })
  return { conversations }
}
