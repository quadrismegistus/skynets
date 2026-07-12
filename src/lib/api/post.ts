import {
  AppBskyEmbedExternal,
  AppBskyEmbedImages,
  AppBskyEmbedRecord,
  AppBskyEmbedRecordWithMedia,
  AppBskyFeedPost,
} from '@atproto/api'
import type { FeedItem } from './timeline'

export function postText(item: FeedItem): string {
  const rec = item.post.record
  return AppBskyFeedPost.isRecord(rec) ? rec.text : ''
}

/** Rich-text facets stored on the post record, if any. */
export function postFacets(item: FeedItem): unknown {
  const rec = item.post.record
  return AppBskyFeedPost.isRecord(rec) ? rec.facets : undefined
}

export interface PostImage {
  thumb: string
  alt: string
}

/** Image thumbnails on a post (direct images embed or record-with-media). */
export function postImages(item: FeedItem): PostImage[] {
  const embed = item.post.embed
  let view: unknown = embed
  if (AppBskyEmbedRecordWithMedia.isView(embed)) view = embed.media
  if (AppBskyEmbedImages.isView(view)) {
    return view.images.map((i) => ({ thumb: i.thumb, alt: i.alt }))
  }
  return []
}

export interface ExternalCard {
  uri: string
  title: string
  description: string
  thumb?: string
}

/** External link-preview card on a post (or record-with-media), if any. */
export function postExternal(item: FeedItem): ExternalCard | null {
  const embed = item.post.embed
  let view: unknown = embed
  if (AppBskyEmbedRecordWithMedia.isView(embed)) view = embed.media
  if (AppBskyEmbedExternal.isView(view)) {
    const e = view.external
    return { uri: e.uri, title: e.title, description: e.description, thumb: e.thumb }
  }
  return null
}

export interface QuotedPost {
  uri: string
  name: string
  handle: string
  text: string
  avatar?: string
}

/** The post quoted by this one (record embed or record-with-media), if any. */
export function postQuote(item: FeedItem): QuotedPost | null {
  const embed = item.post.embed
  let inner: unknown = null
  if (AppBskyEmbedRecord.isView(embed)) inner = embed.record
  else if (AppBskyEmbedRecordWithMedia.isView(embed) && AppBskyEmbedRecord.isView(embed.record)) {
    inner = embed.record.record
  }
  if (AppBskyEmbedRecord.isViewRecord(inner)) {
    const author = inner.author
    const value = inner.value
    const text = AppBskyFeedPost.isRecord(value) ? value.text : ''
    return {
      uri: inner.uri,
      name: author.displayName || author.handle,
      handle: author.handle,
      text,
      avatar: author.avatar,
    }
  }
  return null
}

/** The reposter's profile, if this feed item is a repost. */
export function reposterProfile(
  item: FeedItem,
): { name: string; avatar?: string } | undefined {
  const reason = item.reason
  if (reason && reason.$type === 'app.bsky.feed.defs#reasonRepost') {
    const by = reason.by as { displayName?: string; handle?: string; avatar?: string }
    return { name: by.displayName || by.handle || '', avatar: by.avatar }
  }
  return undefined
}

/** Display name of the reposter, if this feed item is a repost. */
export function reposter(item: FeedItem): string | undefined {
  return reposterProfile(item)?.name || undefined
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
