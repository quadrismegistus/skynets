import { getAgent } from './agent'
import type { AppBskyFeedDefs } from '@atproto/api'

export type FeedItem = AppBskyFeedDefs.FeedViewPost

export interface TimelinePage {
  items: FeedItem[]
  cursor?: string
}

/**
 * Fetch one page of the authenticated user's home timeline.
 * Pass the previous page's `cursor` to page backwards in time.
 */
export async function getTimeline(cursor?: string, limit = 30): Promise<TimelinePage> {
  const res = await getAgent().getTimeline({ cursor, limit })
  return { items: res.data.feed, cursor: res.data.cursor }
}
