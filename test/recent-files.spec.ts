import { test as base, expect, type Page } from '@playwright/test';

const test = base.extend({
  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await use(page);
    expect(errors).toEqual([]);
  },
});

// Real, structured-cloneable handles exercise IndexedDB's transaction lifetime.
// Only the native picker is substituted; documents still open through File → Open.
async function pickFile(page: Page, name: string, contents: string): Promise<void> {
  await page.evaluate(async ({ name, contents }) => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(name, { create: true });
    const writer = await handle.createWritable();
    await writer.write(contents);
    await writer.close();
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: async () => [handle],
    });
  }, { name, contents });
  await page.getByRole('menuitem', { name: 'File', exact: true }).click();
  await page.locator('[data-action="file.open"]').click();
}

async function openFile(page: Page, name: string): Promise<void> {
  await pickFile(page, name, '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="20" height="20"/></svg>');
  await expect(page.locator('#recent-files-list button').first()).toHaveText(name);
}

test('Open Recent updates beyond eight files, reorders reopened files, and survives reload', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { docs?: unknown }).docs);
  await expect(page.locator('#recent-files-trigger')).toHaveAttribute('aria-disabled', 'true');

  for (let i = 1; i <= 10; i++) await openFile(page, `recent-${i}.svg`);
  const expected = Array.from({ length: 8 }, (_, i) => `recent-${10 - i}.svg`);
  await expect(page.locator('#recent-files-list button')).toHaveText(expected);
  await expect(page.locator('#recent-files-trigger')).not.toHaveAttribute('aria-disabled');

  // Reopen from the actual submenu, preserving the current document in its tab.
  const tabsBefore = await page.locator('#tab-list .doc-tab').count();
  await page.getByRole('menuitem', { name: 'File', exact: true }).click();
  await page.locator('#recent-files-trigger').hover();
  await page.locator('#recent-files-list button', { hasText: 'recent-5.svg' }).click();
  const reordered = ['recent-5.svg', ...expected.filter(name => name !== 'recent-5.svg')];
  await expect(page.locator('#recent-files-list button')).toHaveText(reordered);
  await expect(page.locator('#tab-list .doc-tab')).toHaveCount(tabsBefore + 1);

  await page.reload();
  await expect(page.locator('#recent-files-list button')).toHaveText(reordered);
  // Opening another file after restoring a full history must still refresh it.
  await openFile(page, 'recent-11.svg');
  await expect(page.locator('#recent-files-list button')).toHaveText(['recent-11.svg', ...reordered.slice(0, 7)]);
});

// A real one-page PDF with a filled rectangle; no fonts or external assets.
function rectanglePdf(): string {
  const drawing = '0 0 1 rg 10 10 60 40 re f\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${drawing.length} >>\nstream\n${drawing}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += 'xref\n0 5\n0000000000 65535 f \n';
  pdf += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return pdf + `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

test('a handle that cannot be persisted leaves history intact without an uncaught error', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { docs?: unknown }).docs);
  await openFile(page, 'kept.svg');
  await page.evaluate(async () => {
    const modulePath = '/src/ui/recent-files.ts';
    const { rememberRecentFile } = await import(/* @vite-ignore */ modulePath);
    await rememberRecentFile({ name: 'uncloneable.svg', getFile: () => null });
  });
  await page.reload();
  await expect(page.locator('#recent-files-list button')).toHaveText(['kept.svg']);
});

test('PDF imports enter recent history only after confirmation and reorder when reopened', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { docs?: unknown }).docs);
  await pickFile(page, 'recent.pdf', rectanglePdf());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#recent-files-trigger')).toHaveAttribute('aria-disabled', 'true');

  await pickFile(page, 'recent.pdf', rectanglePdf());
  await page.getByRole('button', { name: 'Flattened image' }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.locator('#drawing-layer image')).toHaveCount(1);
  await expect(page.locator('#recent-files-list button')).toHaveText(['recent.pdf']);
  await openFile(page, 'after-pdf.svg');

  await page.getByRole('menuitem', { name: 'File', exact: true }).click();
  await page.locator('#recent-files-trigger').hover();
  await page.getByRole('menuitem', { name: 'recent.pdf', exact: true }).click();
  await page.getByRole('button', { name: 'Flattened image' }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.locator('#drawing-layer image')).toHaveCount(1);
  await expect(page.locator('#recent-files-list button')).toHaveText(['recent.pdf', 'after-pdf.svg']);
  await expect(page.locator('#tab-list .doc-tab')).toHaveCount(3);
});
