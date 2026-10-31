import { test, expect } from '@playwright/test';

/**
 * Behaviour test for the shared Modal primitive (ui/modal.ts), exercised through
 * the real About dialog (Help → About). Pins the lifecycle every dialog now
 * inherits: opens, Escape closes, backdrop-click closes, the ✕ closes, and the
 * singleton guard prevents stacking.
 */

async function openAbout(page: import('@playwright/test').Page) {
  await page.locator('.menu-trigger', { hasText: 'Help' }).click();
  await page.locator('.menu-panel button[data-action="app.about"]').click();
  await expect(page.locator('#about-overlay')).toBeVisible();
}

test('Modal: About dialog opens with proper a11y structure', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });

  await openAbout(page);
  const dialog = page.locator('#about-overlay .modal-dialog');
  await expect(dialog).toHaveAttribute('role', 'dialog');
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog).toHaveClass(/about-dialog/);            // content class applied
  await expect(page.locator('#about-overlay .modal-close')).toBeVisible();
  await expect(dialog.locator('.about-version')).toContainText(/Version \d{4}\.\d{2}\.\d{2}\.\d{9}-dev/);
  expect(pageErrors).toEqual([]);
});

test('Modal: Escape closes', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });
  await openAbout(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#about-overlay')).toHaveCount(0);
});

test('Modal: backdrop click closes, dialog click does not', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });
  await openAbout(page);

  // Click inside the dialog — must NOT close.
  await page.locator('#about-overlay .modal-dialog').click({ position: { x: 10, y: 60 } });
  await expect(page.locator('#about-overlay')).toBeVisible();

  // Click the backdrop (top-left corner, outside the centered dialog) — closes.
  await page.locator('#about-overlay').click({ position: { x: 4, y: 4 } });
  await expect(page.locator('#about-overlay')).toHaveCount(0);
});

test('Modal: close button closes', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });
  await openAbout(page);
  await page.locator('#about-overlay .modal-close').click();
  await expect(page.locator('#about-overlay')).toHaveCount(0);
});

test('Modal: singleton guard prevents stacking', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });
  await openAbout(page);
  // Re-trigger the command while open — must not create a second overlay.
  await page.evaluate(() => {
    const btn = document.querySelector('.menu-panel button[data-action="app.about"]') as HTMLButtonElement;
    btn?.click();
  });
  await expect(page.locator('#about-overlay')).toHaveCount(1);
});

test('Components: Export dialog is built from the shared primitives', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });

  await page.locator('.menu-trigger', { hasText: 'File' }).click();
  await page.locator('.menu-panel button[data-action="file.export-artboards"]').click();
  const overlay = page.locator('#export-dialog-overlay');
  await expect(overlay).toBeVisible();

  // Built on the Modal primitive + component factories.
  await expect(overlay.locator('.modal-dialog')).toBeVisible();
  await expect(overlay.locator('.modal-footer .btn')).toHaveCount(2);
  await expect(overlay.locator('.btn--primary')).toHaveText('Export');
  await expect(overlay.locator('.ui-select').first()).toBeVisible();

  // Scale field is hidden for SVG (default) and shown for a raster format.
  const scaleField = overlay.locator('.field', { hasText: 'Scale' });
  await expect(scaleField).toBeHidden();
  await overlay.locator('.field', { hasText: 'Format' }).locator('.ui-select').selectOption('png');
  await expect(scaleField).toBeVisible();

  // Cancel is a .btn and closes via the Modal lifecycle.
  await overlay.locator('.modal-footer .btn', { hasText: 'Cancel' }).click();
  await expect(overlay).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
