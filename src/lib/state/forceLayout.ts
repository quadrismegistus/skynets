import {
  forceCollide,
  forceLink,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force'

export interface SimNode extends SimulationNodeDatum {
  id: string
  /** Semantic target position (px) this node is pulled toward. */
  tx: number
  ty: number
  /** Radius (px), for collision. */
  r: number
}

export interface Target {
  id: string
  tx: number
  ty: number
  r: number
}

export interface SimLink {
  source: string
  target: string
}

/**
 * Anchored force layout. Nodes are pulled toward rank-based semantic targets
 * (x = engagement, y = recency) rather than floating freely, so the meaning of
 * position survives. Collision keeps avatars from overlapping and a weak link
 * force lets replies drift toward parents. Tuned to *ease* into place over a few
 * seconds (low alphaDecay, high velocityDecay) — motion in slow-mo, not a snap.
 */
export class ForceLayout {
  readonly sim: Simulation<SimNode, SimLink>
  #nodes: SimNode[] = []
  #byId = new Map<string, SimNode>()

  constructor(onTick: () => void) {
    this.sim = forceSimulation<SimNode, SimLink>([])
      .alphaDecay(0.012) // slow settle (~7–8s)
      .velocityDecay(0.5) // friction
      .force('x', forceX<SimNode>((d) => d.tx).strength(0.08))
      .force('y', forceY<SimNode>((d) => d.ty).strength(0.08))
      .force('collide', forceCollide<SimNode>((d) => d.r + 3).strength(0.85))
      .on('tick', onTick)
    this.sim.stop()
  }

  /**
   * Reconcile the simulation with a new set of targets + links. Existing nodes
   * keep their current position/velocity (continuous motion); new nodes start at
   * their target so they ease outward rather than flying in from origin; dropped
   * nodes are removed. Then the sim gently reheats.
   */
  update(targets: Target[], links: SimLink[], pinned: ReadonlySet<string> = new Set()) {
    const next: SimNode[] = []
    const nextById = new Map<string, SimNode>()
    for (const t of targets) {
      const existing = this.#byId.get(t.id)
      const node: SimNode = existing ?? { id: t.id, x: t.tx, y: t.ty, tx: t.tx, ty: t.ty, r: t.r }
      node.tx = t.tx
      node.ty = t.ty
      node.r = t.r
      // Pinned nodes are fixed at their current position (fx/fy); others are free.
      if (pinned.has(t.id)) {
        node.fx = node.x ?? t.tx
        node.fy = node.y ?? t.ty
      } else {
        node.fx = null
        node.fy = null
      }
      next.push(node)
      nextById.set(t.id, node)
    }
    this.#nodes = next
    this.#byId = nextById

    // Only keep links whose endpoints are present (avoids d3 "node not found").
    const present = nextById
    const safeLinks = links
      .filter((l) => present.has(l.source) && present.has(l.target))
      .map((l) => ({ source: l.source, target: l.target }))

    this.sim.nodes(this.#nodes)
    this.sim.force(
      'link',
      forceLink<SimNode, SimLink>(safeLinks)
        .id((d) => d.id)
        .distance(70)
        .strength(0.05),
    )
    this.sim.alpha(0.7).restart()
  }

  positions(): Map<string, { x: number; y: number }> {
    const out = new Map<string, { x: number; y: number }>()
    for (const n of this.#nodes) out.set(n.id, { x: n.x ?? n.tx, y: n.y ?? n.ty })
    return out
  }

  stop() {
    this.sim.stop()
  }
}
