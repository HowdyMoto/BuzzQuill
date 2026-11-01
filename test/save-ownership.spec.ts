import { test, expect } from '@playwright/test';

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`split tabs show save completion with motion preference ${reducedMotion}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto('/');
    await page.waitForFunction(() => !!(window as any).docs);
    const id = await page.evaluate(async () => {
      const w = window as any;
      w.state.pasteSvgMarkup('<svg xmlns="http://www.w3.org/2000/svg"><rect width="80" height="80"/></svg>');
      w.docs.renameTab(w.docs.activeId, 'Brand exploration.svg');
      const id = w.docs.activeId;
      w.docs.newTab();
      w.docs.moveTabToGroup(id, 1, null, true);
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => ({
        name: 'Brand exploration.svg', kind: 'file',
        createWritable: async () => ({ write: async () => new Promise<void>(r => { w.releaseSave = r; }), close: async () => {} }),
      }) });
      const { saveProjectAs } = await import('/src/ui/project-file.ts');
      w.pendingSave = saveProjectAs(w.state);
      return id;
    });
    await page.waitForFunction(() => !!(window as any).releaseSave);
    const tab = page.locator(`.doc-tab[data-tab-id="${id}"]`);
    await expect(tab).toHaveClass(/save-pending/);
    await expect(tab.locator('.doc-tab-dirty')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('saving.png') });
    await page.evaluate(async () => { (window as any).releaseSave(); await (window as any).pendingSave; });
    await expect(tab).toHaveClass(/save-complete/);
    await expect(tab.locator('.doc-tab-dirty')).toHaveCount(0);
    const animation = await tab.locator('.doc-tab-badge').evaluate(el => getComputedStyle(el).animationName);
    expect(animation).toBe(reducedMotion === 'reduce' ? 'none' : 'tab-save-celebrate');
    await page.screenshot({ path: testInfo.outputPath('saved.png') });
    await expect(tab).not.toHaveClass(/save-complete/);
    await expect(tab.locator('.doc-tab-badge')).toHaveCount(1);
  });
}

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
  await expect(page.locator('.doc-tab.active .doc-tab-saving')).toHaveText('Saving…');
  const fillScale = () => page.locator('.doc-tab.active .doc-tab-save-fill').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a);
  const firstScale = await fillScale();
  await expect.poll(fillScale).toBeGreaterThan(firstScale + 0.02);
  const progressed = await fillScale();
  await page.evaluate(() => (window as any).state.onChange_public());
  expect(await fillScale()).toBeGreaterThanOrEqual(progressed);
  expect(await fillScale()).toBeLessThan(1);
  await page.locator('.menu-trigger', { hasText: 'File' }).click();
  await page.locator('[data-action="file.new"]').click();
  await expect(page.locator('.doc-tab').first()).toHaveClass(/save-pending/);
  await expect(page.locator('.doc-tab.active .doc-tab-saving')).toHaveCount(0);
  const before = await page.evaluate(() => ({ name: document.title, source: (window as any).docs.activeSource }));
  await page.evaluate(() => (window as any).releaseSave());
  await expect(page.locator('.doc-tab').first()).toHaveClass(/save-complete/);
  await expect(page.locator('.doc-tab.active')).not.toHaveClass(/save-complete/);
  await expect(page.locator('.doc-tab').first().locator('.doc-tab-dirty')).toHaveCount(0);
  await expect(page.locator('.toast.success')).toHaveCount(0);
  expect(await page.evaluate(() => ({ name: document.title, source: (window as any).docs.activeSource }))).toEqual(before);
  await page.locator('.doc-tab').first().click();
  await expect(page.locator('.doc-tab.active .doc-tab-name')).toHaveText('Saved-A.svg');
  expect(await page.evaluate(() => (window as any).docs.activeSource.kind)).toBe('local');
  expect(await page.evaluate(() => (window as any).state.dirty)).toBe(false);
});

for (const outcome of ['cancel', 'error'] as const) {
  test(`${outcome} does not celebrate or clear the dirty dot`, async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!(window as any).docs);
    page.on('dialog', dialog => dialog.accept());
    await page.evaluate(outcome => {
      const w = window as any;
      w.state.pasteSvgMarkup('<svg xmlns="http://www.w3.org/2000/svg"><rect width="30" height="30"/></svg>');
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => {
        if (outcome === 'cancel') throw new DOMException('Canceled', 'AbortError');
        return { name: 'Failed.svg', createWritable: async () => { throw new Error('Disk unavailable'); } };
      } });
    }, outcome);
    await page.evaluate(async () => {
      const { saveProjectAs } = await import('/src/ui/project-file.ts');
      await saveProjectAs((window as any).state);
    });
    await expect(page.locator('.doc-tab.active .doc-tab-dirty')).toHaveCount(1);
    await expect(page.locator('.doc-tab-save-fill')).toHaveCount(0);
    await expect(page.locator('.doc-tab.save-complete')).toHaveCount(0);
  });
}

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
    await expect.poll(() => page.evaluate(() => (window as any).docs.tabs.some((t: any) => (window as any).docs.isSaving(t.id)))).toBe(false);
    await expect(page.locator('.toast.success')).toHaveCount(0);
    if (action === 'close') {
      expect(await page.evaluate(() => ({ id: (window as any).docs.activeId, title: document.title }))).toEqual(before);
      expect(await page.evaluate(() => (window as any).docs.activeSource)).toBeNull();
      await expect(page.locator('.doc-tab.save-complete')).toHaveCount(0);
    } else {
      expect(await page.evaluate(() => (window as any).state.dirty)).toBe(true);
      await expect(page.locator('.doc-tab.active .doc-tab-dirty')).toHaveCount(1);
      await expect(page.locator('.doc-tab.active')).toHaveClass(/save-complete/);
    }
  });
}
