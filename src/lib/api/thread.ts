import { AppBskyFeedDefs } from '@atproto/api'
import { getAgent } from './agent'
import { isDemo } from './demo'
import type { FeedItem } from './timeline'

/**
 * Flatten a getPostThread response into a flat list of FeedItems: the anchor
 * post, its descendants (replies, recursively), and its ancestor chain (each
 * node's `parent`, up to the root). NotFound/Blocked nodes are skipped. The
 * reply structure is carried in each post's record (reply.parent/root), so
 * buildGraph re-threads them.
 */
export function flattenThread(root: unknown): FeedItem[] {
  const out: FeedItem[] = []
  const down = (node: unknown) => {
    if (AppBskyFeedDefs.isThreadViewPost(node)) {
      out.push({ post: node.post } as FeedItem)
      for (const reply of node.replies ?? []) down(reply)
    }
  }
  down(root)
  // Climb the ancestor chain (parents carry no sibling replies, only `parent`).
  if (AppBskyFeedDefs.isThreadViewPost(root)) {
    let up: unknown = root.parent
    while (AppBskyFeedDefs.isThreadViewPost(up)) {
      out.push({ post: up.post } as FeedItem)
      up = up.parent
    }
  }
  return out
}

/**
 * Fetch the conversation around one post: its replies (and theirs, to depth 6)
 * plus its ancestors up to the thread root — but NOT sibling branches, so
 * mapping a post's replies stays scoped to that post rather than unspooling a
 * stranger's entire thread. In demo mode there is nothing to fetch.
 */
export async function fetchThread(uri: string): Promise<FeedItem[]> {
  if (isDemo()) return []
  const res = await getAgent().getPostThread({ uri, depth: 6, parentHeight: 20 })
  return flattenThread(res.data.thread)
}
