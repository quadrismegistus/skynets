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

test('composing a thread lands as a collapsed thread node', async ({ page }) => {
  await graphReady(page)
  await page.locator('.compose-btn').click()
  await page.locator('.modal textarea').nth(0).fill('post one of the thread')
  await page.locator('.add').click()
  await page.locator('.modal textarea').nth(1).fill('post two of the thread')
  await page.locator('.add').click()
  await page.locator('.modal textarea').nth(2).fill('post three of the thread')
  await page.locator('.post').click()
  await expect(page.locator('.modal')).toHaveCount(0)
  await expect(page.locator('.badge', { hasText: '+2' })).toBeVisible()
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
  expect(await page.locator('.edges line').count()).toBeGreaterThan(0)
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
  expect(await page.locator('.edges line').count()).toBeGreaterThan(0)
})

test('follow button toggles on the card', async ({ page }) => {
  await graphReady(page)
  await page.locator('.wrap').first().hover()
  await page.locator('.card').waitFor()
  await page.locator('.card').hover()
  const follow = page.locator('.card .follow').first()
  await follow.waitFor()
  const before = (await follow.textContent())!.trim()
  await follow.click()
  await expect(follow).not.toHaveText(before)
})

test('cluster mode hides the semantic axes', async ({ page }) => {
  await graphReady(page)
  await page.locator('.gear').click()
  await page.locator('.config .row', { hasText: 'Cluster' }).locator('input').check()
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

test('help dialog opens and closes', async ({ page }) => {
  await graphReady(page)
  await page.locator('.help').click()
  await expect(page.getByText('How Skynets works')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText('How Skynets works')).toHaveCount(0)
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
