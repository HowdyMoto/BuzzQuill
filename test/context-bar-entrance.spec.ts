import { test, expect, type Page } from '@playwright/test';

/**
 * The contextual bars over a selection (Pathfinder / path-actions / image-actions)
 * play an entrance once per NEW selection and never when they merely return:
 * after a drag, a nudge, a Space-pan or a trip through another tool. The old
 * always-on CSS animation replayed every time the bar left display:none, which
 * was after every one of those. Guarded here by counting animationstart on the
 * bar itself. The stagger follows the order the items are seen (CSS order first),
 * so Join, which the Pathfinder bar moves to the front, arrives first.
 */

type AnyState = {
  selectShape(id: string | null): void;
  selectMultiple(ids: string[]): void;
  rebuildShapesFromDOM(): void;
};

async function boot(page: Page): Promise<string[]> {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as unknown as { state?: unknown }).state);
  return page.evaluate(() => {
    const w = window as unknown as { state: AnyState; __starts: number };
    w.__starts = 0;
    for (const id of ['pathfinder-popover', 'path-actions-popover', 'image-actions-popover']) {
      document.getElementById(id)!.addEventListener('animationstart', (e) => { if ((e.target as Element).id === id) w.__starts++; });
    }
    const mk = (tag: string, attrs: Record<string, string>) => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      return el;
    };
    const layer = document.getElementById('drawing-layer')!;
    const p = mk('path', { d: 'M 300 300 C 400 200 500 400 600 300', fill: 'none', stroke: '#f80', 'stroke-width': '6' });
    const q = mk('path', { d: 'M 300 520 L 420 480 L 560 540', fill: 'none', stroke: '#48f', 'stroke-width': '6' });
    const r = mk('rect', { x: '620', y: '420', width: '160', height: '100', fill: '#48f' });
    layer.append(p, q, r);
    w.state.rebuildShapesFromDOM();
    return [p.id, q.id, r.id];
  });
}
const starts = (page: Page) => page.evaluate(() => (window as unknown as { __starts: number }).__starts);
const centre = (page: Page, id: string) => page.evaluate((id) => {
  const r = document.getElementById(id)!.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, id);

test('the bar enters once per new selection, and returns silently after a drag, a pan or a tool switch', async ({ page }) => {
  const [, , rect] = await boot(page);
  await page.evaluate((id) => (window as unknown as { state: AnyState }).state.selectShape(id), rect);
  await expect(page.locator('#path-actions-popover')).toBeVisible();
  await page.waitForTimeout(400);
  expect(await starts(page)).toBe(1);

  // Drag the shape: the bar hides for the drag and comes back in place.
  const c = await centre(page, rect);
  await page.mouse.move(c.x, c.y); await page.mouse.down();
  await page.mouse.move(c.x + 40, c.y + 30, { steps: 5 });
  await expect(page.locator('#path-actions-popover')).toBeHidden();
  await page.mouse.up();
  await expect(page.locator('#path-actions-popover')).toBeVisible();
  await page.waitForTimeout(300);
  expect(await starts(page), 'no replay after a drag').toBe(1);

  // Nudge, Space-pan, another tool and back: still the same selection.
  await page.keyboard.press('ArrowRight');
  await page.mouse.move(640, 250);
  await page.keyboard.down('Space'); await page.mouse.down(); await page.mouse.move(700, 290, { steps: 5 }); await page.mouse.up(); await page.keyboard.up('Space');
  await page.keyboard.press('m'); await page.keyboard.press('v');
  await expect(page.locator('#path-actions-popover')).toBeVisible();
  await page.waitForTimeout(300);
  expect(await starts(page), 'no replay after nudge, pan or tool switch').toBe(1);

  // A press right after the entrance, while it is still playing, must not restart it.
  await page.evaluate(() => (window as unknown as { state: AnyState }).state.selectShape(null));
  const c2 = await centre(page, rect);
  await page.mouse.click(c2.x, c2.y);
  await page.waitForTimeout(100);
  await page.mouse.move(c2.x, c2.y); await page.mouse.down(); await page.mouse.move(c2.x + 40, c2.y, { steps: 5 }); await page.mouse.up();
  await page.waitForTimeout(400);
  expect(await starts(page), 'one entrance for the new selection, none for the quick drag').toBe(2);
});

test('for two open paths Join leads the bar and leads the stagger', async ({ page }) => {
  const [a, b] = await boot(page);
  await page.evaluate(([a, b]) => (window as unknown as { state: AnyState }).state.selectMultiple([a, b]), [a, b]);
  const bar = page.locator('#pathfinder-popover');
  await expect(bar).toHaveClass(/join-first/);
  const order = await bar.evaluate((el) => Array.from(el.children)
    .filter((c) => (c as HTMLElement).style.display !== 'none')
    .map((c) => ({ i: Number((c as HTMLElement).style.getPropertyValue('--ctx-i')), x: c.getBoundingClientRect().left, join: c.id === 'pf-pop-join' }))
    .sort((p, q) => p.x - q.x));
  expect(order[0].join, 'Join is the leftmost item').toBe(true);
  expect(order.map((o) => o.i), 'stagger index runs left to right').toEqual(order.map((_, i) => i));
});

test('with reduced motion the bar is fully there within a frame', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const [a] = await boot(page);
  await page.evaluate((id) => (window as unknown as { state: AnyState }).state.selectShape(id), a);
  await page.waitForTimeout(40);
  const opacities = await page.evaluate(() => Array.from(document.querySelectorAll('#path-actions-popover, #path-actions-popover > *'))
    .filter((e) => (e as HTMLElement).style.display !== 'none').map((e) => getComputedStyle(e).opacity));
  expect(opacities.every((o) => o === '1'), `bar and every item opaque: ${opacities.join(',')}`).toBe(true);
});
