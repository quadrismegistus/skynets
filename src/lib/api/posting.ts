import { getAgent } from './agent'
import { isDemo } from './demo'
import type { ReplyTarget } from '../state/compose.svelte'
import type { UploadedImage } from './upload'

/** Max post length in graphemes (Bluesky's limit). */
export const MAX_GRAPHEMES = 300

export function graphemeLength(text: string): number {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return [...new Intl.Segmenter().segment(text)].length
  }
  return [...text].length
}

/**
 * Create a post (optionally a reply). Returns the new post's uri + cid. In demo
 * mode no network call is made — a fake ref is returned so the flow is testable.
 */
export interface QuoteTarget {
  uri: string
  cid: string
}

export async function createPost(
  text: string,
  reply: ReplyTarget | null,
  quote: QuoteTarget | null = null,
  facets?: unknown[],
  images: UploadedImage[] = [],
): Promise<{ uri: string; cid: string }> {
  if (isDemo()) {
    const id = `${Date.now()}`
    return { uri: `at://did:plc:demo/app.bsky.feed.post/${id}`, cid: `demo-${id}` }
  }
  const record: { text: string; reply?: unknown; embed?: unknown; facets?: unknown[] } = { text }
  if (facets && facets.length) record.facets = facets
  if (reply) {
    record.reply = {
      parent: { uri: reply.uri, cid: reply.cid },
      root: { uri: reply.rootUri, cid: reply.rootCid },
    }
  }

  const media = images.length
    ? {
        $type: 'app.bsky.embed.images',
        images: images.map((i) => ({ image: i.blob, alt: i.alt, aspectRatio: i.aspectRatio })),
      }
    : null
  const recordEmbed = quote
    ? { $type: 'app.bsky.embed.record', record: { uri: quote.uri, cid: quote.cid } }
    : null
  if (media && recordEmbed) {
    record.embed = {
      $type: 'app.bsky.embed.recordWithMedia',
      record: recordEmbed,
      media,
    }
  } else if (media) {
    record.embed = media
  } else if (recordEmbed) {
    record.embed = recordEmbed
  }

  const res = await getAgent().post(record as never)
  return { uri: res.uri, cid: res.cid }
}
