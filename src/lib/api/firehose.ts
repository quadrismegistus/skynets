import { SYNC_COLLECTION } from './syncpds'

/**
 * Real-time sync trigger (#83). The Phase 2 loop already PULLS on a 150s poll and
 * on foreground events (sync.svelte.ts); this adds a low-latency nudge: subscribe
 * to Bluesky's Jetstream, filtered to THIS user's own repo and the sync
 * collection, and fire `onChange` the moment another device writes the record.
 *
 * Scope is deliberately tiny — this is a TRIGGER, not a transport. It never reads
 * the record (the commit event carries only its CID, not the ciphertext we'd need
 * the key for); it just calls back so the existing pull path re-reads + merges.
 * The poll STAYS as a fallback because Jetstream can lag or drop the connection.
 *
 * The URL-building and event-matching are pure functions so they're unit-testable
 * without a live socket; `subscribeSyncRecord` is the thin stateful shell.
 */

// A public Jetstream instance. It carries the firehose as JSON (no CBOR/CAR
// decoding), and its server-side `wantedCollections`/`wantedDids` filters mean we
// receive essentially only our own sync commits.
export const JETSTREAM_ENDPOINT = 'wss://jetstream2.us-east.bsky.network/subscribe'

// Reconnect backoff: start at 1s, double on each successive failure, cap at 30s.
// Reset to the floor whenever a connection opens successfully.
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000

/** Build the Jetstream subscribe URL scoped to one repo + the sync collection. */
export function buildSubscribeUrl(did: string, endpoint: string = JETSTREAM_ENDPOINT): string {
  const url = new URL(endpoint)
  url.searchParams.set('wantedCollections', SYNC_COLLECTION)
  url.searchParams.set('wantedDids', did)
  return url.toString()
}

/**
 * True when a (parsed) Jetstream message is a commit to OUR sync record — i.e. a
 * change on another device we should pull. Matches on the commit kind, the actor
 * DID, and the collection; any operation (create/update/delete) counts, since all
 * three mean the record moved. Re-checks the fields the server already filters on
 * so a mis-scoped or malformed frame can't spuriously trigger a pull.
 */
export function isSyncCommit(msg: unknown, did: string): boolean {
  if (!msg || typeof msg !== 'object') return false
  const m = msg as { kind?: unknown; did?: unknown; commit?: { collection?: unknown } }
  return (
    m.kind === 'commit' &&
    m.did === did &&
    !!m.commit &&
    typeof m.commit === 'object' &&
    m.commit.collection === SYNC_COLLECTION
  )
}

/**
 * Subscribe to sync-record commits for `did`, calling `onChange` on each. Returns
 * a teardown that closes the socket and cancels any pending reconnect. Reconnects
 * with capped exponential backoff on close/error. In an environment without
 * `WebSocket` (node/SSR/tests) this is a no-op returning an inert teardown.
 */
export function subscribeSyncRecord(did: string, onChange: () => void): () => void {
  if (typeof WebSocket === 'undefined') return () => {}

  const url = buildSubscribeUrl(did)
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let delay = RECONNECT_MIN_MS
  let stopped = false

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return // already closing, or a retry is pending
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
    delay = Math.min(delay * 2, RECONNECT_MAX_MS)
  }

  const connect = () => {
    if (stopped) return
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      scheduleReconnect() // construction can throw (e.g. bad URL / blocked scheme)
      return
    }
    ws = socket
    socket.onopen = () => {
      delay = RECONNECT_MIN_MS // healthy connection: reset the backoff
    }
    socket.onmessage = (ev: MessageEvent) => {
      let data: unknown
      try {
        data = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch {
        return // ignore non-JSON / partial frames
      }
      if (isSyncCommit(data, did)) onChange()
    }
    // onclose fires after onerror for a failed/broken connection, so scheduling
    // there covers both; scheduleReconnect's guards de-dupe if error also fires.
    socket.onerror = () => scheduleReconnect()
    socket.onclose = () => scheduleReconnect()
  }

  connect()

  return () => {
    stopped = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (ws) {
      // Drop handlers first so the impending close doesn't schedule a reconnect.
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
      try {
        ws.close()
      } catch {
        // Best-effort; a socket still CONNECTING throws on close in some engines.
      }
      ws = null
    }
  }
}
