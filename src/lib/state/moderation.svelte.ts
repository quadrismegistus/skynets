import {
  BSKY_LABELER_DID,
  DEFAULT_LABEL_SETTINGS,
  moderatePost,
  type ModerationCause,
  type ModerationDecision,
  type ModerationOpts,
  type ModerationPrefs,
} from '@atproto/api'
import { SvelteSet } from 'svelte/reactivity'
import type { FeedItem } from '../api/timeline'

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
  }

  decisionFor(item: FeedItem): ModerationDecision {
    const key = `${item.post.uri}:${item.post.cid}`
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
    if (this.#revealed.has(item.post.uri)) return NO_COVER
    const d = this.decisionFor(item)
    const list = d.ui('contentList')
    const media = d.ui('contentMedia')
    // If any layer refuses override, offer no way in at all: a full cover on a
    // porn-labeled post is overridable at list level but not at media level,
    // and revealing via the outer one would walk straight past the inner.
    const canReveal = !list.noOverride && !media.noOverride
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
}

export const moderation = new Moderation()
