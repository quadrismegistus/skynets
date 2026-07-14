import { getAgent } from './agent'
import { isDemo } from './demo'

export interface ProfileView {
  did: string
  viewer?: { following?: string; followedBy?: string }
}

/** Fetch full profiles (authoritative viewer/follow state) for up to 25 dids. */
export async function getProfiles(dids: string[]): Promise<ProfileView[]> {
  if (isDemo() || dids.length === 0) return []
  const res = await getAgent().getProfiles({ actors: dids })
  return res.data.profiles
}

/** A single actor's fuller profile — for the on-hover preview card. */
export interface ProfileDetail {
  did: string
  handle: string
  displayName?: string
  avatar?: string
  description?: string
  followersCount?: number
  followsCount?: number
  postsCount?: number
  viewer?: { following?: string; followedBy?: string }
}

/** Fetch one actor's detailed profile (bio + counts). In demo mode, fabricate a
 * plausible card from the fake handle baked into the did so the hover still
 * shows something. */
export async function getProfileDetail(did: string): Promise<ProfileDetail | undefined> {
  if (isDemo()) {
    const handle = did.replace(/^did:plc:/, '')
    return {
      did,
      handle,
      displayName: handle.split('.')[0].replace(/^\w/, (c) => c.toUpperCase()),
      description: 'Demo account — bio unavailable offline.',
      followersCount: 1200 + (handle.length % 7) * 340,
      followsCount: 300 + (handle.length % 5) * 90,
      postsCount: 800 + (handle.length % 9) * 210,
    }
  }
  try {
    const res = await getAgent().getProfile({ actor: did })
    const p = res.data
    return {
      did: p.did,
      handle: p.handle,
      displayName: p.displayName,
      avatar: p.avatar,
      description: p.description,
      followersCount: p.followersCount,
      followsCount: p.followsCount,
      postsCount: p.postsCount,
      viewer: p.viewer,
    }
  } catch {
    return undefined
  }
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
