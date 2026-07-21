import {
  getAgent,
  hasAgent,
  loginAppPassword,
  logoutAppPassword,
  resumeAppPassword,
  setActiveAgent,
} from '../api/agent'
import { initOAuth, revokeOAuth, signInOAuth } from '../api/oauth'
import { isDemo } from '../api/demo'
import { read } from './read.svelte'
import { reactions } from './reactions.svelte'
import { sync } from './sync.svelte'
import { moderation } from './moderation.svelte'
import { disposeLocalEmbed } from '../api/localEmbed'

type Status = 'loading' | 'logged-out' | 'logged-in'
type Method = 'oauth' | 'app-password'

/**
 * Reactive session state shared across the app. `status` drives which view
 * App.svelte renders; `handle`/`did` describe the current user; `method`
 * records which auth path is active so logout can clean up the right one.
 */
class SessionState {
  status = $state<Status>('loading')
  handle = $state<string | undefined>(undefined)
  did = $state<string | undefined>(undefined)
  displayName = $state<string | undefined>(undefined)
  avatar = $state<string | undefined>(undefined)
  method = $state<Method | undefined>(undefined)
  error = $state<string | undefined>(undefined)

  /** Fill handle/did from the active agent (one profile fetch if needed). */
  private async resolveIdentity() {
    const agent = getAgent()
    const did = agent.did
    if (!did) return
    this.did = did
    try {
      const profile = await agent.getProfile({ actor: did })
      this.handle = profile.data.handle
      this.displayName = profile.data.displayName
      this.avatar = profile.data.avatar
    } catch {
      this.handle = did
    }
  }

  private async markLoggedIn(method: Method) {
    this.method = method
    this.status = 'logged-in'
    await this.resolveIdentity()
    if (this.did) {
      // Before feeds.load() adopts the real prefs: moderation is already on,
      // running Bluesky's defaults, so nothing is ever unmoderated.
      moderation.setUser(this.did)
      await read.load(this.did)
      await reactions.load(this.did)
      void sync.load(this.did) // non-blocking pull-and-merge if sync is on
    }
  }

  private markLoggedOut() {
    this.status = 'logged-out'
    this.method = undefined
    this.handle = undefined
    this.did = undefined
  }

  /**
   * Startup: complete any OAuth redirect and restore a session from either
   * path. OAuth is tried first because it may need to consume callback params
   * in the URL; app-password resume is the fallback.
   */
  async init() {
    if (isDemo()) {
      this.status = 'logged-in'
      this.method = 'app-password'
      this.handle = 'demo.bsky.social'
      this.did = 'did:plc:demo'
      moderation.setUser(this.did)
      await read.load(this.did)
      await reactions.load(this.did)
      void sync.load(this.did) // non-blocking pull-and-merge if sync is on
      return
    }
    try {
      const oauthDid = await initOAuth()
      if (oauthDid && hasAgent()) {
        await this.markLoggedIn('oauth')
        return
      }
    } catch (err) {
      // A failed OAuth callback shouldn't strand the user on a blank screen.
      console.warn('[mothtrap] OAuth init failed', err)
    }

    if (await resumeAppPassword()) {
      await this.markLoggedIn('app-password')
      return
    }

    this.markLoggedOut()
  }

  async loginWithAppPassword(identifier: string, password: string) {
    this.error = undefined
    try {
      await loginAppPassword(identifier, password)
      await this.markLoggedIn('app-password')
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Login failed'
      throw err
    }
  }

  /** Navigates away to the authorization server; does not return. */
  async loginWithOAuth(handle: string) {
    this.error = undefined
    try {
      await signInOAuth(handle)
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Could not start OAuth'
      throw err
    }
  }

  async logout() {
    if (this.method === 'oauth' && this.did) {
      await revokeOAuth(this.did)
    } else {
      await logoutAppPassword()
    }
    setActiveAgent(null)
    read.reset()
    reactions.reset()
    sync.reset()
    moderation.reset()
    // The embedding worker holds ~100MB of loaded weights; signing out should
    // not leave another account's session sharing them.
    disposeLocalEmbed()
    this.markLoggedOut()
  }
}

export const session = new SessionState()
