import {
  BSKY_LABELER_DID,
  DEFAULT_LABEL_SETTINGS,
  moderatePost,
  type ModerationCause,
  type ModerationDecision,
  type ModerationOpts,
  type ModerationPrefs,
} from '@atproto/api'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import type { FeedItem } from '../api/timeline'
import {
  blockActor,
  muteActor,
  reportAccount,
  reportPost,
  unblockActor,
  unmuteActor,
  type ReportReason,
} from '../api/moderation'

/** Anything carrying the viewer state we care about — a post author, a profile. */
interface Actor {
  did: string
  viewer?: { muted?: boolean; blocking?: string }
}

/**
 * Content moderation: we do not invent a policy, we HONOUR the account's own.
 *
 * Every decision here comes from `moderatePost()` in @atproto/api, fed by the
 * user's real Bluesky moderation preferences — subscribed labelers, per-label
 * warn/hide settings, adult-content opt-in, muted words, hidden posts — plus
 * the per-post `viewer` state (muted/blocking/blocked-by) that already rides
 * along on every `FeedItem`. Mothtrap deliberately offers NO local override UI:
 * whatever you've set on Bluesky is what you get here, which is both the
 * correct behaviour for a client and the honest answer to app-store review.
 *
 * Note on names: `api/labelGroup.ts` and the archive's `labels` store are
 * LLM-generated *topic* labels for the digest. Unrelated. Nothing in this
 * module is called `label*` for exactly that reason.
 *
 * Two severities, two very different treatments:
 *   - `hidden()`  — keep it out of your feed entirely (the `filter` behaviour)
 *   - `cover()`   — draw it, but covered, with a reason and (usually) a way in
 *
 * The split matters in a graph in a way it doesn't in a timeline: a post can be
 * filtered out of your *feed* and still be structurally required as somebody's
 * reply parent. Dropping it there would tear a hole in the conversation. So
 * `hidden()` gates feed inflow only; everything that survives into the graph —
 * feed post or pulled-in ancestor — is covered rather than vanished.
 */

/** Bluesky's shipped defaults: what we moderate by until the real prefs land. */
function defaultPrefs(): ModerationPrefs {
  return {
    // Conservative until told otherwise — this is also Bluesky's own default.
    adultContentEnabled: false,
    labels: { ...DEFAULT_LABEL_SETTINGS },
    labelers: [{ did: BSKY_LABELER_DID, labels: {} }],
    mutedWords: [],
    hiddenPosts: [],
  }
}

/**
 * The built-in label values ship with EMPTY `locales` — Bluesky's own client
 * supplies those strings, so a client that doesn't would show users raw values
 * like `!warn`. Third-party labelers DO self-describe, which is why the locale
 * name still wins when there is one; this is only the fallback for the eight
 * values @atproto/api defines itself.
 */
const BUILTIN_LABEL_NAMES: Record<string, string> = {
  '!hide': 'Content blocked',
  '!warn': 'Content warning',
  '!no-unauthenticated': 'Sign-in required',
  porn: 'Adult content',
  sexual: 'Sexually suggestive',
  nudity: 'Non-sexual nudity',
  'graphic-media': 'Graphic media',
  gore: 'Graphic media',
}

/**
 * Identity of the labels currently on a post, for the decision cache key.
 * Sorted so ordering churn from the API can't invalidate a good entry, and
 * `neg` included because a retraction is as much a change as an application.
 */
function labelFingerprint(item: FeedItem): string {
  const all = [...(item.post.labels ?? []), ...(item.post.author.labels ?? [])]
  if (all.length === 0) return ''
  return all
    .map((l) => `${l.src}/${l.val}${l.neg ? '!' : ''}`)
    .sort()
    .join(',')
}

/** What a cover says it's covering for. */
function causeReason(cause: ModerationCause | undefined): string {
  if (!cause) return 'Content warning'
  switch (cause.type) {
    case 'blocking':
      return 'Blocked account'
    case 'blocked-by':
      return 'This account has blocked you'
    case 'block-other':
      return 'Blocked'
    case 'muted':
      return 'Muted account'
    case 'mute-word':
      return 'Muted word'
    case 'hidden':
      return 'Hidden post'
    case 'label':
      return (
        cause.labelDef.locales[0]?.name ??
        BUILTIN_LABEL_NAMES[cause.label.val] ??
        cause.label.val
      )
  }
}

export interface Cover {
  /** Draw the cover instead of the content. */
  blur: boolean
  /** Cover just the media, not the words (e.g. graphic-media on a text post). */
  media: boolean
  /** Why — shown on the cover. */
  reason: string
  /** False for no-override labels: there is no way in, and we must not offer one. */
  canReveal: boolean
}

const NO_COVER: Cover = { blur: false, media: false, reason: '', canReveal: false }

class Moderation {
  #userDid = $state<string | undefined>(undefined)
  #prefs = $state<ModerationPrefs>(defaultPrefs())
  /** Posts uncovered by an explicit click. Session-only, deliberately: a
   * content warning you dismissed once should come back next time. */
  #revealed = new SvelteSet<string>()
  /** moderatePost() would otherwise run per node per frame. Keyed uri+cid so an
   * edited post re-decides. Plain Map, not reactive — cleared whenever the
   * inputs it was computed under change. */
  #cache = new Map<string, ModerationDecision>()
  /**
   * Optimistic overlay for mutes and blocks made THIS session. A decision comes
   * from the post's own `viewer` state, which is frozen at fetch time, so
   * without this a block wouldn't visibly do anything until the next refetch —
   * unacceptable for the one action a user takes when they want someone gone
   * NOW. The overlay only ever ADDS suppression: un-muting or un-blocking drops
   * the local entry, but if the server data still says muted, those posts stay
   * hidden until the next fetch. Erring toward "still hidden" is the safe
   * direction to be briefly wrong in.
   */
  #muted = new SvelteSet<string>()
  /** did → block record uri; null while the write is still in flight. */
  #blocked = new SvelteMap<string, string | null>()

  opts: ModerationOpts = $derived({ userDid: this.#userDid, prefs: this.#prefs })

  /** Whose moderation view this is. Call on login (before prefs arrive). */
  setUser(did: string | undefined) {
    this.#userDid = did
    this.#cache.clear()
  }

  /**
   * Adopt the account's real moderation preferences. Comes free with the
   * `getPreferences()` call feeds.load() already makes — no extra request.
   * Never called on failure, which is the point: prefs that don't load leave
   * Bluesky's defaults in force rather than switching moderation off.
   */
  adopt(prefs: ModerationPrefs | undefined) {
    if (!prefs) return
    this.#prefs = prefs
    this.#cache.clear()
  }

  reset() {
    this.#userDid = undefined
    this.#prefs = defaultPrefs()
    this.#revealed.clear()
    this.#cache.clear()
    this.#muted.clear()
    this.#blocked.clear()
  }

  decisionFor(item: FeedItem): ModerationDecision {
    // The key must include the LABELS, not just uri+cid. A labeler applying a
    // label doesn't change the cid — the record is untouched — so keying on
    // uri:cid alone pinned the first (clean) verdict for the whole session and
    // a label arriving later was never honoured. Mothtrap sits open re-polling
    // a feed, so a labeler catching up with a post is the ordinary case.
    const key = `${item.post.uri}:${item.post.cid}:${labelFingerprint(item)}`
    let d = this.#cache.get(key)
    if (!d) {
      d = moderatePost(item.post, this.opts)
      this.#cache.set(key, d)
    }
    return d
  }

  /**
   * Should this post be kept out of the feed entirely? Feed inflow only — see
   * the module note on why filtered posts still render as pulled-in context.
   */
  hidden(item: FeedItem): boolean {
    // A mute or block made this session beats the post's frozen viewer state.
    if (this.isMuted(item.post.author) || this.isBlocked(item.post.author)) return true
    return this.decisionFor(item).ui('contentList').filter
  }

  /**
   * How to cover a post that IS being drawn.
   *
   * Always judged in the `contentList` context, never `contentView`. atproto
   * reads contentView as "you deliberately opened this post's own page", and
   * so declines to filter there and won't even blur a muted account. Nothing
   * in Mothtrap is that: a node and its hover card are list items that happen
   * to be laid out in 2-D. Judging them as a list is what makes a muted
   * author's pulled-in reply parent come back covered instead of in the clear.
   *
   * Anything your settings would have filtered gets a full cover if it appears
   * at all (it only can as a structural ancestor) — "hidden from your feed"
   * shouldn't degrade to "shown in full" just because the topology needs it.
   * A post that's fine but whose *media* isn't gets a media-only cover, so a
   * graphic-media image doesn't take the words down with it.
   */
  cover(item: FeedItem): Cover {
    const author = item.post.author
    // A block is absolute and outranks everything, INCLUDING a prior reveal.
    // Reading a post and then deciding to block its author is the ordinary
    // order of events; checking `#revealed` first left exactly that post
    // uncovered afterwards.
    if (this.isBlocked(author)) {
      return { blur: true, media: false, reason: 'Blocked account', canReveal: false }
    }

    const d = this.decisionFor(item)
    const list = d.ui('contentList')
    const media = d.ui('contentMedia')
    // canReveal is the AND across every layer with an opinion, and it must be
    // computed BEFORE any mute is considered. Returning the mute's permissive
    // verdict early meant muting an author *unsealed* their no-override labels:
    // a porn- or !hide-labelled post went from canReveal:false to revealable,
    // so muting somebody weakened moderation of their content.
    const canReveal = !list.noOverride && !media.noOverride

    // A reveal only clears the layers that permit override. Deliberately still
    // honoured under a mute: you asked to see this one post, and a mute governs
    // what arrives rather than what you've already chosen to open. A block is
    // the hard boundary, and it's handled above.
    if (this.#revealed.has(item.post.uri) && canReveal) return NO_COVER

    if (this.isMuted(author)) {
      return { blur: true, media: false, reason: 'Muted account', canReveal }
    }
    if (list.filter || list.blur) {
      return {
        blur: true,
        media: false,
        reason: causeReason(list.blurs[0] ?? list.filters[0]),
        canReveal,
      }
    }
    if (media.blur) {
      return { blur: true, media: true, reason: causeReason(media.blurs[0]), canReveal }
    }
    return NO_COVER
  }

  /** Uncover one post for this session. No-op for no-override causes. */
  reveal(item: FeedItem) {
    if (!this.cover(item).canReveal) return
    this.#revealed.add(item.post.uri)
  }

  isRevealed(uri: string): boolean {
    return this.#revealed.has(uri)
  }

  // ---- Authoring: mute, block, report -------------------------------------
  // Optimistic, mirroring follows.toggle: apply locally, call the server, put
  // the local state back if the call fails. Each rethrows so the caller can say
  // so — silently failing to block someone would be its own kind of harm.

  isMuted(actor: Actor): boolean {
    return this.#muted.has(actor.did) || !!actor.viewer?.muted
  }

  /** The block record's uri, needed to undo. Undefined when not blocked. */
  blockUri(actor: Actor): string | undefined {
    const local = this.#blocked.get(actor.did)
    if (local !== undefined) return local ?? undefined
    return actor.viewer?.blocking
  }

  isBlocked(actor: Actor): boolean {
    return this.#blocked.has(actor.did) || !!actor.viewer?.blocking
  }

  async mute(actor: Actor) {
    if (this.#muted.has(actor.did)) return
    this.#muted.add(actor.did)
    try {
      await muteActor(actor.did)
    } catch (err) {
      this.#muted.delete(actor.did)
      throw err
    }
  }

  async unmute(actor: Actor) {
    const had = this.#muted.delete(actor.did)
    try {
      await unmuteActor(actor.did)
    } catch (err) {
      if (had) this.#muted.add(actor.did)
      throw err
    }
  }

  async block(actor: Actor) {
    if (this.#blocked.has(actor.did)) return
    this.#blocked.set(actor.did, null) // suppress now, learn the uri in a moment
    try {
      const res = await blockActor(actor.did)
      // The user can unblock while this is in flight — the menu already reads
      // "Unblock", because isBlocked() is optimistically true. If they did,
      // the overlay entry is gone, and writing the uri back would silently
      // re-block them AND leave a public app.bsky.graph.block record they
      // believe they removed. Undo it instead.
      if (!this.#blocked.has(actor.did)) {
        await unblockActor(res.uri).catch(() => {
          // Best effort. Re-record it so the UI stops claiming they're
          // unblocked when the record is demonstrably still there.
          this.#blocked.set(actor.did, res.uri)
        })
        return
      }
      this.#blocked.set(actor.did, res.uri)
    } catch (err) {
      this.#blocked.delete(actor.did)
      throw err
    }
  }

  async unblock(actor: Actor) {
    const uri = this.blockUri(actor)
    const prev = this.#blocked.get(actor.did)
    // Delete FIRST: an in-flight block() checks for this entry after its await
    // and treats its absence as "the user changed their mind", undoing the
    // record it just created.
    this.#blocked.delete(actor.did)
    if (!uri) return // in-flight (uri not known yet — block() will undo it)
    try {
      await unblockActor(uri)
    } catch (err) {
      if (prev !== undefined) this.#blocked.set(actor.did, prev)
      throw err
    }
  }

  /** Report a post. Nothing local changes — the report goes to the moderation
   * service, and hiding the post is a separate choice the user makes. */
  async reportPost(item: FeedItem, reason: ReportReason, detail?: string) {
    await reportPost(item.post.uri, item.post.cid, reason, detail)
  }

  async reportAccount(actor: Actor, reason: ReportReason, detail?: string) {
    await reportAccount(actor.did, reason, detail)
  }
}

export const moderation = new Moderation()
