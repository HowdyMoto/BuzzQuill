import { test, expect, type Page } from '@playwright/test';

type W = { state: { importSVGContent: (svg: string) => void; selectedShapeIds: string[]; onChange_public: () => void } };

/** Import one fixture, clear the selection, and return the screen point for (x, y)
 *  in the fixture's own coordinates, plus what the browser's native hit-test finds. */
async function load(page: Page, body: string, x: number, y: number) {
  await page.evaluate((svg) => {
    const w = window as unknown as W;
    w.state.importSVGContent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${svg}</svg>`);
    w.state.selectedShapeIds = [];
    w.state.onChange_public();
  }, body);
  return page.locator('#outline').evaluate((el: SVGGraphicsElement, [px, py]) => {
    const p = new DOMPoint(px, py).matrixTransform(el.getScreenCTM()!);
    return { x: p.x, y: p.y, hit: document.elementFromPoint(p.x, p.y)?.id ?? '' };
  }, [x, y]);
}

const selected = (page: Page) => page.evaluate(() => (window as unknown as W).state.selectedShapeIds);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state);
});

test('clicking inside a closed fill-none path selects its group (#260)', async ({ page }) => {
  const at = await load(page,
    '<g id="layout"><path id="outline" d="M20 20 H180 V180 H20 Z" fill="none" stroke="#000" stroke-width="2"/></g>',
    100, 100);
  expect(at.hit).not.toBe('outline'); // prove the browser's native hit-test misses the hollow interior

  await page.mouse.click(at.x, at.y);
  await expect.poll(() => selected(page)).toEqual(['layout']);
});

test('the inside is the SHAPE, not its bounding box: a U\'s notch stays empty canvas (#260)', async ({ page }) => {
  // (100, 60) is inside the U's bounding box but in the gap between its arms.
  const at = await load(page,
    '<g id="layout"><path id="outline" d="M20 20 H60 V140 H140 V20 H180 V180 H20 Z" fill="none" stroke="#000" stroke-width="2"/></g>',
    100, 60);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(300);
  expect(await selected(page)).toEqual([]);
});

test('a ring\'s hole stays empty canvas (#260)', async ({ page }) => {
  const at = await load(page,
    '<g id="layout"><path id="outline" d="M100 20 A80 80 0 1 1 99.9 20 Z M100 60 A40 40 0 1 0 100.1 60 Z" fill="none" stroke="#000" stroke-width="2"/></g>',
    100, 100);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(300);
  expect(await selected(page)).toEqual([]);
});
