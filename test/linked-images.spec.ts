import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

async function openSvg(page: Page, svg: string) {
  await page.evaluate(async svg => {
    const { loadDocumentSVG } = await import('/src/ui/project-file.ts');
    loadDocumentSVG((window as any).state, svg);
  }, svg);
}
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><image width="200" height="200" href="tiles/tile.png"/></svg>';
test.beforeEach(async ({ page }) => { await page.goto('/'); await page.waitForFunction(() => !!(window as any).state); });
async function folder(page: Page, dir: string) {
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Choose.*folder/ }).click();
  await (await picker).setFiles(dir);
}
async function tile(page: Page, dir: string) {
  await mkdir(dir, { recursive: true });
  const data = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = c.height = 20;
    c.getContext('2d')!.fillRect(0, 0, 20, 20); return c.toDataURL().split(',')[1];
  });
  await writeFile(path.join(dir, 'tile.png'), Buffer.from(data, 'base64'));
}
test('locates local images, embeds on save, and undoes in one step', async ({ page }, info) => {
  let requests = 0; page.on('request', r => { if (r.url().includes('/tiles/')) requests++; });
  await openSvg(page, svg);
  await expect(page.locator('.linked-images-banner')).toContainText('1 linked image needs locating');
  await expect(page.locator('#drawing-layer image')).not.toHaveAttribute('href');
  const dir = info.outputPath('tiles'); await tile(page, dir);
  await page.getByRole('button', { name: 'Locate images…' }).click();
  await expect(page.getByRole('button', { name: 'Add images', exact: true })).toBeHidden();
  await folder(page, dir);
  await expect(page.getByRole('dialog')).toContainText('1 of 1 images found');
  await page.screenshot({ path: info.outputPath('locate-dialog.png') });
  await page.getByRole('button', { name: 'Add 1 image', exact: true }).click();
  await expect(page.locator('#drawing-layer image')).toHaveAttribute('href', /^(blob:|data:image\/png;base64,)/);
  await expect(page.locator('.linked-images-banner')).toBeHidden();
  const saved = await page.evaluate(async () => { const { svg } = await (await import('/src/ui/project-file.ts')).serializeDocumentSVGForSave((window as any).state); return svg instanceof Blob ? await svg.text() : svg; });
  await page.keyboard.press('Control+z');
  await expect(page.locator('.linked-images-banner')).toBeVisible();
  await openSvg(page, saved);
  await expect(page.locator('#drawing-layer image')).toHaveAttribute('href', /^(blob:|data:image\/png;base64,)/);
  expect(requests).toBe(0);
});
test('wrong folder and unreadable images keep recovery open', async ({ page }, info) => {
  await openSvg(page, svg); const dir = info.outputPath('wrong'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'other.txt'), 'wrong');
  await page.getByRole('button', { name: 'Locate images…' }).click(); await folder(page, dir);
  await expect(page.getByRole('dialog')).toContainText('No matching images');
  await writeFile(path.join(dir, 'tile.png'), 'not an image'); await folder(page, dir);
  await page.getByRole('button', { name: 'Add 1 image', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('could not be read as images');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#drawing-layer image')).not.toHaveAttribute('href');
});
test('matching respects paths and refuses ambiguous basenames', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { matchLinkedImages } = await import('/src/core/linked-images.ts');
    const files = ['root/a/tile.png', 'root/b/tile.png'].map(p => {
      const f = new File([''], 'tile.png'); Object.defineProperty(f, 'webkitRelativePath', { value: p }); return f;
    });
    return matchLinkedImages(['a/tile.png', 'missing/tile.png', 'file:///D:/root/b/tile.png'].map(reference => ({ reference, element: document.body })), files)
      .map(m => ({ path: m.file?.webkitRelativePath, ambiguous: m.ambiguous }));
  });
  expect(result).toEqual([{ path: 'root/a/tile.png', ambiguous: false }, { path: undefined, ambiguous: true }, { path: 'root/b/tile.png', ambiguous: false }]);
});
test('cancelling an in-flight decode never changes the document', async ({ page }, info) => {
  await openSvg(page, svg); const dir = info.outputPath('tiles'); await tile(page, dir);
  await page.getByRole('button', { name: 'Locate images…' }).click(); await folder(page, dir);
  await page.evaluate(() => {
    const decode = window.createImageBitmap.bind(window);
    (window as any).createImageBitmap = async (file: Blob) => { await new Promise(r => { (window as any).releaseDecode = r; }); return decode(file); };
  });
  await page.getByRole('button', { name: 'Add 1 image', exact: true }).click();
  await page.waitForFunction(() => !!(window as any).releaseDecode);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => (window as any).releaseDecode());
  await expect(page.locator('.linked-images-banner')).toBeVisible();
  await expect(page.locator('#drawing-layer image')).not.toHaveAttribute('href');
});
test('actual aerial tiles recover at lighter quality', async ({ page }, info) => {
  test.skip(!process.env.BQ_LINKED_IMAGE_SVG, 'Optional local large-file verification');
  const filename = process.env.BQ_LINKED_IMAGE_SVG!;
  await openSvg(page, await readFile(filename, 'utf8'));
  await page.getByRole('button', { name: 'Locate images…' }).click();
  await folder(page, path.join(path.dirname(filename), 'full-20cm'));
  await expect(page.getByRole('dialog')).toContainText('49 of 49 images found');
  await expect(page.locator('#linked-image-quality')).toHaveValue('lighter');
  await page.screenshot({ path: info.outputPath('aerial-preflight.png') });
  await page.getByRole('button', { name: 'Add 49 images', exact: true }).click();
  await expect(page.locator('.linked-images-banner')).toBeHidden({ timeout: 90000 });
  await expect(page.locator('#drawing-layer image[href^="data:"]')).toHaveCount(49);
  await page.screenshot({ path: info.outputPath('aerial-recovered.png') });
});

test('partial matches retain unresolved references through save and reopen', async ({ page }, info) => {
  await openSvg(page, svg.replace('</svg>', '<image x="20" width="30" height="30" href="tiles/missing.png"/></svg>'));
  const dir = info.outputPath('tiles'); await tile(page, dir);
  await page.getByRole('button', { name: 'Locate images…' }).click(); await folder(page, dir);
  await expect(page.getByRole('dialog')).toContainText('1 of 2 images found');
  await expect(page.getByText('1 still missing', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add 1 image', exact: true }).click();
  await expect(page.locator('.linked-images-banner')).toContainText('1 linked image needs locating');
  const saved = await page.evaluate(async () => { const { svg } = await (await import('/src/ui/project-file.ts')).serializeDocumentSVGForSave((window as any).state); return svg instanceof Blob ? await svg.text() : svg; });
  await openSvg(page, saved);
  await expect(page.locator('#drawing-layer image[data-bq-image-href]')).toHaveCount(1);
  await expect(page.locator('#drawing-layer image[href^="data:"]')).toHaveCount(1);
});

test('switching documents during decoding never writes to another tab', async ({ page }, info) => {
  await openSvg(page, svg); const dir = info.outputPath('tiles'); await tile(page, dir);
  await page.getByRole('button', { name: 'Locate images…' }).click(); await folder(page, dir);
  await page.evaluate(() => {
    const decode = window.createImageBitmap.bind(window);
    (window as any).createImageBitmap = async (file: Blob) => { await new Promise(r => { (window as any).releaseDecode = r; }); return decode(file); };
  });
  await page.getByRole('button', { name: 'Add 1 image', exact: true }).click();
  await page.waitForFunction(() => !!(window as any).releaseDecode);
  await page.evaluate(() => { (window as any).docs.newTab(); (window as any).releaseDecode(); });
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('#drawing-layer image')).toHaveCount(0);
});
