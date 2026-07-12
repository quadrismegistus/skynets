import { AppBskyFeedDefs } from '@atproto/api'
import { getAgent } from './agent'
import { isDemo } from './demo'
import type { FeedItem } from './timeline'

/**
 * Flatten a getPostThread response (a nested ThreadViewPost tree) into a flat
 * list of FeedItems. NotFound/Blocked nodes are skipped. The reply structure is
 * carried in each post's record (reply.parent/root), so buildGraph re-threads them.
 */
export function flattenThread(root: unknown): FeedItem[] {
  const out: FeedItem[] = []
  const walk = (node: unknown) => {
    if (AppBskyFeedDefs.isThreadViewPost(node)) {
      out.push({ post: node.post } as FeedItem)
      for (const reply of node.replies ?? []) walk(reply)
    }
  }
  walk(root)
  return out
}

/**
 * Fetch a full conversation via getPostThread. In demo mode there is nothing to fetch.
 */
export async function fetchThread(uri: string): Promise<FeedItem[]> {
  if (isDemo()) return []
  const res = await getAgent().getPostThread({ uri, depth: 6, parentHeight: 0 })
  return flattenThread(res.data.thread)
}
