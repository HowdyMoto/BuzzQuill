import { test, expect } from '@playwright/test';

test('local Save As completion changes only its initiating tab', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).docs);
  await page.evaluate(() => {
    const w = window as any;
    w.state.importSVGContent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="10" height="10" fill="red"/></svg>');
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => ({
      name: 'Saved-A.svg', kind: 'file',
      createWritable: async () => ({
        write: async (data: string) => { w.savedContent = data; await new Promise<void>(r => { w.releaseSave = r; }); },
        close: async () => {},
      }),
    }) });
  });
  await page.locator('.menu-trigger', { hasText: 'File' }).click();
  await page.locator('[data-action="file.save-as"]').click();
  await page.waitForFunction(() => !!(window as any).releaseSave);
  await page.locator('.menu-trigger', { hasText: 'File' }).click();
  await page.locator('[data-action="file.new"]').click();
  const before = await page.evaluate(() => ({ name: document.title, source: (window as any).docs.activeSource }));
  await page.evaluate(() => (window as any).releaseSave());
  await expect(page.locator('.toast.success', { hasText: 'Saved-A.svg' })).toBeVisible();
  expect(await page.evaluate(() => ({ name: document.title, source: (window as any).docs.activeSource }))).toEqual(before);
  await page.locator('.doc-tab').first().click();
  await expect(page.locator('.doc-tab.active .doc-tab-name')).toHaveText('Saved-A.svg');
  expect(await page.evaluate(() => (window as any).docs.activeSource.kind)).toBe('local');
  expect(await page.evaluate(() => (window as any).state.dirty)).toBe(false);
});

for (const action of ['edit', 'close'] as const) {
  test(`local save completion preserves ${action === 'edit' ? 'newer edits' : 'a replacement tab'}`, async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!(window as any).docs);
    await page.evaluate(() => {
      const w = window as any;
      w.state.importSVGContent('<svg xmlns="http://www.w3.org/2000/svg"><rect id="shape-1" width="10" height="10"/></svg>');
      w.state.saveHistory();
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => ({
        name: 'Delayed.svg', kind: 'file',
        createWritable: async () => ({
          write: async () => new Promise<void>(r => { w.releaseSave = r; }),
          close: async () => {},
        }),
      }) });
    });
    await page.locator('.menu-trigger', { hasText: 'File' }).click();
    await page.locator('[data-action="file.save-as"]').click();
    await page.waitForFunction(() => !!(window as any).releaseSave);
    await page.evaluate(action => {
      const w = window as any;
      if (action === 'close') w.docs.closeTab(w.docs.activeId);
      else { w.state.selectShape('shape-1'); w.state.setSelectionOpacity(0.4, true); }
    }, action);
    const before = await page.evaluate(() => ({ id: (window as any).docs.activeId, title: document.title }));
    await page.evaluate(() => (window as any).releaseSave());
    await expect(page.locator('.toast.success', { hasText: 'Delayed.svg' })).toBeVisible();
    if (action === 'close') {
      expect(await page.evaluate(() => ({ id: (window as any).docs.activeId, title: document.title }))).toEqual(before);
      expect(await page.evaluate(() => (window as any).docs.activeSource)).toBeNull();
    } else expect(await page.evaluate(() => (window as any).state.dirty)).toBe(true);
  });
}
