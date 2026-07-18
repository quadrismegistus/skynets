import { AtUri } from '@atproto/api'
import { getAgent } from './agent'
import { isDemo } from './demo'

/**
 * Writes to the user's moderation service. Mirrors api/interactions.ts: thin
 * wrappers over the agent, each demo-guarded, each returning whatever an undo
 * will need (a block is a repo record, so blocking hands back its uri).
 *
 * Reports go to the user's PDS moderation service — Bluesky's, plus any labeler
 * they subscribe to. Mothtrap is a client, not a moderator: acting on a report
 * happens upstream of us, which is also the honest answer to an app-store
 * reviewer asking who responds to reports and how quickly.
 *
 * Nothing here needs an OAuth scope change; `transition:generic` already covers
 * createReport, muteActor and graph.block record writes.
 */

/** The reasons we surface, ordered as they read to someone reporting a post. */
export const REPORT_REASONS = [
  {
    value: 'com.atproto.moderation.defs#reasonSpam',
    label: 'Spam',
    hint: 'Frequent unwanted promotion, replies or mentions',
  },
  {
    value: 'com.atproto.moderation.defs#reasonRude',
    label: 'Harassment',
    hint: 'Rude, harassing, explicit or otherwise unwelcoming behaviour',
  },
  {
    value: 'com.atproto.moderation.defs#reasonSexual',
    label: 'Unwanted sexual content',
    hint: 'Sexual content that is unlabelled or mislabelled',
  },
  {
    value: 'com.atproto.moderation.defs#reasonMisleading',
    label: 'Misleading',
    hint: 'Misleading identity, affiliation or content',
  },
  {
    value: 'com.atproto.moderation.defs#reasonViolation',
    label: 'Breaks the rules',
    hint: 'Violates server rules, laws or terms of service',
  },
  {
    value: 'com.atproto.moderation.defs#reasonOther',
    label: 'Something else',
    hint: 'Anything the categories above do not cover',
  },
] as const

export type ReportReason = (typeof REPORT_REASONS)[number]['value']

/** Report one post. The cid pins the exact version being reported, so an edit
 * afterwards can't quietly change what a moderator is looking at. */
export async function reportPost(
  uri: string,
  cid: string,
  reasonType: ReportReason,
  reason?: string,
): Promise<void> {
  if (isDemo()) return
  await getAgent().createModerationReport({
    reasonType,
    reason: reason?.trim() || undefined,
    subject: { $type: 'com.atproto.repo.strongRef', uri, cid },
  })
}

/** Report a whole account rather than one of its posts. */
export async function reportAccount(
  did: string,
  reasonType: ReportReason,
  reason?: string,
): Promise<void> {
  if (isDemo()) return
  await getAgent().createModerationReport({
    reasonType,
    reason: reason?.trim() || undefined,
    subject: { $type: 'com.atproto.admin.defs#repoRef', did },
  })
}

/** Mute: server-side but private to you, and invisible to the person muted. */
export async function muteActor(did: string): Promise<void> {
  if (isDemo()) return
  await getAgent().mute(did)
}

export async function unmuteActor(did: string): Promise<void> {
  if (isDemo()) return
  await getAgent().unmute(did)
}

/**
 * Block: a public repo record, and mutual — they can't see you either. Unlike
 * follow/like there's no `agent.block()` convenience, so it's a record write of
 * app.bsky.graph.block, and its uri is what an unblock needs later.
 */
export async function blockActor(did: string): Promise<{ uri: string }> {
  if (isDemo()) return { uri: `at://demo/block/${Date.now()}` }
  const agent = getAgent()
  const me = agent.did
  if (!me) throw new Error('Not authenticated')
  const res = await agent.app.bsky.graph.block.create(
    { repo: me },
    { subject: did, createdAt: new Date().toISOString() },
  )
  return { uri: res.uri }
}

export async function unblockActor(blockUri: string): Promise<void> {
  if (isDemo()) return
  const agent = getAgent()
  const me = agent.did
  if (!me) throw new Error('Not authenticated')
  await agent.app.bsky.graph.block.delete({ repo: me, rkey: new AtUri(blockUri).rkey })
}
