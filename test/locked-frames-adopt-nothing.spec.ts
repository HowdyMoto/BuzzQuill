import { test, expect, type Page } from '@playwright/test';

/**
 * A locked frame takes no new children. Everything inside a locked frame is locked,
 * so a shape that auto-parented into one came out unpickable: a raster pasted onto a
 * locked frame couldn't be dragged (the press went through it, and the Layers panel
 * lit up the frame), and it showed a lock it was never given. New and moved artwork
 * over a locked frame now stays on the canvas above it, unlocked, where it landed.
 */

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyState = any;

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });
  return errors;
}

const lockFrame = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as { state: AnyState }).state;
  const fid = s.artboards[0].id as string;
  s.toggleLock(fid);
  s.clearSelection?.();
  return fid;
});

/** Put a real PNG on the system clipboard. */
const pngOnClipboard = (page: Page) => page.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 200; c.height = 120;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e33'; g.fillRect(0, 0, 200, 120);
  const blob = await new Promise<Blob>(r => c.toBlob(b => r(b!), 'image/png'));
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
});

/** Where a shape sits, and whether anything has made it locked. */
const status = (page: Page, id: string) => page.evaluate((id) => {
  const el = document.getElementById(id)!;
  const r = el.getBoundingClientRect();
  return {
    parent: el.parentElement!.id,
    locked: el.closest('[data-locked="true"]') !== null,
    rect: [r.x, r.y, r.width, r.height],
  };
}, id);

const selected = (page: Page) =>
  page.evaluate(() => [...(window as unknown as { state: AnyState }).state.selectedShapeIds] as string[]);

test('a raster pasted onto a locked frame can be moved like any other', async ({ page }) => {
  const errors = await boot(page);
  const fid = await lockFrame(page);
  await pngOnClipboard(page);
  await page.keyboard.press('Control+v');
  await expect.poll(() => page.locator('#drawing-layer image').count()).toBe(1);
  const id = await page.locator('#drawing-layer image').getAttribute('id') as string;

  const s0 = await status(page, id);
  expect(s0.parent, 'not adopted by the locked frame').not.toBe(fid);
  expect(s0.locked).toBe(false);
  expect(await selected(page)).toEqual([id]);

  // Arrow keys nudge it.
  await page.keyboard.press('ArrowRight');
  expect((await status(page, id)).rect[0]).toBeCloseTo(s0.rect[0] + 1 * (s0.rect[2] / 200), 1);

  // A press picks the image (not the frame), and a drag moves it.
  await page.mouse.click(5, 900);
  const r = (await status(page, id)).rect;
  await page.mouse.move(r[0] + r[2] / 2, r[1] + r[3] / 2);
  await page.mouse.down();
  expect(await selected(page)).toEqual([id]);
  await page.mouse.move(r[0] + r[2] / 2 + 60, r[1] + r[3] / 2 + 25, { steps: 8 });
  await page.mouse.up();
  const after = await status(page, id);
  expect(after.rect[0] - r[0]).toBeCloseTo(60, 0);
  expect(after.rect[1] - r[1]).toBeCloseTo(25, 0);
  // Dropping it back over the locked frame doesn't hand it to the frame either.
  expect(after.parent).not.toBe(fid);
  expect(after.locked).toBe(false);
  expect(errors).toEqual([]);
});

test('a shape drawn starting inside a locked frame stays unlocked', async ({ page }) => {
  const errors = await boot(page);
  const fid = await lockFrame(page);
  await page.locator('[data-tool="rect"]').click();
  const box = (await page.locator(`#${fid} .frame-bg`).boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 220, box.y + 180, { steps: 6 });
  await page.mouse.up();
  const id = (await selected(page))[0];
  expect(id).toBeTruthy();
  const s = await status(page, id);
  expect(s.parent).not.toBe(fid);
  expect(s.locked).toBe(false);
  expect(errors).toEqual([]);
});

test('a copy pasted after its frame was locked lands in place, unlocked', async ({ page }) => {
  const errors = await boot(page);
  const { fid, src } = await page.evaluate(() => {
    const s = (window as unknown as { state: AnyState }).state;
    const fid = s.addFrame(200, 100, 400, 300, 'Offset') as string;
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.id = s.nextId();
    for (const [k, v] of Object.entries({ x: 40, y: 30, width: 80, height: 50, fill: '#39f' })) r.setAttribute(k, String(v));
    document.getElementById(fid)!.appendChild(r);
    s.rebuildShapesFromDOM();
    s.saveHistory();
    s.selectMultiple([r.id]);
    s.copySelected();
    s.toggleLock(fid);
    return { fid, src: r.id };
  });
  const at = (await status(page, src)).rect;
  await page.evaluate(() => (window as unknown as { state: AnyState }).state.pasteClipboard(true));
  const id = (await selected(page))[0];
  const s = await status(page, id);
  expect(s.parent).not.toBe(fid);
  expect(s.locked).toBe(false);
  for (let i = 0; i < 4; i++) expect(s.rect[i]).toBeCloseTo(at[i], 3);
  expect(errors).toEqual([]);
});

test('an unlocked frame still adopts what is pasted onto it', async ({ page }) => {
  const errors = await boot(page);
  const fid = await page.evaluate(() => (window as unknown as { state: AnyState }).state.artboards[0].id as string);
  await pngOnClipboard(page);
  await page.keyboard.press('Control+v');
  await expect.poll(() => page.locator('#drawing-layer image').count()).toBe(1);
  const id = await page.locator('#drawing-layer image').getAttribute('id') as string;
  expect((await status(page, id)).parent).toBe(fid);
  expect(errors).toEqual([]);
});
