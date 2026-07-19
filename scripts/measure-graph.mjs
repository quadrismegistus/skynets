/**
 * Measure graph layout behaviour against a REAL timeline.
 *
 * The demo fixture cannot answer most of these questions: 27 posts against ~21
 * planned leaves corpus-wide ranking almost nothing to rank over, and it
 * returned byte-identical numbers across changes that mattered. Anything about
 * reservoirs, arrivals or ranking has to be measured signed in.
 *
 *   npm run build && npx vite preview --port 4319 --strictPort &
 *   BSKY_HANDLE=you.example.com \
 *   BSKY_PASS=$(security find-generic-password -a "$USER" -s mothtrap-test -w) \
 *   node scripts/measure-graph.mjs [boundary|arrivals|settle]
 *
 * The app password is read from the environment and never printed. Keep it out
 * of argv too -- argv is visible in `ps`.
 *
 * Why each probe exists, i.e. the mistake it was written to catch:
 *
 *  boundary  Counts posts whole / hidden / SLICED by the frame edge, and reply
 *            edges crossing it. An earlier version classified a post as
 *            "reserved" if any pixel sat outside, which flags ordinary edge
 *            pills -- it reported a reservoir that did not exist, and stayed
 *            stubbornly constant while I tuned the thing it was measuring.
 *            Classify by CENTRE.
 *
 *  arrivals  Polls fast enough to catch where a new post FIRST appears. A
 *            census that only counts "was it in the DOM before" cannot tell an
 *            arrival that blinked into frame from one that entered at the rim,
 *            which is the entire question.
 *
 *  settle    Pixels travelled per 500ms window after load. Beware: this counts
 *            a tree gliding to a sensible place exactly like a tree being
 *            jostled out of one. It measures motion, not restlessness -- it
 *            called a genuine improvement a 39% regression. Trust your eyes
 *            over this number when they disagree.
 */

import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://localhost:4319'
const MODE = process.argv[2] ?? 'boundary'
const VIEWPORT = { width: 1280, height: 820 }

async function signedInPage(browser) {
  const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage()
  await page.goto(`${BASE}/?pills=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  // Login defaults to OAuth; switch to the app-password form.
  if (await page.locator('button.toggle').count()) {
    await page.locator('button.toggle').click()
    const form = page.locator('form.app-pw')
    await form.locator('input[type="text"]').fill(process.env.BSKY_HANDLE)
    await form.locator('input[type="password"]').fill(process.env.BSKY_PASS)
    await form.locator('button[type="submit"]').click()
  }
  await page.waitForSelector('.wrap.pill', { timeout: 60_000 })
  return page
}

/**
 * Centre of every pill, plus whether it is mid-entrance.
 *
 * Position alone cannot answer "did it glide in?" now that the entrance is a
 * render-level transform: the node's left/top is its FINAL place from the first
 * frame, so a post caught part-way through its glide reads as already in frame.
 * The `entering` class is the direct answer.
 */
const centres = (page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('.wrap.pill')].map((el) => {
        const r = el.getBoundingClientRect()
        return [
          el.querySelector('.say .text')?.textContent?.slice(0, 20) ?? '?',
          [
            Math.round(r.x + r.width / 2),
            Math.round(r.y + r.height / 2),
            el.classList.contains('entering') || getComputedStyle(el).opacity !== '1',
          ],
        ]
      }),
    ),
  )

async function boundary(page) {
  // Sampled twice. A single snapshot cannot tell a tree PARKED in the reservoir
  // from one still gliding in: backfill keeps delivering conversations, and
  // each enters from outside, so there are always some in transit.
  for (const wait of [15_000, 25_000]) {
    await page.waitForTimeout(wait === 15_000 ? wait : wait - 15_000)
    console.log(`at ${wait / 1000}s:`, JSON.stringify(await countBoundary(page)))
  }
}

function countBoundary(page) {
  return page.evaluate(() => {
    const W = innerWidth
    const H = innerHeight
    let whole = 0
    let hidden = 0
    let sliced = 0
    for (const el of document.querySelectorAll('.wrap.pill')) {
      const b = el.getBoundingClientRect()
      if (b.left >= -1 && b.right <= W + 1 && b.top >= -1 && b.bottom <= H + 1) whole++
      else if (b.right <= 1 || b.left >= W - 1 || b.bottom <= 1 || b.top >= H - 1) hidden++
      else sliced++
    }
    // A reply edge with one end in view and the other out means a tree is split
    // across the boundary. An edge ENTIRELY outside the window is not: two
    // reservoir-parked posts connected below the frame are invisible, and an
    // earlier version counted one as "crossing" because its horizontal extent
    // happened to bracket the right edge while the whole element sat below the
    // bottom one.
    let crossing = 0
    for (const el of document.querySelectorAll('svg line, svg path')) {
      const b = el.getBoundingClientRect()
      if (!b.width && !b.height) continue
      if (b.right <= 0 || b.left >= W || b.bottom <= 0 || b.top >= H) continue
      if ((b.left < 0 && b.right > 0) || (b.left < W && b.right > W)) crossing++
      else if ((b.top < 0 && b.bottom > 0) || (b.top < H && b.bottom > H)) crossing++
    }
    return { whole, hidden, slicedByTheEdge: sliced, edgesCrossingBoundary: crossing }
  })
}

async function arrivals(page) {
  await page.waitForTimeout(15_000)
  const seen = new Set(Object.keys(await centres(page)))
  let outside = 0
  let popped = 0
  for (let dismissals = 0; dismissals < 3; dismissals++) {
    // Dispatched rather than clicked: nodes are never "stable" for Playwright
    // (the sim moves them every tick, arrivals carry a transition), and the
    // first pill in DOM order is often one parked OUTSIDE the viewport, which
    // cannot be clicked at all. Pick one in frame and send the events.
    await page.evaluate(() => {
      const inFrame = [...document.querySelectorAll('.wrap.pill')].find((el) => {
        const r = el.getBoundingClientRect()
        const cx = r.x + r.width / 2
        const cy = r.y + r.height / 2
        return cx > 0 && cx < innerWidth && cy > 0 && cy < innerHeight
      })
      if (!inFrame) throw new Error('no pill in frame to dismiss')
      const r = inFrame.getBoundingClientRect()
      const at = { clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, bubbles: true }
      // The handler only honours a right-click from a MOUSE (a touch long-press
      // fires the same event), and reads the type from the preceding pointerdown.
      inFrame.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerType: 'mouse', button: 2 }))
      inFrame.dispatchEvent(new MouseEvent('contextmenu', { ...at, cancelable: true }))
    })
    for (let i = 0; i < 22; i++) {
      for (const [key, [x, y, animating]] of Object.entries(await centres(page))) {
        if (seen.has(key)) continue
        seen.add(key)
        const inFrame = x >= 0 && x <= VIEWPORT.width && y >= 0 && y <= VIEWPORT.height
        // Glided if it was seeded outside OR caught mid-entrance.
        if (animating || !inFrame) outside++
        else popped++
        console.log(
          `${animating ? 'GLIDING IN      ' : inFrame ? 'POPPED IN FRAME ' : 'entered outside '} at (${x},${y})`,
        )
      }
      await page.waitForTimeout(100) // fast enough to catch first appearance
    }
  }
  console.log(`\nglided in: ${outside}   popped in frame: ${popped}`)
}

async function settle(page) {
  let prev = null
  let total = 0
  for (let t = 0; t <= 6000; t += 500) {
    const now = await centres(page)
    if (prev) {
      let step = 0
      for (const k of Object.keys(now)) {
        if (prev[k]) step += Math.hypot(now[k][0] - prev[k][0], now[k][1] - prev[k][1])
      }
      total += step
      console.log(`${t}ms  travel=${Math.round(step)}px`)
    }
    prev = now
    await page.waitForTimeout(500)
  }
  // Per post as well as total: the total sums over whatever is on screen, so a
  // change that shows MORE posts looks like more churn even when each one is
  // calmer. That confound made a density win read as a churn regression.
  const n = Object.keys(prev ?? {}).length || 1
  console.log(`TOTAL settling travel: ${Math.round(total)}px over ${n} posts = ${Math.round(total / n)}px each`)
}

const browser = await chromium.launch()
try {
  const page = await signedInPage(browser)
  if (MODE === 'arrivals') await arrivals(page)
  else if (MODE === 'settle') await settle(page)
  else await boundary(page)
} finally {
  await browser.close()
}
