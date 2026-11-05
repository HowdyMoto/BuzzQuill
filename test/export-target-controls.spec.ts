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
