import { test, expect, type Page } from '@playwright/test';

/**
 * Join (⌘J), driven with real clicks and keys:
 *  - one open path closes; ends far apart get a straight closing segment, ends on top
 *    of each other merge into one anchor that keeps both curves;
 *  - two open paths join at their nearest ends into ONE path, in the upper path's
 *    space and appearance — even when the two live under different transforms;
 *  - node editing: the two selected end points join (close one subpath, or splice
 *    two subpaths of a compound path);
 *  - lines and polylines join too; closed shapes can't; it's all one undo step.
 */

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

/** Add elements (markup in frame-local coords) to the first frame; returns their ids. */
const add = (page: Page, markup: string) => page.evaluate((markup) => {
  const s = (window as unknown as { state: AnyState }).state;
  const frame = document.getElementById(s.artboards[0].id)!;
  const holder = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  holder.innerHTML = markup;
  const ids: string[] = [];
  const reId = (el: Element) => {
    if (el.tagName.toLowerCase() !== 'g' || el.hasAttribute('data-name')) { el.id = s.nextId(); ids.push(el.id); }
    for (const c of Array.from(el.children)) reId(c);
  };
  for (const el of Array.from(holder.children)) { reId(el); frame.appendChild(el); }
  s.rebuildShapesFromDOM();
  s.saveHistory();
  return ids;
}, markup);

const select = (page: Page, ids: string[]) =>
  page.evaluate((ids) => (window as unknown as { state: AnyState }).state.selectMultiple(ids), ids);

/** World points along a path, so geometry can be compared across transforms. */
const samples = (page: Page, id: string, n = 200) => page.evaluate(([id, n]) => {
  const el = document.getElementById(id as string) as unknown as SVGGeometryElement;
  const L = document.getElementById('drawing-layer') as unknown as SVGGraphicsElement;
  const m = L.getScreenCTM()!.inverse().multiply(el.getScreenCTM()!);
  const len = el.getTotalLength();
  const out: number[][] = [];
  for (let i = 0; i <= (n as number); i++) {
    const p = el.getPointAtLength((len * i) / (n as number)).matrixTransform(m);
    out.push([p.x, p.y]);
  }
  return out;
}, [id, n] as [string, number]);

/** Largest distance from any point of `pts` to the nearest point of `onto`. */
const farthest = (pts: number[][], onto: number[][]) =>
  Math.max(...pts.map(p => Math.min(...onto.map(q => Math.hypot(p[0] - q[0], p[1] - q[1])))));

const d = (page: Page, id: string) => page.evaluate((id) => document.getElementById(id)?.getAttribute('d') ?? null, id);

test('one open path closes with a straight segment', async ({ page }) => {
  const errors = await boot(page);
  const [p] = await add(page, '<path d="M 100 300 C 100 150 300 150 300 300" fill="none" stroke="#f60" stroke-width="3"/>');
  const before = await samples(page, p);
  await select(page, [p]);
  await page.keyboard.press('Control+j');
  const out = (await d(page, p))!;
  expect(out.trim().endsWith('Z')).toBe(true);
  // The old curve is untouched, and the new closing edge is the straight line back.
  expect(out).toContain('M 100 300 C 100 150 300 150 300 300');
  const after = await samples(page, p, 1500);
  expect(farthest(before, after)).toBeLessThan(0.5);
  const chord = Array.from({ length: 21 }, (_, i) => [300 - 10 * i, 300]);
  expect(farthest(chord, after)).toBeLessThan(0.5);
  // One undo step back to the open path.
  await page.keyboard.press('Control+z');
  expect((await d(page, p))!.includes('Z')).toBe(false);
  expect(errors).toEqual([]);
});

test('ends on top of each other merge into one anchor that keeps both curves', async ({ page }) => {
  const errors = await boot(page);
  // A teardrop drawn as an open path whose last point lands back on its first.
  const [p] = await add(page, '<path d="M 200 100 C 300 100 320 250 200 300 C 80 250 100 100 200.3 100.2" fill="none" stroke="#f60" stroke-width="3"/>');
  const before = await samples(page, p);
  await select(page, [p]);
  await page.keyboard.press('Control+j');
  const out = (await d(page, p))!;
  expect(out.trim().endsWith('Z')).toBe(true);
  // Two anchors left, not three: the coincident ends became one point.
  expect((out.match(/[MC]/g) ?? []).length).toBe(3); // M + 2 curves (the closing one included)
  const after = await samples(page, p);
  expect(farthest(before, after)).toBeLessThan(0.5);
  expect(farthest(after, before)).toBeLessThan(0.5);
  expect(errors).toEqual([]);
});

test('two open paths in different spaces join into one, in the upper one', async ({ page }) => {
  const errors = await boot(page);
  const ids = await add(page, `
    <g data-name="A" transform="translate(40 30)"><path d="M 60 200 C 100 120 180 120 220 200" fill="none" stroke="#f60" stroke-width="3"/></g>
    <g data-name="B" transform="translate(300 260) scale(2)"><path d="M -20 -30 L 40 10" fill="none" stroke="#0af" stroke-width="5"/></g>`);
  const [, a, , b] = ids; // group, path, group, path
  const wa = await samples(page, a), wb = await samples(page, b);
  await select(page, [a, b]);
  await page.keyboard.press('Control+j');
  // B is above A, so B survives (its stroke) and A is gone.
  expect(await d(page, a)).toBeNull();
  const joined = await page.evaluate((b) => {
    const el = document.getElementById(b)!;
    return { stroke: el.getAttribute('stroke'), sel: [...(window as unknown as { state: AnyState }).state.selectedShapeIds] };
  }, b);
  expect(joined.stroke).toBe('#0af');
  expect(joined.sel).toEqual([b]);
  // Both original curves are on the joined path, in world space.
  const after = await samples(page, b, 600);
  expect(farthest(wa, after)).toBeLessThan(0.5);
  expect(farthest(wb, after)).toBeLessThan(0.5);
  expect((await d(page, b))!.includes('Z')).toBe(false); // joined, not closed
  // One undo step restores both.
  await page.keyboard.press('Control+z');
  expect(await d(page, a)).not.toBeNull();
  expect(farthest(await samples(page, b), wb)).toBeLessThan(0.5);
  expect(errors).toEqual([]);
});

test('a line and a polyline join (they convert to a path)', async ({ page }) => {
  const errors = await boot(page);
  const [l, pl] = await add(page, `
    <line x1="100" y1="100" x2="200" y2="100" stroke="#000" stroke-width="2"/>
    <polyline points="200,100 260,160 320,100" fill="none" stroke="#000" stroke-width="2"/>`);
  await select(page, [l, pl]);
  await page.keyboard.press('Control+j');
  const remaining = await page.evaluate(([l, pl]) => [l, pl].filter(id => document.getElementById(id)), [l, pl]);
  expect(remaining).toHaveLength(1);
  const out = (await d(page, remaining[0]))!;
  // Shared end merged: 4 anchors (100,100 · 200,100 · 260,160 · 320,100), one run.
  expect((out.match(/[ML]/g) ?? []).length).toBe(4);
  expect(errors).toEqual([]);
});

test('a straight two-point line has nothing to close', async ({ page }) => {
  const errors = await boot(page);
  // Closing it would add a zero-length segment back along itself: a sliver with no
  // area, indistinguishable from doing nothing — so Join is not offered at all.
  const [l] = await add(page, '<line x1="100" y1="100" x2="300" y2="200" stroke="#f60" stroke-width="3"/>');
  await select(page, [l]);
  expect(await page.evaluate(() => (window as unknown as { state: AnyState }).state.canJoinPaths())).toBe(false);
  await page.keyboard.press('Control+j');
  expect(await page.evaluate((id) => document.getElementById(id)?.tagName.toLowerCase(), l)).toBe('line');
  // A curve between two points DOES enclose area once closed (the first test above).
  expect(errors).toEqual([]);
});

test('closed shapes and three paths are not joinable', async ({ page }) => {
  const errors = await boot(page);
  const ids = await add(page, `
    <rect x="50" y="50" width="80" height="60"/>
    <path d="M 10 10 L 60 10 L 60 60 Z" fill="none" stroke="#000"/>
    <path d="M 200 10 L 260 10" stroke="#000"/>
    <path d="M 200 40 L 260 40" stroke="#000"/>
    <path d="M 200 70 L 260 70" stroke="#000"/>`);
  const can = (sel: string[]) => page.evaluate((sel) => {
    const s = (window as unknown as { state: AnyState }).state;
    s.selectMultiple(sel);
    return s.canJoinPaths() as boolean;
  }, sel);
  expect(await can([ids[0]])).toBe(false);          // rect
  expect(await can([ids[1]])).toBe(false);          // closed path
  expect(await can([ids[2], ids[3], ids[4]])).toBe(false);
  expect(await can([ids[2], ids[3]])).toBe(true);
  expect(errors).toEqual([]);
});

/** Screen centre of a node-edit anchor marker. */
const anchorAt = async (page: Page, ref: string) => {
  const box = (await page.locator(`[data-node-anchor="${ref}"]`).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test('node editing: the two selected end points close the path', async ({ page }) => {
  const errors = await boot(page);
  const [p] = await add(page, '<path d="M 100 300 C 100 150 300 150 300 300 L 380 300" fill="none" stroke="#f60" stroke-width="3"/>');
  await page.evaluate((id) => {
    const s = (window as unknown as { state: AnyState }).state;
    s.selectMultiple([id]);
    s.requestTool?.('directSelect');
  }, p);
  await expect(page.locator('[data-node-anchor="0:0"]')).toHaveCount(1);
  const a0 = await anchorAt(page, '0:0'), a2 = await anchorAt(page, '0:2');
  await page.mouse.click(a0.x, a0.y);
  await page.keyboard.down('Shift');
  await page.mouse.click(a2.x, a2.y);
  await page.keyboard.up('Shift');
  await page.keyboard.press('Control+j');
  expect((await d(page, p))!.trim().endsWith('Z')).toBe(true);
  expect(errors).toEqual([]);
});

test('node editing: end points of two runs of one path splice them', async ({ page }) => {
  const errors = await boot(page);
  const [p] = await add(page, '<path d="M 100 100 L 200 100 M 300 100 L 300 200" fill="none" stroke="#f60" stroke-width="3"/>');
  await page.evaluate((id) => {
    const s = (window as unknown as { state: AnyState }).state;
    s.selectMultiple([id]);
    s.requestTool?.('directSelect');
  }, p);
  await expect(page.locator('[data-node-anchor="1:0"]')).toHaveCount(1);
  const a = await anchorAt(page, '0:1'), b = await anchorAt(page, '1:0');
  await page.mouse.click(a.x, a.y);
  await page.keyboard.down('Shift');
  await page.mouse.click(b.x, b.y);
  await page.keyboard.up('Shift');
  await page.keyboard.press('Control+j');
  const out = (await d(page, p))!;
  expect((out.match(/M/g) ?? []).length).toBe(1);   // one run now
  expect(out.includes('Z')).toBe(false);
  expect((out.match(/[ML]/g) ?? []).length).toBe(4); // 100,100 · 200,100 · 300,100 · 300,200
  expect(errors).toEqual([]);
});
