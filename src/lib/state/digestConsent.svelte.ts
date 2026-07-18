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

export type Consent = 'unasked' | 'granted' | 'declined'

/** Where a request would go, in the words the dialog needs. */
export type Destination = 'local' | 'server' | 'cloud'

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
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
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
  /** A request was blocked and the dialog should show. */
  pending = $state(false)
  /** Where the blocked request was headed, so the dialog can say so. */
  destination = $state<Destination>('server')

  /** True when work with these settings may proceed. Raises the dialog if not. */
  allows(provider: string, ollamaUrl?: string): boolean {
    const dest = destinationOf(provider, ollamaUrl)
    if (dest === 'local') return true // nothing leaves; nothing to consent to
    if (this.state === 'granted') return true
    if (this.state === 'unasked') {
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
    this.destination = dest
    this.pending = true
  }

  /** True when a declined answer is the reason the digest isn't running — so
   * the UI can say so instead of showing an empty panel and a dead button. */
  blocks(provider: string, ollamaUrl?: string): boolean {
    return this.state === 'declined' && destinationOf(provider, ollamaUrl) !== 'local'
  }

  grant() {
    this.state = 'granted'
    this.pending = false
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
    this.#save()
  }

  #save() {
    try {
      localStorage.setItem(KEY, this.state)
    } catch {
      /* private mode — the choice just won't persist */
    }
  }
}

export const digestConsent = new DigestConsent()
