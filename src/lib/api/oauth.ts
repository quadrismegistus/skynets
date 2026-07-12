import { Agent } from '@atproto/api'
import {
  BrowserOAuthClient,
  buildAtprotoLoopbackClientMetadata,
  type OAuthSession,
} from '@atproto/oauth-client-browser'
import { setActiveAgent } from './agent'

/**
 * Scopes we request. `atproto` is identity; `transition:generic` grants the
 * same broad API access an app password has (read timeline, post, etc.).
 */
const SCOPE = 'atproto transition:generic'
const HANDLE_RESOLVER = 'https://bsky.social'

/**
 * In production, set VITE_OAUTH_CLIENT_ID to the HTTPS URL of your hosted
 * client-metadata.json (that URL *is* the client_id). When unset we run in
 * atproto's loopback development mode: no metadata hosting required, but the
 * app must be opened at http://127.0.0.1:<port> (NOT localhost), and refresh
 * tokens last only ~1 day.
 */
const PROD_CLIENT_ID = import.meta.env.VITE_OAUTH_CLIENT_ID as string | undefined

let clientPromise: Promise<BrowserOAuthClient> | null = null

function getClient(): Promise<BrowserOAuthClient> {
  if (!clientPromise) {
    clientPromise = PROD_CLIENT_ID
      ? BrowserOAuthClient.load({ clientId: PROD_CLIENT_ID, handleResolver: HANDLE_RESOLVER })
      : Promise.resolve(
          // Loopback dev mode: synthesize client metadata that (a) *declares* the
          // scopes we request — the default loopback metadata only declares
          // `atproto`, so `transition:generic` fails as invalid_scope — and
          // (b) pins the redirect URI to this exact origin including port. The
          // default loopback redirect is portless (http://127.0.0.1/), which the
          // auth server sends us back to verbatim (port 80), not our dev port.
          new BrowserOAuthClient({
            handleResolver: HANDLE_RESOLVER,
            clientMetadata: buildAtprotoLoopbackClientMetadata({
              scope: SCOPE,
              redirect_uris: [`${location.origin}/`],
            }),
          }),
        )
  }
  return clientPromise
}

function useSession(session: OAuthSession) {
  setActiveAgent(new Agent(session))
}

/**
 * Initialize the OAuth client. This both (a) completes a login redirect if the
 * current URL carries OAuth callback params, and (b) restores an existing
 * session otherwise. Returns the DID if we end up authenticated.
 */
export async function initOAuth(): Promise<string | undefined> {
  const client = await getClient()
  const result = await client.init()
  if (result?.session) {
    useSession(result.session)
    return result.session.did
  }
  return undefined
}

/**
 * Begin OAuth sign-in for a handle/DID/PDS URL. This navigates away to the
 * authorization server and does not return; on redirect back, initOAuth()
 * completes the flow.
 */
export async function signInOAuth(input: string): Promise<never> {
  const client = await getClient()
  return client.signInRedirect(input.trim(), { scope: SCOPE })
}

export async function revokeOAuth(did: string) {
  const client = await getClient()
  try {
    await client.revoke(did)
  } catch {
    // Best-effort revocation.
  }
}
