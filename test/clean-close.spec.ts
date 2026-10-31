import { test, expect, type Page } from '@playwright/test';

/**
 * Closing a tab asks "Unsaved changes will be lost" only when closing really would
 * lose work. A document opened from a file the editor holds no writable handle for —
 * File ▸ Open without the File System Access API, or a dropped file — is that file
 * while it's clean, so closing it untouched must not warn. (It did: the close guard
 * counted only a handle or a cloud doc as a home, so every such document read as
 * homeless work.) The #178 protections stay: an edited document warns, and so does
 * untitled work whose only copy is the restored session.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyState = any;

const DOC = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300">
  <rect x="40" y="40" width="120" height="80" fill="#e33"/>
  <path d="M 200 60 C 260 20 340 80 300 160 Z" fill="none" stroke="#39f" stroke-width="3"/>
</svg>`;

/** Boot with no File System Access — the open falls back to a plain file input. */
async function boot(page: Page): Promise<{ errors: string[]; prompts: string[] }> {
  const errors: string[] = [];
  const prompts: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => {
    // Dirty work makes a reload ask "Leave site?" — leave, so the session restores.
    if (d.type() === 'beforeunload') { void d.accept(); return; }
    prompts.push(d.message());
    void d.dismiss();
  });
  await page.addInitScript(() => {
    for (const k of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
      delete (window as unknown as Record<string, unknown>)[k];
    }
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { docs?: unknown }).docs, { timeout: 15_000 });
  return { errors, prompts };
}

/** File ▸ Open through the real menu, answering the file input. */
async function openViaMenu(page: Page, name = 'track.svg'): Promise<void> {
  await page.getByText('File', { exact: true }).first().click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.menu-item, [role=menuitem]').filter({ hasText: /^Open/ }).first().click(),
  ]);
  await chooser.setFiles({ name, mimeType: 'image/svg+xml', buffer: Buffer.from(DOC) });
  await expect(page.locator('.doc-tab', { hasText: name })).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (window as unknown as { state: AnyState }).state.shapes.length)).toBeGreaterThan(0);
}

/** Close the active tab with its × button. */
const closeActive = (page: Page) => page.locator('.doc-tab.active .doc-tab-close, .doc-tab[aria-selected="true"] .doc-tab-close').first().click();

const tabTitles = (page: Page) =>
  page.evaluate(() => (window as unknown as { docs: AnyState }).docs.tabs.map((t: { title: string }) => t.title) as string[]);

/** Draw something with the real rectangle tool. */
async function drawRect(page: Page): Promise<void> {
  await page.locator('button[data-tool="rect"]').click();
  const c = (await page.locator('#svg-canvas').boundingBox())!;
  await page.mouse.move(c.x + c.width / 2 - 60, c.y + c.height / 2 - 40);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width / 2 + 60, c.y + c.height / 2 + 40, { steps: 5 });
  await page.mouse.up();
  await page.locator('button[data-tool="select"]').click();
}

test('a file opened without a handle closes untouched without a warning', async ({ page }) => {
  const { errors, prompts } = await boot(page);
  await openViaMenu(page);
  await closeActive(page);
  expect(prompts).toEqual([]);
  expect(await tabTitles(page)).not.toContain('track.svg');
  expect(errors).toEqual([]);
});

test('an edit warns; undoing back to the file stops warning', async ({ page }) => {
  const { errors, prompts } = await boot(page);
  await openViaMenu(page);
  await page.evaluate(() => {
    const s = (window as unknown as { state: AnyState }).state;
    s.selectMultiple([s.shapes.flatMap((x: AnyState) => [x, ...(x.children ?? [])]).find((x: AnyState) => x.type === 'rect').id]);
  });
  await page.keyboard.press('ArrowRight');
  await closeActive(page);
  expect(prompts).toHaveLength(1);                     // dismissed → the tab stays
  expect(await tabTitles(page)).toContain('track.svg');
  await page.keyboard.press('Control+z');
  await closeActive(page);
  expect(prompts).toHaveLength(1);                     // no second warning
  expect(await tabTitles(page)).not.toContain('track.svg');
  expect(errors).toEqual([]);
});

test('after a reload the restored file still closes without a warning', async ({ page }) => {
  const { errors, prompts } = await boot(page);
  await openViaMenu(page);
  await page.waitForTimeout(1500);                    // the session save is debounced
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { docs?: unknown }).docs);
  await expect(page.locator('.doc-tab', { hasText: 'track.svg' })).toHaveCount(1);
  await closeActive(page);
  expect(prompts).toEqual([]);
  expect(errors).toEqual([]);
});

test('untitled work restored from the session still warns (#178)', async ({ page }) => {
  const { errors, prompts } = await boot(page);
  await drawRect(page);
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { docs?: unknown }).docs);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { state: AnyState }).state.shapes.some((s: AnyState) => s.type !== 'frame' || (s.children?.length ?? 0) > 0))).toBe(true);
  await closeActive(page);
  expect(prompts).toEqual(['Close this document? Unsaved changes will be lost.']);
  expect(errors).toEqual([]);
});

test('untitled work saved as a download closes without a warning', async ({ page }) => {
  const { errors, prompts } = await boot(page);
  await drawRect(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
  expect(dl.suggestedFilename()).toMatch(/\.svg$/);
  await closeActive(page);
  expect(prompts).toEqual([]);
  expect(errors).toEqual([]);
});
