import { test, expect } from '@playwright/test';

/**
 * Arrow-key nudge (Figma/Illustrator-style): with the Select tool and a
 * selection, arrows move it 1 unit, Shift+arrow 10 units, and each press is its
 * own undo step. Locked shapes don't move.
 */

const RECT = '<svg xmlns="http://www.w3.org/2000/svg"><rect id="r1" x="100" y="100" width="20" height="10" fill="red"/></svg>';

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });
}

test('arrows nudge 1, Shift+arrow nudges 10, and it is undoable', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  await page.evaluate((svg) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as unknown as { state: any }).state;
    s.importSVGContent(svg);
    s.selectMultiple(['r1']);
  }, RECT);

  const rect = page.locator('#r1');
  const x = async () => parseFloat((await rect.getAttribute('x'))!);
  const y = async () => parseFloat((await rect.getAttribute('y'))!);

  expect(await x()).toBe(100);
  await page.keyboard.press('ArrowRight');
  expect(await x()).toBe(101);                 // 1px
  await page.keyboard.press('Shift+ArrowRight');
  expect(await x()).toBe(111);                 // +10px
  await page.keyboard.press('ArrowUp');
  expect(await y()).toBe(99);                  // up = -y, 1px
  await page.keyboard.press('Shift+ArrowDown');
  expect(await y()).toBe(109);                 // +10px

  // Each press is a discrete undo step: undo the last (Shift+Down) → y back to 99.
  await page.evaluate(() => (window as unknown as { state: any }).state.undo());
  expect(await y()).toBe(99);

  expect(errors).toEqual([]);
});

test('nudging shows the gesture-hint HUD with the modifier options', async ({ page }) => {
  await boot(page);
  await page.evaluate((svg) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as unknown as { state: any }).state;
    s.importSVGContent(svg);
    s.selectMultiple(['r1']);
  }, RECT);

  await page.keyboard.press('ArrowRight');
  const hud = page.locator('#tool-hint.gesturing');
  await expect(hud).toBeVisible();
  await expect(hud).toContainText('move 10px'); // the Shift hint
  await expect(hud).toContainText('faster');    // the hold/accelerate hint
});

test('holding a key accelerates and coalesces into one undo step', async ({ page }) => {
  await boot(page);
  const moved = await page.evaluate((svg) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as unknown as { state: any }).state;
    s.importSVGContent(svg);
    s.selectMultiple(['r1']);
    const x0 = parseFloat(s.findShapeById('r1').element.getAttribute('x'));
    // Simulate a held key: one fresh keydown, then auto-repeats.
    const fire = (repeat: boolean) => window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', repeat, bubbles: true, cancelable: true }));
    fire(false);
    for (let i = 0; i < 15; i++) fire(true);
    const x1 = parseFloat(s.findShapeById('r1').element.getAttribute('x'));
    return { presses: 16, distance: x1 - x0 };
  }, RECT);

  // 16 non-accelerated presses would move 16; acceleration must move clearly more.
  expect(moved.distance).toBeGreaterThan(moved.presses * 1.5);

  // Let the held run commit via its timer, then one undo returns to the start —
  // proving the whole hold was a single, coalesced undo step.
  await page.waitForTimeout(300);
  const backToStart = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as unknown as { state: any }).state;
    s.undo();
    return parseFloat(s.findShapeById('r1').element.getAttribute('x'));
  });
  expect(backToStart).toBe(100);
});

test('locked shapes are not nudged', async ({ page }) => {
  await boot(page);
  await page.evaluate((svg) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as unknown as { state: any }).state;
    s.importSVGContent(svg);
    const shape = s.findShapeById('r1');
    shape.locked = true;
    shape.element.setAttribute('data-locked', 'true');
    s.selectMultiple(['r1']);
  }, RECT);

  const rect = page.locator('#r1');
  await page.keyboard.press('ArrowRight');
  expect(parseFloat((await rect.getAttribute('x'))!)).toBe(100); // unchanged
});
