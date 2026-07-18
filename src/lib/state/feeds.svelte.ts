import { getAgent } from '../api/agent'
import { isDemo } from '../api/demo'
import { FOLLOWING } from '../api/timeline'
import { moderation } from './moderation.svelte'

/** A feed the user can view in the graph. `key` doubles as the fetch target:
 * the sentinel 'following' (home timeline) or a feed-generator AT-uri, so it
 * passes straight to getFeedPage without resolving the list first. */
export interface Feed {
  key: string
  name: string
}

const ACTIVE_KEY = 'mothtrap.activeFeed'
const FOLLOWING_FEED: Feed = { key: FOLLOWING, name: 'Following' }

function readActive(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? FOLLOWING
  } catch {
    return FOLLOWING
  }
}

/**
 * The user's pinned Bluesky feeds, shown as the top tab bar. Following is always
 * first; the rest are their pinned feed generators AND curated lists (the feeds
 * they saved or created), resolved to display names. `active` — the selected
 * feed's key — is both the tab selection and the fetch target, and is persisted
 * so a reload reopens the same feed.
 */
class Feeds {
  list = $state<Feed[]>([FOLLOWING_FEED])
  active = $state<string>(readActive())
  loaded = $state(false)

  setActive(key: string) {
    this.active = key
    try {
      localStorage.setItem(ACTIVE_KEY, key)
    } catch {
      /* private mode — selection just won't persist */
    }
  }

  /** The display name for the active feed (falls back to the key). */
  get activeName(): string {
    return this.list.find((f) => f.key === this.active)?.name ?? 'Feed'
  }

  /** Load the pinned feeds from the account's preferences and resolve names. */
  async load() {
    if (isDemo()) {
      this.loaded = true
      return
    }
    try {
      const agent = getAgent()
      const prefs = await agent.getPreferences()
      // The same response carries the account's moderation settings (labelers,
      // per-label warn/hide, adult opt-in, muted words). Free — no extra call.
      // On failure we fall through to the catch and keep Bluesky's defaults.
      moderation.adopt(prefs.moderationPrefs)
      const out: Feed[] = [FOLLOWING_FEED]
      const feedUris: string[] = []
      const listUris: string[] = []
      for (const s of prefs.savedFeeds) {
        if (!s.pinned) continue
        // 'timeline' is Following (already first).
        if (s.type === 'feed') {
          out.push({ key: s.value, name: shortName(s.value) })
          feedUris.push(s.value)
        } else if (s.type === 'list') {
          out.push({ key: s.value, name: shortName(s.value) })
          listUris.push(s.value)
        }
      }
      // Resolve display names: feed generators in one batch, lists one-by-one
      // (there's no batch getList). Failures keep the short-name fallback.
      const names = new Map<string, string>()
      if (feedUris.length) {
        try {
          const gens = await agent.app.bsky.feed.getFeedGenerators({ feeds: feedUris })
          for (const g of gens.data.feeds) names.set(g.uri, g.displayName)
        } catch {
          /* keep fallbacks */
        }
      }
      if (listUris.length) {
        const resolved = await Promise.all(
          listUris.map((uri) =>
            agent.app.bsky.graph
              .getList({ list: uri, limit: 1 })
              .then((r) => [uri, r.data.list.name] as const)
              .catch(() => undefined),
          ),
        )
        for (const r of resolved) if (r) names.set(r[0], r[1])
      }
      for (const f of out) {
        const dn = names.get(f.key)
        if (dn) f.name = dn
      }
      this.list = out
      // A previously-pinned feed the user has since removed → fall back to Following.
      if (!out.some((f) => f.key === this.active)) this.setActive(FOLLOWING)
    } catch {
      /* preferences unavailable — Following-only is a safe default */
    } finally {
      this.loaded = true
    }
  }
}

/** Last path segment of a feed uri, as a placeholder until the real name loads. */
function shortName(uri: string): string {
  return uri.split('/').pop() || 'Feed'
}

export const feeds = new Feeds()
