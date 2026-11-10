import { test, expect, type Page } from '@playwright/test';

async function setup(page: Page, transform = '', divisions = false, snap = true) {
  await page.goto('/'); await page.waitForFunction(() => !!(window as any).state);
  const id = await page.evaluate(({ transform, divisions, snap }) => {
    const s = (window as any).state, ns = 'http://www.w3.org/2000/svg';
    const frame = document.getElementById(s.artboards[0].id)!;
    frame.setAttribute('transform', 'translate(37 23)');
    const group = document.createElementNS(ns, 'g'); group.id = s.nextId();
    group.setAttribute('transform', 'translate(30 15)'); frame.append(group);
    const path = document.createElementNS(ns, 'path'); path.id = s.nextId();
    path.setAttribute('d', 'M100 100 C130 100 170 160 200 160 L260 220');
    path.setAttribute('transform', transform); path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#39b');
    group.append(path); s.rebuildShapesFromDOM();
    s.setFrameGrid(frame.id, { mode: divisions ? 'divisions' : 'px', size: 20, cols: 8, rows: 6, subdivisions: 2, visible: true, snap, color: '#7f8fa6' });
    s.addFrame(2000, 0, 400, 400, 'Other frame'); // deliberately leave a different frame active
    s.saveHistory(); s.selectShape(path.id); return path.id;
  }, { transform, divisions, snap });
  await page.keyboard.press('a'); return id;
}
async function worldAnchors(page: Page) {
  return page.evaluate(async () => {
    const s = (window as any).state;
    const { pointMapperBetween } = await import('/src/core/coords.ts');
    const map = pointMapperBetween(document.getElementById('drawing-layer') as any, s.editingGeometryEl())!;
    return s.pathEdit.model.subpaths[0].anchors.map((a: any) => ({ ...map(a.x, a.y), out: map(a.outX ?? a.x, a.outY ?? a.y) }));
  });
}
async function dragTo(page: Page, selector: string, x: number, y: number) {
  const box = (await page.locator(selector).boundingBox())!;
  const end = await page.evaluate(({ x, y }) => {
    const m = (document.getElementById('drawing-layer') as unknown as SVGGraphicsElement).getScreenCTM()!;
    const p = new DOMPoint(x, y).matrixTransform(m); return { x: p.x, y: p.y };
  }, { x, y });
  await page.mouse.move(box.x + box.width/2, box.y + box.height/2); await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 }); await page.mouse.up();
}
for (const transform of ['', 'rotate(25)', 'scale(1.4 .8)', 'matrix(-1 .2 .3 1 400 0)']) {
  test(`point snaps to its own frame grid through ${transform || 'translation'}`, async ({ page }) => {
    const id = await setup(page, transform);
    const before = await page.locator(`[id="${id}"]`).getAttribute('d');
    await dragTo(page, '[data-node-anchor="0:0"]', 250, 200);
    const points = await worldAnchors(page);
    expect(points[0].x).toBeCloseTo(257, 2); expect(points[0].y).toBeCloseTo(203, 2);
    await page.keyboard.press('Control+z'); await expect(page.locator(`[id="${id}"]`)).toHaveAttribute('d', before!);
  });
}
test('division grid moves selected points rigidly and snaps curve handles', async ({ page }) => {
  await setup(page, 'rotate(20)', true);
  await page.evaluate(() => { const s = (window as any).state; s.pathEdit.selectOnly(0,0); s.pathEdit.addSelect(0,1); s.onChange_public(); });
  const before = await worldAnchors(page);
  await dragTo(page, '[data-node-anchor="0:0"]', 250, 200);
  const after = await worldAnchors(page);
  expect(after[0].x).toBeCloseTo(277, 2); expect(after[0].y).toBeCloseTo(203, 2);
  expect(after[1].x-after[0].x).toBeCloseTo(before[1].x-before[0].x, 2);
  expect(after[1].y-after[0].y).toBeCloseTo(before[1].y-before[0].y, 2);
  await dragTo(page, '[data-node-handle="0:0:out"]', 310, 250);
  const handled = await worldAnchors(page);
  expect(handled[0].out.x).toBeCloseTo(337, 2); expect(handled[0].out.y).toBeCloseTo(248, 2);
});
for (const bypass of ['disabled', 'Control']) {
  test(`${bypass} leaves point movement unsnapped`, async ({ page }) => {
    await setup(page, 'rotate(25)', false, bypass !== 'disabled');
    if (bypass === 'Control') await page.keyboard.down('Control');
    await dragTo(page, '[data-node-anchor="0:0"]', 250, 200);
    if (bypass === 'Control') await page.keyboard.up('Control');
    const points = await worldAnchors(page);
    expect(Math.abs(points[0].x - 250)).toBeLessThan(1.5); expect(Math.abs(points[0].y - 200)).toBeLessThan(1.5);
  });
}
test('Pen places new points on the grid in the frame where drawing begins', async ({ page }) => {
  await setup(page); await page.keyboard.press('Escape'); await page.keyboard.press('p');
  for (const [x,y] of [[350,300],[450,360]]) {
    const p = await page.evaluate(({x,y}) => {
      const pt = new DOMPoint(x,y).matrixTransform((document.getElementById('drawing-layer') as unknown as SVGGraphicsElement).getScreenCTM()!);
      return { x: pt.x, y: pt.y };
    }, {x,y});
    await page.mouse.click(p.x,p.y);
  }
  await page.keyboard.press('Enter'); await page.keyboard.press('a');
  const points = await worldAnchors(page);
  expect(points[0].x).toBeCloseTo(357,2); expect(points[0].y).toBeCloseTo(303,2);
  expect(points[1].x).toBeCloseTo(457,2); expect(points[1].y).toBeCloseTo(363,2);
});
