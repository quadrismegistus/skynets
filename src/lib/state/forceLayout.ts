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
  /** Half-extents (px) when the node is a rectangle rather than a circle.
   * Set only in pill mode; see setCollision. */
  hw?: number
  hh?: number
  group?: string
}

export interface Target {
  id: string
  tx: number
  ty: number
  r: number
  hw?: number
  hh?: number
  group?: string
}

/**
 * Axis-aligned rectangle collision, for pill-shaped nodes.
 *
 * d3's forceCollide is circular, and a circle circumscribing a 208x56 pill
 * reserves about four times the area the pill occupies — enough that the graph
 * reads as a handful of islands instead of a conversation. This resolves the
 * real overlap instead, separating each pair along whichever axis they overlap
 * least, so pills stack closely in rows the way they look like they should.
 *
 * O(n^2), which is fine: pill mode caps the graph at a few dozen nodes, and a
 * quadtree would cost more in complexity than it saves in a thousand pair
 * checks per tick.
 */
function rectCollide(padX: number, padY: number, strength = 0.7, iterations = 2) {
  let nodes: SimNode[] = []
  // Deliberately ignores alpha, as d3's own forceCollide does. Scaling the
  // push by alpha means separation weakens as the sim cools, so overlapping
  // pills simply freeze that way instead of resolving — which is exactly what
  // the first version of this did.
  const force = () => {
    for (let pass = 0; pass < iterations; pass++)
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]
      if (a.x == null || a.y == null) continue
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]
        if (b.x == null || b.y == null) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const ox = (a.hw ?? a.r) + (b.hw ?? b.r) + padX - Math.abs(dx)
        if (ox <= 0) continue
        const oy = (a.hh ?? a.r) + (b.hh ?? b.r) + padY - Math.abs(dy)
        if (oy <= 0) continue
        // Separate along the axis of least penetration: pills that merely graze
        // side-on shouldn't be flung vertically.
        const k = strength * 0.5
        if (ox < oy) {
          const push = (dx < 0 ? -1 : 1) * ox * k
          a.vx = (a.vx ?? 0) - push
          b.vx = (b.vx ?? 0) + push
        } else {
          const push = (dy < 0 ? -1 : 1) * oy * k
          a.vy = (a.vy ?? 0) - push
          b.vy = (b.vy ?? 0) + push
        }
      }
    }
  }
  force.initialize = (n: SimNode[]) => {
    nodes = n
  }
  return force
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
  #bounds = { w: 0, h: 0, top: 0, bottom: 0, bleedX: 0, bleedY: 0 }
  #edge = 2

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

  /** Circles (avatars), or rectangles with the caller's gap (post pills). Cheap
   * to flip: the sim keeps its nodes and positions, so toggling re-settles
   * rather than restarting. The gap comes from the caller so that the collision,
   * the tidy-tree grid and the node budget all read the same number — three
   * copies of it would drift apart the first time one was tuned. */
  setCollision(gap: { x: number; y: number } | null) {
    // Keep nodes off the canvas edge by the same gap they keep from each other.
    // The old 2px was fine for an avatar but leaves a 212px pill flush against
    // the frame, where it sits on top of the axis labels.
    this.#edge = gap ? Math.min(gap.x, gap.y) : 2
    this.sim.force(
      'collide',
      gap ? rectCollide(gap.x, gap.y) : forceCollide<SimNode>((d) => d.r + 9).strength(0.9),
    )
  }

  /** Bounding box of a set of nodes, including each one's collision padding. */
  #boxOf(members: SimNode[]) {
    let l = Infinity
    let r = -Infinity
    let t = Infinity
    let b = -Infinity
    for (const n of members) {
      const hw = (n.hw ?? n.r) + this.#edge
      const hh = (n.hh ?? n.r) + this.#edge
      l = Math.min(l, n.x! - hw)
      r = Math.max(r, n.x! + hw)
      t = Math.min(t, n.y! - hh)
      b = Math.max(b, n.y! + hh)
    }
    return { l, r, t, b }
  }

  #groups() {
    const groups = new Map<string, SimNode[]>()
    for (const n of this.#nodes) {
      if (n.x == null || n.y == null) continue
      const key = n.group ?? n.id // an ungrouped post is its own group
      const g = groups.get(key)
      if (g) g.push(n)
      else groups.set(key, [n])
    }
    return groups
  }

  #shift(members: SimNode[], dx: number, dy: number) {
    for (const n of members) {
      n.x! += dx
      n.y! += dy
      n.tx += dx
      n.ty += dy
    }
  }

  /**
   * Hold whole conversations apart from each other.
   *
   * Collision acts on single posts, so two neighbouring trees interpenetrate and
   * shove each other member by member -- which reads as bouncing rather than as
   * two threads finding their places. A tree is one object, so it repels as one:
   * overlapping bounding boxes are separated along whichever axis they overlap
   * least, and every member moves by the same amount, leaving the tidy-tree
   * shape untouched.
   *
   * Once per update, on targets as well as positions. Per-tick this would be the
   * same accumulating shove it is meant to replace.
   */
  #separateGroups() {
    const groups = [...this.#groups().values()].filter((g) => g.length > 1)
    if (groups.length < 2) return
    for (let pass = 0; pass < 12; pass++) {
      let moved = false
      for (let i = 0; i < groups.length; i++) {
        for (let j = i + 1; j < groups.length; j++) {
          const a = this.#boxOf(groups[i])
          const b = this.#boxOf(groups[j])
          const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l)
          if (ox <= 0) continue
          const oy = Math.min(a.b, b.b) - Math.max(a.t, b.t)
          if (oy <= 0) continue
          const acx = (a.l + a.r) / 2
          const bcx = (b.l + b.r) / 2
          const acy = (a.t + a.b) / 2
          const bcy = (b.t + b.b) / 2
          if (ox < oy) {
            const push = (bcx < acx ? -1 : 1) * ox * 0.5
            this.#shift(groups[i], -push, 0)
            this.#shift(groups[j], push, 0)
          } else {
            const push = (bcy < acy ? -1 : 1) * oy * 0.5
            this.#shift(groups[i], 0, -push)
            this.#shift(groups[j], 0, push)
          }
          moved = true
        }
      }
      if (!moved) break
    }
  }

  /**
   * Keep a whole conversation on one side of the frame edge.
   *
   * Resolving posts one at a time leaves every post whole but lets a reply tree
   * split across the boundary -- half a thread in view, half out, with edges
   * running off into nothing. A tree reads as one object, so it moves as one:
   * the group's bounding box decides, and every member shifts by the same
   * amount, which preserves the tidy-tree shape exactly.
   *
   * A tree too large to fit the frame is left alone. Shoving it wholly outside
   * would hide a conversation the reader can only ever see part of, which is
   * worse than showing part of it.
   *
   * Called once per update. It moves targets as well as positions, so it must
   * NOT run per-tick: doing that accumulated a fresh shift every frame and the
   * layout visibly bounced while the forces chased it.
   */
  #unstraddleGroups() {
    const { w, h, bleedX, bleedY } = this.#bounds
    if (!bleedX && !bleedY) return
    const groups = new Map<string, SimNode[]>()
    for (const n of this.#nodes) {
      if (!n.group || n.x == null || n.y == null) continue
      const g = groups.get(n.group)
      if (g) g.push(n)
      else groups.set(n.group, [n])
    }
    for (const members of groups.values()) {
      if (members.length < 2) continue // a lone post is already resolved
      let l = Infinity
      let r = -Infinity
      let t = Infinity
      let bm = -Infinity
      for (const n of members) {
        const hw = (n.hw ?? n.r) + this.#edge
        const hh = (n.hh ?? n.r) + this.#edge
        l = Math.min(l, n.x! - hw)
        r = Math.max(r, n.x! + hw)
        t = Math.min(t, n.y! - hh)
        bm = Math.max(bm, n.y! + hh)
      }
      let dx = 0
      let dy = 0
      if (bleedX && r - l <= w) {
        if (l < 0 && r > 0) dx = (l + r) / 2 > 0 ? -l : -r
        else if (l < w && r > w) dx = (l + r) / 2 < w ? w - r : w - l
      }
      if (bleedY && bm - t <= h) {
        if (t < 0 && bm > 0) dy = (t + bm) / 2 > 0 ? -t : -bm
        else if (t < h && bm > h) dy = (t + bm) / 2 < h ? h - bm : h - t
      }
      if (!dx && !dy) continue
      for (const n of members) {
        n.x! += dx
        n.y! += dy
        n.tx += dx // move the target too, or the forces drag it straight back
        n.ty += dy
      }
    }
  }

  /**
   * Resolve a straddled frame edge: a post is either in the frame or out of it,
   * never sliced by the boundary. Half a post is unreadable, and it doesn't read
   * as "there is more over here" either -- it just looks broken.
   *
   * Which way it resolves is decided by the side its centre is already on, which
   * gives the rule its own hysteresis: a node cannot oscillate across the edge,
   * because crossing the centre line is what changes the answer.
   */
  #unstraddle(c: number, half: number, edge: number): number {
    if (c - half < edge && c + half > edge) return c > edge ? edge + half : edge - half
    return c
  }

  /**
   * Project a point out to the world's boundary, keeping its direction from the
   * frame's centre. A post bound for the top-right enters from the top-right,
   * so its arrival reads as coming from where it belongs rather than sliding in
   * from an arbitrary edge.
   */
  #outsideAlong(tx: number, ty: number) {
    const { w, h, bleedX, bleedY } = this.#bounds
    const cx = w / 2
    const cy = h / 2
    const vx = tx - cx
    const vy = ty - cy
    if (!vx && !vy) return { x: cx, y: -bleedY } // dead centre: come from above
    const kx = vx ? (cx + bleedX) / Math.abs(vx) : Infinity
    const ky = vy ? (cy + bleedY) / Math.abs(vy) : Infinity
    const k = Math.min(kx, ky)
    return { x: cx + vx * k, y: cy + vy * k }
  }

  /** Keep every node fully within the canvas (below `top`, above `bottom`, and
   * inside the left/right edges), respecting its radius. */
  /**
   * `bleed` lets nodes live OUTSIDE the visible frame — a reservoir parked just
   * past each edge. Dismissing an on-screen post re-ranks everything, and the
   * reservoir's nearest member drifts inward to take its place, instead of a
   * replacement popping into existence mid-canvas.
   */
  setBounds(w: number, h: number, top: number, bottom: number, bleedX = 0, bleedY = 0) {
    this.#bounds = { w, h, top, bottom, bleedX, bleedY }
  }
  #clamp() {
    const { w, h, top, bottom, bleedX, bleedY } = this.#bounds
    if (!w || !h) return
    for (const n of this.#nodes) {
      const hw = n.hw ?? n.r
      const hh = n.hh ?? n.r
      const e = this.#edge
      // `bleed` is how far a node's CENTRE may travel past the frame -- not how
      // far its edge may poke out. Subtracting it from an hw-based inset (the
      // first attempt) let bleed cancel hw and confined every centre to the
      // frame anyway, so the reservoir never existed. Parking a node out of
      // sight needs its centre beyond the edge, hence hw drops out entirely.
      if (n.x != null)
        n.x = bleedX
          ? Math.max(-bleedX, Math.min(w + bleedX, n.x))
          : Math.max(hw + e, Math.min(w - hw - e, n.x))
      if (n.y != null)
        n.y = bleedY
          ? Math.max(top - bleedY, Math.min(h - bottom + bleedY, n.y))
          : Math.max(top + hh, Math.min(h - bottom - hh, n.y))
      // With a reservoir there are real edges to straddle; without one every
      // node is inside the frame already and there is nothing to resolve.
      if (bleedX && n.x != null) {
        n.x = this.#unstraddle(n.x, hw + e, 0)
        n.x = this.#unstraddle(n.x, hw + e, w)
      }
      if (bleedY && n.y != null) {
        // The VISIBLE edges are 0 and h. `top`/`bottom` are chrome keep-outs,
        // and resolving against those pushed a node clear of the topbar and
        // straight across y=0 instead -- still sliced, just by a different line.
        n.y = this.#unstraddle(n.y, hh + e, 0)
        n.y = this.#unstraddle(n.y, hh + e, h)
      }
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
        node = { id: t.id, x: sx, y: sy, tx: t.tx, ty: t.ty, r: t.r, hw: t.hw, hh: t.hh, group: t.group }
      }
      node.tx = t.tx
      node.ty = t.ty
      if (this.#bounds.w) {
        const bhw = (t.hw ?? t.r) + this.#edge
        const bhh = (t.hh ?? t.r) + this.#edge
        const { w: bw, h: bh, top: bt, bottom: bb, bleedX: bx, bleedY: by } = this.#bounds
        if (bx) {
          node.tx = this.#unstraddle(this.#unstraddle(node.tx, bhw, 0), bhw, bw)
        }
        if (by) {
          node.ty = this.#unstraddle(this.#unstraddle(node.ty, bhh, 0), bhh, bh)
        }
      }
      node.r = t.r
      node.hw = t.hw
      node.hh = t.hh
      node.group = t.group
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
    // Once per update, not once per tick. Run from #clamp it re-shifted targets
    // on every frame, so the forces were chasing a target that kept moving --
    // which is what the bouncing was.
    this.#separateGroups()
    this.#unstraddleGroups()

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
