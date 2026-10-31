import { test, expect, type Page } from '@playwright/test';

/**
 * "Fit to paths" export bounds, and hidden layers staying out of exports.
 *
 * A file holding several alternate layouts of one track exports each layout with
 * the others (and the tracing image) hidden. The exported canvas must hug the
 * visible path — the consumer expects the outline to touch the edges — while the
 * coordinates stay the document's, so every layout still shares one space. And the
 * hidden layers must not ride along in the file.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyState = any;

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // Exports take the download path: no File System Access pickers in the test.
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
    delete (window as unknown as Record<string, unknown>).showDirectoryPicker;
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });
  return errors;
}

/** A frame at (100,50) holding: a visible curve, a hidden wider curve, a hidden
 *  tracing image larger than the frame, and a rotated ellipse (optional) — whose
 *  rotated bounding box is looser than its outline. */
async function setup(page: Page, opts: { rotated?: boolean } = {}) {
  return page.evaluate(({ PNG, rotated }) => {
    const s = (window as unknown as { state: AnyState }).state;
    const NS = 'http://www.w3.org/2000/svg';
    const fid = s.addFrame(100, 50, 600, 400, 'Track') as string;
    const frame = document.getElementById(fid)!;
    const mk = (tag: string, at: Record<string, string>) => {
      const el = document.createElementNS(NS, tag);
      el.id = s.nextId();
      for (const [k, v] of Object.entries(at)) el.setAttribute(k, v);
      frame.appendChild(el);
      return el.id;
    };
    const image = mk('image', { href: PNG, x: '-200', y: '-200', width: '1000', height: '900' });
    const layout = mk('path', { d: 'M 60 200 C 60 80 300 60 420 140 C 520 210 480 330 300 320 C 160 310 60 300 60 200 Z', fill: 'none', stroke: '#ff0', 'stroke-width': '3' });
    const other = mk('path', { d: 'M 20 200 C 20 20 560 20 560 200 C 560 380 20 380 20 200 Z', fill: 'none', stroke: '#f60', 'stroke-width': '3' });
    const turned = rotated ? mk('ellipse', { cx: '260', cy: '170', rx: '80', ry: '25', transform: 'rotate(30 260 170)', fill: '#39f' }) : null;
    s.rebuildShapesFromDOM();
    s.toggleVisibility(image);
    s.toggleVisibility(other);
    s.saveHistory();
    return { fid, image, layout, other, turned };
  }, { PNG, rotated: !!opts.rotated });
}

/** Export through the real Export dialog; returns the downloaded SVG text. */
async function exportViaDialog(page: Page, fid: string, bounds: 'frame' | 'paths', bake = false): Promise<string> {
  await page.evaluate(async () => {
    const m = await import('/src/ui/export-dialog.ts');
    m.showExportDialog((window as unknown as { state: AnyState }).state);
  });
  const dlg = page.locator('#export-dialog-overlay');
  await dlg.locator('select').nth(2).selectOption(bounds); // Format, Size mode, Bounds
  const bakeBox = dlg.getByLabel('Bake transforms into geometry');
  if ((await bakeBox.isChecked()) !== bake) await bakeBox.click();
  // Only the test frame.
  const rows = dlg.locator('input[type=checkbox][value^="shape-"]');
  for (let i = 0; i < await rows.count(); i++) {
    const cb = rows.nth(i);
    const want = (await cb.getAttribute('value')) === fid;
    if ((await cb.isChecked()) !== want) await cb.click();
  }
  const [dl] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: 'Export' }).click()]);
  const stream = await dl.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const viewBox = (svg: string) => /viewBox="([^"]+)"/.exec(svg)![1].split(/[\s,]+/).map(Number);

/** Exact world bounds of the given elements' geometry, measured on the canvas. */
const worldGeometry = (page: Page, ids: string[]) => page.evaluate((ids) => {
  const L = document.getElementById('drawing-layer') as unknown as SVGGraphicsElement;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const id of ids) {
    const el = document.getElementById(id) as unknown as SVGGeometryElement;
    const m = L.getScreenCTM()!.inverse().multiply(el.getScreenCTM()!);
    const n = el.getTotalLength();
    for (let i = 0; i <= 8000; i++) {
      const p = el.getPointAtLength((n * i) / 8000).matrixTransform(m);
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
  }
  return [x0, y0, x1 - x0, y1 - y0];
}, ids);

test('Fit to paths hugs the visible path, keeps coordinates, and leaves hidden layers out', async ({ page }) => {
  const errors = await boot(page);
  const ids = await setup(page);
  const docD = await page.evaluate((id) => document.getElementById(id)!.getAttribute('d'), ids.layout);

  const svg = await exportViaDialog(page, ids.fid, 'paths');
  const vb = viewBox(svg);
  const geo = await worldGeometry(page, [ids.layout]);
  for (let i = 0; i < 4; i++) expect(Math.abs(vb[i] - geo[i]), `viewBox[${i}]`).toBeLessThan(0.01);
  // The canvas size follows the fitted box.
  expect(svg).toMatch(new RegExp(`width="${vb[2]}" height="${vb[3]}"`));
  // Coordinates are the document's: the path is written exactly as it is on the canvas.
  expect(svg).toContain(`d="${docD}"`);
  // Hidden layers are not in the file at all.
  expect(svg).not.toContain('<image');
  expect(svg).not.toContain(`id="${ids.other}"`);

  // Frame bounds are unchanged — and still leave hidden layers out.
  const framed = await exportViaDialog(page, ids.fid, 'frame');
  expect(viewBox(framed)).toEqual([100, 50, 600, 400]);
  expect(framed).not.toContain('<image');
  expect(framed).not.toContain(`id="${ids.other}"`);
  expect(errors).toEqual([]);
});

test('a rotated shape counts by its outline, not its rotated bounding box', async ({ page }) => {
  const errors = await boot(page);
  const ids = await setup(page, { rotated: true });
  // Hide the curve so the rotated ellipse alone sets the bounds.
  await page.evaluate((id) => (window as unknown as { state: AnyState }).state.toggleVisibility(id), ids.layout);
  const vb = viewBox(await exportViaDialog(page, ids.fid, 'paths'));
  const geo = await worldGeometry(page, [ids.turned!]);
  // An ellipse is measured as its four-cubic path form, which strays from the true
  // ellipse by a few hundredths here; its rotated bounding box would be ~11 units out.
  for (let i = 0; i < 4; i++) expect(Math.abs(vb[i] - geo[i]), `viewBox[${i}]`).toBeLessThan(0.05);
  expect(errors).toEqual([]);
});

test('a baked export fits the same and drops hidden layers too', async ({ page }) => {
  const errors = await boot(page);
  const ids = await setup(page);
  const svg = await exportViaDialog(page, ids.fid, 'paths', true);
  const geo = await worldGeometry(page, [ids.layout]);
  const vb = viewBox(svg);
  for (let i = 0; i < 4; i++) expect(Math.abs(vb[i] - geo[i]), `viewBox[${i}]`).toBeLessThan(0.01);
  expect(svg).not.toContain('<image');
  expect(svg).not.toContain(`id="${ids.other}"`);
  expect(errors).toEqual([]);
});

test('a hidden element something references stays in the export', async ({ page }) => {
  const errors = await boot(page);
  const r = await page.evaluate(() => {
    const s = (window as unknown as { state: AnyState }).state;
    const NS = 'http://www.w3.org/2000/svg';
    const fid = s.addFrame(100, 50, 300, 200, 'Refs') as string;
    const frame = document.getElementById(fid)!;
    const src = document.createElementNS(NS, 'path');
    src.id = 'tmpl';
    src.setAttribute('d', 'M 10 10 L 60 10 L 35 50 Z');
    src.setAttribute('style', 'display:none');
    const use = document.createElementNS(NS, 'use');
    use.id = s.nextId();
    use.setAttribute('href', '#tmpl');
    use.setAttribute('x', '100');
    frame.append(src, use);
    s.rebuildShapesFromDOM();
    return s.getDrawingLayerSVGForExport() as string;
  });
  expect(r).toContain('id="tmpl"');
  expect(errors).toEqual([]);
});

test("a frame's quick export honours its target's Fit to paths", async ({ page }) => {
  const errors = await boot(page);
  const ids = await setup(page);
  await page.evaluate((fid) => {
    const s = (window as unknown as { state: AnyState }).state;
    s.setFrameExportTargets(fid, [{ format: 'svg', name: 'track', scale: 1, bounds: 'paths' }], true);
  }, ids.fid);
  // Survives the stored round trip.
  expect(await page.evaluate((fid) =>
    (window as unknown as { state: AnyState }).state.getFrameExportTargets(fid)[0].bounds, ids.fid)).toBe('paths');
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(async (fid) => {
      const s = (window as unknown as { state: AnyState }).state;
      const m = await import('/src/ui/export-dialog.ts');
      await m.exportArtboardToFile(s, s.getArtboardById(fid));
    }, ids.fid),
  ]);
  const stream = await dl.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const svg = Buffer.concat(chunks).toString('utf8');
  const vb = viewBox(svg);
  const geo = await worldGeometry(page, [ids.layout]);
  for (let i = 0; i < 4; i++) expect(Math.abs(vb[i] - geo[i]), `viewBox[${i}]`).toBeLessThan(0.01);
  expect(svg).not.toContain('<image');
  expect(errors).toEqual([]);
});

test('a frame with nothing visible falls back to the frame', async ({ page }) => {
  const errors = await boot(page);
  const ids = await setup(page);
  await page.evaluate((id) => (window as unknown as { state: AnyState }).state.toggleVisibility(id), ids.layout);
  const notes: string[] = [];
  page.on('dialog', (d) => { notes.push(d.message()); void d.dismiss(); });
  const svg = await exportViaDialog(page, ids.fid, 'paths');
  expect(viewBox(svg)).toEqual([100, 50, 600, 400]);
  await expect.poll(() => notes.join('\n')).toContain('no visible paths');
  expect(errors).toEqual([]);
});
