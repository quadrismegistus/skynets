import type { FeedItem } from '../api/timeline'

/**
 * What the report dialog is aimed at. Modelled on compose.svelte: a tiny global
 * so the dialog can be mounted once in App.svelte, rather than threaded down
 * through Graph.svelte as yet another callback prop.
 *
 * It also has to outlive its opener. The post card is a hover affordance that
 * closes when the pointer leaves, and a report form the user is halfway through
 * typing into must not vanish with it.
 */
class ReportTarget {
  item = $state<FeedItem | undefined>(undefined)
  /** Report this one post, or the account behind it. */
  scope = $state<'post' | 'account'>('post')

  get open(): boolean {
    return this.item !== undefined
  }

  show(item: FeedItem, scope: 'post' | 'account' = 'post') {
    this.item = item
    this.scope = scope
  }

  close() {
    this.item = undefined
  }
}

export const report = new ReportTarget()
