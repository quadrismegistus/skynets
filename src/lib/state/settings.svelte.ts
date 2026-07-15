import type { SelectMode } from './graph'

const KEY = 'skynets.settings'

interface Persisted {
  nodeLimit: number
  selectMode: SelectMode
  autoCycle: boolean
  cycleInterval: number
  livePoll: boolean
  connectReplies: boolean
  replyChains: boolean
  /** 0 = posts glued to the recency/engagement axes; 1 = connections pull
   * connected posts together (loosening the axes). Replaces the old boolean
   * `clusterForce`, which is still read once for migration. */
  cohesion: number
  clusterForce?: boolean
  curvedEdges: boolean
  showReposts: boolean
  followsOnly: boolean
  debugMode: boolean
}

function load(): Partial<Persisted> {
  if (typeof localStorage === 'undefined') return {}
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Persisted>
  } catch {
    return {}
  }
}

/**
 * User's view preferences, persisted to localStorage. Reactive via runes, so
 * components can bind directly (e.g. `bind:value={settings.nodeLimit}`) and the
 * change is saved automatically.
 */
class Settings {
  nodeLimit = $state(20)
  selectMode = $state<SelectMode>('mix')
  autoCycle = $state(false)
  cycleInterval = $state(4)
  livePoll = $state(true)
  connectReplies = $state(true)
  replyChains = $state(false)
  cohesion = $state(0)
  curvedEdges = $state(true)
  showReposts = $state(true)
  followsOnly = $state(false)
  debugMode = $state(false)

  constructor() {
    const p = load()
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
    if (typeof p.debugMode === 'boolean') this.debugMode = p.debugMode

    if (typeof localStorage !== 'undefined') {
      $effect.root(() => {
        $effect(() => {
          const data: Persisted = {
            nodeLimit: this.nodeLimit,
            selectMode: this.selectMode,
            autoCycle: this.autoCycle,
            cycleInterval: this.cycleInterval,
            livePoll: this.livePoll,
            connectReplies: this.connectReplies,
            replyChains: this.replyChains,
            cohesion: this.cohesion,
            curvedEdges: this.curvedEdges,
            showReposts: this.showReposts,
            followsOnly: this.followsOnly,
            debugMode: this.debugMode,
          }
          localStorage.setItem(KEY, JSON.stringify(data))
        })
      })
    }
  }
}

export const settings = new Settings()
