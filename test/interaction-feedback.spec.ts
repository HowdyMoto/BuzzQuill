import { test, expect } from '@playwright/test';

for (const reduced of [false, true]) {
  test(`surfaces preserve focus and dismiss immediately (${reduced ? 'reduced' : 'full'} motion)`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await page.goto('/');
    await page.waitForFunction(() => !!(window as any).docs);
    await page.locator('.menu-trigger', { hasText: 'Help' }).click();
    await page.locator('[data-action="app.about"]').click();
    const dialog = page.locator('#about-overlay .modal-dialog');
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(el => getComputedStyle(el).animationName)).toBe(reduced ? 'none' : 'fx-surface-in');
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press('Control+k');
    await expect(page.locator('.cmdk-input')).toBeFocused();
    expect(await page.locator('.cmdk-panel').evaluate(el => getComputedStyle(el).animationName)).toBe(reduced ? 'none' : 'fx-surface-in');
    await page.keyboard.press('Escape');
    await expect(page.locator('.cmdk-overlay')).toBeHidden();
  });
}

test('actionable toast pauses while keyboard focus is inside it', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).docs);
  await page.evaluate(async () => {
    const { showToast } = await import('/src/ui/toast.ts');
    showToast('Saved a test copy', 500, { label: 'Open copy', onClick: () => { (window as any).openedCopy = true; } }, 'success');
  });
  const action = page.locator('.toast-action');
  await action.focus();
  await page.waitForTimeout(850); // beyond expiry: focus must hold the action
  await expect(action).toBeVisible();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (window as any).openedCopy)).toBe(true);
  await expect(page.locator('.toast')).toHaveCount(0);
});

test('reduced motion keeps loading visible and effects clean up after repeated activation', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).docs);
  await page.evaluate(async () => {
    const { pulse } = await import('/src/ui/feedback.ts');
    const button = document.getElementById('tab-new')!;
    for (let i = 0; i < 8; i++) pulse(button);
  });
  await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  await expect(page.locator('#tab-new')).toHaveClass(/fx-pulse/);
  await expect(page.locator('#tab-new')).not.toHaveClass(/fx-pulse/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const result = await page.evaluate(async () => {
    const { pulse } = await import('/src/ui/feedback.ts');
    const { showLoadingOverlay } = await import('/src/ui/loading-overlay.ts');
    pulse(document.getElementById('tab-new')!);
    showLoadingOverlay('Opening artwork…');
    const bar = document.querySelector('.loading-bar')!;
    const style = getComputedStyle(bar);
    return { pulse: document.getElementById('tab-new')!.classList.contains('fx-pulse'), animation: style.animationName, transform: style.transform,
      barWidth: bar.getBoundingClientRect().width, trackWidth: bar.parentElement!.getBoundingClientRect().width };
  });
  expect(result.pulse).toBe(false);
  expect(result.animation).toBe('none');
  expect(result.transform).toBe('none');
  expect(result.barWidth).toBe(result.trackWidth);
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-label', 'Opening artwork…');
});

test('export celebration preserves button child listeners and existing width', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).docs);
  await page.evaluate(async () => {
    const { playExportSuccess } = await import('/src/ui/feedback.ts');
    const button = document.createElement('button'); button.id = 'export-probe'; button.style.minWidth = '120px';
    const label = document.createElement('span'); label.textContent = 'Export';
    label.addEventListener('click', () => { (window as any).exportListener = true; });
    button.append(label); document.body.append(button); playExportSuccess(button);
  });
  await expect(page.locator('#export-probe')).toHaveAttribute('aria-label', 'Exported');
  await expect(page.locator('#export-probe')).not.toHaveClass(/fx-export-done/);
  await page.locator('#export-probe span').click();
  expect(await page.evaluate(() => (window as any).exportListener)).toBe(true);
  expect(await page.locator('#export-probe').evaluate(el => el.style.minWidth)).toBe('120px');
});

test('toolbar press and keyboard activation keep the pointer target stationary', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).docs);
  const tool = page.locator('.tool-btn[data-tool="rect"]');
  const before = (await tool.boundingBox())!;
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  expect(await tool.boundingBox()).toEqual(before);
  await page.mouse.up();
  await expect(tool).toHaveClass(/active/);
  await page.keyboard.press('v');
  await expect(page.locator('.tool-btn[data-tool="select"]')).toHaveClass(/active/);
  await page.keyboard.press('r');
  await expect(tool).toHaveClass(/active/);
  expect(await tool.boundingBox()).toEqual(before);
});
