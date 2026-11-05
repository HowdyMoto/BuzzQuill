import { test, expect, type Page } from '@playwright/test';

async function boot(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).state);
  const id = await page.evaluate(() => {
    const s = (window as any).state;
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.id = s.nextId(); el.setAttribute('d', 'M100 180 C160 180 240 180 300 180 C390 180 440 180 500 180');
    el.setAttribute('fill', 'none'); el.setAttribute('stroke', '#48a'); el.setAttribute('stroke-width', '4');
    document.getElementById(s.artboards[0].id)!.append(el);
    s.rebuildShapesFromDOM(); s.saveHistory(); s.selectShape(el.id); return el.id;
  });
  await page.keyboard.press('a');
  await page.locator('[data-node-anchor="0:1"]').click();
  return id;
}
const mode = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const anchor = (page: Page) => page.evaluate(() => ({ ...(window as any).state.pathEdit.model.subpaths[0].anchors[1] }));
async function reenter(page: Page) {
  await page.keyboard.press('v'); await page.keyboard.press('a');
  await page.locator('[data-node-anchor="0:1"]').click();
}

test('Broken survives point reselection, leaving edit mode and undo/redo without changing the curve', async ({ page }, info) => {
  const id = await boot(page);
  const before = await anchor(page);
  await mode(page, 'Broken').click();
  expect(await anchor(page)).toEqual({ ...before, type: 'broken' });
  await page.locator('[data-node-anchor="0:0"]').click();
  await page.locator('[data-node-anchor="0:1"]').click();
  await expect(mode(page, 'Broken')).toHaveAttribute('aria-pressed', 'true');
  await reenter(page);
  await expect(mode(page, 'Broken')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Control+z');
  await page.evaluate(id => (window as any).state.selectShape(id), id);
  await reenter(page);
  expect((await anchor(page)).type).toBe('smooth');
  await page.keyboard.press('Control+Shift+z');
  await page.evaluate(id => (window as any).state.selectShape(id), id);
  await reenter(page);
  await page.locator('[data-node-anchor="0:1"]').click();
  await expect(mode(page, 'Broken')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`[id="${id}"]`)).toHaveAttribute('data-point-modes', 'obbb');
  expect(await mode(page, 'Broken').evaluate(el => getComputedStyle(el, '::after').content)).toBe('none');
  await page.locator('#prop-node-row').screenshot({ path: info.outputPath('point-modes.png') });
});

for (const name of ['Broken', 'Smooth'] as const) {
  test(`${name} handle drag respects the chosen linkage`, async ({ page }) => {
    await boot(page); await mode(page, name).click();
    const before = await anchor(page);
    const box = (await page.locator('[data-node-handle="0:1:out"]').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 30, { steps: 5 }); await page.mouse.up();
    const after = await anchor(page);
    if (name === 'Broken') { expect(after.inX).toBe(before.inX); expect(after.inY).toBe(before.inY); }
    else {
      expect(Math.hypot(after.inX - after.x, after.inY - after.y)).toBeCloseTo(60, 3);
      expect((after.inX - after.x) * (after.outY - after.y) - (after.inY - after.y) * (after.outX - after.x)).toBeCloseTo(0, 3);
    }
    await reenter(page);
    expect((await anchor(page)).type).toBe(name.toLowerCase());
  });
}

test('Smooth preserves unequal lengths; Corner removes handles and remains Corner', async ({ page }) => {
  await boot(page); const before = await anchor(page);
  await mode(page, 'Smooth').click(); expect(await anchor(page)).toEqual(before);
  await mode(page, 'Corner').click();
  await expect(page.locator('[data-node-handle^="0:1:"]')).toHaveCount(0);
  await reenter(page);
  await expect(mode(page, 'Corner')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-node-handle^="0:1:"]')).toHaveCount(0);
});

test('saved SVG restores point modes', async ({ page }) => {
  const id = await boot(page); await mode(page, 'Broken').click();
  await page.keyboard.press('v');
  await page.evaluate(async id => {
    const s = (window as any).state;
    const { loadDocumentSVG, serializeDocumentSVG } = await import('/src/ui/project-file.ts');
    const markup = serializeDocumentSVG(s);
    loadDocumentSVG(s, markup); s.selectShape(id);
  }, id);
  await page.keyboard.press('a'); await page.locator('[data-node-anchor="0:1"]').click();
  await expect(mode(page, 'Broken')).toHaveAttribute('aria-pressed', 'true');
});

for (const wrapper of ['width', 'appearance']) {
  test(`${wrapper} wrappers retain the source point mode`, async ({ page }) => {
    const id = await boot(page); await mode(page, 'Broken').click();
    await page.keyboard.press('v');
    await page.evaluate(({ id, wrapper }) => {
      const s = (window as any).state;
      if (wrapper === 'width') s.setWidthProfile(id, [{ t: 0, w: 10 }, { t: 1, w: 2 }], 10);
      else s.setAppearance(id, [{ t: 'stroke', paint: '#e33', width: 6 }, { t: 'stroke', paint: '#000', width: 2 }]);
      s.selectShape(id);
    }, { id, wrapper });
    await page.keyboard.press('a'); await page.locator('[data-node-anchor="0:1"]').click();
    await expect(mode(page, 'Broken')).toHaveAttribute('aria-pressed', 'true');
    await mode(page, 'Smooth').click(); await reenter(page);
    await expect(mode(page, 'Smooth')).toHaveAttribute('aria-pressed', 'true');
    if (wrapper === 'width') {
      await page.keyboard.press('v');
      await page.evaluate(id => (window as any).state.clearWidthProfile(id), id);
      await page.keyboard.press('a'); await page.locator('[data-node-anchor="0:1"]').click();
      await expect(mode(page, 'Smooth')).toHaveAttribute('aria-pressed', 'true');
    }
  });
}

test('mixed selections are explicit and applying a mode updates every selected point', async ({ page }) => {
  await boot(page);
  await page.keyboard.down('Shift'); await page.locator('[data-node-anchor="0:0"]').click(); await page.keyboard.up('Shift');
  await expect(page.locator('#prop-node-hint')).toContainText('Mixed modes');
  await expect(page.locator('.point-mode[aria-pressed="true"]')).toHaveCount(0);
  await mode(page, 'Corner').click();
  await expect(mode(page, 'Corner')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-node-handle]')).toHaveCount(0);
});


test('reversing a path carries modes with their original points', async ({ page }) => {
  const id = await boot(page); await mode(page, 'Broken').click();
  await page.locator('[data-node-anchor="0:0"]').click(); await mode(page, 'Smooth').click();
  await page.keyboard.press('v'); await page.keyboard.press('Control+Alt+r');
  await expect(page.locator(`[id="${id}"]`)).toHaveAttribute('data-point-modes', 'obbs');
  await page.keyboard.press('a'); await page.locator('[data-node-anchor="0:2"]').click();
  await expect(mode(page, 'Smooth')).toHaveAttribute('aria-pressed', 'true');
});
