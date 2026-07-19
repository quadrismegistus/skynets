import { test, expect, type Page } from '@playwright/test'

/**
 * Phone-sized layout regressions.
 *
 * Every bug this file guards against shipped at least once, and none of them
 * would have failed a unit test or shown up in a desktop viewport: a strip of
 * graph visible between the digest panel and the bottom bar, a close button a
 * third of a usable touch target, a swipe threshold low enough to fire on an
 * ordinary scroll. They were all found by looking at a phone.
 *
 * The digest panel opens fine without a language model — summarize() sets
 * showDigest before it awaits anything — so this runs in demo mode with no
 * login and no network, same as the rest of the e2e suite.
 */

// A small phone in CSS pixels. isMobile is chromium-only, which is the only
// browser CI installs.
test.use({ viewport: { width: 402, height: 874 }, hasTouch: true, isMobile: true })

async function openPanel(page: Page) {
  await page.goto('/?demo=1')
  await page.waitForSelector('button.node')
  await page.waitForTimeout(1200) // let the force layout settle
  await page.locator('.digest-btn').click()
  await page.waitForSelector('.panel', { state: 'visible' })
  await page.waitForTimeout(400) // panel transition
}

/**
 * Drive the panel's pointer handlers directly.
 *
 * Playwright's touchscreen can tap but not drag, and its mouse emits
 * pointerType "mouse", which the panel deliberately ignores. Synthesising the
 * sequence exercises our gesture logic — the axis lock and the distance
 * threshold — but not the browser's own touch pipeline, so it can't catch a
 * touch-action mistake. That part still needs a thumb.
 */
async function swipe(page: Page, dx: number, dy: number, id: number) {
  const box = await page.locator('.panel').boundingBox()
  if (!box) throw new Error('panel not on screen')
  const x = box.x + box.width / 2
  const y = box.y + box.height * 0.6
  await page.evaluate(
    ([x, y, dx, dy, id]) => {
      const el = document.querySelector('.panel')
      if (!el) throw new Error('panel gone')
      const send = (type: string, cx: number, cy: number) =>
        el.dispatchEvent(
          new PointerEvent(type, {
            pointerId: id,
            pointerType: 'touch',
            clientX: cx,
            clientY: cy,
            bubbles: true,
          }),
        )
      const STEPS = 12
      send('pointerdown', x, y)
      for (let i = 1; i <= STEPS; i++) send('pointermove', x + (dx * i) / STEPS, y + (dy * i) / STEPS)
      send('pointerup', x + dx, y + dy)
    },
    [x, y, dx, dy, id] as const,
  )
  await page.waitForTimeout(400)
}

test.describe('digest panel on a phone', () => {
  test('covers the bottom bar instead of stopping above it', async ({ page }) => {
    await openPanel(page)

    // Two earlier fixes positioned the panel to end exactly at the bar's
    // measured top. Both measured flush here and both still leaked a strip of
    // graph on the device, because the container being measured extends under
    // the home indicator. The panel now runs to the floor and stacks over the
    // bar, so the assertion is about what is painted, not about arithmetic
    // agreeing with itself.
    // Probe the centre of each control in the bottom bar, NOT the middle of the
    // panel. The bar is discrete pills with gaps between them, so a midpoint
    // probe hits the panel whatever the z-order — an earlier version of this
    // test passed happily with the panel stacked UNDER the bar.
    const seen = await page.evaluate(() => {
      const p = document.querySelector('.panel')!.getBoundingClientRect()
      const covers = (sel: string) => {
        const el = document.querySelector(sel)
        if (!el) return `missing:${sel}`
        const r = el.getBoundingClientRect()
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return top?.closest('.panel') ? 'panel' : (top?.className?.toString().slice(0, 30) ?? 'none')
      }
      return {
        reachesFloor: Math.round(p.bottom) >= window.innerHeight,
        overDigestBtn: covers('.digest-btn'),
        overConfig: covers('.config-wrap'),
        overHud: covers('.hud'),
      }
    })

    expect(seen.reachesFloor).toBe(true)
    // Each bar control sits beneath the panel, so nothing of the bar — or of
    // the graph behind it — is painted in that band.
    expect(seen.overDigestBtn).toBe('panel')
    expect(seen.overConfig).toBe('panel')
    expect(seen.overHud).toBe('panel')
  })

  test('has a close button big enough to hit', async ({ page }) => {
    await openPanel(page)
    const box = await page.locator('.panel .x').boundingBox()
    // 44px is Apple's minimum comfortable touch target. Covering the bottom bar
    // takes away the Digest button as a way out, so this is now load-bearing.
    expect(box!.width).toBeGreaterThanOrEqual(44)
    expect(box!.height).toBeGreaterThanOrEqual(44)
  })

  test('closes on a rightward swipe, back the way it came', async ({ page }) => {
    await openPanel(page)
    await swipe(page, 170, 0, 1)
    await expect(page.locator('.panel')).toHaveCount(0)
  })

  test('keeps scrolling the list rather than treating it as a swipe', async ({ page }) => {
    await openPanel(page)
    await swipe(page, 0, -120, 2)
    await expect(page.locator('.panel')).toHaveCount(1)
  })

  test('ignores a sideways drag too short to be deliberate', async ({ page }) => {
    await openPanel(page)
    await swipe(page, 40, 0, 3) // under the 90px threshold
    await expect(page.locator('.panel')).toHaveCount(1)
  })
})
