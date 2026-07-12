import type { FeedItem } from '../api/timeline'

/**
 * Engagement score for a post: the geometric mean of its reposts, likes, and
 * replies (each +1 so a zero doesn't zero out the product). Adapted from
 * Mastotron, which borrowed it from mastodon_digest. The geometric mean keeps
 * any single signal from dominating the way a sum would.
 */
export function postScore(item: FeedItem): number {
  const p = item.post
  const reposts = (p.repostCount ?? 0) + 1
  const likes = (p.likeCount ?? 0) + 1
  const replies = (p.replyCount ?? 0) + 1
  return Math.cbrt(reposts * likes * replies)
}
