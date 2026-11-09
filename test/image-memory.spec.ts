import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
test.beforeEach(async ({ page }) => { await page.goto('/'); await page.waitForFunction(() => !!(window as any).state); });

test('shared originals survive edits, undo, portable save and session reload', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const a = await import('/src/core/raster-assets.ts');
    const { serializeDocumentSVG, serializeDocumentSVGForSave } = await import('/src/ui/project-file.ts');
    const state = (window as any).state;
    const canvas = document.createElement('canvas'); canvas.width = 2400; canvas.height = 1600;
    canvas.getContext('2d')!.fillRect(0, 0, 2400, 1600);
    const blob = await new Promise<Blob>(r => canvas.toBlob(b => r(b!), 'image/jpeg', .9));
    const id = await a.prepareAsset(new File([blob], 'original.jpg', { type: blob.type }));
    state.importSVGContent('<svg xmlns="http://www.w3.org/2000/svg"><image x="0" y="0" width="200" height="100"/></svg>');
    const image = document.querySelector('#drawing-layer image')!; a.attachAsset(image, id);
    state.saveHistory(); state.onChange_public();
    for (let i = 0; i < 100; i++) { image.setAttribute('x', String(i)); state.saveHistory(); }
    const historyChars = state.exportHistory().entries.reduce((n: number, e: any) => n + e.svgContent.length, 0);
    state.undo(); state.redo();
    const saved = await serializeDocumentSVGForSave(state);
    const text = saved.svg instanceof Blob ? await saved.svg.text() : saved.svg;
    const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
    const href = parsed.querySelector('image')!.getAttribute('href')!;
    const original = new Uint8Array(await blob.arrayBuffer());
    const exported = Uint8Array.from(atob(href.split(',')[1]), c => c.charCodeAt(0));
    const same = original.length === exported.length && original.every((n, i) => exported[i] === n);
    const session = (window as any).docs.serializeSession();
    await (await import('/src/core/session-store.ts')).saveSession(session);
    return { same, historyChars, compactChars: serializeDocumentSVG(state).length, count: a.assetStats().count,
      noPortableRefs: !text.includes('data-bq-raster') && !text.includes('blob:'), sessionChars: session.tabs[0].svg.length };
  });
  expect(result.same).toBe(true); expect(result.noPortableRefs).toBe(true);
  expect(result.historyChars).toBeLessThan(200000); expect(result.compactChars).toBeLessThan(20000);
  expect(result.sessionChars).toBeLessThan(20000); expect(result.count).toBe(1);
  await page.reload();
  await expect(page.locator('#drawing-layer image[data-bq-raster]')).toHaveAttribute('href', /^blob:/);
  const size = await page.evaluate(async () => {
    const a = await import('/src/core/raster-assets.ts');
    return a.assetSnapshot([document.getElementById('drawing-layer')!.innerHTML]).map(a => [a.width, a.height]);
  });
  expect(size).toEqual([[2400, 1600]]);
});

test('actual 49 full-resolution tiles keep editing state compact', async ({ page }, info) => {
  test.skip(!process.env.BQ_LINKED_IMAGE_SVG, 'Optional actual aerial stress test'); test.setTimeout(300000);
  const filename = process.env.BQ_LINKED_IMAGE_SVG!;
  await page.evaluate(async svg => {
    (await import('/src/ui/project-file.ts')).loadDocumentSVG((window as any).state, svg);
  }, await readFile(filename, 'utf8'));
  await page.getByRole('button', { name: 'Locate images…' }).click();
  const picker = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Choose folder…', exact: true }).click();
  await (await picker).setFiles(path.join(path.dirname(filename), 'full-20cm'));
  await page.locator('#linked-image-quality').selectOption('original');
  await page.getByRole('button', { name: 'Add 49 images', exact: true }).click();
  await expect(page.locator('.linked-images-banner')).toBeHidden({ timeout: 120000 });
  await expect(page.locator('#drawing-layer image[data-bq-raster]')).toHaveCount(49);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  const processMemory = async () => {
    if (process.platform !== 'win32') return null;
    const browserCdp = await page.context().browser()!.newBrowserCDPSession();
    const processes = await browserCdp.send('SystemInfo.getProcessInfo'); await browserCdp.detach();
    const ids = processes.processInfo.filter((p: any) => p.type === 'renderer').map((p: any) => Number(p.id)).filter(Number.isInteger);
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process -Id ${ids.join(',')} | Select-Object Id,PrivateMemorySize64,WorkingSet64 | ConvertTo-Json -Compress`], { encoding: 'utf8' }));
  };
  const before = await cdp.send('Runtime.getHeapUsage'); const nativeBefore = await processMemory();
  const result = await page.evaluate(async () => {
    const state = (window as any).state;
    for (let i = 0; i < 100; i++) {
      document.querySelector('#drawing-layer image')!.setAttribute('x', String(i)); state.saveHistory();
      if (i % 10 === 0) { state.onChange_public(); await new Promise(r => setTimeout(r, 10)); }
    }
    for (let i = 0; i < 25; i++) state.undo();
    for (let i = 0; i < 25; i++) state.redo();
    const session = (window as any).docs.serializeSession();
    await (await import('/src/core/session-store.ts')).saveSession(session);
    const a = await import('/src/core/raster-assets.ts');
    return { stats: a.assetStats(), historyChars: state.exportHistory().entries.reduce((n: number, e: any) => n + e.svgContent.length, 0),
      markupChars: document.getElementById('drawing-layer')!.innerHTML.length, sessionChars: session.tabs[0].svg.length };
  });
  await cdp.send('HeapProfiler.collectGarbage');
  const after = await cdp.send('Runtime.getHeapUsage'); const nativeAfter = await processMemory();
  await writeFile(info.outputPath('memory-evidence.json'), JSON.stringify({ before, after, nativeBefore, nativeAfter, ...result }, null, 2));
  await info.attach('memory-evidence', { body: JSON.stringify({ before, after, nativeBefore, nativeAfter, ...result }, null, 2), contentType: 'application/json' });
  expect(result.stats.count).toBe(49); expect(result.stats.originalBytes).toBeGreaterThan(500 * 1024 * 1024);
  expect(result.stats.previewPixelUpperBound * 4).toBeLessThan(90 * 1024 * 1024);
  expect(result.historyChars).toBeLessThan(5 * 1024 * 1024); expect(result.sessionChars).toBeLessThan(100000);
  expect(after.usedSize - before.usedSize).toBeLessThan(50 * 1024 * 1024);
  await page.screenshot({ path: info.outputPath('full-resolution-editing.png') });
  const roundTrip = await page.evaluate(async () => {
    const a = await import('/src/core/raster-assets.ts');
    const io = await import('/src/ui/project-file.ts'); const state = (window as any).state;
    const hashes = async (records: any[]) => {
      const out: string[] = [];
      for (const record of records) out.push([...new Uint8Array(await crypto.subtle.digest('SHA-256', await record.original.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join(''));
      return out;
    };
    const before = await hashes(a.assetSnapshot([io.serializeDocumentSVG(state)]));
    const { svg } = await io.serializeDocumentSVGForSave(state);
    if (!(svg instanceof Blob)) throw new Error('Expected chunked SVG Blob');
    const compact = await a.readAssetSvg(svg); io.loadDocumentSVG(state, compact); a.collectAssets();
    const after = await hashes(a.assetSnapshot([io.serializeDocumentSVG(state)]));
    return { bytes: svg.size, same: JSON.stringify(before) === JSON.stringify(after), count: a.assetStats().count };
  });
  expect(roundTrip.same).toBe(true); expect(roundTrip.count).toBe(49);
  expect(roundTrip.bytes).toBeGreaterThan(680 * 1024 * 1024);
  await writeFile(info.outputPath('round-trip-evidence.json'), JSON.stringify(roundTrip, null, 2));
});

test('streaming reopen preserves bytes and ignores image-looking comments', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const a = await import('/src/core/raster-assets.ts');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
    const ctx = canvas.getContext('2d')!; const pixels = ctx.createImageData(1024, 1024);
    for (let i = 0; i < pixels.data.length; i += 65536) crypto.getRandomValues(pixels.data.subarray(i, i + 65536));
    ctx.putImageData(pixels, 0, 0);
    const blob = await new Promise<Blob>(r => canvas.toBlob(b => r(b!), 'image/png'));
    const id = await a.prepareAsset(new File([blob], 'tile.png'));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><!-- <image href="not-real"/> --><image data-bq-raster="${id}" data-label="a&gt;b" width="10" height="10"/></svg>`;
    const saved = await a.portableSvg(svg); a.forgetAsset(id);
    const reopened = await a.readAssetSvg(saved);
    const doc = new DOMParser().parseFromString(reopened, 'image/svg+xml');
    const image = doc.querySelector('image')!;
    const asset = a.assetSnapshot([reopened])[0];
    const original = new Uint8Array(await blob.arrayBuffer()); const restored = new Uint8Array(await asset.original.arrayBuffer());
    return { same: original.length === restored.length && original.every((b, i) => b === restored[i]),
      label: image.getAttribute('data-label'), comment: reopened.includes('<!-- <image href="not-real"/> -->'), compact: reopened.length };
  });
  expect(result).toMatchObject({ same: true, label: 'a>b', comment: true }); expect(result.compact).toBeLessThan(1000);
});

test('crop/uncrop and internal copy keep the original asset identity', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const a = await import('/src/core/raster-assets.ts');
    const { uncropToImage } = await import('/src/tools/crop.ts');
    const state = (window as any).state;
    const c = document.createElement('canvas'); c.width = c.height = 100;
    const b = await new Promise<Blob>(r => c.toBlob(v => r(v!)));
    const id = await a.prepareAsset(new File([b], 'tile.png'));
    state.importSVGContent(`<svg xmlns="http://www.w3.org/2000/svg"><svg data-crop="" viewBox="0 0 50 50" width="50" height="50"><image data-bq-raster="${id}" width="100" height="100"/></svg></svg>`);
    const crop = document.querySelector('#drawing-layer svg[data-crop]') as SVGElement;
    const uncropped = uncropToImage(crop)!;
    state.selectShape(crop.id); state.copySelected(); state.pasteClipboard(true);
    a.collectAssets();
    return { uncropped: uncropped.getAttribute(a.ASSET_ATTR), expected: id, count: a.assetStats().count,
      images: document.querySelectorAll('#drawing-layer image[data-bq-raster]').length,
      bound: [...document.querySelectorAll('#drawing-layer image')].every(el => el.getAttribute('href')?.startsWith('blob:')) };
  });
  expect(result.uncropped).toBe(result.expected); expect(result.count).toBe(1); expect(result.images).toBe(2); expect(result.bound).toBe(true);
});

test('asset cleanup retains undo roots and frees discarded originals', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const a = await import('/src/core/raster-assets.ts'); const state = (window as any).state;
    const c = document.createElement('canvas'); const b = await new Promise<Blob>(r => c.toBlob(v => r(v!)));
    const id = await a.prepareAsset(new File([b], 'tile.png'));
    state.importSVGContent('<svg xmlns="http://www.w3.org/2000/svg"><image width="20" height="20"/></svg>');
    a.attachAsset(document.querySelector('#drawing-layer image')!, id); state.saveHistory();
    document.querySelector('#drawing-layer image')!.remove(); state.rebuildShapesFromDOM(); state.saveHistory(); a.collectAssets();
    const withUndo = a.assetStats().count; state.undo(); const restored = document.querySelector('#drawing-layer image')!.getAttribute('href');
    (await import('/src/ui/project-file.ts')).loadDocumentSVG(state, '<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>');
    a.collectAssets(); return { withUndo, restored, after: a.assetStats().count };
  });
  expect(result.withUndo).toBe(1); expect(result.restored).toMatch(/^blob:/); expect(result.after).toBe(0);
});

test('actual crop commit saves portable originals and can save again after reopen', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const a = await import('/src/core/raster-assets.ts'); const io = await import('/src/ui/project-file.ts');
    const { CropTool } = await import('/src/tools/crop.ts'); const state = (window as any).state;
    const c = document.createElement('canvas'); c.width = c.height = 100;
    const b = await new Promise<Blob>(r => c.toBlob(v => r(v!)));
    const id = await a.prepareAsset(new File([b], 'tile.png'));
    state.importSVGContent('<svg xmlns="http://www.w3.org/2000/svg"><image width="100" height="100"/></svg>');
    const image = document.querySelector('#drawing-layer image')!; a.attachAsset(image, id); state.selectShape(image.id);
    const tool = new CropTool(state, (window as any).docs.canvas, document.getElementById('svg-canvas') as unknown as SVGSVGElement);
    tool.activate(); (tool as any).crop = { x: 10, y: 10, w: 50, h: 50 }; tool.deactivate();
    const wrapperHasId = document.querySelector('#drawing-layer svg[data-crop]')!.hasAttribute(a.ASSET_ATTR);
    const saved = await io.serializeDocumentSVGForSave(state); const text = saved.svg instanceof Blob ? await saved.svg.text() : saved.svg;
    io.loadDocumentSVG(state, text); a.collectAssets();
    const again = await io.serializeDocumentSVGForSave(state); const second = again.svg instanceof Blob ? await again.svg.text() : again.svg;
    return { wrapperHasId, portable: !text.includes('data-bq-raster'), again: second.includes('data:image/png;base64,') };
  });
  expect(result).toEqual({ wrapperHasId: false, portable: true, again: true });
});

test('image-pattern edits retain originals and split previews render assets', async ({ page }) => {
  await page.evaluate(async () => {
    const a = await import('/src/core/raster-assets.ts'); const state = (window as any).state;
    const c = document.createElement('canvas'); c.width = c.height = 100; c.getContext('2d')!.fillRect(0, 0, 100, 100);
    const b = await new Promise<Blob>(r => c.toBlob(v => r(v!)));
    const id = await a.prepareAsset(new File([b], 'tile.png'));
    state.importSVGContent(`<svg xmlns="http://www.w3.org/2000/svg"><defs><pattern id="asset-pattern" width="100" height="100" patternUnits="userSpaceOnUse"><image data-bq-raster="${id}" width="100" height="100"/></pattern></defs><rect width="200" height="200" fill="url(#asset-pattern)"/></svg>`);
    const pat = state.getPatternById('asset-pattern'); state.updatePattern({ ...pat, rotation: 30, scale: 1.5 });
    const io = await import('/src/ui/project-file.ts'); const saved = await io.serializeDocumentSVGForSave(state);
    const text = saved.svg instanceof Blob ? await saved.svg.text() : saved.svg;
    const image = new DOMParser().parseFromString(text, 'image/svg+xml').querySelector('pattern image')!;
    if (!image.getAttribute('href')?.startsWith('data:image/png;base64,')) throw new Error('Original missing after pattern edit');
    (window as any).docs.enterSplit(); (window as any).docs.focusGroup(1);
  });
  await expect(page.locator('#split-preview img')).toBeVisible();
  await expect.poll(() => page.locator('#split-preview img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await page.evaluate(() => (window as any).docs.exitSplit());
  await expect(page.locator('#split-preview img')).toHaveCount(0);
});

test('large copies stay usable internally and explain the system clipboard limit', async ({ page }) => {
  await page.evaluate(async () => {
    const a = await import('/src/core/raster-assets.ts'); const state = (window as any).state;
    const c = document.createElement('canvas'); c.width = c.height = 1;
    const preview = await new Promise<Blob>(r => c.toBlob(v => r(v!)));
    const id = crypto.randomUUID();
    a.restoreAssets([{ id, original: new Blob([new Uint8Array(49 * 1024 * 1024)]), preview, width: 1, height: 1 }]);
    state.importSVGContent(`<svg xmlns="http://www.w3.org/2000/svg"><image data-bq-raster="${id}" width="100" height="100"/></svg>`);
    state.selectShape(document.querySelector('#drawing-layer image')!.id); state.copySelected(); state.pasteClipboard(true);
  });
  await expect(page.getByText('Copied within BuzzQuill. To transfer this large selection to another app, export it as SVG.')).toBeVisible();
  await expect(page.locator('#drawing-layer image[data-bq-raster]')).toHaveCount(2);
});
