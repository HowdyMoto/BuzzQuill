import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).state);
});

test('wrapped embedded raster reaches a real preview instead of remaining a placeholder', async ({ page }) => {
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 700;
    const context = canvas.getContext('2d')!;
    const pixels = context.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      pixels.data[i] = Math.random() * 256; pixels.data[i + 1] = Math.random() * 256;
      pixels.data[i + 2] = Math.random() * 256; pixels.data[i + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const url = canvas.toDataURL(); canvas.width = canvas.height = 0;
    const [header, payload] = url.split(',');
    const wrapped = header + ',' + payload.match(/.{1,76}/g)!.join('\n');
    const { loadDocumentSVG } = await import('/src/ui/project-file.ts');
    loadDocumentSVG((window as any).state, `<svg xmlns="http://www.w3.org/2000/svg"><image width="1000" height="700" href="${wrapped}"/></svg>`);
  });
  await expect(page.locator('#drawing-layer image')).toHaveAttribute('data-bq-raster', /.+/);
  await expect.poll(() => page.evaluate(async () => {
    const { assetSnapshot } = await import('/src/core/raster-assets.ts');
    return assetSnapshot([document.getElementById('drawing-layer')!.innerHTML])[0]?.previewPending;
  })).toBe(false);
  const preview = await page.evaluate(async () => {
    const { assetSnapshot } = await import('/src/core/raster-assets.ts');
    const asset = assetSnapshot([document.getElementById('drawing-layer')!.innerHTML])[0];
    const bitmap = await createImageBitmap(asset.preview);
    const dimensions = [bitmap.width, bitmap.height]; bitmap.close();
    return { dimensions, original: [asset.width, asset.height], originalBytes: asset.original.size };
  });
  expect(preview.dimensions).toEqual([512, 358]);
  expect(preview.original).toEqual([1000, 700]);
  expect(preview.originalBytes).toBeGreaterThan(256 * 1024);
});

test('an import begun in an empty drawing cannot land in a newly selected document', async ({ page }) => {
  await page.evaluate(async () => {
    const state = (window as any).state;
    state.importSVGContent('<svg xmlns="http://www.w3.org/2000/svg"/>');
    document.getElementById('drawing-layer')!.replaceChildren();
    if (document.getElementById('drawing-layer')!.firstElementChild) throw new Error('Expected empty source drawing');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 600;
    const blob = await new Promise<Blob>(r => canvas.toBlob(b => r(b!)));
    const decode = window.createImageBitmap.bind(window);
    (window as any).createImageBitmap = async (...args: any[]) => {
      await new Promise(r => { (window as any).releaseRasterDecode = r; });
      return (decode as any)(...args);
    };
    const { importRasterBlob } = await import('/src/ui/import-image.ts');
    (window as any).pendingRasterImport = importRasterBlob(state, blob);
  });
  await page.waitForFunction(() => !!(window as any).releaseRasterDecode);
  const result = await page.evaluate(async () => {
    const state = (window as any).state, docs = (window as any).docs;
    docs.newTab(); const owner = docs.activeId;
    state.importSVGContent('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L40 40"/></svg>');
    (window as any).releaseRasterDecode(); await (window as any).pendingRasterImport;
    return { ownerUnchanged: docs.activeId === owner, images: document.querySelectorAll('#drawing-layer image').length,
      paths: document.querySelectorAll('#drawing-layer path').length };
  });
  expect(result).toEqual({ ownerUnchanged: true, images: 0, paths: 1 });
});

test('high-pixel WebP is managed even when compressed bytes are tiny', async ({ page }) => {
  const size = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = c.height = 4000;
    c.getContext('2d')!.fillRect(0, 0, c.width, c.height);
    const href = c.toDataURL('image/webp'); c.width = c.height = 0;
    if (!href.startsWith('data:image/webp;')) throw new Error('Browser does not encode WebP');
    if (href.length >= 256 * 1024) throw new Error('Fixture must fit below byte threshold');
    (await import('/src/ui/project-file.ts')).loadDocumentSVG((window as any).state,
      `<svg xmlns="http://www.w3.org/2000/svg"><image width="4000" height="4000" href="${href}"/></svg>`);
    return href.length;
  });
  expect(size).toBeLessThan(256 * 1024);
  await expect(page.locator('#drawing-layer image')).toHaveAttribute('data-bq-raster', /.+/);
  await expect.poll(() => page.evaluate(async () => {
    const { assetSnapshot } = await import('/src/core/raster-assets.ts');
    const asset = assetSnapshot([document.getElementById('drawing-layer')!.innerHTML])[0];
    return asset && !asset.previewPending ? [asset.width, asset.height] : [];
  })).toEqual([4000, 4000]);
});
