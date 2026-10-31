import { test, expect } from '@playwright/test';

/**
 * Document tabs: double-click to rename, drag to reorder. Driven through the real
 * tab bar (ui/tab-bar.ts) + the dev-only window.docs handle.
 */

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(
    () => (window as unknown as { docs?: unknown; state?: unknown }).docs
       && (window as unknown as { state?: unknown }).state,
    { timeout: 15_000 });
}

test('double-click a tab renames it (and the active document title)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  await page.locator('#tab-new').click(); // 2 tabs now (the new one is active)
  const tabs = page.locator('#tab-list .doc-tab');
  await expect(tabs).toHaveCount(2);

  await tabs.first().dblclick();
  const input = page.locator('#tab-list .doc-tab .layer-rename');
  await expect(input).toBeVisible();
  await input.fill('My Design');
  await input.press('Enter');

  await expect(tabs.first().locator('.doc-tab-name')).toHaveText('My Design');
  const title0 = await page.evaluate(() => (window as unknown as { docs: any }).docs.tabs[0].title);
  expect(title0).toBe('My Design');
  expect(errors).toEqual([]);
});

test('Escape cancels a tab rename', async ({ page }) => {
  await boot(page);
  const tab = page.locator('#tab-list .doc-tab').first();
  const before = await tab.locator('.doc-tab-name').textContent();
  await tab.dblclick();
  const input = page.locator('#tab-list .doc-tab .layer-rename');
  await input.fill('Discarded');
  await input.press('Escape');
  await expect(tab.locator('.doc-tab-name')).toHaveText(before!);
});

test('drag reorders tabs (model + rendered order)', async ({ page }) => {
  await boot(page);
  await page.locator('#tab-new').click();
  await page.locator('#tab-new').click(); // 3 tabs
  const idsBefore = await page.evaluate(() => (window as unknown as { docs: any }).docs.tabs.map((t: any) => t.id));
  expect(idsBefore.length).toBe(3);

  // Simulate dragging the first tab onto the right half of the last (→ drop after).
  await page.evaluate(() => {
    const list = document.getElementById('tab-list')!;
    const tabs = [...list.querySelectorAll('.doc-tab')] as HTMLElement[];
    const first = tabs[0], last = tabs[tabs.length - 1];
    const dt = new DataTransfer();
    const r = last.getBoundingClientRect();
    const x = r.right - 3, y = r.top + r.height / 2;
    first.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    last.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    last.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    first.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });

  const idsAfter = await page.evaluate(() => (window as unknown as { docs: any }).docs.tabs.map((t: any) => t.id));
  // First tab moved to the end; the middle one is now first.
  expect(idsAfter).toEqual([idsBefore[1], idsBefore[2], idsBefore[0]]);

  // The rendered bar matches the new model order.
  const renderedIds = await page.locator('#tab-list .doc-tab').evaluateAll(
    (els) => els.map((e) => (e as HTMLElement).dataset.tabId));
  expect(renderedIds).toEqual(idsAfter);
});
