import { test, expect } from '@playwright/test';

/**
 * Aspect-ratio lock (issue #106): a toggle in the Transform panel. When on,
 * editing Width derives Height from the object's ratio (and vice versa); off,
 * they're independent. (Drag-resize also honors it — see SelectTool — but that's
 * exercised via the shared `proportional` flag rather than a synthetic drag here.)
 */

const RECT_2x1 = '<svg xmlns="http://www.w3.org/2000/svg"><rect id="r1" x="0" y="0" width="200" height="100" fill="#888"/></svg>';

async function selectRect(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });
  await page.evaluate((svg) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as unknown as { state: any }).state;
    s.importSVGContent(svg);
    s.selectMultiple(['r1']);
  }, RECT_2x1);
}

test('lock on: editing Width drives Height (and vice versa) by the ratio', async ({ page }) => {
  await selectRect(page);
  const w = page.locator('#prop-w'), h = page.locator('#prop-h'), lock = page.locator('#prop-lock-ratio');
  await expect(w).toHaveValue('200');
  await expect(h).toHaveValue('100'); // ratio 2:1

  await lock.click();
  await expect(lock).toHaveClass(/active/);

  await w.fill('300');                 // W→300, ratio 2 → H should be 150
  await expect(h).toHaveValue('150');
  await h.fill('50');                  // H→50, ratio 2 → W should be 100
  await expect(w).toHaveValue('100');

  // The shape actually resized to the linked dimensions.
  const dims = await page.evaluate(() => {
    const r = document.getElementById('r1')!;
    return { w: r.getAttribute('width'), h: r.getAttribute('height') };
  });
  expect(dims).toEqual({ w: '100', h: '50' });
});

test('lock off (default): Width and Height are independent', async ({ page }) => {
  await selectRect(page);
  const w = page.locator('#prop-w'), h = page.locator('#prop-h');
  await expect(page.locator('#prop-lock-ratio')).not.toHaveClass(/active/);
  await w.fill('300');
  await expect(h).toHaveValue('100'); // unchanged
});
