export interface LayoutNode {
  id: string
  /** Semantic target position (px) — where the layout wants this node. */
  tx: number
  ty: number
  /** Radius (px), for collision. */
  r: number
  /** Half-extents (px) when the node is a rectangle rather than a circle.
   * Set only in pill mode; see setCollision. */
  hw?: number
  hh?: number
  group?: string
  /** Solved position. */
  x: number
  y: number
  /** Held in place this solve: pinned by the user, or under the pointer. */
  fixed: boolean
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
 * Pill-mode node budget, pre-density and pre-clamp: how many pills to plan so
 * the FRAME ends up comfortably full. Extracted from Graph.svelte so the
 * phone-width case is unit-testable (the derivation there reads reactive state).
 *
 * `frameArea / cell` is the number of pills that geometrically tile the frame;
 * ×0.5 leaves the solver spread room (the other half is breathing space, not
 * emptiness). The subtlety is the reservoir: the solver spreads the whole
 * budget across the WORLD — frame plus a `bleed`-deep ring on every side — so
 * only the frame's share of that world area actually lands on-screen. To seat
 * ~half-the-frame pills in view, the budget must be scaled by world/frame area,
 * NOT a flat 1+OVERFLOW.
 *
 * On a desktop the bleed is a thin rim, so world/frame ≈ 1.33 and the old flat
 * 1.4 was fine — max() keeps that path byte-for-byte unchanged. On a ~402px
 * phone the pill is ~212px and bleed.x ~170px, so the horizontal reservoir is
 * nearly as wide as the frame itself: world/frame ≈ 2.2. The flat 1.4 planned
 * ~9 nodes, of which the solver parked more than half in that side reservoir
 * and only ~3 reached the screen. Scaling by the real ratio plans ~15, which
 * lands the ~8 readable pills a phone has room for while still stocking the
 * reservoir for dismissals.
 */
export function pillBudgetBase(
  frameW: number,
  frameH: number,
  cell: number,
  bleedX: number,
  bleedY: number,
  overflow: number,
): number {
  const area = frameW * frameH
  if (area <= 0 || cell <= 0) return 0
  const worldArea = (frameW + 2 * bleedX) * (frameH + 2 * bleedY)
  // max(): desktop stays on the original 1+OVERFLOW; narrow screens, whose
  // reservoir eats a larger share of the world, get the true ratio instead.
  return (area / cell) * 0.5 * Math.max(1 + overflow, worldArea / area)
}

/**
 * Deterministic layout solver. Replaces the d3-force simulation.
 *
 * At the setting everyone actually used (cohesion 0) the simulation ran only a
 * pull toward each node's semantic target, a link force at whisper strength,
 * and a collision pass — arriving at a position a solver can compute exactly,
 * just seven seconds of alpha decay later. That decay was the load flicker and
 * the post-arrival friction. Meanwhile the real layout work had migrated into
 * constraint passes that set positions directly (#separateGroups,
 * #unstraddleGroups, #clamp) and fought the simulation for the same
 * coordinates every tick.
 *
 * So: one pipeline, run to completion, synchronously.
 *
 *   1. seed every node at its semantic target
 *   2. hold whole conversations apart                         (#separateGroups)
 *   3. keep each conversation on one side of the frame edge (#unstraddleGroups)
 *   4. relax pairwise collisions to a fixed point                      (#relax)
 *   5. clamp to the world, never slicing the visible edge              (#clamp)
 *
 * `update()` returns with positions final. Motion is a render concern: the
 * caller animates from the previously painted positions to the new answer.
 * Same targets always solve to the same positions — there is no randomness and
 * no history in the free nodes, so the layout is testable as a pure function.
 */
export class Layout {
  #onChange: () => void
  #nodes: LayoutNode[] = []
  #byId = new Map<string, LayoutNode>()
  // Canvas bounds — see setBounds; 0 = unbounded.
  #bounds = { w: 0, h: 0, top: 0, bottom: 0, bleedX: 0, bleedY: 0 }
  #edge = 2
  /** Pill mode's inter-node gap; null = circular (avatar) collision. */
  #gap: { x: number; y: number } | null = null
  #targets: Target[] = []
  #pinned: ReadonlySet<string> = new Set()
  /** The node currently under the pointer, held where the drag put it. */
  #dragId: string | null = null
  /** Per-solve count of band rescues per group+axis — see #clamp's bench rule. */
  #bandTries = new Map<string, number>()

  constructor(onChange: () => void) {
    this.#onChange = onChange
  }

  /** Circles (avatars), or rectangles with the caller's gap (post pills). The
   * gap comes from the caller so that the collision, the tidy-tree grid and
   * the node budget all read the same number — three copies of it would drift
   * apart the first time one was tuned. */
  setCollision(gap: { x: number; y: number } | null) {
    // Keep nodes off the canvas edge by the same gap they keep from each other.
    // 2px is fine for an avatar but leaves a 212px pill flush against the
    // frame, where it sits on top of the axis labels.
    this.#edge = gap ? Math.min(gap.x, gap.y) : 2
    this.#gap = gap
  }

  /**
   * `bleed` lets nodes live OUTSIDE the visible frame — a reservoir parked
   * just past each edge. Dismissing an on-screen post re-ranks everything, and
   * the reservoir's nearest member moves inward to take its place, instead of
   * a replacement popping into existence mid-canvas.
   */
  setBounds(w: number, h: number, top: number, bottom: number, bleedX = 0, bleedY = 0) {
    this.#bounds = { w, h, top, bottom, bleedX, bleedY }
  }

  /** Solve for a new set of targets. Positions are final when this returns. */
  update(targets: Target[], pinned: ReadonlySet<string> = new Set()) {
    this.#targets = targets
    this.#pinned = pinned
    this.#solve()
  }

  /** Hold a node at (x, y) while the user drags it; everything else re-solves
   * around it on every call, so neighbours flow out of the way live. */
  dragTo(id: string, x: number, y: number) {
    const n = this.#byId.get(id)
    if (!n) return
    this.#dragId = id
    n.x = x
    n.y = y
    this.#solve()
  }

  /** End a drag — and deliberately do NOT re-solve. The node rests at its
   * drop point until the next update() decides its fate: if the user pins it
   * (a click follows the drop by ~200ms), the pin captures the DROP point; if
   * data moves on, the node seeds at its semantic target and glides home.
   * Re-solving here sent it home in that ~200ms gap, so pinning captured the
   * semantic spot instead of where the user just put it — a regression from
   * the simulation, whose near-cold alpha left dropped nodes in place until
   * the next reheat. */
  dragEnd(id: string) {
    if (this.#dragId === id) this.#dragId = null
  }

  positions(): Map<string, { x: number; y: number }> {
    const out = new Map<string, { x: number; y: number }>()
    for (const n of this.#nodes) out.set(n.id, { x: n.x, y: n.y })
    return out
  }

  #solve() {
    this.#seed()
    this.#anchorHeldGroups()
    // Iterated, because the two constraints interact: pulling a straddling
    // tree back inside the frame can drop it onto the neighbour it was just
    // separated from, and separating two trees can push one back across the
    // edge. Three rounds settles the realistic cases; it is a fixed bound
    // rather than a guarantee, and the passes below are the backstop.
    for (let round = 0; round < 3; round++) {
      this.#separateGroups()
      this.#unstraddleGroups()
    }
    // Collisions, then bounds — to a JOINT fixed point, because each can undo
    // the other: the clamp pulls straddling groups onto the same resting line
    // (stacking pills relax had just separated — measured: six visible
    // overlapping pairs at 25 nodes when this ran a fixed two rounds), and
    // separating that overlap can push a node back over an edge. So iterate
    // until the clamp stops moving anything, and always END on the clamp: the
    // never-sliced invariant is its exit guarantee.
    //
    // If two rounds haven't converged, the pair is in a tug-of-war the axis
    // rule cannot end — pills stacked along a resting line separate towards
    // the edge (least penetration) and the clamp puts them straight back. An
    // escape pass then resolves overlaps along the OTHER axis, spreading them
    // along the line instead of against the immovable edge. On budget
    // exhaustion the residual overlap is left, not looped on.
    this.#bandTries.clear()
    for (let round = 0; round < 12; round++) {
      this.#relax(round >= 2)
      if (this.#clamp() < 0.5) break
    }
    this.#onChange()
  }

  /**
   * Reconcile with the current targets, seeding every free node AT its target.
   *
   * No history: a free node's outcome depends only on this update's targets,
   * which is what makes the solve deterministic and idempotent. Only a pinned
   * or dragged node keeps its previous position — being held somewhere is the
   * one legitimate piece of state.
   */
  #seed() {
    const { w, h, bleedX, bleedY } = this.#bounds
    // During an active drag, free nodes WARM-START from their last solved
    // position instead of snapping back to their semantic target. #solve runs
    // per pointermove; reseeding every free node at its target each time made
    // the whole network teleport-to-target and re-separate on every move —
    // with large grouped pills (group + reservoir passes) that reads as the
    // graph "going haywire". Held to their last position, only the nodes the
    // dragged one actually collides with shift; the rest stay put. (Avatars
    // survived the reset because circle separation barely moves them, so this
    // changes nothing visible there.)
    const dragging = this.#dragId !== null
    const next: LayoutNode[] = []
    const nextById = new Map<string, LayoutNode>()
    for (const t of this.#targets) {
      const prev = this.#byId.get(t.id)
      const fixed = this.#pinned.has(t.id) || t.id === this.#dragId
      const warm = dragging && !fixed && prev !== undefined
      // A non-finite coordinate would spread through the pairwise passes to
      // every node (NaN defeats each comparison on its way to the y-push), so
      // it is contained here rather than diagnosed downstream.
      // Resolve a lone target that straddles a frame edge before anything
      // else reads it: half a post is unreadable, and it doesn't read as
      // "there is more over here" either — it just looks broken. Grouped
      // targets keep their raw geometry: resolving members one at a time sent
      // them to opposite sides of the edge, tearing the tree shape before the
      // group passes ever saw it. A tree resolves as one, in
      // #unstraddleGroups and #clamp.
      let tx = Number.isFinite(t.tx) ? t.tx : 0
      let ty = Number.isFinite(t.ty) ? t.ty : 0
      if (w && !t.group) {
        const bhw = (t.hw ?? t.r) + this.#edge
        const bhh = (t.hh ?? t.r) + this.#edge
        if (bleedX) tx = this.#unstraddle(this.#unstraddle(tx, bhw, 0), bhw, w)
        if (bleedY) ty = this.#unstraddle(this.#unstraddle(ty, bhh, 0), bhh, h)
      }
      const node: LayoutNode = {
        id: t.id,
        tx,
        ty,
        r: t.r,
        hw: t.hw,
        hh: t.hh,
        group: t.group,
        x: (fixed || warm) && prev ? prev.x : tx,
        y: (fixed || warm) && prev ? prev.y : ty,
        fixed,
      }
      next.push(node)
      nextById.set(t.id, node)
    }
    this.#nodes = next
    this.#byId = nextById
  }

  /**
   * A conversation with a pinned member arranges itself AROUND the pin.
   *
   * Revealing a topic pill pins it where it was clicked, but the members'
   * tidy-tree targets sit at the conversation's semantic spot — which can be
   * the far side of the canvas. Left unanchored, the pinned root stayed put
   * while its children seeded away at those targets, stretching the tree
   * corner to corner. Pinning means "this conversation lives here now", so
   * the whole group's targets shift to put the pinned node's target at its
   * held position; free members then seed beside it, and the semantic ranks
   * survive as the tree's INTERNAL arrangement. A dragged pin is preferred as
   * the anchor so a held conversation tracks the pointer as one.
   */
  #anchorHeldGroups() {
    for (const members of this.#groups().values()) {
      if (members.length < 2) continue
      const pinnedOnes = members.filter((n) => this.#pinned.has(n.id))
      const anchor = pinnedOnes.find((n) => n.id === this.#dragId) ?? pinnedOnes[0]
      if (!anchor) continue
      const dx = anchor.x - anchor.tx
      const dy = anchor.y - anchor.ty
      if (!dx && !dy) continue
      for (const n of members) {
        n.tx += dx
        n.ty += dy
        if (!n.fixed) {
          n.x = n.tx
          n.y = n.ty
        }
      }
    }
  }

  /** Resolve a straddled edge to whichever side the centre is already on. */
  #unstraddle(c: number, half: number, edge: number): number {
    if (c - half < edge && c + half > edge) return c > edge ? edge + half : edge - half
    return c
  }

  /** Bounding box of a group's TARGETS, including each member's padding.
   * Targets, not positions: a pinned member sits away from its target, and
   * measuring where it happens to be would make the separation depend on
   * interaction history rather than on this update's inputs. */
  #boxOf(members: LayoutNode[]) {
    let l = Infinity
    let r = -Infinity
    let t = Infinity
    let b = -Infinity
    for (const n of members) {
      const hw = (n.hw ?? n.r) + this.#edge
      const hh = (n.hh ?? n.r) + this.#edge
      l = Math.min(l, n.tx - hw)
      r = Math.max(r, n.tx + hw)
      t = Math.min(t, n.ty - hh)
      b = Math.max(b, n.ty + hh)
    }
    return { l, r, t, b }
  }

  #groups() {
    const groups = new Map<string, LayoutNode[]>()
    for (const n of this.#nodes) {
      const key = n.group ?? n.id // an ungrouped post is its own group
      const g = groups.get(key)
      if (g) g.push(n)
      else groups.set(key, [n])
    }
    return groups
  }

  /** Move a whole group — targets and positions together, so members do not
   * have to travel to a place the layout has already decided. */
  #shift(members: LayoutNode[], dx: number, dy: number) {
    for (const n of members) {
      n.tx += dx
      n.ty += dy
      n.x += dx
      n.y += dy
    }
  }

  /** A group the passes must not move: it contains a node the user is holding
   * in place. Everything else moves around it. */
  #held(members: LayoutNode[]): boolean {
    return members.some((n) => n.fixed)
  }

  /**
   * Hold whole conversations apart from each other.
   *
   * Collision acts on single posts, so two neighbouring trees would
   * interpenetrate and shove each other member by member — which reads as
   * bouncing rather than as two threads finding their places. A tree is one
   * object, so it repels as one: overlapping bounding boxes are separated
   * along whichever axis they overlap least, and every member moves by the
   * same amount, leaving the tidy-tree shape untouched.
   *
   * Two HELD groups overlapping are left overlapping: the user asked for both
   * spots, and honouring one pin by breaking the other is worse than the
   * overlap.
   */
  #separateGroups() {
    const groups = [...this.#groups().values()].filter((g) => g.length > 1)
    if (groups.length < 2) return
    for (let pass = 0; pass < 12; pass++) {
      let moved = false
      for (let i = 0; i < groups.length; i++) {
        for (let j = i + 1; j < groups.length; j++) {
          const gi = groups[i]
          const gj = groups[j]
          const iHeld = this.#held(gi)
          const jHeld = this.#held(gj)
          if (iHeld && jHeld) continue
          const a = this.#boxOf(gi)
          const b = this.#boxOf(gj)
          const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l)
          if (ox <= 0) continue
          const oy = Math.min(a.b, b.b) - Math.max(a.t, b.t)
          if (oy <= 0) continue
          const acx = (a.l + a.r) / 2
          const bcx = (b.l + b.r) / 2
          const acy = (a.t + a.b) / 2
          const bcy = (b.t + b.b) / 2
          if (ox < oy) {
            const s = bcx < acx ? -1 : 1
            if (iHeld) this.#shift(gj, s * ox, 0)
            else if (jHeld) this.#shift(gi, -s * ox, 0)
            else {
              this.#shift(gi, -s * ox * 0.5, 0)
              this.#shift(gj, s * ox * 0.5, 0)
            }
          } else {
            const s = bcy < acy ? -1 : 1
            if (iHeld) this.#shift(gj, 0, s * oy)
            else if (jHeld) this.#shift(gi, 0, -s * oy)
            else {
              this.#shift(gi, 0, -s * oy * 0.5)
              this.#shift(gj, 0, s * oy * 0.5)
            }
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
   * Resolving posts one at a time leaves every post whole but lets a reply
   * tree split across the boundary — half a thread in view, half out, with
   * edges running off into nothing. The group's bounding box decides, and
   * every member shifts by the same amount, preserving the tidy-tree shape.
   *
   * A tree too large to fit the frame is left alone. Shoving it wholly
   * outside would hide a conversation the reader can only ever see part of,
   * which is worse than showing part of it.
   */
  #unstraddleGroups() {
    const { w, h, bleedX, bleedY } = this.#bounds
    if (!bleedX && !bleedY) return
    for (const members of this.#groups().values()) {
      if (members.length < 2 || !members[0].group) continue // a lone post resolves in seed/clamp
      if (this.#held(members)) continue // don't teleport a tree the user is holding
      let l = Infinity
      let r = -Infinity
      let t = Infinity
      let bm = -Infinity
      for (const n of members) {
        const hw = (n.hw ?? n.r) + this.#edge
        const hh = (n.hh ?? n.r) + this.#edge
        l = Math.min(l, n.x - hw)
        r = Math.max(r, n.x + hw)
        t = Math.min(t, n.y - hh)
        bm = Math.max(bm, n.y + hh)
      }
      let dx = 0
      let dy = 0
      if (bleedX && this.#resolvable((r - l) / 2, w)) {
        if (l < 0 && r > 0) dx = (l + r) / 2 > 0 ? -l : -r
        else if (l < w && r > w) dx = (l + r) / 2 < w ? w - r : w - l
      }
      if (bleedY && this.#resolvable((bm - t) / 2, h)) {
        if (t < 0 && bm > 0) dy = (t + bm) / 2 > 0 ? -t : -bm
        else if (t < h && bm > h) dy = (t + bm) / 2 < h ? h - bm : h - t
      }
      if (dx || dy) this.#shift(members, dx, dy)
    }
  }

  /**
   * Relax pairwise collisions to a fixed point.
   *
   * The body is rectCollide's, converted from velocity space to position
   * space: each overlapping pair separates along whichever axis it overlaps
   * least (pills that merely graze side-on shouldn't be flung vertically), by
   * the full overlap, split between whichever ends are free to move. Iterated
   * until the worst correction in a pass is under half a pixel or the budget
   * runs out — on exhaustion the residual overlap is left, not looped on.
   *
   * O(n² · passes), which is fine: the graph caps at a few dozen nodes, and a
   * quadtree would cost more in complexity than it saves.
   */
  #relax(escapeFirst = false) {
    const nodes = this.#nodes
    let prevWorst = Infinity
    let stalled = 0
    for (let pass = 0; pass < 50; pass++) {
      // Deadlock escape: a free pill between two PINNED pills ping-ponged the
      // whole budget — each neighbour pushed it fully back across the other,
      // and the least-penetration rule kept choosing the axis that cannot be
      // satisfied. When three passes make no progress, resolve the stuck
      // pairs along the OTHER axis once (the row-change escape), then resume.
      // `escapeFirst` is the same escape driven from #solve, for tugs-of-war
      // against the clamp that a single relax call cannot see.
      const escape = (escapeFirst && pass === 0) || stalled >= 3
      let worst = 0
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]
          if (a.fixed && b.fixed) continue
          worst = Math.max(worst, this.#gap ? this.#relaxRect(a, b, escape) : this.#relaxCircle(a, b))
        }
      }
      if (worst < 0.5) break
      if (escape || worst < prevWorst - 0.5) stalled = 0
      else stalled++
      prevWorst = worst
    }
  }

  /** Apply a separation: the free end moves; two free ends split it. */
  #push(a: LayoutNode, b: LayoutNode, px: number, py: number) {
    if (a.fixed) {
      b.x += px
      b.y += py
    } else if (b.fixed) {
      a.x -= px
      a.y -= py
    } else {
      a.x -= px / 2
      a.y -= py / 2
      b.x += px / 2
      b.y += py / 2
    }
  }

  #relaxRect(a: LayoutNode, b: LayoutNode, escape = false): number {
    const gap = this.#gap!
    const dx = b.x - a.x
    const ox = (a.hw ?? a.r) + (b.hw ?? b.r) + gap.x - Math.abs(dx)
    if (ox <= 0) return 0
    const dy = b.y - a.y
    const oy = (a.hh ?? a.r) + (b.hh ?? b.r) + gap.y - Math.abs(dy)
    if (oy <= 0) return 0
    // Least penetration normally; the LARGER axis on a deadlock-escape pass.
    if (ox < oy !== escape) {
      this.#push(a, b, (dx < 0 ? -1 : 1) * ox, 0)
      return ox
    }
    this.#push(a, b, 0, (dy < 0 ? -1 : 1) * oy)
    return oy
  }

  #relaxCircle(a: LayoutNode, b: LayoutNode): number {
    // 9px of breathing room per node, as d3's forceCollide(r + 9) gave.
    const min = a.r + b.r + 18
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d2 = dx * dx + dy * dy
    if (d2 >= min * min) return 0
    const d = Math.sqrt(d2)
    if (d < 1e-6) {
      // Coincident centres: separate along x. The direction is arbitrary but
      // must be deterministic — same inputs, same layout.
      this.#push(a, b, min, 0)
      return min
    }
    const o = min - d
    this.#push(a, b, (dx / d) * o, (dy / d) * o)
    return o
  }

  /**
   * Resolve a span protruding past a content edge, biased toward staying
   * VISIBLE, and never left sliced by the WINDOW edge.
   *
   * Two distinct boundaries, because the chrome keep-outs leave a margin
   * between them: `inEdge` is where content should stop (visT/visB), and
   * `outEdge` is where the screen actually ends (0/h). Treating them as one —
   * pushing a group merely past the content edge — parked it in the visible
   * margin band with its body run off the bottom of the window: "out" of the
   * layout's frame, sliced on the reader's screen. Out means past the window.
   * A group already wholly within the margin band is left alone: visible and
   * whole, just rubbing shoulders with the chrome. On the x axis the two
   * edges coincide and the band is empty.
   *
   * The bias: deciding by centre alone sends a conversation outside as soon
   * as more than half hangs over the line, which parked far more than it
   * needed to — measured, ten of twenty posts. A tree is pushed out only when
   * little enough of it would show that the sliver is noise, not content.
   */
  #resolveBand(
    lo: number,
    hi: number,
    inEdge: number,
    outEdge: number,
    insidePositive: boolean,
    forceOut = false,
  ): number {
    const span = hi - lo
    if (span <= 0) return 0
    const KEEP_VISIBLE = 0.3
    if (insidePositive) {
      if (lo >= inEdge || hi <= outEdge) return 0 // wholly in content, or wholly off-window
      if (lo >= outEdge && hi <= inEdge) return 0 // wholly within the margin band
      const fraction = Math.max(0, Math.min(1, (hi - Math.max(lo, inEdge)) / span))
      return fraction >= KEEP_VISIBLE && !forceOut ? inEdge - lo : outEdge - hi
    }
    if (hi <= inEdge || lo >= outEdge) return 0
    if (hi <= outEdge && lo >= inEdge) return 0
    const fraction = Math.max(0, Math.min(1, (Math.min(hi, inEdge) - lo) / span))
    return fraction >= KEEP_VISIBLE && !forceOut ? inEdge - hi : outEdge - lo
  }

  /** Can both edges of a span be satisfied at once? Below 2x the half-extent
   * the two resolutions contradict — on a 250px canvas a 138px half pushed a
   * node off the left edge to clear the right — so it is better to leave it. */
  #resolvable(half: number, span: number): boolean {
    return 2 * half <= span
  }

  /**
   * Keep every group fully within the world (the frame plus the reservoir on
   * each side), and never sliced by the visible edge.
   *
   * Grouped nodes clamp as a unit: clamping members independently squashed a
   * parked conversation flat — a four-level thread at y = [-320,-232,-144,-56]
   * became [-60,-60,-60,-60], destroying the tidy-tree shape the group passes
   * exist to preserve. Bounds are inviolable, so this moves pinned and
   * dragged nodes too — a drag below the canvas comes to rest at the floor.
   *
   * Returns the largest displacement it applied, so #solve can iterate
   * relax↔clamp to a joint fixed point instead of guessing a round count.
   *
   * Known limit, unchanged from the simulation era: with no bleed on an axis,
   * a group larger than the content area is still squashed by the per-node
   * clamp at the end — the unit shift cannot satisfy bounds a group doesn't
   * fit inside.
   */
  #clamp(): number {
    const { w, h, top, bottom, bleedX, bleedY } = this.#bounds
    if (!w || !h) return 0
    const e = this.#edge
    let moved = 0
    // The VISIBLE content edges. `top`/`bottom` are the chrome keep-outs, and
    // a pill resolved against 0/h instead came to rest with its last 20px
    // behind the Digest bar.
    const visT = top
    const visB = h - bottom

    for (const members of this.#groups().values()) {
      let l = Infinity
      let r = -Infinity
      let t = Infinity
      let b = -Infinity
      for (const n of members) {
        const hw = (n.hw ?? n.r) + e
        const hh = (n.hh ?? n.r) + e
        l = Math.min(l, n.x - hw)
        r = Math.max(r, n.x + hw)
        t = Math.min(t, n.y - hh)
        b = Math.max(b, n.y + hh)
      }
      // The world a group may occupy: the frame plus the reservoir on each
      // side. The vertical reservoir hangs off the WINDOW edges (0/h), not
      // the content edges — parking "out" means past the screen, and the
      // reservoir must be deep enough to hold a group wholly off it.
      const worldL = bleedX ? -bleedX - (r - l) / 2 : 0
      const worldR = bleedX ? w + bleedX + (r - l) / 2 : w
      const worldT = bleedY ? -bleedY - (b - t) / 2 : visT
      const worldB = bleedY ? h + bleedY + (b - t) / 2 : visB

      let dx = 0
      let dy = 0
      if (l < worldL) dx = worldL - l
      else if (r > worldR) dx = worldR - r
      if (t < worldT) dy = worldT - t
      else if (b > worldB) dy = worldB - b

      // Never slice the visible edge: resolve the whole group to one side, but
      // only when it could fit — shoving an oversized conversation entirely
      // out of view hides something you can at best see part of.
      //
      // The bench rule: a group that needs rescuing from the same axis over
      // and over within one solve is in a game of musical chairs — the frame
      // has no room for it, relax keeps pushing it back over the edge, and
      // the KEEP_VISIBLE bias keeps pulling it in again, a limit cycle the
      // solve loop cannot exit (measured: clamp displacing a constant 43px
      // per round, forever). After three rescues it is resolved OUT and the
      // interior decrowds by one.
      const key = members[0].group ?? members[0].id
      if (bleedX && this.#resolvable((r - l) / 2, w)) {
        const force = (this.#bandTries.get(`x:${key}`) ?? 0) > 2
        const d1 = this.#resolveBand(l + dx, r + dx, 0, 0, true, force)
        const d2 = this.#resolveBand(l + dx + d1, r + dx + d1, w, w, false, force)
        if (d1 || d2) this.#bandTries.set(`x:${key}`, (this.#bandTries.get(`x:${key}`) ?? 0) + 1)
        dx += d1 + d2
      }
      if (bleedY && this.#resolvable((b - t) / 2, visB - visT)) {
        const force = (this.#bandTries.get(`y:${key}`) ?? 0) > 2
        const d1 = this.#resolveBand(t + dy, b + dy, visT, 0, true, force)
        const d2 = this.#resolveBand(t + dy + d1, b + dy + d1, visB, h, false, force)
        if (d1 || d2) this.#bandTries.set(`y:${key}`, (this.#bandTries.get(`y:${key}`) ?? 0) + 1)
        dy += d1 + d2
      }

      for (const n of members) {
        const px = n.x
        const py = n.y
        n.x += dx
        n.y += dy
        if (!bleedX) {
          const hw = (n.hw ?? n.r) + e
          n.x = Math.max(hw, Math.min(w - hw, n.x))
        }
        if (!bleedY) {
          const hh = (n.hh ?? n.r) + e
          n.y = Math.max(visT + hh, Math.min(visB - hh, n.y))
        }
        moved = Math.max(moved, Math.abs(n.x - px), Math.abs(n.y - py))
      }
    }
    return moved
  }
}
