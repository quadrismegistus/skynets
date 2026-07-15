import { getTimeline } from '../api/timeline'
import { isDemo } from '../api/demo'
import { archive } from './archive'

/**
 * Gap-healing backfill (PLAN §6/§7 Phase A2). Page the home timeline *backward*
 * on startup and record each page into the archive, so the corpus includes
 * history from before this session — on a fresh archive it seeds a batch of
 * history; on return it heals the gap since last session.
 *
 * The caveats §7 flagged, handled here:
 * - The timeline is a personalized *view*, not an append-only log, so the stop
 *   condition can't assume ordering. We stop when a run of pages is mostly posts
 *   already archived in a PRIOR session (firstSeen < mountTime) — the overlap
 *   boundary — and otherwise cap at MAX_PAGES (and log that we hit the cap).
 * - Rate limits: throttle between pages, and back off + retry (bounded) on error.
 * - Deleted posts are simply absent and unrecoverable — nothing to do.
 */

const MAX_PAGES = 20
const PAGE_SIZE = 100
const THROTTLE_MS = 800
const BACKOFF_MS = 2500
const MAX_RETRIES = 3
const OVERLAP_STOP = 0.8 // page is "known" if ≥80% is prior-session
const STOP_STREAK = 2 // this many consecutive known pages → done

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface BackfillResult {
  pages: number
  imported: number
  hitCap: boolean
}

export interface BackfillOpts {
  onProgress?: (r: BackfillResult) => void
  throttleMs?: number
  backoffMs?: number
  maxPages?: number
}

export async function backfill(mountTime: number, opts: BackfillOpts = {}): Promise<BackfillResult> {
  const throttle = opts.throttleMs ?? THROTTLE_MS
  const backoff = opts.backoffMs ?? BACKOFF_MS
  const maxPages = opts.maxPages ?? MAX_PAGES
  const result: BackfillResult = { pages: 0, imported: 0, hitCap: false }
  if (isDemo() || !archive.ready) return result

  let cursor: string | undefined
  let knownStreak = 0
  while (result.pages < maxPages) {
    let page: Awaited<ReturnType<typeof getTimeline>> | undefined
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      try {
        page = await getTimeline(cursor, PAGE_SIZE)
        break
      } catch {
        if (retry === MAX_RETRIES) return result // give up gracefully
        if (backoff > 0) await sleep(backoff) // likely rate-limited — back off and retry
      }
    }
    if (!page || page.items.length === 0) break

    const uris = page.items.map((i) => i.post.uri)
    const known = await archive.countKnownBefore(uris, mountTime)
    // One bad post (e.g. an un-cloneable field → the whole tx rejects) must not
    // halt the entire backfill — skip this page's write and keep paging.
    await archive.record(page.items).catch(() => {})

    result.pages++
    result.imported += uris.length - known
    opts.onProgress?.({ ...result })

    cursor = page.cursor
    if (!cursor) break
    if (known >= uris.length * OVERLAP_STOP) {
      if (++knownStreak >= STOP_STREAK) break // reached already-archived history
    } else {
      knownStreak = 0
    }
    if (throttle > 0) await sleep(throttle)
  }
  result.hitCap = result.pages >= maxPages
  return result
}
