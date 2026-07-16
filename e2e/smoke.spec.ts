import { test, expect, type Page } from '@playwright/test'
import zlib from 'node:zlib'

const DEMO = '/?demo=1'

async function graphReady(page: Page) {
  await page.goto(DEMO)
  await page.waitForSelector('button.node')
  await page.waitForTimeout(1200) // let the force layout settle
}

/** Minimal valid solid-colour PNG so the composer's image decode succeeds. */
function makePng(w = 120, h = 80): Buffer {
  const crc32 = (buf: Buffer) => {
    let c = ~0
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i]
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return (~c) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const t = Buffer.from(type)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
    return Buffer.concat([len, t, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2 // 8-bit RGB
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 3) + 1 + x * 3
      raw[o] = 50
      raw[o + 1] = 110
      raw[o + 2] = 200
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('renders the graph with nodes', async ({ page }) => {
  await graphReady(page)
  expect(await page.locator('button.node').count()).toBeGreaterThan(5)
})

test('hover card like toggles the count', async ({ page }) => {
  await graphReady(page)
  await page.locator('.wrap').first().hover()
  await page.locator('.card').waitFor()
  await page.locator('.card').hover() // move into the card (persistence)
  const likeCount = page.locator('.act.like span')
  const before = (await likeCount.textContent())!.trim()
  await page.locator('.act.like').click()
  await expect(likeCount).not.toHaveText(before)
  await page.locator('.act.like').click()
  await expect(likeCount).toHaveText(before)
})

test('dismiss backfills to keep the visible count', async ({ page }) => {
  // Pin count AND reply-chains (both defaults moved) — the invariant under
  // test is that a dismissal backfills to hold the limit, so no chain-context
  // nodes should ride along beyond it.
  await page.addInitScript(() => localStorage.setItem('skynets.settings', JSON.stringify({ v: 2, nodeLimit: 20, replyChains: false })))
  await graphReady(page)
  await page.locator('.wrap').first().hover()
  await page.keyboard.press('d')
  await page.waitForTimeout(800)
  expect(await page.locator('button.node').count()).toBe(20)
})

test('composing a post closes the modal', async ({ page }) => {
  await graphReady(page)
  await page.locator('.compose-btn').click()
  await page.locator('.modal textarea').fill('hello from e2e')
  await page.locator('.post').click()
  await expect(page.locator('.modal')).toHaveCount(0)
})

test('composing a thread lands as ONE run node (a monologue, scrollable card)', async ({ page }) => {
  await graphReady(page)
  await page.locator('.compose-btn').click()
  await page.locator('.modal textarea').nth(0).fill('post one of the thread')
  await page.locator('.add').click()
  await page.locator('.modal textarea').nth(1).fill('post two of the thread')
  await page.locator('.add').click()
  await page.locator('.modal textarea').nth(2).fill('post three of the thread')
  await page.locator('.post').click()
  await expect(page.locator('.modal')).toHaveCount(0)
  // Contiguous self-replies are ONE display unit: a run node with a 3≡ badge,
  // whose card scrolls through the continuation posts.
  await expect(page.locator('.run-badge', { hasText: '3≡' })).toBeVisible()
  const runNode = page.locator('.wrap:has(.run-badge)').first()
  await runNode.hover()
  await expect(page.locator('.card .run-post')).toHaveCount(2) // posts 2 and 3
  // Every post in the run is its own interaction target: the head's action bar
  // sits above the continuation, and each continuation post has a compact row.
  await expect(page.locator('.card .actions.compact')).toHaveCount(2)
})

test('composing with an image attaches and posts', async ({ page }) => {
  await graphReady(page)
  await page.locator('.compose-btn').click()
  await page.locator('.modal input[type=file]').setInputFiles({
    name: 'photo.png',
    mimeType: 'image/png',
    buffer: makePng(),
  })
  await page.locator('.att img').waitFor()
  await page.locator('.att-alt').fill('a blue rectangle')
  await page.locator('.modal textarea').first().fill('a post with a photo')
  await page.locator('.post').click()
  await expect(page.locator('.modal')).toHaveCount(0)
})

test('connect-replies draws edges for small threads by default', async ({ page }) => {
  await graphReady(page)
  // The demo mini-thread (post + one reply) renders as a connected edge.
  expect(await page.locator('.edges path').count()).toBeGreaterThan(0)
})

test('a reposted node shows the reposter avatar', async ({ page }) => {
  // The demo's one repost can fall outside the viewport-scaled default window.
  await page.addInitScript(() => localStorage.setItem('skynets.settings', JSON.stringify({ v: 2, nodeLimit: 27 })))
  await graphReady(page)
  expect(await page.locator('.reposter').count()).toBeGreaterThan(0)
})

test('non-followed authors are marked (dashed) and followed are not', async ({ page }) => {
  await graphReady(page)
  // Demo marks a couple of authors as not-followed; most are followed.
  expect(await page.locator('.wrap.unfollowed').count()).toBeGreaterThan(0)
  expect(await page.locator('.wrap:not(.unfollowed)').count()).toBeGreaterThan(0)
})

test('single-click pins a node and keeps its card shown', async ({ page }) => {
  await graphReady(page)
  await page.locator('.wrap').first().click()
  await expect(page.locator('.wrap.pinned')).toHaveCount(1)
  // Move the pointer away; the pinned post's card stays displayed.
  await page.mouse.move(5, 5)
  await page.waitForTimeout(400)
  await expect(page.locator('.card')).toHaveCount(1)
})

test('Map replies expands a thread with edges', async ({ page }) => {
  await graphReady(page)
  const thread = page.locator('.wrap.thread').first()
  await thread.hover()
  await page.locator('.card').waitFor()
  await page.locator('.card').hover()
  await page.locator('.map-replies').click()
  await page.waitForTimeout(800)
  expect(await page.locator('.edges path').count()).toBeGreaterThan(0)
})

test('follow button toggles; unfollowing prunes the author from the graph', async ({ page }) => {
  // Unfollowing asks for confirmation — accept it so the toggle proceeds.
  page.on('dialog', (d) => d.accept())
  await graphReady(page)
  // A non-repost node: unfollowing its author prunes their plain feed posts.
  const node = page.locator('.wrap:not(:has(.reposter))').first()
  const name = await node.locator('button.node').getAttribute('aria-label')
  await node.hover()
  await page.locator('.card').waitFor()
  await page.locator('.card').hover()
  const follow = page.locator('.card .follow').first()
  await follow.waitFor()
  const before = (await follow.textContent())!.trim()
  await follow.click()
  if (before === 'Following') {
    // The unfollowed author's posts leave the graph immediately.
    await expect(page.locator(`button.node[aria-label="${name}"]`)).toHaveCount(0)
  } else {
    await expect(follow).toHaveText('Following')
  }
})

test('dragging moves a node without pinning; a click pins it', async ({ page }) => {
  await graphReady(page)
  // Use the rightmost node: its hover card opens away from it (or flips left),
  // so the card never covers the node center we need to grab.
  const wraps = await page.locator('.wrap').all()
  let node = wraps[0]
  let before = (await node.boundingBox())!
  for (const w of wraps) {
    const b = await w.boundingBox()
    if (b && b.x > before.x) {
      node = w
      before = b
    }
  }
  const cx = before.x + before.width / 2
  const cy = before.y + before.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx - 140, cy + 90, { steps: 6 })
  // While held, the node is at the drag position (checked before release, since
  // an un-pinned node drifts back to its semantic spot once let go).
  const held = (await node.boundingBox())!
  const dist = Math.hypot(held.x - before.x, held.y - before.y)
  expect(dist).toBeGreaterThan(60)
  await page.mouse.up()
  // Releasing does NOT pin it.
  await expect(node).not.toHaveClass(/pinned/)
  // A normal click pins it. Click the node locator (not stale coordinates):
  // Playwright waits for the node to settle back from the drag before clicking,
  // so the stronger axis snap-back can't slide it out from under the cursor.
  await node.click()
  await expect(node).toHaveClass(/pinned/)
})

test('Reply chains is on by default; turning it off collapses the chain', async ({ page }) => {
  // Room for the demo thread's whole chain under the viewport-scaled default.
  await page.addInitScript(() => localStorage.setItem('skynets.settings', JSON.stringify({ v: 2, nodeLimit: 27 })))
  await graphReady(page)
  const edgesBefore = await page.locator('.edges path').count()
  await page.locator('.gear').click()
  const box = page.locator('.config .row', { hasText: 'Reply chains' }).locator('input')
  await expect(box).toBeChecked() // the new default
  await box.uncheck()
  await page.mouse.click(650, 400) // close config
  await page.waitForTimeout(1200)
  // The 5-post demo thread collapses back to one node → fewer edges.
  expect(await page.locator('.edges path').count()).toBeLessThan(edgesBefore)
})

test('a previously-dismissed ancestor returns as a dimmed ghost for its chain', async ({ page }) => {
  // Seed the read store (idb-keyval) with the demo thread ROOT dismissed —
  // as if read in an earlier session — while its replies remain visible.
  // Every visible reply must still get its chain: the root comes back dimmed.
  // Room for the whole thread under the viewport-scaled default, so the
  // dismissed root's replies are definitely on screen.
  await page.addInitScript(() => localStorage.setItem('skynets.settings', JSON.stringify({ v: 2, nodeLimit: 27 })))
  // Seeded from a static same-origin page so the write COMPLETES before the
  // app boots (an addInitScript put races the app's read.load()).
  await page.goto('/client-metadata.json')
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const uri = 'at://did:plc:alice.bsky.social/app.bsky.feed.post/t0'
        const open = indexedDB.open('keyval-store', 1)
        open.onupgradeneeded = () => open.result.createObjectStore('keyval')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const tx = open.result.transaction('keyval', 'readwrite')
          tx.objectStore('keyval').put([uri], 'skynets:dismissed:did:plc:demo')
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        }
      }),
  )
  await graphReady(page)
  await expect(page.locator('.wrap.ghost').first()).toBeVisible({ timeout: 5000 })
  // Ghosts carry no dismiss ✕ (they're already dismissed) and keep their edge.
  await expect(page.locator('.wrap.ghost .dismiss')).toHaveCount(0)
  expect(await page.locator('.edges path').count()).toBeGreaterThan(0)
})

test('config popover closes on a click outside it', async ({ page }) => {
  await graphReady(page)
  await page.locator('.gear').click()
  await expect(page.locator('.config')).toBeVisible()
  await page.mouse.click(700, 400) // empty canvas
  await expect(page.locator('.config')).toHaveCount(0)
})

test('high cohesion hides the semantic axes', async ({ page }) => {
  await graphReady(page)
  await page.locator('.gear').click()
  // Drag Cohesion to the top of its range — the axes stop meaning anything.
  await page.locator('.config .row', { hasText: 'Cohesion' }).locator('input').fill('1')
  await expect(page.locator('.x-axis')).toHaveCount(0)
  expect(await page.locator('button.node').count()).toBeGreaterThan(0)
})

test('a card near the bottom is not clipped', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 500 })
  await graphReady(page)
  // Hover the lowest node on screen — the worst case for bottom clipping.
  const idx = await page.evaluate(() => {
    const wraps = [...document.querySelectorAll('.wrap')]
    let best = 0
    let bestTop = -Infinity
    wraps.forEach((w, i) => {
      const top = w.getBoundingClientRect().top
      if (top > bestTop) {
        bestTop = top
        best = i
      }
    })
    return best
  })
  await page.locator('.wrap').nth(idx).hover({ force: true })
  await page.locator('.card').waitFor()
  await page.waitForTimeout(200)
  const box = (await page.locator('.card').boundingBox())!
  expect(box.y + box.height).toBeLessThanOrEqual(502)
})

test('digest button opens the panel and annotates the graph (demo)', async ({ page }) => {
  await graphReady(page)
  await page.locator('.digest-btn').click()
  // The panel opens; with no API key a demo digest renders conversations.
  await expect(page.locator('.panel')).toBeVisible()
  await expect(page.locator('.convos > li').first()).toBeVisible()
  // A conversation label is annotated onto the graph, and clicking an exemplar
  // pins its node (pops a card).
  await expect(page.locator('.topic-node').first()).toBeVisible()
  await page.locator('.convos .ex').first().click()
  await expect(page.locator('.wrap.pinned')).toHaveCount(1)
})

test('digest exemplars keep one focused card; background click collapses', async ({ page }) => {
  await graphReady(page)
  await page.locator('.digest-btn').click()
  await page.locator('.convos > li').first().waitFor()
  const exemplars = page.locator('.convos .ex')
  await exemplars.nth(0).click()
  await expect(page.locator('.wrap.pinned')).toHaveCount(1)
  // Focusing a second exemplar releases the first — still exactly one pinned.
  await exemplars.nth(1).click()
  await expect(page.locator('.wrap.pinned')).toHaveCount(1)
  // A click on empty canvas collapses it.
  await page.mouse.click(60, 400)
  await expect(page.locator('.wrap.pinned')).toHaveCount(0)
})

test('continuous mode auto-establishes without pressing Update (demo)', async ({ page }) => {
  await graphReady(page)
  await page.locator('.digest-btn').click()
  await page.locator('.convos > li').first().waitFor()
  // Auto-update is on by default — the status shows with no clicks at all.
  await expect(page.locator('.engine-status')).toContainText(/auto-updating/, { timeout: 5000 })
  await expect(page.locator('.convos > li').first()).toBeVisible()
})

test('pressing D on a topic node dismisses its whole conversation', async ({ page }) => {
  await graphReady(page)
  await page.locator('.digest-btn').click()
  await page.locator('.topic-node').first().waitFor()
  await page.locator('.topic-node').first().hover()
  await page.keyboard.press('d')
  await page.waitForTimeout(500)
  // Its member posts are marked read → the dismissed counter shows.
  await expect(page.locator('.dismissed-count')).toBeVisible()
})

test('D still dismisses a post after dismissing a topic (no stuck hover)', async ({ page }) => {
  await graphReady(page)
  await page.locator('.digest-btn').click()
  await page.locator('.topic-node').first().waitFor()
  await page.locator('.topic-node').first().hover()
  await page.keyboard.press('d') // dismiss the topic; the pill vanishes
  await page.waitForTimeout(400)
  const dismissed = async () =>
    parseInt((await page.locator('.dismissed-count').innerText()).replace(/\D/g, ''), 10) || 0
  const before = await dismissed()
  // Dismiss a plain post with D — this used to be swallowed by the stale
  // hoveredTopic (the topic branch of onKey kept winning). The counter must grow.
  await page.locator('.wrap').first().hover()
  await page.keyboard.press('d')
  await page.waitForTimeout(600)
  expect(await dismissed()).toBeGreaterThan(before)
})

test('hovering a card avatar opens a profile preview', async ({ page }) => {
  await graphReady(page)
  await page.locator('.wrap').first().hover()
  await page.locator('.card').waitFor()
  await page.locator('.card').hover()
  await page.locator('.card .avatar-wrap').hover()
  await expect(page.locator('.profile-hover')).toBeVisible()
  // The preview carries the fetched profile (compact follower count).
  await expect(page.locator('.profile-hover .ph-stats')).toContainText('followers')
})

test('hovering the reposter name opens a profile preview', async ({ page }) => {
  // The viewport-scaled default count can leave the demo's one repost outside
  // the window; pre-tune the persisted Count as a user would.
  await page.addInitScript(() => localStorage.setItem('skynets.settings', JSON.stringify({ v: 2, nodeLimit: 27 })))
  await graphReady(page)
  const rep = page.locator('.wrap:has(.reposter)').first()
  await rep.hover()
  await page.locator('.card').waitFor()
  await page.locator('.card').hover()
  await page.locator('.rt-name').first().hover()
  await expect(page.locator('.rt-name .profile-hover')).toBeVisible()
})

test('a mutual is marked "follows you" on its card', async ({ page }) => {
  await graphReady(page)
  const wraps = await page.locator('.wrap').all()
  let seen = false
  for (const w of wraps) {
    await w.hover()
    if (await page.locator('.card .follows-you').count()) {
      seen = true
      break
    }
    await page.mouse.move(3, 3)
  }
  expect(seen).toBe(true)
})

test('the digest runs automatically on load — labels appear with zero clicks', async ({ page }) => {
  await graphReady(page)
  // No .digest-btn click, no panel: topic captions/pills arrive on their own.
  await expect(page.locator('.node-caption, .topic-node').first()).toBeVisible({ timeout: 8000 })
})

test('per-post label mode tags nodes and groups by topic', async ({ page }) => {
  await graphReady(page)
  await page.locator('.digest-btn').click()
  await page.locator('button.go').first().click()
  // Labels land, then group by embedding: shared topics become pills, one-offs
  // become captions under their node. At least the caption path should show.
  await expect(page.locator('.node-caption').first()).toBeVisible({ timeout: 8000 })
  const captions = await page.locator('.node-caption').count()
  const pills = await page.locator('.topic-node').count()
  expect(captions + pills).toBeGreaterThan(2)
  expect(await page.locator('.convos > li').count()).toBeGreaterThan(0)
})

test('merge slider re-groups labels without re-labeling', async ({ page }) => {
  await graphReady(page)
  await page.locator('.digest-btn').click()
  await page.locator('button.go').first().click()
  await page.locator('.convos > li').first().waitFor()
  const before = await page.locator('.convos > li').count()
  // Settings collapse once results exist (auto-digest) — open them first.
  if (!(await page.locator('.row.window.sub').count())) await page.locator('.cfg-toggle').click()
  // Crank the threshold to the strictest — fewer merges → at least as many groups.
  await page.locator('.row.window.sub', { hasText: 'Merge' }).locator('input').fill('0.9')
  await page.waitForTimeout(300)
  const after = await page.locator('.convos > li').count()
  expect(after).toBeGreaterThanOrEqual(before)
})

test('clicking a topic pill reveals all its posts', async ({ page }) => {
  await graphReady(page)
  await page.locator('.digest-btn').click()
  await page.locator('button.go').first().click()
  const pill = page.locator('.topic-node').first()
  await pill.waitFor({ timeout: 8000 })
  const before = await page.locator('button.node').count()
  await pill.click()
  await expect(pill).toHaveClass(/revealed/)
  // Its off-budget members come in, so the node count doesn't drop.
  expect(await page.locator('button.node').count()).toBeGreaterThanOrEqual(before)
  // Clicking again collapses the reveal.
  await pill.click()
  await expect(pill).not.toHaveClass(/revealed/)
})

test('archive coverage view opens with a histogram', async ({ page }) => {
  await graphReady(page)
  await page.waitForTimeout(1500) // let the archive capture the loaded feed
  await page.locator('.gear').click()
  const cov = page.locator('.export-btn', { hasText: 'Coverage' })
  await cov.scrollIntoViewIfNeeded()
  await expect(cov).toBeEnabled({ timeout: 5000 }) // archive populated → enabled
  await cov.click({ force: true })
  await expect(page.locator('.cov')).toBeVisible()
  await expect(page.locator('.hist rect').first()).toBeVisible()
  await expect(page.locator('.summary')).toContainText('posts')
  // Granularity toggle re-bins.
  await page.locator('.grans button', { hasText: 'hour' }).click()
  await expect(page.locator('.hist rect').first()).toBeVisible()
  // Hover shows a cursor tooltip with count + time.
  const box = (await page.locator('.chart').boundingBox())!
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2)
  await expect(page.locator('.tip')).toContainText('post')
  // Posted/Captured toggle swaps the axis source.
  await page.locator('.grans.src button', { hasText: 'captured' }).click()
  await expect(page.locator('.note')).toContainText('capture')
})

test('help dialog opens and closes', async ({ page }) => {
  await graphReady(page)
  await page.locator('.help').click()
  await expect(page.getByText('How Mothtrap works')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText('How Mothtrap works')).toHaveCount(0)
})

test('settings persist across reload', async ({ page }) => {
  await graphReady(page)
  await page.locator('.gear').click()
  await page.locator('.config input[type=range]').first().fill('8')
  await page.locator('.seg button', { hasText: 'top' }).click()
  await page.reload()
  await page.locator('.gear').waitFor()
  await page.locator('.gear').click()
  await expect(page.locator('.config .val').first()).toHaveText('8')
  await expect(page.locator('.seg button.on')).toHaveText('top')
})
