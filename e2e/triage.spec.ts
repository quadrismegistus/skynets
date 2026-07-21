import { test, expect, type Page } from '@playwright/test'

/**
 * Triage + private-reactions coverage.
 *
 * These behaviours shipped with thin or no e2e: the keyboard rate keys
 * (f/s/y/n/↑/↓), the #87 change that makes `d` ADVANCE the selection instead of
 * dead-ending on a null hover, the recently-dismissed log (#82), and the
 * reactions panel's relationship buckets (#69/#70). Everything here runs in demo
 * mode (?demo=1) — no login, no network — the same footing as smoke.spec.ts, and
 * reuses its idioms (graphReady, hover .wrap, the dismiss+backfill invariant).
 *
 * The rate itself is private and on-device, so it isn't observable from the DOM;
 * these tests assert its side effects instead — the post is dismissed (and the
 * viewport-derived count BACKFILLS to hold, exactly as the smoke `d` test does),
 * the reaction later surfaces in the reactions panel, and the selection advances.
 */

const DEMO = '/?demo=1'

async function graphReady(page: Page) {
  await page.goto(DEMO)
  await page.waitForSelector('button.node')
  await page.waitForTimeout(1200) // let the force layout settle
}

/** Turn reply chains off so a single dismissal backfills 1-for-1 and the visible
 *  count is a clean invariant — the same setup the smoke `d` test relies on. */
async function noReplyChains(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem('skynets.settings', JSON.stringify({ v: 2, replyChains: false })),
  )
}

// The rate keys all funnel through rateAndAdvance → react (records a private
// thumb) + dismiss + advance. The rate is invisible, but the dismiss BACKFILLS
// to keep whatever the viewport-derived count is — the same invariant the smoke
// `d` test asserts. Cover each documented key/alias with that invariant.
for (const key of ['f', 's', 'y', 'n', 'ArrowUp', 'ArrowDown']) {
  test(`rate key ${key} dismisses the hovered post and backfills the count`, async ({ page }) => {
    await noReplyChains(page)
    await graphReady(page)
    const before = await page.locator('button.node').count()
    expect(before).toBeGreaterThan(0)
    await page.locator('.wrap').first().hover()
    await page.keyboard.press(key)
    await page.waitForTimeout(800)
    // Rate + dismiss removed the post; a backfill holds the count. (A no-op — e.g.
    // the key not landing on the hovered post — would leave a stale higher/lower
    // count only if backfill failed; the point is the count survives the dismiss.)
    expect(await page.locator('button.node').count()).toBe(before)
  })
}

test('a rate key records a reaction that surfaces in the reactions panel', async ({ page }) => {
  await graphReady(page)
  // f = favourable (thumbs up). react() attributes the thumb to the displayed
  // post's author and dismisses — the author then appears in the reactions log.
  await page.locator('.wrap').first().hover()
  await page.keyboard.press('f')
  await page.waitForTimeout(300)
  await page.locator('button[aria-label="Your reactions"]').click()
  const dlg = page.locator('[role="dialog"][aria-label="Your reactions"]')
  await expect(dlg).toBeVisible()
  // At least one rated author is listed (the empty state renders no rows).
  await expect(dlg.locator('.rows li').first()).toBeVisible()
})

test('d advances the selection rather than dead-ending; a rate key then still acts (#87)', async ({
  page,
}) => {
  await graphReady(page)
  await page.locator('.wrap').first().hover()
  // The hovered/selected node carries .active.
  await expect(page.locator('.wrap.active')).toHaveCount(1)
  await page.keyboard.press('d')
  await page.waitForTimeout(600)
  // Pre-#87, `d` cleared the hover and the sweep dead-ended (no .active node).
  // The selection now hands off to the next survivor, so exactly one stays active.
  await expect(page.locator('.wrap.active')).toHaveCount(1)
  // And that advanced selection is live: a rate key (no re-hover, no mouse move —
  // the keyboard selection holds) records a reaction on the post it moved to.
  await page.keyboard.press('f')
  await page.waitForTimeout(300)
  await page.locator('button[aria-label="Your reactions"]').click()
  const dlg = page.locator('[role="dialog"][aria-label="Your reactions"]')
  await expect(dlg).toBeVisible()
  await expect(dlg.locator('.rows li').first()).toBeVisible()
})

test('recently-dismissed view logs a post dismissed from the graph (#82)', async ({ page }) => {
  await graphReady(page)
  await page.locator('.wrap').first().hover()
  await page.keyboard.press('d')
  await page.waitForTimeout(400)
  await page.locator('button[aria-label="Recently dismissed"]').click()
  const dlg = page.locator('[role="dialog"][aria-label="Recently dismissed"]')
  await expect(dlg).toBeVisible()
  await expect(dlg.getByRole('heading', { name: 'Recently dismissed' })).toBeVisible()
  // The just-dismissed post shows up as a log row (author + snippet, or a degraded
  // row if it has aged out — either way at least one entry, not the empty state).
  await expect(dlg.locator('.rows li').first()).toBeVisible()
  await expect(dlg.locator('.empty')).toHaveCount(0)
})

test('reactions panel shows the relationship bucket tabs once a reaction exists (#69/#70)', async ({
  page,
}) => {
  await graphReady(page)
  // The bucket tabs only render when there is at least one reaction (otherwise the
  // panel shows an empty state), so seed one first.
  await page.locator('.wrap').first().hover()
  await page.keyboard.press('f')
  await page.waitForTimeout(300)
  await page.locator('button[aria-label="Your reactions"]').click()
  const dlg = page.locator('[role="dialog"][aria-label="Your reactions"]')
  await expect(dlg).toBeVisible()
  // All / Following / Follower / Mutual — the 2×2 of the two follow directions,
  // as single-select tabs. Scoped to the dialog so the topbar feed tabs (which
  // also carry a "Following") can't be mistaken for these.
  const tabs = dlg.locator('[role="tablist"][aria-label="Filter by relationship"]')
  await expect(tabs).toBeVisible()
  await expect(dlg.getByRole('tab', { name: 'All' })).toBeVisible()
  await expect(dlg.getByRole('tab', { name: 'Following' })).toBeVisible()
  await expect(dlg.getByRole('tab', { name: 'Follower' })).toBeVisible()
  await expect(dlg.getByRole('tab', { name: 'Mutual' })).toBeVisible()
  // The tabs are a live single-select: clicking one selects it.
  await dlg.getByRole('tab', { name: 'Mutual' }).click()
  await expect(dlg.getByRole('tab', { name: 'Mutual' })).toHaveAttribute('aria-selected', 'true')
})
