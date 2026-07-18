import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BSKY_LABELER_DID, DEFAULT_LABEL_SETTINGS, type ModerationPrefs } from '@atproto/api'
import { moderation } from './moderation.svelte'
import type { FeedItem } from '../api/timeline'
import * as api from '../api/moderation'

// The wrappers themselves are one-liners over the agent; what needs testing is
// the optimistic overlay around them, so stub the network edge.
vi.mock('../api/moderation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/moderation')>()),
  muteActor: vi.fn(async () => {}),
  unmuteActor: vi.fn(async () => {}),
  blockActor: vi.fn(async () => ({ uri: 'at://me/app.bsky.graph.block/abc' })),
  unblockActor: vi.fn(async () => {}),
  reportPost: vi.fn(async () => {}),
  reportAccount: vi.fn(async () => {}),
}))

const AT = new Date(0).toISOString()

let n = 0
function makeItem(
  opts: { labels?: string[]; viewer?: Record<string, unknown>; text?: string } = {},
): FeedItem {
  const uri = `at://did:plc:them/app.bsky.feed.post/${++n}`
  return {
    post: {
      uri,
      cid: `cid${n}`,
      author: { did: 'did:plc:them', handle: 'them.bsky.social', viewer: opts.viewer ?? {} },
      record: { $type: 'app.bsky.feed.post', text: opts.text ?? 'hello', createdAt: AT },
      labels: (opts.labels ?? []).map((val) => ({ src: BSKY_LABELER_DID, uri, val, cts: AT })),
      indexedAt: AT,
    },
  } as unknown as FeedItem
}

function prefs(over: Partial<ModerationPrefs> = {}): ModerationPrefs {
  return {
    adultContentEnabled: false,
    labels: { ...DEFAULT_LABEL_SETTINGS },
    labelers: [{ did: BSKY_LABELER_DID, labels: {} }],
    mutedWords: [],
    hiddenPosts: [],
    ...over,
  }
}

beforeEach(() => {
  moderation.reset()
  moderation.setUser('did:plc:me')
})

describe('moderation', () => {
  it('leaves an unlabeled post alone', () => {
    const item = makeItem()
    expect(moderation.hidden(item)).toBe(false)
    expect(moderation.cover(item).blur).toBe(false)
  })

  it('moderates on Bluesky defaults before any prefs load', () => {
    // The account's real prefs arrive later (feeds.load) or never (offline,
    // failed request). Neither may leave moderation switched off.
    expect(moderation.hidden(makeItem({ labels: ['porn'] }))).toBe(true)
    expect(moderation.hidden(makeItem({ labels: ['!hide'] }))).toBe(true)
  })

  // The load-bearing case for the graph. A muted author's post is filtered from
  // the feed, but can still be pulled in as somebody's reply parent — and there
  // it must come back COVERED. Judged in atproto's `contentView` context it
  // would come back in the clear, which is why cover() judges as a list.
  it('covers a muted author pulled in as context, not just hides them', () => {
    const item = makeItem({ viewer: { muted: true } })
    expect(moderation.hidden(item)).toBe(true)
    const c = moderation.cover(item)
    expect(c.blur).toBe(true)
    expect(c.reason).toBe('Muted account')
  })

  it('offers no way past a block', () => {
    const c = moderation.cover(makeItem({ viewer: { blocking: 'at://x' } }))
    expect(c.blur).toBe(true)
    expect(c.canReveal).toBe(false)
  })

  it('covers a warn-labeled post without hiding it', () => {
    const item = makeItem({ labels: ['!warn'] })
    expect(moderation.hidden(item)).toBe(false)
    const c = moderation.cover(item)
    expect(c.blur).toBe(true)
    expect(c.media).toBe(false)
    expect(c.canReveal).toBe(true)
    // Built-in labels carry no locale strings; without a fallback table the
    // user would be shown the raw value `!warn`.
    expect(c.reason).toBe('Content warning')
  })

  it('covers only the media when only the media is labeled', () => {
    moderation.adopt(prefs({ adultContentEnabled: true }))
    const item = makeItem({ labels: ['graphic-media'] })
    expect(moderation.hidden(item)).toBe(false)
    const c = moderation.cover(item)
    expect(c.blur).toBe(true)
    expect(c.media).toBe(true) // the words survive; the image doesn't
  })

  it('refuses the reveal when an inner layer is no-override', () => {
    // porn is overridable at list level but not at media level — offering
    // "show anyway" on the outer cover would walk straight past the inner one.
    const item = makeItem({ labels: ['porn'] })
    expect(moderation.cover(item).canReveal).toBe(false)
    moderation.reveal(item)
    expect(moderation.cover(item).blur).toBe(true)
  })

  it('reveals a coverable post for the session', () => {
    const item = makeItem({ labels: ['!warn'] })
    moderation.reveal(item)
    expect(moderation.cover(item).blur).toBe(false)
    // …and a fresh session starts covered again.
    moderation.reset()
    moderation.setUser('did:plc:me')
    expect(moderation.cover(item).blur).toBe(true)
  })

  it('re-decides an already-seen post when prefs change', () => {
    const item = makeItem({ text: 'this has badword in it' })
    expect(moderation.hidden(item)).toBe(false)
    moderation.adopt(
      prefs({ mutedWords: [{ value: 'badword', targets: ['content'], actorTarget: 'all' }] }),
    )
    expect(moderation.hidden(item)).toBe(true) // stale memo would say false
  })

  it('keeps defaults when prefs are unavailable', () => {
    moderation.adopt(undefined)
    expect(moderation.hidden(makeItem({ labels: ['porn'] }))).toBe(true)
  })

  it('drops everything on logout', () => {
    const item = makeItem({ labels: ['!warn'] })
    moderation.reveal(item)
    moderation.reset()
    expect(moderation.cover(item).blur).toBe(true)
  })
})

describe('moderation actions', () => {
  beforeEach(() => vi.clearAllMocks())

  // The whole point of the overlay: a decision is computed from the post's
  // `viewer` state, frozen at fetch time. Without a local override, blocking
  // someone would appear to do nothing until the next refetch.
  it('a block suppresses that author immediately, before any refetch', async () => {
    const item = makeItem()
    expect(moderation.hidden(item)).toBe(false)
    await moderation.block(item.post.author)
    expect(moderation.hidden(item)).toBe(true)
    expect(api.blockActor).toHaveBeenCalledWith('did:plc:them')
  })

  it('a muted author is covered but still reachable; a blocked one is not', async () => {
    const muted = makeItem()
    await moderation.mute(muted.post.author)
    const mc = moderation.cover(muted)
    expect(mc.reason).toBe('Muted account')
    expect(mc.canReveal).toBe(true)

    moderation.reset()
    moderation.setUser('did:plc:me')
    const blocked = makeItem()
    await moderation.block(blocked.post.author)
    const bc = moderation.cover(blocked)
    expect(bc.reason).toBe('Blocked account')
    expect(bc.canReveal).toBe(false)
  })

  it('rolls the overlay back when the write fails', async () => {
    const item = makeItem()
    vi.mocked(api.blockActor).mockRejectedValueOnce(new Error('offline'))
    await expect(moderation.block(item.post.author)).rejects.toThrow('offline')
    // Rethrown so the UI can report it, and NOT left looking blocked.
    expect(moderation.isBlocked(item.post.author)).toBe(false)
    expect(moderation.hidden(item)).toBe(false)
  })

  it('rolls a failed mute back too', async () => {
    const item = makeItem()
    vi.mocked(api.muteActor).mockRejectedValueOnce(new Error('nope'))
    await expect(moderation.mute(item.post.author)).rejects.toThrow('nope')
    expect(moderation.isMuted(item.post.author)).toBe(false)
  })

  it('reads block state the feed already carried, and unblocks with its uri', async () => {
    const server = makeItem({ viewer: { blocking: 'at://me/app.bsky.graph.block/xyz' } })
    expect(moderation.isBlocked(server.post.author)).toBe(true)
    expect(moderation.hidden(server)).toBe(true)
    await moderation.unblock(server.post.author)
    expect(api.unblockActor).toHaveBeenCalledWith('at://me/app.bsky.graph.block/xyz')
  })

  it('learns the record uri so a block made this session can be undone', async () => {
    const item = makeItem()
    await moderation.block(item.post.author)
    expect(moderation.blockUri(item.post.author)).toBe('at://me/app.bsky.graph.block/abc')
    await moderation.unblock(item.post.author)
    expect(api.unblockActor).toHaveBeenCalledWith('at://me/app.bsky.graph.block/abc')
    expect(moderation.isBlocked(item.post.author)).toBe(false)
  })

  it('reports a post against its exact cid', async () => {
    const item = makeItem()
    await moderation.reportPost(item, 'com.atproto.moderation.defs#reasonSpam', ' bot ')
    expect(api.reportPost).toHaveBeenCalledWith(
      item.post.uri,
      item.post.cid,
      'com.atproto.moderation.defs#reasonSpam',
      ' bot ',
    )
  })

  it('reporting alone does not hide anything — that stays the user’s choice', async () => {
    const item = makeItem()
    await moderation.reportPost(item, 'com.atproto.moderation.defs#reasonRude')
    expect(moderation.hidden(item)).toBe(false)
    expect(moderation.cover(item).blur).toBe(false)
  })

  it('forgets mutes and blocks on logout', async () => {
    const item = makeItem()
    await moderation.block(item.post.author)
    moderation.reset()
    expect(moderation.isBlocked(item.post.author)).toBe(false)
  })
})
