/**
 * Consent for the one thing Mothtrap does that isn't local.
 *
 * The digest groups your feed into topics with a language model. Where that
 * model runs decides whether anything leaves your machine:
 *
 *   - your own Ollama on localhost  → nothing leaves, so we never ask
 *   - a hosted model (mothtrap.blue proxies one at /ollama) → post text and
 *     AUTHOR HANDLES go to that server, so we ask once
 *   - a cloud provider → the same data goes to a genuine third party
 *
 * The handles are the reason this is asked at all rather than merely disclosed:
 * they belong to people who never chose to use Mothtrap.
 *
 * Asked ONCE, in context, the first time a request would actually leave — not
 * on the login screen, where nobody yet knows what a digest is. Answer stored
 * per device; after a yes the digest stays automatic, zero clicks, forever.
 */

const KEY = 'mothtrap.digestConsent'
const HOST_KEY = 'mothtrap.digestConsentHost'

export type Consent = 'unasked' | 'granted' | 'declined'

/** Where a request would go, in the words the dialog needs. */
export type Destination = 'local' | 'server' | 'cloud'

/** Where a request would go, as a stable identity to record consent against. */
export function hostFor(provider: string, ollamaUrl?: string): string {
  if (provider !== 'ollama') return `cloud:${provider}`
  try {
    const origin = typeof location !== 'undefined' ? location.origin : 'http://localhost'
    return new URL(ollamaUrl || 'http://localhost:11434', origin).host
  } catch {
    return 'unknown'
  }
}

function readHost(): string {
  try {
    return localStorage.getItem(HOST_KEY) ?? ''
  } catch {
    return ''
  }
}

function read(): Consent {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'granted' || v === 'declined' ? v : 'unasked'
  } catch {
    return 'unasked' // private mode — ask again next time rather than assume yes
  }
}

/**
 * Does a request with these settings leave this device?
 *
 * A relative endpoint (`/ollama`) resolves against the page origin, so the same
 * config is local when you're running the app on your own machine and remote
 * once it's deployed — which is exactly the distinction that matters.
 */
export function destinationOf(provider: string, ollamaUrl?: string): Destination {
  if (provider !== 'ollama') return 'cloud'
  const raw = ollamaUrl || 'http://localhost:11434'
  let host: string
  try {
    const origin = typeof location !== 'undefined' ? location.origin : 'http://localhost'
    host = new URL(raw, origin).hostname
  } catch {
    return 'server' // unparseable → assume it leaves; erring the safe way
  }
  // The URL parser hands back IPv6 hosts bracketed ('[::1]'), so a bare '::1'
  // comparison never matched and a genuinely local IPv6 Ollama was classified
  // remote — prompting for a request that never leaves the machine.
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase()
  const local = bare === 'localhost' || bare === '127.0.0.1' || bare === '::1' || bare === '0.0.0.0'
  return local ? 'local' : 'server'
}

/** Thrown instead of sending, so a blocked digest surfaces as a normal error
 * path rather than a silent no-op the engine would keep retrying. */
export class ConsentRequired extends Error {
  constructor() {
    super('The digest needs your permission before it can send anything.')
    this.name = 'ConsentRequired'
  }
}

class DigestConsent {
  state = $state<Consent>(read())
  /** The endpoint host the answer was given FOR. A grant is consent to send to
   * a particular place — the dialog names it — so if the deployment config or
   * the panel's URL field later points somewhere else, that consent no longer
   * covers it and we must ask again. */
  grantedFor = $state<string>(readHost())
  /** A request was blocked and the dialog should show. */
  pending = $state(false)
  /** Where the blocked request was headed, so the dialog can say so. */
  destination = $state<Destination>('server')
  /** Dismissed without answering this session — see dismiss(). Never persisted:
   * "I didn't answer" should not survive a reload the way a real answer does. */
  #deferred = false

  /** True when work with these settings may proceed. Raises the dialog if not. */
  allows(provider: string, ollamaUrl?: string): boolean {
    const dest = destinationOf(provider, ollamaUrl)
    if (dest === 'local') return true // nothing leaves; nothing to consent to
    if (this.state === 'granted') {
      const host = hostFor(provider, ollamaUrl)
      // A grant with no recorded destination predates this check (or came from
      // a bare grant()). Honour it, but PIN the host now, so that a later move
      // does trigger a re-ask rather than riding on the old answer forever.
      if (!this.grantedFor) {
        this.grantedFor = host
        this.#save()
        return true
      }
      if (this.grantedFor === host) return true
      // The endpoint moved after consent was given — the dialog named a
      // specific destination, and this isn't it. Ask again for the new one.
      this.destination = dest
      this.pending = true
      return false
    }
    if (this.state === 'unasked' && !this.#deferred) {
      this.destination = dest
      this.pending = true
    }
    return false
  }

  /** Guard for the network boundary — throws rather than quietly sending. */
  require(provider: string, ollamaUrl?: string) {
    if (!this.allows(provider, ollamaUrl)) throw new ConsentRequired()
  }

  /**
   * Re-open the question from an explicit user action.
   *
   * `allows()` deliberately only raises the dialog when the answer is still
   * `unasked`, so a declined user isn't nagged on every live-poll tick. That
   * left no way back: declining once disabled the digest permanently and
   * silently. This is the way back, and it must be reachable from the UI.
   *
   * No-op when nothing would leave the device — there is nothing to consent to.
   */
  ask(provider: string, ollamaUrl?: string) {
    const dest = destinationOf(provider, ollamaUrl)
    if (dest === 'local') return
    this.#deferred = false
    this.destination = dest
    this.pending = true
  }

  /**
   * True when the digest is waiting on the user — so the UI can say so instead
   * of showing an empty panel and a button that does nothing.
   *
   * Covers BOTH a decline and a dismissal. Dismissing suppresses the dialog for
   * the session, which without this left the panel showing its normal label
   * over a dead button — recreating the exact silent dead end that dismiss()
   * was added to prevent, one layer along.
   */
  blocks(provider: string, ollamaUrl?: string): boolean {
    if (destinationOf(provider, ollamaUrl) === 'local') return false
    return this.state === 'declined' || (this.state === 'unasked' && this.#deferred)
  }

  /**
   * Close the dialog without answering — a backdrop click or Escape.
   *
   * Deliberately NOT the same as declining. Dismissing used to record a
   * permanent "no", so one stray click outside the modal disabled the digest
   * forever with no visible trace. A misclick shouldn't be able to make a
   * lasting privacy decision; an explicit "No thanks" is the only thing that
   * should stick.
   *
   * Suppressed for the rest of the session (in memory, never persisted) so it
   * doesn't immediately reappear on the next live-poll tick, then asked again
   * next time — which is the honest reading of "I didn't answer".
   */
  dismiss() {
    this.pending = false
    this.#deferred = true
  }

  grant(provider?: string, ollamaUrl?: string) {
    if (provider) this.grantedFor = hostFor(provider, ollamaUrl)
    this.state = 'granted'
    this.pending = false
    this.#deferred = false
    this.#save()
  }

  decline() {
    this.state = 'declined'
    this.pending = false
    this.#save()
  }

  /** Re-open the choice (from settings), e.g. after declining. */
  reset() {
    this.state = 'unasked'
    this.pending = false
    this.#deferred = false
    this.grantedFor = '' // the destination is part of the answer, so it goes too
    this.#save()
  }

  #save() {
    try {
      localStorage.setItem(HOST_KEY, this.grantedFor)
      localStorage.setItem(KEY, this.state)
    } catch {
      /* private mode — the choice just won't persist */
    }
  }
}

export const digestConsent = new DigestConsent()
