import type { SelectMode } from './graph'

const KEY = 'skynets.settings'

interface Persisted {
  nodeLimit: number
  selectMode: SelectMode
  autoCycle: boolean
  cycleInterval: number
  livePoll: boolean
  connectReplies: boolean
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
          }
          localStorage.setItem(KEY, JSON.stringify(data))
        })
      })
    }
  }
}

export const settings = new Settings()
