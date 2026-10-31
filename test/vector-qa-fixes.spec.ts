import { test, expect, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).state);
});

test('drawing tools keep accessible names and expose the active tool', async ({ page }) => {
  for (const name of ['Selection Tool', 'Rectangle Tool', 'Ellipse Tool', 'Pen Tool', 'Type Tool', 'Hand Tool', 'Zoom Tool']) {
    await expect(page.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveCount(1);
  }
  const ellipse = page.getByRole('button', { name: /^Ellipse Tool/ });
  await ellipse.click();
  await expect(ellipse).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('v');
  await expect(ellipse).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: /^Selection Tool/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'New document' })).toHaveCount(1);
});

async function cropFixture(page: Page, scale = 1, inside = false) {
  return page.evaluate(({ scale, inside }) => {
    const s = (window as any).state;
    document.getElementById('drawing-layer')!.innerHTML = '';
    s.rebuildShapesFromDOM();
    const frame = s.addFrame(250, 150, 300, 220, 'Crop target');
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const id = s.nextId();
    const attrs = { id, 'data-crop': '', x: inside ? '350' : '650', y: '210', width: String(100 * scale), height: String(80 * scale),
      viewBox: '1500 900 100 80', preserveAspectRatio: 'none', overflow: 'hidden', 'data-name': 'Cropped raster' };
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    const im = document.createElementNS('http://www.w3.org/2000/svg', 'image');
    im.setAttribute('width', '2000'); im.setAttribute('height', '1200');
    im.setAttribute('href', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
    el.appendChild(im);
    s.addShape({ id, type: 'image', element: el, name: 'Cropped raster', style: { ...s.defaultStyle }, visible: true, locked: false });
    return { id, frame };
  }, { scale, inside });
}

async function cropBounds(page: Page, id: string) {
  return page.evaluate(async id => {
    const { visualWorldBBox } = await import('/src/core/coords.ts');
    return visualWorldBBox(document.getElementById('svg-canvas') as any, document.getElementById(id) as any)!;
  }, id);
}

async function screenPoint(page: Page, x: number, y: number) {
  return page.evaluate(({ x, y }) => {
    const layer = document.getElementById('drawing-layer') as unknown as SVGGraphicsElement;
    const p = new DOMPoint(x, y).matrixTransform(layer.getScreenCTM()!);
    return { x: p.x, y: p.y };
  }, { x, y });
}

for (const scale of [1, 1.5]) {
  test(`cropped raster at scale ${scale} moves into an offset frame using its visible bounds`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    const { id, frame } = await cropFixture(page, scale);
    const from = await screenPoint(page, 650 + 50 * scale, 210 + 40 * scale);
    const to = await screenPoint(page, 350 + 50 * scale, 210 + 40 * scale);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator(`[id="${frame}"] > [id="${id}"]`)).toHaveCount(1);
    let b = await cropBounds(page, id);
    expect(b.x).toBeCloseTo(350, 0); expect(b.y).toBeCloseTo(210, 0);
    expect(b.width).toBeCloseTo(100 * scale, 0);
    await page.keyboard.press('Control+z');
    await expect(page.locator(`#drawing-layer > [id="${id}"]`)).toHaveCount(1);
    expect((await cropBounds(page, id)).x).toBeCloseTo(650, 0);
    await page.keyboard.press('Control+Shift+z');
    await expect(page.locator(`[id="${frame}"] > [id="${id}"]`)).toHaveCount(1);
    expect((await cropBounds(page, id)).x).toBeCloseTo(350, 0);
    // Numeric movement uses the same ownership seam as a drag. X is frame-local.
    await page.locator('#prop-x').fill('400');
    await page.locator('#prop-x').press('Enter');
    await expect(page.locator(`#drawing-layer > [id="${id}"]`)).toHaveCount(1);
    b = await cropBounds(page, id);
    expect(b.x).toBeCloseTo(650, 0);
    expect(errors).toEqual([]);
  });
}

test('a newly added cropped raster is parented by its viewport and stays in place', async ({ page }) => {
  const { id, frame } = await cropFixture(page, 1.5, true);
  await expect(page.locator(`[id="${frame}"] > [id="${id}"]`)).toHaveCount(1);
  const b = await cropBounds(page, id);
  expect(b.x).toBeCloseTo(350); expect(b.y).toBeCloseTo(210);
  expect(b.width).toBeCloseTo(150); expect(b.height).toBeCloseTo(120);
  // The committed crop remains a viewport through save/load, without exposing its source.
  await page.evaluate(async () => {
    const s = (window as any).state;
    const { serializeDocumentSVG, loadDocumentSVG } = await import('/src/ui/project-file.ts');
    const saved = serializeDocumentSVG(s);
    loadDocumentSVG(s, saved);
  });
  await expect(page.locator(`[id="${frame}"] > [id="${id}"][data-crop]`)).toHaveCount(1);
  expect((await cropBounds(page, id)).x).toBeCloseTo(350);
});

test('crop brackets resize the viewport and Escape cancels a second crop', async ({ page }, testInfo) => {
  const { id } = await cropFixture(page);
  const center = await screenPoint(page, 700, 250);
  await page.mouse.dblclick(center.x, center.y);
  await expect(page.locator('#svg-canvas')).toHaveAttribute('data-tool', 'crop');
  await expect(page.locator('[data-crop-handle]')).toHaveCount(8);
  await expect(page.locator('#selection-layer [data-handle]')).toHaveCount(0);
  const handle = page.locator('[data-crop-handle="nw"]');
  const originalHandle = await handle.boundingBox();
  await page.locator('#zoom-select').selectOption('2');
  const zoomedHandle = await handle.boundingBox();
  expect(zoomedHandle!.width).toBeCloseTo(originalHandle!.width, 0);
  expect(zoomedHandle!.height).toBeCloseTo(originalHandle!.height, 0);
  await page.locator('#zoom-select').selectOption('1');
  await page.screenshot({ path: testInfo.outputPath('crop-handles.png') });
  const corner = await screenPoint(page, 750, 290);
  const end = await screenPoint(page, 725, 270);
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up();
  await page.keyboard.press('Enter');
  let b = await cropBounds(page, id);
  expect(b.width).toBeCloseTo(75, 0); expect(b.height).toBeCloseTo(60, 0);
  const again = await screenPoint(page, 680, 240);
  await page.mouse.dblclick(again.x, again.y);
  await expect(page.locator('#svg-canvas')).toHaveAttribute('data-tool', 'crop');
  const edge = await screenPoint(page, 725, 240);
  await page.mouse.move(edge.x, edge.y); await page.mouse.down();
  await page.mouse.move(edge.x - 15, edge.y, { steps: 4 }); await page.mouse.up();
  await page.keyboard.press('Escape');
  b = await cropBounds(page, id);
  expect(b.width).toBeCloseTo(75, 0); expect(b.height).toBeCloseTo(60, 0);
});

test('frame dialog and quick export both surface residual transform warnings', async ({ page }) => {
  await page.evaluate(() => {
    const s = (window as any).state;
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
    el.id = s.nextId();
    for (const [k, v] of Object.entries({ cx: '200', cy: '200', rx: '80', ry: '20', transform: 'rotate(-20 200 200)', fill: 'orange' })) el.setAttribute(k, v);
    s.addShape({ id: el.id, type: 'ellipse', element: el, name: 'Rotated ellipse', style: s.defaultStyle, visible: true, locked: false });
    s.bakeTransformsOnExport = true;
    s.setFrameExportTargets(s.artboards[0].id, [{ format: 'svg', bake: true }]);
    // Exercise the download fallback without opening an OS file picker in tests.
    delete (window as any).showSaveFilePicker;
  });
  const messages: string[] = [];
  page.on('dialog', async d => { messages.push(d.message()); await d.accept(); });
  await page.keyboard.press('Control+Alt+e');
  await expect(page.getByRole('checkbox', { name: 'Bake transforms into geometry' })).toBeChecked();
  const batchDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await batchDownload;
  await expect.poll(() => messages.join('\n')).toContain('<ellipse> kept a transform');
  const quickDownload = page.waitForEvent('download');
  await page.locator('.layer-export').click();
  await quickDownload;
  await expect(page.getByText(/<ellipse> kept a transform/)).toBeVisible();
});
