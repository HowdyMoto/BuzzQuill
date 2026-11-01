import { test, expect } from '@playwright/test';

/**
 * Pasting external clipboard content onto the canvas: a raster image is embedded
 * as an <image>; vector SVG copied from another app becomes editable shapes.
 * Tests the pure router (pasteFromDataTransfer) with a constructed DataTransfer —
 * synthetic ClipboardEvents can't reliably carry clipboardData in Chromium.
 */

// 1×1 transparent PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });
});

test('pasting a raster image embeds it as an <image> and selects it', async ({ page }) => {
  const r = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));

    const m = await import('/src/ui/paste.ts');
    const state = (window as unknown as { state: any }).state;
    const handled = m.pasteFromDataTransfer(state, dt);

    // Embedding is async (FileReader + Image decode) — poll for the <image>.
    let img: SVGImageElement | null = null;
    for (let i = 0; i < 60 && !img; i++) {
      img = document.querySelector('#svg-canvas image');
      if (!img) await new Promise(res => setTimeout(res, 50));
    }
    const href = img?.getAttribute('href') || img?.getAttribute('xlink:href') || '';
    return { handled, hasImage: !!img, dataHref: href.startsWith('data:image/'), selected: state.selectedShapeIds.length };
  }, PNG_B64);

  expect(r.handled, 'router consumed the paste').toBe(true);
  expect(r.hasImage, 'an <image> was embedded').toBe(true);
  expect(r.dataHref, 'image carries a data: URL').toBe(true);
  expect(r.selected, 'pasted image is selected').toBeGreaterThan(0);
});

test('a raster pasted while editing points can be dragged immediately', async ({ page }) => {
  await page.evaluate(() => {
    const s = (window as any).state;
    s.pasteSvgMarkup('<svg xmlns="http://www.w3.org/2000/svg"><path d="M 20 20 L 100 20 L 100 100 Z"/></svg>');
  });
  await page.keyboard.press('a');
  await expect(page.locator('[data-node-anchor]')).not.toHaveCount(0);
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 120;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#2385c7'; ctx.fillRect(0, 0, 120, 120);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!)));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'pasted.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const img = page.locator('#drawing-layer image');
  await expect(img).toHaveCount(1);
  const before = (await img.boundingBox())!;
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 40, before.y + before.height / 2 + 30, { steps: 5 });
  await page.mouse.up();
  const after = (await img.boundingBox())!;
  expect(after.x - before.x).toBeGreaterThan(25);
  expect(after.y - before.y).toBeGreaterThan(15);
  await expect(page.locator('[data-node-anchor]')).toHaveCount(0);
});

test('pasting plain text drops an editable multi-line <text> element', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'Hello world\nsecond line');
    const m = await import('/src/ui/paste.ts');
    const state = (window as unknown as { state: any }).state;
    const handled = m.pasteFromDataTransfer(state, dt);
    const text = document.querySelector('#drawing-layer text');
    const tspans = text?.querySelectorAll('tspan').length ?? 0;
    return { handled, hasText: !!text, content: text?.textContent ?? '', tspans, selected: state.selectedShapeIds.length };
  });
  expect(r.handled).toBe(true);
  expect(r.hasText, 'a <text> element was created').toBe(true);
  expect(r.content).toContain('Hello world');
  expect(r.content).toContain('second line');
  expect(r.tspans, 'two lines → two tspans').toBe(2);
  expect(r.selected, 'pasted text is selected').toBeGreaterThan(0);
});

test('pasting external SVG becomes editable shapes', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="40" height="40" fill="#39c"/></svg>');
    const m = await import('/src/ui/paste.ts');
    const state = (window as unknown as { state: any }).state;
    const before = document.querySelectorAll('#drawing-layer rect').length;
    const handled = m.pasteFromDataTransfer(state, dt);
    const after = document.querySelectorAll('#drawing-layer rect').length;
    return { handled, added: after - before };
  });
  expect(r.handled).toBe(true);
  expect(r.added, 'a rect shape was added from the pasted SVG').toBeGreaterThan(0);
});
