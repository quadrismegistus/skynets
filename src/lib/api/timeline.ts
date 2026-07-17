import { getAgent } from './agent'
import { demoFeed, isDemo } from './demo'
import type { AppBskyFeedDefs } from '@atproto/api'

export type FeedItem = AppBskyFeedDefs.FeedViewPost

export interface TimelinePage {
  items: FeedItem[]
  cursor?: string
}

/** Sentinel for the home ("Following") timeline — distinct from a feed AT-uri. */
export const FOLLOWING = 'following'

/**
 * Fetch one page of the authenticated user's home timeline.
 * Pass the previous page's `cursor` to page backwards in time.
 */
export async function getTimeline(cursor?: string, limit = 30): Promise<TimelinePage> {
  if (isDemo()) return { items: demoFeed(), cursor: undefined }
  const res = await getAgent().getTimeline({ cursor, limit })
  return { items: res.data.feed, cursor: res.data.cursor }
}

/**
 * Fetch one page of a feed. `feed` is a feed-generator AT-uri, or the sentinel
 * `FOLLOWING` for the home timeline (which uses a different endpoint). A saved
 * feed's `value` IS its AT-uri, so the caller can pass `feeds.active` directly.
 */
export async function getFeedPage(feed: string, cursor?: string, limit = 30): Promise<TimelinePage> {
  if (isDemo()) return { items: demoFeed(), cursor: undefined }
  if (feed === FOLLOWING) return getTimeline(cursor, limit)
  const res = await getAgent().app.bsky.feed.getFeed({ feed, cursor, limit })
  return { items: res.data.feed, cursor: res.data.cursor }
}
