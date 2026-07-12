import { AppBskyFeedPost } from '@atproto/api'
import type { FeedItem } from './timeline'

export function postText(item: FeedItem): string {
  const rec = item.post.record
  return AppBskyFeedPost.isRecord(rec) ? rec.text : ''
}

/** Display name of the reposter, if this feed item is a repost. */
export function reposter(item: FeedItem): string | undefined {
  const reason = item.reason
  if (reason && reason.$type === 'app.bsky.feed.defs#reasonRepost') {
    const by = reason.by as { displayName?: string; handle?: string }
    return by.displayName || by.handle
  }
  return undefined
}

export function authorName(item: FeedItem): string {
  return item.post.author.displayName || item.post.author.handle
}

/** Link to the post on bsky.app (web). */
export function bskyUrl(item: FeedItem): string {
  const rkey = item.post.uri.split('/').pop()
  return `https://bsky.app/profile/${item.post.author.handle}/post/${rkey}`
}

function createdAtMs(item: FeedItem): number {
  const rec = item.post.record
  const created = AppBskyFeedPost.isRecord(rec) ? rec.createdAt : undefined
  return Date.parse(created ?? item.post.indexedAt)
}

/** Compact relative age, e.g. "just now", "5m", "3h", "2d", "4mo", "1y". */
export function timeAgo(item: FeedItem): string {
  const s = (Date.now() - createdAtMs(item)) / 1000
  if (s < 45) return 'just now'
  const m = s / 60
  if (m < 60) return `${Math.round(m)}m`
  const h = m / 60
  if (h < 24) return `${Math.round(h)}h`
  const d = h / 24
  if (d < 30) return `${Math.round(d)}d`
  const mo = d / 30
  if (mo < 12) return `${Math.round(mo)}mo`
  return `${Math.round(d / 365)}y`
}

/** Full local date/time, for a tooltip. */
export function fullDate(item: FeedItem): string {
  return new Date(createdAtMs(item)).toLocaleString()
}
