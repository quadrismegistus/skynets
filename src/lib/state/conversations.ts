import { AppBskyFeedPost } from '@atproto/api'
import type { FeedItem } from '../api/timeline'
import { parentUriOf, rootUriOf } from './graph'
import { postScoreRate } from './score'

/**
 * The conversation model (PLAN §8): the graph as a first-class data structure.
 *
 * Every display decision this app makes — what to show, what to collapse, what
 * to unroll — is really a decision about CONVERSATIONS, but the old pipeline
 * ranked posts and discovered conversation shapes late (after selection,
 * during chain-climbs, across async fetches). Each layer knew a little; none
 * knew the whole; mega-threads and reply-flooding accounts slipped through
 * every local cap.
 *
 * Here the components are computed once, with global knowledge:
 * connected components over the union of DECLARED thread roots (reply.root
 * refs, present even when the chain's middle is unloaded) and loaded parent
 * links. A partially-fetched mega-thread is ONE conversation here, not a
 * confetti of fragments.
 */

export interface Conversation {
  /** Component id: the canonical (declared or connectivity) root uri. */
  id: string
  /** True if any member is a primary (your own / timeline) post. Context-only
   * conversations are never ranked on their own merits. */
  hasPrimary: boolean
  /** Loaded members, oldest first. */
  members: FeedItem[]
  /** Topmost loaded post (the OP when loaded; else the earliest ancestor we have). */
  root: FeedItem
  /** Loudest engagement among members (rate-scored, same as node scoring). */
  score: number
  /** Newest member timestamp. */
  lastActivity: number
  /** Post count per author did — the reply-flood signal. */
  authors: Map<string, number>
  /** The author did contributing the most members. */
  dominantAuthor: string
}

function timestampOf(item: FeedItem): number {
  const rec = item.post.record
  const created = AppBskyFeedPost.isRecord(rec) ? rec.createdAt : undefined
  return Date.parse(created ?? item.post.indexedAt) || 0
}

/** Group loaded items into conversations: union by declared root AND loaded
 * parent links, so fragments of one thread merge even with unloaded middles.
 * When `primaryUris` is given, score/lastActivity rank on PRIMARY members only
 * (your feed's posts) — a loud stranger's OP pulled in as context must not buy
 * its conversation a better seat. */
export function buildConversations(items: FeedItem[], primaryUris?: ReadonlySet<string>): Conversation[] {
  const byUri = new Map<string, FeedItem>()
  for (const it of items) if (!byUri.has(it.post.uri)) byUri.set(it.post.uri, it)
  const unique = [...byUri.values()]

  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r) as string
    while (parent.get(x) !== r) {
      const n = parent.get(x) as string
      parent.set(x, r)
      x = n
    }
    return r
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  // Keys: every loaded post uri + every declared root uri (loaded or not).
  const ensure = (u: string) => {
    if (!parent.has(u)) parent.set(u, u)
  }
  for (const it of unique) {
    const u = it.post.uri
    ensure(u)
    const declared = rootUriOf(it)
    ensure(declared)
    union(u, declared)
    const p = parentUriOf(it)
    if (p) {
      ensure(p)
      union(u, p)
    }
  }

  const groups = new Map<string, FeedItem[]>()
  for (const it of unique) {
    const key = find(it.post.uri)
    const g = groups.get(key)
    if (g) g.push(it)
    else groups.set(key, [it])
  }

  const out: Conversation[] = []
  for (const members of groups.values()) {
    members.sort((a, b) => timestampOf(a) - timestampOf(b))
    const loaded = new Set(members.map((m) => m.post.uri))
    // Topmost loaded: a member whose parent isn't loaded (the earliest such).
    const root = members.find((m) => {
      const p = parentUriOf(m)
      return !p || !loaded.has(p)
    }) ?? members[0]
    const authors = new Map<string, number>()
    for (const m of members) {
      const did = m.post.author.did
      authors.set(did, (authors.get(did) ?? 0) + 1)
    }
    let dominantAuthor = members[0].post.author.did
    for (const [did, n] of authors) if (n > (authors.get(dominantAuthor) ?? 0)) dominantAuthor = did
    const rankable = primaryUris ? members.filter((m) => primaryUris.has(m.post.uri)) : members
    const forRank = rankable.length ? rankable : members
    out.push({
      id: find(members[0].post.uri),
      hasPrimary: !primaryUris || rankable.length > 0,
      members,
      root,
      score: Math.max(...forRank.map((m) => postScoreRate(m))),
      lastActivity: Math.max(...forRank.map((m) => timestampOf(m))),
      authors,
      dominantAuthor,
    })
  }
  return out
}

/** How much of a conversation the view draws. */
export type Resolution = 'full' | 'rep' | 'hidden'

export interface PlannedConvo {
  convo: Conversation
  level: Resolution
  /** The members the view materializes ('rep' = just the root). */
  nodes: FeedItem[]
}

export interface PlanOpts {
  /** Total node slots the viewport affords. */
  budget: number
  /** 'full' trees only for conversations up to this many loaded members. */
  autoUnrollMax?: number
  /** An author DOMINATING more than this many ranked conversations gets the
   * surplus deprioritized to the back of the queue — the reply-flood guard
   * (one bot's thirty 2-post conversations must not fill the window). */
  perAuthorMax?: number
  /** Conversation ids the user manually mapped — always planned 'full'. */
  forceFull?: ReadonlySet<string>
  ranking?: 'top' | 'recent' | 'mix'
  /** Turnover: rotate the ranked list so the queue cycles through ('n' key). */
  offset?: number
}

/**
 * The view planner (PLAN §8): ONE pass, global knowledge, explicit budget.
 * Ranks conversations (not posts), applies author diversity, then allocates a
 * resolution per conversation until the budget is spent: small conversations
 * draw whole, mega-threads draw as their representative (+N), the rest queue.
 */
export function planView(convos: Conversation[], opts: PlanOpts): PlannedConvo[] {
  const { budget, autoUnrollMax = 10, perAuthorMax = 3, forceFull, ranking = 'mix', offset = 0 } = opts

  const byScore = [...convos].sort((a, b) => b.score - a.score)
  const byTime = [...convos].sort((a, b) => b.lastActivity - a.lastActivity)
  let ranked: Conversation[]
  if (ranking === 'top') ranked = byScore
  else if (ranking === 'recent') ranked = byTime
  else {
    const seen = new Set<string>()
    ranked = []
    const half = Math.ceil(convos.length / 2)
    for (const c of byScore.slice(0, half)) {
      ranked.push(c)
      seen.add(c.id)
    }
    for (const c of byTime) if (!seen.has(c.id)) ranked.push(c)
  }

  // Author diversity: an author's conversations beyond perAuthorMax move to an
  // overflow queue — shown only if room remains once everyone else has a slot.
  const perAuthor = new Map<string, number>()
  const main: Conversation[] = []
  const overflow: Conversation[] = []
  for (const c of ranked) {
    const n = perAuthor.get(c.dominantAuthor) ?? 0
    if (n >= perAuthorMax && !forceFull?.has(c.id)) {
      overflow.push(c)
    } else {
      perAuthor.set(c.dominantAuthor, n + 1)
      main.push(c)
    }
  }

  const out: PlannedConvo[] = []
  let spent = 0
  const rot = main.length ? ((offset % main.length) + main.length) % main.length : 0
  const rotated = [...main.slice(rot), ...main.slice(0, rot)]
  for (const c of [...rotated, ...overflow]) {
    const manual = forceFull?.has(c.id) ?? false
    const wantFull = manual || c.members.length <= autoUnrollMax
    const fullCost = c.members.length
    if (manual) {
      // The user asked for the whole thing — it doesn't compete for budget.
      out.push({ convo: c, level: 'full', nodes: c.members })
      continue
    }
    if (spent >= budget) {
      out.push({ convo: c, level: 'hidden', nodes: [] })
      continue
    }
    if (wantFull && spent + fullCost <= budget) {
      out.push({ convo: c, level: 'full', nodes: c.members })
      spent += fullCost
    } else {
      out.push({ convo: c, level: 'rep', nodes: [c.root] })
      spent += 1
    }
  }
  return out
}
