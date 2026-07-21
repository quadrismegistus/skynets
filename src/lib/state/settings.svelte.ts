import type { SelectMode } from './graph'

const KEY = 'skynets.settings' // legacy name from before the Mothtrap rename — do not change (users' saved settings)

interface Persisted {
  /** Persistence-format version. Absent = v1 (see migrateV1). */
  v?: number
  /** Legacy fixed post count. Retired in favour of `density` (the count is now
   * derived from viewport area); still typed so migrateV1 can strip old blobs. */
  nodeLimit?: number
  /** How tightly the graph fills the frame — the padding preference that
   * replaced the fixed count. 1 = comfortable default; <1 sparser, >1 denser. */
  density?: number
  /** Speculative: render posts as readable pills instead of avatar circles. */
  postNodes?: boolean
  /** Entrance animation duration for arriving posts, in ms. 0 = snap (no
   * fly-in). Only the entrance is animated; positions are never eased. */
  motionMs?: number
  selectMode?: SelectMode
  autoCycle?: boolean
  cycleInterval?: number
  livePoll?: boolean
  connectReplies?: boolean
  replyChains?: boolean
  curvedEdges?: boolean
  showReposts?: boolean
  followsOnly?: boolean
  hideMutedReplies?: boolean
  debugMode?: boolean
}

/** Current defaults. A field is persisted ONLY while its value differs from
 * these, so changing a default here reaches every user who never touched that
 * control — the v1 format persisted everything on load, which silently froze
 * the defaults of first visit. */
export const DEFAULTS = {
  selectMode: 'mix' as SelectMode,
  autoCycle: false,
  cycleInterval: 4,
  livePoll: true,
  connectReplies: true,
  replyChains: true,
  curvedEdges: false,
  showReposts: true,
  followsOnly: false,
  hideMutedReplies: false,
  debugMode: false,
  postNodes: false,
  density: 1,
  motionMs: 450,
}

/** Bounds for the post-motion slider (ms). 0 = snap. Keep in sync with the slider. */
export const MOTION_MIN = 0
export const MOTION_MAX = 1000

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
  // The cohesion slider is gone (the deterministic solver has no forces to
  // blend), but the key stays here so migrateV1 strips it from old blobs.
  cohesion: 0,
  curvedEdges: true,
  showReposts: true,
  followsOnly: false,
  hideMutedReplies: false,
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

/** Debug tooling is a dev affordance: offered in any dev build and on
 * localhost (covers LAN-IP phone testing via `vite --host`); the hosted
 * instances hide the toggle and ignore any persisted value. */
export const debugAllowed =
  import.meta.env.DEV ||
  (typeof location !== 'undefined' && ['localhost', '127.0.0.1'].includes(location.hostname))

/**
 * User's view preferences, persisted to localStorage. Reactive via runes, so
 * components can bind directly (e.g. `bind:value={settings.density}`) and the
 * change is saved automatically.
 */
class Settings {
  density = $state(DEFAULTS.density)
  selectMode = $state<SelectMode>(DEFAULTS.selectMode)
  autoCycle = $state(DEFAULTS.autoCycle)
  cycleInterval = $state(DEFAULTS.cycleInterval)
  livePoll = $state(DEFAULTS.livePoll)
  connectReplies = $state(DEFAULTS.connectReplies)
  replyChains = $state(DEFAULTS.replyChains)
  curvedEdges = $state(DEFAULTS.curvedEdges)
  showReposts = $state(DEFAULTS.showReposts)
  followsOnly = $state(DEFAULTS.followsOnly)
  hideMutedReplies = $state(DEFAULTS.hideMutedReplies)
  debugMode = $state(DEFAULTS.debugMode)
  postNodes = $state(DEFAULTS.postNodes)
  motionMs = $state(DEFAULTS.motionMs)

  constructor() {
    const p = load()
    // Clamp to the slider's range on load: the derived budget already clamps its
    // own output, but a hand-edited/corrupt blob shouldn't leave `density` itself
    // out of [0.5, 2.5] for any future raw reader. Keep in sync with the slider.
    if (typeof p.density === 'number' && Number.isFinite(p.density)) {
      this.density = Math.min(2.5, Math.max(0.5, p.density))
    }
    if (p.selectMode === 'top' || p.selectMode === 'recent' || p.selectMode === 'mix') {
      this.selectMode = p.selectMode
    }
    if (typeof p.autoCycle === 'boolean') this.autoCycle = p.autoCycle
    if (typeof p.cycleInterval === 'number') this.cycleInterval = p.cycleInterval
    if (typeof p.livePoll === 'boolean') this.livePoll = p.livePoll
    if (typeof p.connectReplies === 'boolean') this.connectReplies = p.connectReplies
    if (typeof p.replyChains === 'boolean') this.replyChains = p.replyChains
    if (typeof p.curvedEdges === 'boolean') this.curvedEdges = p.curvedEdges
    if (typeof p.showReposts === 'boolean') this.showReposts = p.showReposts
    if (typeof p.followsOnly === 'boolean') this.followsOnly = p.followsOnly
    if (typeof p.hideMutedReplies === 'boolean') this.hideMutedReplies = p.hideMutedReplies
    if (typeof p.postNodes === 'boolean') this.postNodes = p.postNodes
    if (typeof p.motionMs === 'number' && Number.isFinite(p.motionMs)) {
      this.motionMs = Math.min(MOTION_MAX, Math.max(MOTION_MIN, p.motionMs))
    }
    if (typeof p.debugMode === 'boolean' && debugAllowed) this.debugMode = p.debugMode

    if (typeof localStorage !== 'undefined') {
      $effect.root(() => {
        $effect(() => {
          // Persist only what differs from the defaults (v2): an untouched
          // control keeps following the default, even when we change it later.
          const data: Persisted = { v: 2 }
          if (this.density !== DEFAULTS.density) data.density = this.density
          if (this.selectMode !== DEFAULTS.selectMode) data.selectMode = this.selectMode
          if (this.autoCycle !== DEFAULTS.autoCycle) data.autoCycle = this.autoCycle
          if (this.cycleInterval !== DEFAULTS.cycleInterval) data.cycleInterval = this.cycleInterval
          if (this.livePoll !== DEFAULTS.livePoll) data.livePoll = this.livePoll
          if (this.connectReplies !== DEFAULTS.connectReplies) data.connectReplies = this.connectReplies
          if (this.replyChains !== DEFAULTS.replyChains) data.replyChains = this.replyChains
          if (this.curvedEdges !== DEFAULTS.curvedEdges) data.curvedEdges = this.curvedEdges
          if (this.showReposts !== DEFAULTS.showReposts) data.showReposts = this.showReposts
          if (this.followsOnly !== DEFAULTS.followsOnly) data.followsOnly = this.followsOnly
          if (this.hideMutedReplies !== DEFAULTS.hideMutedReplies)
            data.hideMutedReplies = this.hideMutedReplies
          if (this.postNodes !== DEFAULTS.postNodes) data.postNodes = this.postNodes
          if (this.motionMs !== DEFAULTS.motionMs) data.motionMs = this.motionMs
          if (this.debugMode !== DEFAULTS.debugMode) data.debugMode = this.debugMode
          localStorage.setItem(KEY, JSON.stringify(data))
        })
      })
    }
  }
}

export const settings = new Settings()
