import { getAgent } from './agent'
import { isDemo } from './demo'

/** Like a post; returns the like record uri (needed to unlike later). */
export async function likePost(uri: string, cid: string): Promise<{ uri: string }> {
  if (isDemo()) return { uri: `at://demo/like/${Date.now()}` }
  return getAgent().like(uri, cid)
}

export async function unlikePost(likeUri: string): Promise<void> {
  if (isDemo()) return
  await getAgent().deleteLike(likeUri)
}

/** Repost a post; returns the repost record uri (needed to un-repost later). */
export async function repostPost(uri: string, cid: string): Promise<{ uri: string }> {
  if (isDemo()) return { uri: `at://demo/repost/${Date.now()}` }
  return getAgent().repost(uri, cid)
}

export async function unrepostPost(repostUri: string): Promise<void> {
  if (isDemo()) return
  await getAgent().deleteRepost(repostUri)
}
