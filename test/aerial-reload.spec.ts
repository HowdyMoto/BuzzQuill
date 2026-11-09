import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
test('diagnose oversized DOM serialization without decoding images', async ({ page }) => {
  test.skip(!process.env.BQ_SERIALIZE_LIMIT, 'Local browser-limit reproduction');
  await page.goto('/');
  const result = await page.evaluate(() => {
    const root = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const payload = 'a'.repeat(14 * 1024 * 1024);
    for (let i = 0; i < 49; i++) { const image = document.createElementNS(root.namespaceURI, 'image'); image.setAttribute('data-payload', payload); root.append(image); }
    try { return { children: root.children.length, serialized: root.innerHTML.length }; }
    catch (e) { return { children: root.children.length, error: String(e) }; }
  });
  console.log('SERIALIZATION LIMIT', JSON.stringify(result));
  expect(result.children).toBe(49);
});
test('inspect the reported saved file', async ({ page }) => {
  test.skip(!process.env.BQ_BROKEN_SVG, 'Local reported file');
  await page.goto('/'); await page.waitForFunction(() => !!(window as any).state);
  const svg = await readFile(process.env.BQ_BROKEN_SVG!, 'utf8');
  const result = await page.evaluate(async svg => {
    const io = await import('/src/ui/project-file.ts');
    try { io.loadDocumentSVG((window as any).state, svg); return ''; } catch (error) { return String(error); }
  }, svg);
  expect(result).toContain('no drawing data');
});

test('an empty serialization of a populated drawing cannot begin a file save', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => !!(window as any).state);
  const result = await page.evaluate(async () => {
    const state = (window as any).state;
    state.importSVGContent('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L100 100"/></svg>');
    const layer = document.getElementById('drawing-layer')!;
    Object.defineProperty(layer, 'innerHTML', { configurable: true, get: () => '' });
    const save = (await import('/src/ui/project-file.ts')).beginDocumentSave(state);
    delete (layer as any).innerHTML;
    return { aborted: save === null, paths: layer.querySelectorAll('path').length };
  });
  expect(result).toEqual({ aborted: true, paths: 1 });
  await expect(page.getByText(/could not be serialized safely/)).toBeVisible();
});

test('legacy embedded rasters become compact assets before reaching live DOM or history', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => !!(window as any).state);
  const result = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = c.height = 4000;
    c.getContext('2d')!.fillRect(0, 0, 4000, 4000); const url = c.toDataURL(); c.width = c.height = 0;
    const state = (window as any).state;
    (await import('/src/ui/project-file.ts')).loadDocumentSVG(state, `<svg xmlns="http://www.w3.org/2000/svg"><image width="4000" height="4000" href="${url}"/><path d="M10 10 L100 100"/></svg>`);
    return { managed: !!document.querySelector('#drawing-layer image[data-bq-raster]'), href: document.querySelector('#drawing-layer image')!.getAttribute('href'),
      chars: state.exportHistory().entries.at(-1).svgContent.length, paths: document.querySelectorAll('#drawing-layer path').length };
  });
  expect(result.managed).toBe(true); expect(result.href).toMatch(/^blob:/); expect(result.chars).toBeLessThan(10000); expect(result.paths).toBe(1);
});

test('slow open cannot replace a different tab or newly edited content', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => !!(window as any).state);
  const result = await page.evaluate(async () => {
    const io = await import('/src/ui/project-file.ts'); const docs = (window as any).docs;
    let release!: () => void; const wait = new Promise<void>(r => release = r);
    const handle = { name: 'slow.svg', getFile: async () => { await wait; return new File(['<svg xmlns="http://www.w3.org/2000/svg"><circle r="20"/></svg>'], 'slow.svg'); } } as FileSystemFileHandle;
    const pending = await io.pendingFromHandle(handle); const opening = docs.openDocument(pending!);
    docs.newTab(); const activeId = docs.activeId;
    (window as any).state.importSVGContent('<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1 L50 50"/></svg>');
    release(); await opening;
    return { same: docs.activeId === activeId, path: !!document.querySelector('#drawing-layer path'), circle: !!document.querySelector('#drawing-layer ellipse') };
  });
  expect(result).toEqual({ same: true, path: true, circle: false });
});

test('a late recovered session keeps current work and opens recovery in a background tab', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => !!(window as any).state);
  const result = await page.evaluate(() => {
    const docs = (window as any).docs, state = (window as any).state;
    state.importSVGContent('<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1 L50 50"/></svg>'); const activeId = docs.activeId;
    docs.restoreSession({ tabs: [{ title: 'Recovered aerial', svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20"/></svg>', view: null, selection: [] }], activeIndex: 0 }, true);
    return { same: docs.activeId === activeId, path: !!document.querySelector('#drawing-layer path'), tabs: docs.tabs.length, recovered: docs.tabs.some((t: any) => t.title === 'Recovered aerial') };
  });
  expect(result).toEqual({ same: true, path: true, tabs: 2, recovered: true });
});

test('actual tiled SVG: UI drawing, sustained zoom, Save As, and reopen preserve paths and all images', async ({ page }, info) => {
  test.skip(!process.env.BQ_AERIAL_UI, 'Optional user aerial workflow'); test.setTimeout(300000);
  const source = await readFile('D:/tmp/nurburgring-aerial/out/trace-on-20cm-tiles.svg', 'utf8');
  await page.addInitScript(source => {
    (window as any).showOpenFilePicker = async () => [{ name: 'trace-on-20cm-tiles.svg', kind: 'file', getFile: async () => new File([source], 'trace-on-20cm-tiles.svg', { type: 'image/svg+xml' }) }];
    (window as any).showSaveFilePicker = async () => ({ name: 'aerial-roundtrip.svg', kind: 'file', queryPermission: async () => 'granted', requestPermission: async () => 'granted',
      createWritable: async () => ({ write: async (value: Blob | string) => { (window as any).savedAerial = value instanceof Blob ? value : new Blob([value]); }, close: async () => {} }) });
  }, source);
  await page.goto('/'); await page.waitForFunction(() => !!(window as any).state);
  await page.locator('.menu-trigger', { hasText: 'File' }).click(); await page.locator('[data-action="file.open"]').click();
  await page.getByRole('button', { name: 'Locate images…' }).click();
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Choose folder…', exact: true }).click();
  await (await chooser).setFiles('D:/tmp/nurburgring-aerial/out/full-20cm');
  await page.locator('#linked-image-quality').selectOption('original'); await page.getByRole('button', { name: 'Add 49 images', exact: true }).click();
  await expect(page.locator('#drawing-layer image[data-bq-raster]')).toHaveCount(49, { timeout: 90000 });
  await expect(page.getByRole('dialog')).toBeHidden();
  const box = await page.locator('#svg-canvas').boundingBox(); if (!box) throw new Error('No canvas');
  await page.locator('[data-tool="pen"]').click();
  for (const [dx, dy] of [[.3,.3],[.4,.4],[.5,.3],[.6,.5]]) await page.mouse.click(box.x + box.width * dx, box.y + box.height * dy);
  await page.keyboard.press('Enter'); await page.keyboard.press('v');
  await expect(page.locator('#drawing-layer path')).not.toHaveCount(0);
  const d = await page.locator('#drawing-layer path').last().getAttribute('d');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 16; i++) { await page.mouse.wheel(0, i % 4 < 2 ? -150 : 150); await page.waitForTimeout(1100); }
  await page.keyboard.press('Control+Shift+s');
  await page.waitForFunction(() => (window as any).savedAerial?.size > 700000000, undefined, { timeout: 90000 });
  await page.evaluate(() => {
    (window as any).showOpenFilePicker = async () => [{ name: 'aerial-roundtrip.svg', kind: 'file', getFile: async () => new File([(window as any).savedAerial], 'aerial-roundtrip.svg', { type: 'image/svg+xml' }) }];
  });
  await page.locator('.menu-trigger', { hasText: 'File' }).click(); await page.locator('[data-action="file.open"]').click();
  await expect(page.locator('#drawing-layer image[data-bq-raster]')).toHaveCount(49, { timeout: 120000 });
  await expect(page.locator('#drawing-layer path').last()).toHaveAttribute('d', d!);
  await page.screenshot({ path: info.outputPath('aerial-reopened.png') });
});


test('missing drawing data is rejected without clearing existing work or undo', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => !!(window as any).state);
  const result = await page.evaluate(async () => {
    const state = (window as any).state;
    const io = await import('/src/ui/project-file.ts');
    state.importSVGContent('<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1 L20 20"/></svg>');
    const before = JSON.stringify(state.exportHistory());
    const parsed = new DOMParser().parseFromString(io.serializeDocumentSVG(state), 'image/svg+xml');
    parsed.querySelector('g.svgmaker-doc')!.replaceChildren();
    let message = '';
    try { io.loadDocumentSVG(state, new XMLSerializer().serializeToString(parsed)); } catch (error) { message = String(error); }
    return { message, paths: document.querySelectorAll('#drawing-layer path').length, historyPreserved: before === JSON.stringify(state.exportHistory()) };
  });
  expect(result.message).toContain('no drawing data');
  expect(result.paths).toBe(1); expect(result.historyPreserved).toBe(true);
});


test('large file open shows progress before reading and keeps it visible until the drawing is ready', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => !!(window as any).state);
  await page.evaluate(async () => {
    const file = new File(['<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L30 30"/><!--', ' '.repeat(1_100_000), '--></svg>'], 'large.svg');
    const read = file.arrayBuffer.bind(file);
    file.arrayBuffer = async () => {
      (window as any).overlayAtRead = getComputedStyle(document.querySelector('.loading-overlay')!).display !== 'none';
      await new Promise<void>(r => { (window as any).finishRead = r; });
      return read();
    };
    const io = await import('/src/ui/project-file.ts');
    (window as any).openingLarge = io.openHandle((window as any).state, { name: file.name, getFile: async () => file } as FileSystemFileHandle);
  });
  await expect(page.getByRole('progressbar', { name: 'Opening large.svg…' })).toBeVisible();
  await page.waitForFunction(() => !!(window as any).finishRead);
  expect(await page.evaluate(() => (window as any).overlayAtRead)).toBe(true);
  await page.evaluate(async () => { (window as any).finishRead(); await (window as any).openingLarge; });
  await expect(page.getByRole('progressbar')).toBeHidden();
  await expect(page.locator('#drawing-layer path')).toHaveCount(1);
});

test('loading feedback survives overlapping work and clears after a read error', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { withLoadingOverlay } = await import('/src/ui/loading-overlay.ts');
    (window as any).firstLoad = withLoadingOverlay('Opening first.svg…', () => new Promise<void>(r => { (window as any).finishFirst = r; }));
    (window as any).secondLoad = withLoadingOverlay('Opening second.svg…', () => new Promise<void>((_, reject) => { (window as any).failSecond = () => reject(new Error('Read failed')); })).catch(() => {});
  });
  await page.waitForFunction(() => !!(window as any).finishFirst && !!(window as any).failSecond);
  await page.evaluate(async () => { (window as any).finishFirst(); await (window as any).firstLoad; });
  await expect(page.getByRole('progressbar', { name: 'Opening second.svg…' })).toBeVisible();
  await page.evaluate(async () => { (window as any).failSecond(); await (window as any).secondLoad; });
  await expect(page.getByRole('progressbar')).toBeHidden();
});
