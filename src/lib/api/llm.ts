import { AppBskyFeedPost } from '@atproto/api'
import type { FeedItem } from './timeline'
import { isDemo } from './demo'
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

/** Default local model + endpoint. llama3.1:8b (~5GB Q4) fits a 16GB machine
 * and follows the JSON instruction reliably; swap in the panel for others. */
export const DEFAULT_OLLAMA_MODEL = 'llama3.1:8b'
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434'

/** Suggested local models, ordered by appetite, for the panel's datalist. */
export const OLLAMA_MODELS: { id: string; label: string }[] = [
  { id: 'llama3.1:8b', label: 'llama3.1:8b — ~5GB, needs 16GB RAM' },
  { id: 'qwen2.5:7b', label: 'qwen2.5:7b — ~5GB, strong at JSON' },
  { id: 'qwen3:8b', label: 'qwen3:8b — ~5GB, resolves subtweets well' },
  { id: 'qwen3:4b', label: 'qwen3:4b — ~3GB, for 8GB RAM' },
  { id: 'gemma3:4b', label: 'gemma3:4b — ~3GB, for 8GB RAM' },
  { id: 'gemma3:12b', label: 'gemma3:12b — ~8GB, needs a GPU/32GB' },
]

const ENDPOINT = 'https://api.anthropic.com/v1/messages'

/** JSON schema for the digest, handed to Ollama's `format` so the local model
 * is constrained to valid, parseable output (no truncation/parse fragility). */
const DIGEST_SCHEMA = {
  type: 'object',
  properties: {
    conversations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          summary: { type: 'string' },
          status: { type: 'string', enum: ['heating', 'cooling', 'steady'] },
          postIds: { type: 'array', items: { type: 'integer' } },
        },
        required: ['id', 'label', 'summary', 'status', 'postIds'],
      },
    },
  },
  required: ['conversations'],
} as const

function postText(item: FeedItem): string {
  const rec = item.post.record
  return AppBskyFeedPost.isRecord(rec) ? rec.text : ''
}

/** Compact per-post line for the prompt — a short integer index, author,
 * counts, text. Posts are referenced back by index (not their long at-uri) so
 * the model's answer stays tiny and can't truncate mid-uri; kept terse so 100
 * posts stay ~10k tokens. */
function promptLines(items: FeedItem[]): string {
  return items
    .map((i, n) => {
      const p = i.post
      const handle = p.author.handle
      const t = postText(i).replace(/\s+/g, ' ').slice(0, 280)
      return `[${n}]\t@${handle}\t♥${p.likeCount ?? 0} ↻${p.repostCount ?? 0} ↺${p.replyCount ?? 0}\t${t}`
    })
    .join('\n')
}

const SYSTEM = `You are the interpreter for a Bluesky timeline visualizer. You are given the posts currently in the user's home-feed graph, one per line, tab-separated: [index], author handle, engagement counts, text.

Group them into the handful of distinct CONVERSATIONS actually in play — the discourse-events a person would name if asked "what's the feed about today" (e.g. "a public figure died", "an argument about how people reacted to it", "a tooling release"). A conversation may span replies AND standalone posts that share a subject even without shared vocabulary — resolve subtweets and vague reactions to what they are actually about. Not every post joins one; ignore true one-offs rather than forcing them.

Return ONLY a JSON object, no prose, of the form:
{"conversations":[{"id":"kebab-slug","label":"Short Title","summary":"one sentence, plain and specific","status":"heating|cooling|steady","postIds":[3,7,12]}]}

Rules:
- 2–6 conversations. Order them most-active first.
- label ≤ 4 words. summary ≤ 25 words, concrete, no hedging.
- postIds are the integer [index] values of member posts. Use only indices that appear in the input.
- status: heating if it looks like it's growing, cooling if petering out, else steady.
- If a previous digest is provided, KEEP the same id and label for a conversation that continues, so labels stay stable across calls. Only add/retire conversations as the feed changes.`

function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  if (start === -1) throw new Error('No JSON object in model response')
  const end = text.lastIndexOf('}')
  // An opening brace with no valid close, or a slice that won't parse, is almost
  // always a response truncated by max_tokens — surface something the user can
  // act on rather than the raw parser position.
  const truncated = () =>
    new Error('Model response was cut off before valid JSON (try a smaller feed or a larger model).')
  if (end < start) throw truncated()
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    throw truncated()
  }
}

function coerceDigest(raw: unknown, items: FeedItem[]): Digest {
  const obj = raw as { conversations?: unknown }
  const list = Array.isArray(obj?.conversations) ? obj.conversations : []
  const conversations: Conversation[] = []
  for (const c of list) {
    const conv = c as { id?: unknown; label?: unknown; summary?: unknown; status?: unknown; postIds?: unknown }
    const ids = Array.isArray(conv.postIds) ? conv.postIds : []
    // Map indices back to URIs; an out-of-range or non-integer index is simply
    // dropped, so the model cannot reference a post it wasn't given.
    const kept: string[] = []
    for (const id of ids) {
      if (Number.isInteger(id) && id >= 0 && id < items.length) kept.push(items[id].post.uri)
    }
    if (kept.length === 0) continue
    const status: ConvoStatus =
      conv.status === 'heating' || conv.status === 'cooling' ? conv.status : 'steady'
    conversations.push({
      id: typeof conv.id === 'string' && conv.id ? conv.id : `c${conversations.length}`,
      label: typeof conv.label === 'string' ? conv.label : 'Untitled',
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
}

/** The user-turn content: the numbered feed plus, optionally, the prior
 * conversation labels (id+label only — the old post indices are stale). */
function userContent(items: FeedItem[], previous?: Digest): string {
  const prevJson = previous
    ? `\n\nPrevious conversations (reuse id+label if the topic continues):\n${JSON.stringify(
        previous.conversations.map((c) => ({ id: c.id, label: c.label })),
      )}`
    : ''
  return `Posts:\n${promptLines(items)}${prevJson}`
}

/**
 * Summarize a feed into conversations. In demo mode — or when the chosen
 * provider isn't configured (no Anthropic key) — returns a deterministic offline
 * digest so the UI and e2e work without a network call.
 */
export async function summarizeFeed(items: FeedItem[], opts: SummarizeOpts): Promise<Digest> {
  if (isDemo()) return demoDigest(items)
  const content = userContent(items, opts.previous)
  if (opts.provider === 'ollama') return summarizeOllama(items, content, opts)
  if (!opts.apiKey) return demoDigest(items)
  return summarizeAnthropic(items, content, opts)
}

async function summarizeAnthropic(items: FeedItem[], content: string, opts: SummarizeOpts): Promise<Digest> {
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
      system: SYSTEM,
      messages: [{ role: 'user', content }],
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Anthropic API ${res.status}: ${detail.slice(0, 200) || res.statusText}`)
  }
  const data = (await res.json()) as { content?: { type: string; text?: string }[] }
  const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
  return coerceDigest(extractJson(text), items)
}

async function summarizeOllama(items: FeedItem[], content: string, opts: SummarizeOpts): Promise<Digest> {
  const base = (opts.ollamaUrl || DEFAULT_OLLAMA_URL).replace(/\/$/, '')
  let res: Response
  try {
    res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        // Constrain output to the schema — the local model can't return
        // unparseable JSON — and lift the default 2048 context so a full feed
        // isn't silently truncated.
        format: DIGEST_SCHEMA,
        // Disable extended reasoning: on a thinking model (qwen3, deepseek-r1)
        // the reasoning trace turns a ~15s clustering call into minutes for no
        // quality gain on this task; non-thinking models ignore the flag.
        think: false,
        options: { temperature: 0.2, num_ctx: 8192 },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content },
        ],
      }),
    })
  } catch {
    // A browser-level failure here is nearly always the environment, not the
    // request: Ollama not running, CORS origin not allowed, or an https page
    // blocked from reaching http://localhost (mixed content).
    throw new Error(
      `Could not reach Ollama at ${base}. Is it running with OLLAMA_ORIGINS set for this origin? (A deployed https page can't call http://localhost.)`,
    )
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Ollama ${res.status}: ${detail.slice(0, 200) || res.statusText}`)
  }
  const data = (await res.json()) as { message?: { content?: string } }
  return coerceDigest(extractJson(data.message?.content ?? ''), items)
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
