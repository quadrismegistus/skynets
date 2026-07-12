import { Agent, AtpAgent, type AtpSessionData, type AtpSessionEvent } from '@atproto/api'

const SESSION_KEY = 'skynets.session'
const SERVICE = 'https://bsky.social'

/**
 * The single agent used for all API calls. It's set by whichever auth path
 * succeeds — app-password (`atpAgent` below) or OAuth (`new Agent(oauthSession)`
 * in oauth.ts). Both are `Agent`s and expose identical XRPC methods, so the rest
 * of the app never needs to know which login was used.
 */
let active: Agent | null = null

export function getAgent(): Agent {
  if (!active) throw new Error('Not authenticated')
  return active
}

export function setActiveAgent(a: Agent | null) {
  active = a
}

export function hasAgent(): boolean {
  return !!active
}

// ─────────────────────────────── app password ───────────────────────────────

function loadSession(): AtpSessionData | null {
  const raw = localStorage.getItem(SESSION_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as AtpSessionData
  } catch {
    localStorage.removeItem(SESSION_KEY)
    return null
  }
}

function saveSession(session: AtpSessionData | null) {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  else localStorage.removeItem(SESSION_KEY)
}

/**
 * The app-password agent. Its `persistSession` hook keeps localStorage in sync
 * as tokens refresh, so a resumed session survives access-token rotation.
 */
export const atpAgent = new AtpAgent({
  service: SERVICE,
  persistSession: (evt: AtpSessionEvent, session?: AtpSessionData) => {
    saveSession(evt === 'expired' || !session ? null : session)
  },
})

/** Try to resume a stored app-password session. Returns true if logged in. */
export async function resumeAppPassword(): Promise<boolean> {
  const stored = loadSession()
  if (!stored) return false
  try {
    await atpAgent.resumeSession(stored)
    if (atpAgent.session) {
      setActiveAgent(atpAgent)
      return true
    }
  } catch {
    saveSession(null)
  }
  return false
}

/** Log in with a handle and an app password. */
export async function loginAppPassword(identifier: string, password: string): Promise<void> {
  await atpAgent.login({ identifier: identifier.trim(), password: password.trim() })
  setActiveAgent(atpAgent)
}

/** Clear the app-password session, if that's the active one. */
export async function logoutAppPassword() {
  saveSession(null)
  try {
    await atpAgent.logout()
  } catch {
    // Best-effort; localStorage is what actually gates a resume.
  }
}
