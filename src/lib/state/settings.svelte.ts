import type { SelectMode } from './graph'

const KEY = 'skynets.settings' // legacy name from before the Mothtrap rename — do not change (users' saved settings)

interface Persisted {
  /** Persistence-format version. Absent = v1 (see migrateV1). */
  v?: number
  nodeLimit?: number
  selectMode?: SelectMode
  autoCycle?: boolean
  cycleInterval?: number
  livePoll?: boolean
  connectReplies?: boolean
  replyChains?: boolean
  /** 0 = posts glued to the recency/engagement axes; 1 = connections pull
   * connected posts together (loosening the axes). Replaces the old boolean
   * `clusterForce`, which is still read once for migration. */
  cohesion?: number
  clusterForce?: boolean
  curvedEdges?: boolean
  showReposts?: boolean
  followsOnly?: boolean
  debugMode?: boolean
}

/** Current defaults. A field is persisted ONLY while its value differs from
 * these, so changing a default here reaches every user who never touched that
 * control — the v1 format persisted everything on load, which silently froze
 * the defaults of first visit. (nodeLimit's default is computed per load.) */
export const DEFAULTS = {
  selectMode: 'mix' as SelectMode,
  autoCycle: false,
  cycleInterval: 4,
  livePoll: true,
  connectReplies: true,
  replyChains: true,
  cohesion: 0,
  curvedEdges: false,
  showReposts: true,
  followsOnly: false,
  debugMode: false,
}

/** What the defaults were when the v1 (persist-everything) format was live.
 * Note replyChains/curvedEdges/nodeLimit differ from today's. */
const V1_DEFAULTS: Record<string, unknown> = {
  nodeLimit: 20,
  selectMode: 'mix',
  autoCycle: false,
  cycleInterval: 4,
  livePoll: true,
  connectReplies: true,
  replyChains: false,
  cohesion: 0,
  curvedEdges: true,
  showReposts: true,
  followsOnly: false,
  debugMode: false,
}

/** v1 blobs were written wholesale on every load, so a field equal to its OLD
 * default is indistinguishable from "never touched" — treat it as unset, so
 * today's defaults apply. Values a user genuinely changed (≠ old default)
 * survive. Exported for tests. */
export function migrateV1(p: Partial<Persisted>): Partial<Persisted> {
  if (p.v === 2) return p
  const out: Record<string, unknown> = { ...p }
  for (const [k, dflt] of Object.entries(V1_DEFAULTS)) {
    if (out[k] === dflt) delete out[k]
  }
  return out as Partial<Persisted>
}

function load(): Partial<Persisted> {
  if (typeof localStorage === 'undefined') return {}
  try {
    return migrateV1(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Persisted>)
  } catch {
    return {}
  }
}

/**
 * Default node count scales with viewport area: ~30 fits comfortably on a
 * 1920x1080 desktop, so smaller screens get proportionally fewer (a phone
 * lands near the floor). Recomputed every load until the user moves the Count
 * slider — only a value that differs from the load-time default is persisted.
 */
function defaultNodeLimit(): number {
  if (typeof window === 'undefined') return 20
  const mpx = (window.innerWidth * window.innerHeight) / 1e6
  return Math.max(8, Math.min(60, Math.round(mpx * 14.5)))
}

/** Debug tooling is a dev affordance: offered in any dev build and on
 * localhost (covers LAN-IP phone testing via `vite --host`); the hosted
 * instances hide the toggle and ignore any persisted value. */
export const debugAllowed =
  import.meta.env.DEV ||
  (typeof location !== 'undefined' && ['localhost', '127.0.0.1'].includes(location.hostname))

/**
 * User's view preferences, persisted to localStorage. Reactive via runes, so
 * components can bind directly (e.g. `bind:value={settings.nodeLimit}`) and the
 * change is saved automatically.
 */
class Settings {
  nodeLimit = $state(defaultNodeLimit())
  selectMode = $state<SelectMode>(DEFAULTS.selectMode)
  autoCycle = $state(DEFAULTS.autoCycle)
  cycleInterval = $state(DEFAULTS.cycleInterval)
  livePoll = $state(DEFAULTS.livePoll)
  connectReplies = $state(DEFAULTS.connectReplies)
  replyChains = $state(DEFAULTS.replyChains)
  cohesion = $state(DEFAULTS.cohesion)
  curvedEdges = $state(DEFAULTS.curvedEdges)
  showReposts = $state(DEFAULTS.showReposts)
  followsOnly = $state(DEFAULTS.followsOnly)
  debugMode = $state(DEFAULTS.debugMode)

  constructor() {
    const p = load()
    const defaultLimit = this.nodeLimit
    if (typeof p.nodeLimit === 'number') this.nodeLimit = p.nodeLimit
    if (p.selectMode === 'top' || p.selectMode === 'recent' || p.selectMode === 'mix') {
      this.selectMode = p.selectMode
    }
    if (typeof p.autoCycle === 'boolean') this.autoCycle = p.autoCycle
    if (typeof p.cycleInterval === 'number') this.cycleInterval = p.cycleInterval
    if (typeof p.livePoll === 'boolean') this.livePoll = p.livePoll
    if (typeof p.connectReplies === 'boolean') this.connectReplies = p.connectReplies
    if (typeof p.replyChains === 'boolean') this.replyChains = p.replyChains
    if (typeof p.cohesion === 'number') this.cohesion = Math.max(0, Math.min(1, p.cohesion))
    else if (p.clusterForce === true) this.cohesion = 1 // migrate old boolean
    if (typeof p.curvedEdges === 'boolean') this.curvedEdges = p.curvedEdges
    if (typeof p.showReposts === 'boolean') this.showReposts = p.showReposts
    if (typeof p.followsOnly === 'boolean') this.followsOnly = p.followsOnly
    if (typeof p.debugMode === 'boolean' && debugAllowed) this.debugMode = p.debugMode

    if (typeof localStorage !== 'undefined') {
      $effect.root(() => {
        $effect(() => {
          // Persist only what differs from the defaults (v2): an untouched
          // control keeps following the default, even when we change it later.
          const data: Persisted = { v: 2 }
          if (this.nodeLimit !== defaultLimit) data.nodeLimit = this.nodeLimit
          if (this.selectMode !== DEFAULTS.selectMode) data.selectMode = this.selectMode
          if (this.autoCycle !== DEFAULTS.autoCycle) data.autoCycle = this.autoCycle
          if (this.cycleInterval !== DEFAULTS.cycleInterval) data.cycleInterval = this.cycleInterval
          if (this.livePoll !== DEFAULTS.livePoll) data.livePoll = this.livePoll
          if (this.connectReplies !== DEFAULTS.connectReplies) data.connectReplies = this.connectReplies
          if (this.replyChains !== DEFAULTS.replyChains) data.replyChains = this.replyChains
          if (this.cohesion !== DEFAULTS.cohesion) data.cohesion = this.cohesion
          if (this.curvedEdges !== DEFAULTS.curvedEdges) data.curvedEdges = this.curvedEdges
          if (this.showReposts !== DEFAULTS.showReposts) data.showReposts = this.showReposts
          if (this.followsOnly !== DEFAULTS.followsOnly) data.followsOnly = this.followsOnly
          if (this.debugMode !== DEFAULTS.debugMode) data.debugMode = this.debugMode
          localStorage.setItem(KEY, JSON.stringify(data))
        })
      })
    }
  }
}

export const settings = new Settings()
