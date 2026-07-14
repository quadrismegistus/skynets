import { getAgent } from './agent'
import { isDemo } from './demo'

export interface ProfileView {
  did: string
  viewer?: { following?: string }
}

/** Fetch full profiles (authoritative viewer/follow state) for up to 25 dids. */
export async function getProfiles(dids: string[]): Promise<ProfileView[]> {
  if (isDemo() || dids.length === 0) return []
  const res = await getAgent().getProfiles({ actors: dids })
  return res.data.profiles
}

/** All DIDs `actor` follows (paginated, capped) — for the archive's periodic
 * follows-list snapshot (network over time). */
export async function getFollowDids(actor: string): Promise<string[]> {
  if (isDemo()) return []
  const dids: string[] = []
  let cursor: string | undefined
  do {
    const res = await getAgent().getFollows({ actor, cursor, limit: 100 })
    for (const f of res.data.follows) dids.push(f.did)
    cursor = res.data.cursor
  } while (cursor && dids.length < 10_000)
  return dids
}
