import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type ForceX,
  type ForceY,
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
  // Canvas bounds — nodes are clamped fully inside so they can't drift up behind
  // the top bar (or off any edge). Set via setBounds; 0 = unbounded.
  // The bottom chrome (gear bottom-left, Digest/Load-more bottom-right) lives in
  // the CORNERS, so a bigger bottom inset is reserved only there — the
  #bounds = { w: 0, h: 0, top: 0, bottom: 0 }

  constructor(onTick: () => void) {
    this.sim = forceSimulation<SimNode, SimLink>([])
      .alphaDecay(0.012) // slow settle (~7–8s)
      .velocityDecay(0.5) // friction
      .force('x', forceX<SimNode>((d) => d.tx).strength(0.08))
      .force('y', forceY<SimNode>((d) => d.ty).strength(0.08))
      .force('collide', forceCollide<SimNode>((d) => d.r + 9).strength(0.9))
      .on('tick', () => {
        this.#clamp()
        onTick()
      })
    this.sim.stop()
  }

  /** Keep every node fully within the canvas (below `top`, above `bottom`, and
   * inside the left/right edges), respecting its radius. */
  setBounds(w: number, h: number, top: number, bottom: number) {
    this.#bounds = { w, h, top, bottom }
  }
  #clamp() {
    const { w, h, top, bottom } = this.#bounds
    if (!w || !h) return
    for (const n of this.#nodes) {
      const r = n.r
      if (n.x != null) n.x = Math.max(r + 2, Math.min(w - r - 2, n.x))
      if (n.y != null) n.y = Math.max(top + r, Math.min(h - bottom - r, n.y))
    }
  }

  /**
   * Reconcile the simulation with a new set of targets + links. Existing nodes
   * keep their current position/velocity (continuous motion); new nodes start at
   * their target so they ease outward rather than flying in from origin — except
   * a new node linked to an already-placed one (a mapped thread reply), which is
   * seeded beside its partner so it visibly emanates from the conversation
   * rather than materializing elsewhere on the canvas. Dropped nodes are
   * removed. Then the sim gently reheats.
   */
  update(
    targets: Target[],
    links: SimLink[],
    pinned: ReadonlySet<string> = new Set(),
    /** 0 = nodes glued to their recency/engagement targets; 1 = links + charge
     * dominate and connected posts clump. Interpolated, not a switch. */
    cohesion = 0,
  ) {
    // For a new node, find an already-placed anchor: follow the reply→parent
    // chain (a freshly mapped thread anchors to the clicked post), else any
    // directly linked placed node (a pulled-in parent anchors to its reply).
    const parentOf = new Map(links.map((l) => [l.source, l.target]))
    const anchorFor = (id: string): SimNode | undefined => {
      let cur: string | undefined = id
      for (let hops = 0; cur && hops < 32; hops++) {
        const found = this.#byId.get(cur)
        if (found) return found
        cur = parentOf.get(cur)
      }
      const back = links.find((l) => l.target === id && this.#byId.has(l.source))
      return back ? this.#byId.get(back.source) : undefined
    }
    const next: SimNode[] = []
    const nextById = new Map<string, SimNode>()
    for (const t of targets) {
      const existing = this.#byId.get(t.id)
      let node: SimNode
      if (existing) {
        node = existing
      } else {
        const near = anchorFor(t.id)
        const sx = near?.x != null ? near.x + (Math.random() - 0.5) * 24 : t.tx
        const sy = near?.y != null ? near.y + (Math.random() - 0.5) * 24 : t.ty
        node = { id: t.id, x: sx, y: sy, tx: t.tx, ty: t.ty, r: t.r }
      }
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

    // Cohesion dial: at 0 the recency × engagement axes dominate and links are a
    // whisper (the axis anchor OUTWEIGHS the edges, so reply/topic edges can't
    // drag the graph into a central knot); at 1 strong links + charge pull
    // connected posts into clumps and the axes go slack. Everything in between is
    // a smooth blend, not a switch.
    const k = Math.max(0, Math.min(1, cohesion))
    ;(this.sim.force('x') as ForceX<SimNode>).strength(0.18 - 0.16 * k)
    ;(this.sim.force('y') as ForceY<SimNode>).strength(0.18 - 0.16 * k)
    this.sim.force(
      'link',
      forceLink<SimNode, SimLink>(safeLinks)
        .id((d) => d.id)
        .distance(60 - 14 * k)
        .strength(0.02 + 0.53 * k),
    )
    this.sim.force('charge', k > 0.05 ? forceManyBody<SimNode>().strength(-30 * k) : null)
    this.sim.alpha(0.7).restart()
  }

  /** Hold a node at (x, y) while the user drags it; keeps the sim warm so
   * neighbors flow around it. */
  dragTo(id: string, x: number, y: number) {
    const n = this.#byId.get(id)
    if (!n) return
    n.fx = x
    n.fy = y
    n.x = x
    n.y = y
    this.sim.alphaTarget(0.12).restart()
  }

  /** End a drag: cool the sim; release the node unless it should stay fixed
   * (i.e. it was pinned by the drop). */
  dragEnd(id: string, keepFixed: boolean) {
    this.sim.alphaTarget(0)
    const n = this.#byId.get(id)
    if (n && !keepFixed) {
      n.fx = null
      n.fy = null
    }
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
