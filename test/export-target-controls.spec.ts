import { test, expect, type Page } from '@playwright/test';

async function setup(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).docs);
  await page.evaluate(() => {
    const s = (window as any).state, fid = s.artboards[0].id;
    s.setFrameExportTargets(fid, [
      { format: 'svg', name: 'bahrain-gp-layout-main', scale: 1 },
      { format: 'png', name: 'bahrain-gp-layout-backup', scale: 2 },
    ], true);
    s.selectShape(fid);
  });
}

test('rename commits without swallowing the next disclosure or format click', async ({ page }) => {
  await setup(page);
  const target = page.locator('.fp-target-wrap').first();
  const name = target.getByRole('textbox', { name: 'Export file name' });
  await target.getByRole('button', { name: 'Export options', exact: true }).click();
  await name.fill('renamed-track');
  await target.getByRole('button', { name: 'Export options', exact: true }).click();
  await expect(target).not.toHaveClass(/open/);
  await name.fill('final-track');
  await target.locator('.fp-target-fmt').click();
  await page.locator('.context-menu-item').filter({ hasText: /^PNG$/ }).click();
  await expect(target.locator('.fp-target-fmt')).toHaveText('PNG');
  expect(await page.evaluate(() => {
    const s = (window as any).state; return s.getFrameExportTargets(s.artboards[0].id)[0].name;
  })).toBe('final-track');
  await page.keyboard.press('Control+z');
  await expect(target.locator('.fp-target-fmt')).toHaveText('SVG');
  await expect(name).toHaveValue('final-track');
  await page.keyboard.press('Control+z');
  await expect(name).toHaveValue('renamed-track');
});

test('filename line has room independently of format and size and never overflows', async ({ page }, testInfo) => {
  await setup(page);
  for (const width of [1100, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const metrics = await page.locator('.fp-target').evaluateAll(rows => rows.map(row => {
      const name = row.querySelector<HTMLInputElement>('.fp-target-name')!;
      const format = row.querySelector('.fp-target-fmt')!.getBoundingClientRect();
      const box = name.getBoundingClientRect();
      return { width: box.width, separate: box.bottom <= format.top, overflow: row.scrollWidth > row.clientWidth,
        ellipsis: getComputedStyle(name).textOverflow };
    }));
    for (const m of metrics) {
      expect(m.width).toBeGreaterThan(150);
      expect(m.separate).toBe(true);
      expect(m.overflow).toBe(false);
      expect(m.ellipsis).toBe('ellipsis');
    }
  }
  await page.locator('#fp-export-list').screenshot({ path: testInfo.outputPath('filenames.png') });
});


test('fit switch and size controls keep the output dimensions accurate', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const s = (window as any).state, frame = document.getElementById(s.artboards[0].id)!;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.id = s.nextId(); path.setAttribute('d', 'M 20 20 h 200 v 100 h -200 Z');
    frame.append(path); s.rebuildShapesFromDOM(); s.onChange_public();
  });
  const target = page.locator('.fp-target-wrap').first();
  await target.getByRole('button', { name: 'Export options', exact: true }).click();
  const fit = target.getByRole('switch', { name: 'Fit to paths', exact: true });
  await expect(fit).not.toBeChecked();
  await fit.click();
  await expect(fit).toBeChecked();
  await expect(target.locator('.fp-opt-caption')).toHaveText('Output 200×100 px');
  await target.getByRole('spinbutton', { name: 'Scale', exact: true }).fill('2');
  await expect(target.locator('.fp-opt-caption')).toHaveText('Output 400×200 px');
  await target.getByRole('button', { name: 'Dimensions', exact: true }).click();
  await expect(target.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveValue('400');
  await expect(target.getByRole('spinbutton', { name: 'Height', exact: true })).toHaveAttribute('placeholder', '200');
  await target.getByRole('combobox', { name: 'Text', exact: true }).selectOption('outline');
  await target.getByRole('switch', { name: 'Transparent background', exact: true }).click();
  await expect(target.getByRole('button', { name: 'Background color', exact: true })).toBeVisible();
  expect(await page.evaluate(() => {
    const s = (window as any).state; return s.getFrameExportTargets(s.artboards[0].id)[0];
  })).toMatchObject({ bounds: 'paths', width: 400, textMode: 'outline', background: '#FFFFFF' });
});

test('expanded export options fit the sidebar for every format', async ({ page }, testInfo) => {
  await setup(page);
  await page.setViewportSize({ width: 1100, height: 1000 });
  const target = page.locator('.fp-target-wrap').first();
  await target.getByRole('button', { name: 'Export options', exact: true }).click();
  for (const format of ['SVG', 'PNG', 'JPG', 'BMP', 'GIF', 'TIFF']) {
    await target.locator('.fp-target-fmt').click();
    await page.locator('.context-menu-item').filter({ hasText: new RegExp(`^${format}$`) }).click();
    await expect(target.getByRole('switch', { name: 'Fit to paths', exact: true })).toBeVisible();
    expect(await target.evaluate(el => [el, ...el.querySelectorAll('.fp-opt-row')].filter(row => row.scrollWidth > row.clientWidth).map(row => ({ text: row.textContent, width: row.clientWidth, scroll: row.scrollWidth })))).toEqual([]);
    if (['SVG', 'PNG', 'JPG'].includes(format)) {
      await target.screenshot({ path: testInfo.outputPath(`export-${format}.png`) });
    }
  }
});
