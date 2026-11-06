import { test, expect, type Page } from '@playwright/test';

async function boot(page: Page) {
  await page.goto('/'); await page.waitForFunction(() => !!(window as any).state);
  return page.evaluate(() => {
    const s = (window as any).state;
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.id = s.nextId(); el.setAttribute('d', 'M160 180 L480 180');
    el.setAttribute('fill', 'none'); el.setAttribute('stroke', '#38a'); el.setAttribute('stroke-width', '8');
    document.getElementById(s.artboards[0].id)!.append(el);
    s.rebuildShapesFromDOM(); s.selectShape(el.id); s.saveHistory(); return el.id;
  });
}
async function choose(page: Page, control: string, name: string) {
  await page.locator(control).click(); await page.getByRole('menuitemradio', { name, exact: true }).click();
}

test('cap menu previews all caps and applies them with undo', async ({ page }, info) => {
  const id = await boot(page); const path = page.locator(`[id="${id}"]`);
  await page.locator('#prop-cap-picker').click();
  await expect(page.getByRole('menuitemradio')).toHaveCount(3);
  await expect(page.getByRole('menuitemradio').locator('svg')).toHaveCount(3);
  await page.getByRole('menu', { name: 'Cap style' }).screenshot({ path: info.outputPath('caps.png') });
  await page.getByRole('menuitemradio', { name: 'Round', exact: true }).click();
  await expect(path).toHaveAttribute('stroke-linecap', 'round');
  await choose(page, '#prop-cap-picker', 'Square'); await expect(path).toHaveAttribute('stroke-linecap', 'square');
  await page.keyboard.press('Control+z'); await expect(path).toHaveAttribute('stroke-linecap', 'round');
  await choose(page, '#prop-cap-picker', 'Flat'); await expect(path).not.toHaveAttribute('stroke-linecap');
});

test('endpoint menus show previews and keep start and end independent', async ({ page }, info) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  const id = await boot(page); const path = page.locator(`[id="${id}"]`);
  await page.locator('#mk-end').click();
  await expect(page.getByRole('menuitemradio')).toHaveCount(8);
  await expect(page.getByRole('menuitemradio').locator(':scope > span > svg')).toHaveCount(8);
  await page.getByRole('menu', { name: 'End', exact: true }).screenshot({ path: info.outputPath('ends.png') });
  await page.getByRole('menuitemradio', { name: 'Inward triangle', exact: true }).click();
  await choose(page, '#mk-start', 'Diamond');
  await expect(path).toHaveAttribute('marker-start', 'url(#mk-diamond)');
  await expect(path).toHaveAttribute('marker-end', 'url(#mk-triangle)');
  await page.locator('#panel-stroke').screenshot({ path: info.outputPath('stroke-panel.png') });
  expect(await page.locator('#prop-markers-row').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await choose(page, '#mk-end', 'None');
  await expect(path).not.toHaveAttribute('marker-end');
  await expect(path).toHaveAttribute('marker-start', 'url(#mk-diamond)');
});

test('keyboard selection and escape return focus without canvas shortcuts', async ({ page }) => {
  const id = await boot(page);
  await page.locator('#prop-cap-picker').focus(); await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await expect(page.locator(`[id="${id}"]`)).toHaveAttribute('stroke-linecap', 'square');
  await expect(page.locator('#prop-cap-picker')).toBeFocused();
  await page.keyboard.press('Space'); await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0); await expect(page.locator('#prop-cap-picker')).toBeFocused();
});

test('new markers survive saved SVG and all definitions are restored independently', async ({ page }) => {
  const id = await boot(page);
  await choose(page, '#mk-start', 'Square'); await choose(page, '#mk-end', 'Bar');
  const saved = await page.evaluate(async id => {
    const s = (window as any).state;
    const { serializeDocumentSVG, loadDocumentSVG } = await import('/src/ui/project-file.ts');
    const svg = serializeDocumentSVG(s); loadDocumentSVG(s, svg); s.selectShape(id); return svg;
  }, id);
  expect(saved).toContain('id="mk-square"'); expect(saved).toContain('id="mk-bar"');
  await expect(page.locator('#mk-end')).toHaveAttribute('aria-label', 'End: Bar');
  await page.evaluate(() => document.querySelector('marker[id="mk-diamond"]')!.remove());
  await choose(page, '#mk-end', 'Diamond');
  await expect(page.locator('marker[id="mk-diamond"]')).toHaveCount(1);
  await expect(page.locator('marker[id="mk-arrow"]')).toHaveCount(1);
});

test('appearance strokes expose the same cap controls', async ({ page }) => {
  const id = await boot(page);
  await page.evaluate(id => (window as any).state.setAppearance(id, [
    { t: 'stroke', paint: '#38a', width: 8 }, { t: 'stroke', paint: '#fff', width: 2 },
  ]), id);
  await choose(page, '#prop-cap-picker', 'Round');
  expect(await page.evaluate(id => (window as any).state.getAppearance(id).filter((l: any) => l.t === 'stroke').map((l: any) => l.cap), id)).toEqual(['round', 'round']);
});


test('mixed caps and imported custom markers are represented honestly', async ({ page }) => {
  const id = await boot(page);
  await page.evaluate(id => {
    const s = (window as any).state, first = document.getElementById(id)!;
    first.setAttribute('marker-end', 'url(#custom-marker)');
    const clone = first.cloneNode(true) as Element; clone.id = s.nextId(); clone.setAttribute('stroke-linecap', 'round');
    first.parentNode!.appendChild(clone); s.rebuildShapesFromDOM(); s.selectMultiple([id, clone.id]);
  }, id);
  await expect(page.locator('#prop-cap-picker')).toHaveAttribute('aria-label', 'Cap style: Mixed');
  await expect(page.locator('#mk-end')).toHaveAttribute('aria-label', 'End: Custom');
  await choose(page, '#prop-cap-picker', 'Square');
  expect(await page.evaluate(() => (window as any).state.getSelectedShapes().map((s: any) => s.element.getAttribute('stroke-linecap')))).toEqual(['square', 'square']);
});

for (const style of ['Diamond', 'Inward triangle', 'Square', 'Bar']) {
  test(`${style} remains part of the geometry when outlining a stroke`, async ({ page }) => {
    await boot(page); await choose(page, '#mk-end', style);
    const result = await page.evaluate(async () => {
      const s = (window as any).state; const ok = await s.outlineSelectedStroke();
      const el = s.getSelectedShape().element as SVGGraphicsElement;
      const b = el.getBBox();
      return { ok, height: b.height, markers: el.querySelectorAll('[marker-end]').length };
    });
    expect(result.ok).toBe(true); expect(result.height).toBeGreaterThan(20); expect(result.markers).toBe(0);
  });
}
