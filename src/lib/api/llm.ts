import { AppBskyFeedPost } from '@atproto/api'
import type { FeedItem } from './timeline'
import { isDemo } from './demo'
import { postQuote } from './post'
import { postScoreRate } from '../state/score'

/**
 * The LLM digest: the feed's day resolved into the handful of distinct
 * "conversations" (discourse-events) actually in play, each labelled and
 * summarized. An LLM does the clustering because it reads deixis and pragmatics
 * that sink sentence embedders on short cryptic posts ("this.", subtweets) — see
 * PLAN §6 Phase E.
 */
export type ConvoStatus = 'heating' | 'cooling' | 'steady'

export interface Conversation {
  /** Stable-ish slug the model reuses across calls so labels don't churn. */
  id: string
  label: string
  summary: string
  status: ConvoStatus
  /** URIs of member posts — validated against the input set (no fabrications). */
  postUris: string[]
}

export interface Digest {
  conversations: Conversation[]
}

/** Where the digest is computed: Anthropic's cloud (BYO key) or a local Ollama. */
export type Provider = 'anthropic' | 'ollama'

/** Cheapest current cloud model — the sane default for a per-fetch summary. */
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

export const MODELS: { id: string; label: string }[] = [
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (cheapest)' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
]

/** Default local model + endpoint. qwen3.5:4b-mlx benchmarked best for this
 * task on Apple Silicon — ~31 tok/s, and it resolved real subtweets (an ICE
 * killing discussed without naming ICE) that a fixture wouldn't reveal; the 9b
 * was ~2.3× slower for no clear quality gain. */
export const DEFAULT_OLLAMA_MODEL = 'qwen3.5:4b-mlx'
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434'

/** Suggested local models, ordered by appetite, for the panel's datalist. */
export const OLLAMA_MODELS: { id: string; label: string }[] = [
  { id: 'qwen3.5:4b-mlx', label: 'qwen3.5:4b-mlx — ~4GB, fast, best tested pick' },
  { id: 'qwen3.5:9b-mlx', label: 'qwen3.5:9b-mlx — ~9GB, richer but ~2× slower' },
  { id: 'llama3.1:8b', label: 'llama3.1:8b — ~5GB, GGUF, needs 16GB RAM' },
  { id: 'qwen2.5:7b', label: 'qwen2.5:7b — ~5GB, strong at JSON' },
  { id: 'gemma3:4b', label: 'gemma3:4b — ~3GB, for 8GB RAM' },
]

const ENDPOINT = 'https://api.anthropic.com/v1/messages'

/** LEAN schema for the local (Ollama) path, handed to `format`. Only the two
 * fields the model must produce — a `label` and the member `postIds`. A heavier
 * schema (id/summary/status) makes MLX's soft grammar drop to prose and fail
 * (measured 0/5 valid vs 5/5 for this lean form — see PLAN §7); everything else
 * is derived client-side. Paired with an EXPLICIT output-shape prompt, which is
 * also load-bearing (a vague prompt fails even this lean schema). */
const LEAN_SCHEMA = {
  type: 'object',
  properties: {
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          postIds: { type: 'array', items: { type: 'integer' } },
        },
        required: ['label', 'postIds'],
      },
    },
  },
  required: ['clusters'],
} as const

function postText(item: FeedItem): string {
  const rec = item.post.record
  return AppBskyFeedPost.isRecord(rec) ? rec.text : ''
}

/** If a post quote-reposts another, the quoted text as an inline tag — a quote
 * post is often just "this 👇" and is meaningless to the classifier without the
 * post it's quoting. Empty string when there's no quote. */
function quoteContext(item: FeedItem): string {
  const q = postQuote(item)
  if (!q || !q.text) return ''
  return ` [quoting @${q.handle}: "${q.text.replace(/\s+/g, ' ').slice(0, 160)}"]`
}

/** Choose an Ollama context window that fits the whole prompt plus room for the
 * JSON answer. Estimate ~4 chars/token, add output headroom, round to a 4k step,
 * and clamp — small enough not to waste memory on a short feed, large enough
 * that a 100-post feed isn't truncated from the left. */
export function contextFor(system: string, content: string): number {
  const promptTokens = Math.ceil((system.length + content.length) / 4)
  const needed = promptTokens + 1536 // output + schema + slack
  const stepped = Math.ceil(needed / 4096) * 4096
  return Math.min(32768, Math.max(8192, stepped))
}

function parentUriOf(item: FeedItem): string | undefined {
  const rec = item.post.record
  return AppBskyFeedPost.isRecord(rec) && rec.reply ? rec.reply.parent.uri : undefined
}

/** Compact per-post line for the prompt — index, author, counts, text. When a
 * post is a reply and its parent is resolvable (via `postByUri`), the parent's
 * text is inlined as context, since a bare reply ("exactly this", "he should be
 * scared") is unclassifiable without it — the whole point. Kept terse. */
function promptLines(items: FeedItem[], postByUri?: Map<string, FeedItem>): string {
  return items
    .map((i, n) => {
      const p = i.post
      const handle = p.author.handle
      let t = postText(i).replace(/\s+/g, ' ').slice(0, 280)
      const pu = parentUriOf(i)
      const parent = pu && postByUri ? postByUri.get(pu) : undefined
      if (parent) {
        const pt = postText(parent).replace(/\s+/g, ' ').slice(0, 160)
        t = `[re @${parent.post.author.handle}: "${pt}"] ${t}`
      }
      t += quoteContext(i)
      return `[${n}]\t@${handle}\t♥${p.likeCount ?? 0} ↻${p.repostCount ?? 0} ↺${p.replyCount ?? 0}\t${t}`
    })
    .join('\n')
}

const CLUSTERING_GUIDANCE = `Group them into the handful of distinct CONVERSATIONS actually in play — the discourse-events a person would name if asked "what's the feed about today" (e.g. "a public figure died", "an argument about how people reacted to it", "a tooling release"). A conversation may span replies AND standalone posts that share a subject even without shared vocabulary — resolve subtweets and vague reactions to what they are actually about. A post prefixed with [re @handle: "..."] is a REPLY — the quoted text is the post it replies to; use it to place the reply correctly. Not every post joins one; ignore true one-offs rather than forcing them.

Rules:
- 2–6 conversations. Order them most-active first.
- label ≤ 4 words.
- postIds are the integer [index] values of member posts. Use only indices that appear in the input.
- If a previous digest is provided, KEEP the same label for a conversation that continues, so labels stay stable across calls. Only add/retire conversations as the feed changes.`

/** Rich prompt for the cloud path (Anthropic), which reliably follows a heavier
 * JSON shape, so we let it produce summary + status directly. */
const RICH_SYSTEM = `You are the interpreter for a Bluesky timeline visualizer. You are given the posts currently in the user's home-feed graph, one per line, tab-separated: [index], author handle, engagement counts, text.

${CLUSTERING_GUIDANCE}

Return ONLY a JSON object, no prose, of the form:
{"conversations":[{"id":"kebab-slug","label":"Short Title","summary":"one sentence, plain and specific","status":"heating|cooling|steady","postIds":[3,7,12]}]}
- summary ≤ 25 words, concrete, no hedging. status: heating if growing, cooling if petering out, else steady.`

/** Lean prompt for the local path (Ollama). Asks ONLY for label + postIds and is
 * EXPLICIT about the exact JSON shape — both are required for MLX reliability
 * (PLAN §7). summary/status/id are derived client-side. */
const LEAN_SYSTEM = `You are the interpreter for a Bluesky timeline visualizer. You are given posts, one per line, tab-separated: [index], author handle, engagement counts, text.

${CLUSTERING_GUIDANCE}

Return ONLY this JSON object, no prose:
{"clusters":[{"label":"Short Title","postIds":[3,7,12]}]}`

/**
 * Pull the first complete JSON value out of a model response. Must be tolerant:
 * Ollama's `format` schema is a HARD grammar only on the llama.cpp/GGUF engine —
 * on the MLX engine it's soft, so a local model there can wrap output in a
 * ```json fence, return a bare array instead of the object, or emit trailing
 * prose. We strip fences, find the first `{` or `[`, and balance-scan (respecting
 * strings/escapes) to its matching close, ignoring anything after.
 */
/** Index of the bracket matching the one at `start`, respecting strings/escapes;
 * -1 if it never closes (truncated). */
function matchClose(t: string, start: number): number {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < t.length; i++) {
    const ch = t[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      if (--depth === 0) return i
    }
  }
  return -1
}

export function extractJson(text: string): unknown {
  let t = text.trim()
  const fence = t.match(/^```[a-z]*\n?/i)
  if (fence) {
    t = t.slice(fence[0].length)
    const close = t.lastIndexOf('```')
    if (close !== -1) t = t.slice(0, close)
    t = t.trim()
  }
  // Every `{`/`[` is a candidate start — the real JSON may follow prose that
  // itself contains braces (`Sure, {here}: {"clusters":…}`), so we can't just
  // lock onto the first bracket. Try each candidate in order; return the first
  // that balance-closes AND parses. Capped so pathological input can't go O(n²).
  const starts: number[] = []
  for (let i = 0; i < t.length && starts.length < 64; i++) {
    if (t[i] === '{' || t[i] === '[') starts.push(i)
  }
  if (starts.length === 0) throw new Error('No JSON in model response')
  let sawTruncation = false
  for (const start of starts) {
    const end = matchClose(t, start)
    if (end === -1) {
      sawTruncation = true
      continue
    }
    try {
      return JSON.parse(t.slice(start, end + 1))
    } catch {
      // Not this fragment — try the next candidate bracket.
    }
  }
  // A candidate opened but never closed → the response was cut off.
  if (sawTruncation) {
    throw new Error('Model response was cut off before valid JSON (try a smaller feed or a larger model).')
  }
  throw new Error('Model response was not valid JSON.')
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'c'
}

function ageHours(item: FeedItem): number {
  const rec = item.post.record
  const created = AppBskyFeedPost.isRecord(rec) ? rec.createdAt : undefined
  return (Date.now() - Date.parse(created ?? item.post.indexedAt)) / 3_600_000
}

/** Derive a status when the model didn't give one (the lean local path): a
 * conversation with a fresh newest post is heating, one whose posts are all old
 * is cooling, else steady. */
function deriveStatus(members: FeedItem[]): ConvoStatus {
  const newest = Math.min(...members.map(ageHours))
  if (newest < 3) return 'heating'
  if (newest > 12) return 'cooling'
  return 'steady'
}

function coerceDigest(raw: unknown, items: FeedItem[]): Digest {
  // Accept the rich `{conversations:[…]}` (cloud), the lean `{clusters:[…]}`
  // (local), or a bare `[…]` array (soft-schema MLX drops the wrapper).
  const obj = raw as { conversations?: unknown; clusters?: unknown }
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(obj?.conversations)
      ? obj.conversations
      : Array.isArray(obj?.clusters)
        ? obj.clusters
        : []
  const conversations: Conversation[] = []
  for (const c of list) {
    const conv = c as { id?: unknown; label?: unknown; summary?: unknown; status?: unknown; postIds?: unknown }
    const ids = Array.isArray(conv.postIds) ? conv.postIds : []
    // Map indices back to URIs; an out-of-range or non-integer index is simply
    // dropped, so the model cannot reference a post it wasn't given.
    const kept: string[] = []
    const members: FeedItem[] = []
    for (const id of ids) {
      if (Number.isInteger(id) && (id as number) >= 0 && (id as number) < items.length) {
        kept.push(items[id as number].post.uri)
        members.push(items[id as number])
      }
    }
    if (kept.length === 0) continue
    const label = typeof conv.label === 'string' ? conv.label : 'Untitled'
    // Use the model's status/summary if it gave them (cloud path); otherwise
    // derive status from recency and leave summary empty (lean local path).
    const status: ConvoStatus =
      conv.status === 'heating' || conv.status === 'cooling' || conv.status === 'steady'
        ? conv.status
        : deriveStatus(members)
    conversations.push({
      id: typeof conv.id === 'string' && conv.id ? conv.id : slug(label),
      label,
      summary: typeof conv.summary === 'string' ? conv.summary : '',
      status,
      postUris: [...new Set(kept)],
    })
  }
  return { conversations }
}

export interface SummarizeOpts {
  provider: Provider
  model: string
  previous?: Digest
  /** Anthropic only. */
  apiKey?: string
  /** Ollama only. */
  ollamaUrl?: string
  /** Resolves reply parents so their text can be inlined as context. */
  postByUri?: Map<string, FeedItem>
}

/** The user-turn content: the numbered feed plus, optionally, the prior
 * conversation labels (id+label only — the old post indices are stale). */
function userContent(items: FeedItem[], previous?: Digest, postByUri?: Map<string, FeedItem>): string {
  const prevJson = previous
    ? `\n\nPrevious conversations (reuse id+label if the topic continues):\n${JSON.stringify(
        previous.conversations.map((c) => ({ id: c.id, label: c.label })),
      )}`
    : ''
  return `Posts:\n${promptLines(items, postByUri)}${prevJson}`
}

/** Called with the accumulated raw model text as it streams in (Ollama path). */
export type OnProgress = (rawText: string) => void

/**
 * Summarize a feed into conversations. In demo mode — or when the chosen
 * provider isn't configured (no Anthropic key) — returns a deterministic offline
 * digest so the UI and e2e work without a network call. When `onProgress` is
 * given, the Ollama path streams raw text back as it generates.
 */
export async function summarizeFeed(
  items: FeedItem[],
  opts: SummarizeOpts,
  onProgress?: OnProgress,
): Promise<Digest> {
  if (isDemo()) return demoDigest(items)
  const content = userContent(items, opts.previous, opts.postByUri)
  if (opts.provider === 'ollama') return summarizeOllama(items, content, opts, onProgress)
  if (!opts.apiKey) return demoDigest(items)
  return summarizeAnthropic(items, content, opts)
}

/** Low-level Anthropic call: returns the parsed JSON value from the response. */
async function anthropicRaw(system: string, content: string, opts: SummarizeOpts): Promise<unknown> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': opts.apiKey as string,
      'anthropic-version': '2023-06-01',
      // Required for browser-origin calls. Named "dangerous" because the key
      // rides in the page — see PLAN §6 Phase E on the XSS exposure.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 2048,
      system,
      messages: [{ role: 'user', content }],
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Anthropic API ${res.status}: ${detail.slice(0, 200) || res.statusText}`)
  }
  const data = (await res.json()) as { content?: { type: string; text?: string }[] }
  const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
  return extractJson(text)
}

/** Low-level Ollama chat call (lean schema + think:false + scaled context),
 * with optional token streaming. Returns the parsed JSON value. */
async function ollamaRaw(
  system: string,
  content: string,
  schema: unknown,
  opts: SummarizeOpts,
  onProgress?: OnProgress,
): Promise<unknown> {
  const base = (opts.ollamaUrl || DEFAULT_OLLAMA_URL).replace(/\/$/, '')
  const stream = !!onProgress
  let res: Response
  try {
    res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        stream,
        format: schema,
        think: false,
        options: { temperature: 0.2, num_ctx: contextFor(system, content) },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content },
        ],
      }),
    })
  } catch {
    throw new Error(
      `Could not reach Ollama at ${base}. Is it running with OLLAMA_ORIGINS set for this origin? (A deployed https page can't call http://localhost.)`,
    )
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Ollama ${res.status}: ${detail.slice(0, 200) || res.statusText}`)
  }
  if (!stream || !res.body) {
    const data = (await res.json()) as { message?: { content?: string } }
    return extractJson(data.message?.content ?? '')
  }
  // Streaming: newline-delimited JSON chunks, each with an incremental
  // message.content token. `thinking` should never appear (think:false) but if
  // it leaks, surface it rather than silently dropping it.
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let full = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let obj: { message?: { content?: string; thinking?: string }; error?: string }
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      if (obj.error) throw new Error(`Ollama: ${obj.error}`)
      if (obj.message?.thinking) full += obj.message.thinking
      const piece = obj.message?.content ?? ''
      if (piece) full += piece
      if (piece || obj.message?.thinking) onProgress?.(full)
    }
  }
  return extractJson(full)
}

async function summarizeAnthropic(items: FeedItem[], content: string, opts: SummarizeOpts): Promise<Digest> {
  return coerceDigest(await anthropicRaw(RICH_SYSTEM, content, opts), items)
}

async function summarizeOllama(
  items: FeedItem[],
  content: string,
  opts: SummarizeOpts,
  onProgress?: OnProgress,
): Promise<Digest> {
  return coerceDigest(await ollamaRaw(LEAN_SYSTEM, content, LEAN_SCHEMA, opts, onProgress), items)
}

// ── Rolling continuation (PLAN §7) ──────────────────────────────────────────
// Incorporate only NEW posts into an existing digest: send the existing labels +
// the new posts, ask "continue an existing conversation or start a new one." The
// balanced prompt (full-digest discipline) + lean output is what makes this
// reliable locally; the engine merges the result and dedups new clusters.

export interface RollUpdate {
  label: string
  /** The model's hint; the engine matches by label, so this is advisory. */
  isNew: boolean
  uris: string[]
}

const ROLL_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          isNew: { type: 'boolean' },
          postIds: { type: 'array', items: { type: 'integer' } },
        },
        required: ['label', 'isNew', 'postIds'],
      },
    },
  },
  required: ['results'],
} as const

const ROLL_SYSTEM = `You maintain a running digest of a Bluesky feed. You are given the conversations already identified (by label), then a batch of NEW posts (numbered [index]). Produce 2–6 conversations TOTAL covering these new posts. Each new post either EXTENDS an existing conversation (reuse its EXACT label — prefer this when it fits) or joins a NEW one you name. Merge related topics into one; every conversation needs at least 2 of the new posts; drop true one-offs. Resolve subtweets and vague reactions to what they are actually about.

Return ONLY this JSON object, no prose:
{"results":[{"label":"Short Title","isNew":true,"postIds":[0,3]}]}`

function rollContent(
  newItems: FeedItem[],
  existing: { label: string; summary?: string }[],
  postByUri?: Map<string, FeedItem>,
): string {
  const ex = existing.map((c) => `"${c.label}"${c.summary ? ` — ${c.summary}` : ''}`).join('\n')
  return `EXISTING CONVERSATIONS:\n${ex || '(none yet)'}\n\nNEW POSTS:\n${promptLines(newItems, postByUri)}`
}

function coerceRoll(raw: unknown, newItems: FeedItem[]): RollUpdate[] {
  const obj = raw as { results?: unknown }
  const list = Array.isArray(raw) ? raw : Array.isArray(obj?.results) ? obj.results : []
  const out: RollUpdate[] = []
  for (const r of list) {
    const rr = r as { label?: unknown; isNew?: unknown; postIds?: unknown }
    const ids = Array.isArray(rr.postIds) ? rr.postIds : []
    const uris: string[] = []
    for (const id of ids) {
      if (Number.isInteger(id) && (id as number) >= 0 && (id as number) < newItems.length) {
        uris.push(newItems[id as number].post.uri)
      }
    }
    if (uris.length === 0) continue
    out.push({
      label: typeof rr.label === 'string' && rr.label ? rr.label : 'Untitled',
      isNew: rr.isNew !== false,
      uris: [...new Set(uris)],
    })
  }
  return out
}

/** Roll a batch of new posts into an existing set of conversations. Returns the
 * changed/new conversations with their new-post URIs; the caller merges. */
export async function rollFeed(
  newItems: FeedItem[],
  existing: { label: string; summary?: string }[],
  opts: SummarizeOpts,
  onProgress?: OnProgress,
): Promise<RollUpdate[]> {
  if (newItems.length === 0) return []
  if (isDemo()) return demoRoll(newItems)
  const content = rollContent(newItems, existing, opts.postByUri)
  if (opts.provider === 'ollama') {
    return coerceRoll(await ollamaRaw(ROLL_SYSTEM, content, ROLL_SCHEMA, opts, onProgress), newItems)
  }
  if (!opts.apiKey) return demoRoll(newItems)
  return coerceRoll(await anthropicRaw(ROLL_SYSTEM, content, opts), newItems)
}

/** Offline roll: one keyword bucket, so demo/e2e exercise the merge path. */
function demoRoll(newItems: FeedItem[]): RollUpdate[] {
  return [{ label: 'New Posts', isNew: true, uris: newItems.map((i) => i.post.uri) }]
}

// ── Per-post labeling (PLAN §7 variant) ─────────────────────────────────────
// Instead of one big clustering prompt, ask the model for a short topic label
// for each OP separately — a trivial task even a small local model nails every
// time, and labels stream in one-by-one. Grouping (by shared label) happens
// client-side in labelGroup.ts, so the model never has to emit an array.

const LABEL_SYSTEM =
  'You label a single social-media post with its topic. Reply with ONLY a 2–4 word topic label — no quotes, no punctuation, no explanation, no "Label:" prefix. Prefer the concrete subject (a person, event, or thing) over a vague category.'

const LABEL_STOP = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'and', 'is', 'it', 'for', 'with',
  'that', 'this', 'my', 'i', 'you', 'we', 'they', 'at', 'as', 'be', 'so', 'but',
])

/** Tidy a raw model label: first line, strip quotes/asterisks/prefixes, cap
 * length. Empty string means "unusable" (caller drops it). */
export function cleanLabel(raw: string): string {
  let s = (raw.split('\n').find((l) => l.trim()) ?? '').trim()
  s = s.replace(/^(label|topic)\s*:\s*/i, '')
  s = s.replace(/^["'`*\s]+|["'`*.\s]+$/g, '')
  s = s.replace(/\s+/g, ' ')
  return s.split(' ').slice(0, 5).join(' ').slice(0, 48)
}

/** Offline/demo label: the first couple of content words, Title-cased. */
function demoLabel(item: FeedItem): string {
  const words = postText(item)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !LABEL_STOP.has(w))
    .slice(0, 2)
  if (!words.length) return 'General chatter'
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
}

/** Plain-text chat completion (no JSON schema) — used for the tiny label task. */
async function chatText(system: string, content: string, opts: SummarizeOpts): Promise<string> {
  if (opts.provider === 'ollama') {
    const base = (opts.ollamaUrl || DEFAULT_OLLAMA_URL).replace(/\/$/, '')
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        think: false,
        options: { temperature: 0.2, num_ctx: contextFor(system, content) },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content },
        ],
      }),
    })
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${res.statusText}`)
    const data = (await res.json()) as { message?: { content?: string } }
    return data.message?.content ?? ''
  }
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': opts.apiKey as string,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 24,
      system,
      messages: [{ role: 'user', content }],
    }),
  })
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${res.statusText}`)
  const data = (await res.json()) as { content?: { type: string; text?: string }[] }
  return (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
}

/** Label one post. Falls back to a deterministic offline label in demo mode or
 * when the cloud provider has no key. */
async function labelOne(item: FeedItem, opts: SummarizeOpts): Promise<string> {
  if (isDemo() || (opts.provider === 'anthropic' && !opts.apiKey)) return demoLabel(item)
  const content = `Post by @${item.post.author.handle}:\n"${postText(item).replace(/\s+/g, ' ').slice(0, 400)}"${quoteContext(item)}`
  return cleanLabel(await chatText(LABEL_SYSTEM, content, opts))
}

/** Called as each post's label lands, so the caller can rebuild the digest
 * progressively (labels appear on the map one-by-one). */
export type OnLabel = (uri: string, label: string) => void

/**
 * Label every post, a few concurrent at a time. A single local model instance
 * serializes anyway, but a small pool keeps its pipe busy across prefills; the
 * cloud can take more. Errors on one post just drop that label.
 */
export async function labelFeed(
  items: FeedItem[],
  opts: SummarizeOpts,
  onLabel?: OnLabel,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const queue = [...items]
  const concurrency = opts.provider === 'anthropic' ? 6 : 2
  const worker = async () => {
    for (;;) {
      const item = queue.shift()
      if (!item) break
      const label = await labelOne(item, opts).catch(() => '')
      if (label) {
        out.set(item.post.uri, label)
        onLabel?.(item.post.uri, label)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return out
}

/** Exemplar posts for a conversation, loudest-by-velocity first. */
export function exemplars(convo: Conversation, byUri: Map<string, FeedItem>, n = 3): FeedItem[] {
  return convo.postUris
    .map((u) => byUri.get(u))
    .filter((i): i is FeedItem => i !== undefined)
    .sort((a, b) => postScoreRate(b) - postScoreRate(a))
    .slice(0, n)
}

/** Stable color per conversation id (hashed hue), shared by the panel and the
 * graph annotation so a conversation reads as the same thing in both. */
export function convoColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return `hsl(${h} 70% 60%)`
}

/** Deterministic offline digest: buckets demo posts by naive keyword so the
 * panel and annotations have something real to render without an API key. */
function demoDigest(items: FeedItem[]): Digest {
  const buckets: { id: string; label: string; summary: string; status: ConvoStatus; match: RegExp }[] = [
    { id: 'the-map-metaphor', label: 'The Map Metaphor', summary: 'Posts about reading the feed as a spatial map of conversations rather than a scroll.', status: 'steady', match: /map|layout|graph|semantic|axis|canvas|node/i },
    { id: 'triage-workflow', label: 'Triage Workflow', summary: 'How dismissing, threading, and the queue make feed triage fast.', status: 'heating', match: /dismiss|thread|queue|triage|engagement|digest|collaps/i },
  ]
  const conversations: Conversation[] = []
  for (const b of buckets) {
    const uris = items.filter((i) => b.match.test(postText(i))).map((i) => i.post.uri)
    if (uris.length) conversations.push({ id: b.id, label: b.label, summary: b.summary, status: b.status, postUris: uris })
  }
  return { conversations }
}
