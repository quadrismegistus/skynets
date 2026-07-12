import { SvelteMap } from 'svelte/reactivity'
import { likePost, repostPost, unlikePost, unrepostPost } from '../api/interactions'
import type { FeedItem } from '../api/timeline'

interface Overlay {
  liked: boolean
  likeUri?: string
  reposted: boolean
  repostUri?: string
}

interface Viewer {
  like?: string
  repost?: string
}

function viewerOf(item: FeedItem): Viewer {
  return ((item.post as { viewer?: Viewer }).viewer ?? {}) as Viewer
}

/**
 * Optimistic like/repost state, overlaid on the feed by post uri so we never
 * mutate the feed objects themselves. Reads fall back to the post's own viewer
 * state until the user interacts. Actions update the overlay immediately and
 * roll back if the API call fails.
 */
class Interactions {
  private map = new SvelteMap<string, Overlay>()

  private start(item: FeedItem): Overlay {
    const uri = item.post.uri
    const existing = this.map.get(uri)
    if (existing) return existing
    const v = viewerOf(item)
    return { liked: !!v.like, likeUri: v.like, reposted: !!v.repost, repostUri: v.repost }
  }

  liked(item: FeedItem): boolean {
    return this.map.get(item.post.uri)?.liked ?? !!viewerOf(item).like
  }
  reposted(item: FeedItem): boolean {
    return this.map.get(item.post.uri)?.reposted ?? !!viewerOf(item).repost
  }

  likeCount(item: FeedItem): number {
    const base = item.post.likeCount ?? 0
    const o = this.map.get(item.post.uri)
    if (!o) return base
    return base + (o.liked ? 1 : 0) - (viewerOf(item).like ? 1 : 0)
  }
  repostCount(item: FeedItem): number {
    const base = item.post.repostCount ?? 0
    const o = this.map.get(item.post.uri)
    if (!o) return base
    return base + (o.reposted ? 1 : 0) - (viewerOf(item).repost ? 1 : 0)
  }

  async toggleLike(item: FeedItem) {
    const uri = item.post.uri
    const o = { ...this.start(item) }
    if (o.liked) {
      const del = o.likeUri
      this.map.set(uri, { ...o, liked: false, likeUri: undefined })
      if (del) await unlikePost(del).catch(() => this.map.set(uri, o))
    } else {
      this.map.set(uri, { ...o, liked: true })
      try {
        const res = await likePost(uri, item.post.cid)
        this.map.set(uri, { ...this.map.get(uri)!, likeUri: res.uri })
      } catch {
        this.map.set(uri, o)
      }
    }
  }

  async toggleRepost(item: FeedItem) {
    const uri = item.post.uri
    const o = { ...this.start(item) }
    if (o.reposted) {
      const del = o.repostUri
      this.map.set(uri, { ...o, reposted: false, repostUri: undefined })
      if (del) await unrepostPost(del).catch(() => this.map.set(uri, o))
    } else {
      this.map.set(uri, { ...o, reposted: true })
      try {
        const res = await repostPost(uri, item.post.cid)
        this.map.set(uri, { ...this.map.get(uri)!, repostUri: res.uri })
      } catch {
        this.map.set(uri, o)
      }
    }
  }
}

export const interactions = new Interactions()
