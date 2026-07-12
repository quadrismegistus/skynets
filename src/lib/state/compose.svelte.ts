import { AppBskyFeedPost } from '@atproto/api'
import type { FeedItem } from '../api/timeline'
import { session } from './session.svelte'

export interface ReplyTarget {
  uri: string
  cid: string
  rootUri: string
  rootCid: string
  item: FeedItem
}

/** Reply refs for a post: parent is the target, root is its thread root. */
export function toReplyTarget(item: FeedItem): ReplyTarget {
  const p = item.post
  const rec = p.record
  const root =
    AppBskyFeedPost.isRecord(rec) && rec.reply ? rec.reply.root : { uri: p.uri, cid: p.cid }
  return { uri: p.uri, cid: p.cid, rootUri: root.uri, rootCid: root.cid, item }
}

/** An optimistic FeedItem for a post we just made, so it shows immediately. */
export function buildSelfPost(
  text: string,
  uri: string,
  cid: string,
  reply: ReplyTarget | null,
): FeedItem {
  const createdAt = new Date().toISOString()
  const record: Record<string, unknown> = { $type: 'app.bsky.feed.post', text, createdAt }
  if (reply) {
    record.reply = {
      parent: { uri: reply.uri, cid: reply.cid },
      root: { uri: reply.rootUri, cid: reply.rootCid },
    }
  }
  return {
    post: {
      uri,
      cid,
      author: {
        did: session.did ?? 'did:self',
        handle: session.handle ?? 'you',
        displayName: session.displayName,
        avatar: session.avatar,
      },
      record,
      replyCount: 0,
      repostCount: 0,
      likeCount: 0,
      indexedAt: createdAt,
    },
  } as unknown as FeedItem
}

/** Modal state + optimistically-injected posts the graph merges in. */
class ComposeState {
  open = $state(false)
  reply = $state<ReplyTarget | null>(null)
  quote = $state<FeedItem | null>(null)
  injected = $state<FeedItem[]>([])

  openNew() {
    this.reply = null
    this.quote = null
    this.open = true
  }
  openReply(item: FeedItem) {
    this.quote = null
    this.reply = toReplyTarget(item)
    this.open = true
  }
  openQuote(item: FeedItem) {
    this.reply = null
    this.quote = item
    this.open = true
  }
  close() {
    this.open = false
    this.reply = null
    this.quote = null
  }
  inject(item: FeedItem) {
    this.injected = [item, ...this.injected]
  }
}

export const compose = new ComposeState()
