import { getAgent } from './agent'
import { isDemo } from './demo'
import type { FeedItem } from './timeline'

/** Fetch posts by uri (batched, 25 per call). Used to pull in reply parents. */
export async function fetchPosts(uris: string[]): Promise<FeedItem[]> {
  if (isDemo() || uris.length === 0) return []
  const out: FeedItem[] = []
  for (let i = 0; i < uris.length; i += 25) {
    const chunk = uris.slice(i, i + 25)
    try {
      const res = await getAgent().getPosts({ uris: chunk })
      for (const post of res.data.posts) out.push({ post } as FeedItem)
    } catch {
      // Skip a bad batch; the rest still resolve.
    }
  }
  return out
}
