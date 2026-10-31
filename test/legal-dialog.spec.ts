import { test, expect } from '@playwright/test';

/**
 * The Legal (Privacy/Terms) dialog runs on the shared Modal primitive. This pins
 * that it opens on `.modal-dialog` and that Escape closes it, and that the Help
 * menu's support entry is a plain outbound link to the issue tracker — the app
 * runs no server, so there is no contact form for it to post to.
 */

async function openHelp(page: import('@playwright/test').Page, action: string) {
  await page.locator('.menu-trigger', { hasText: 'Help' }).click();
  await page.locator(`.menu-panel button[data-action="${action}"]`).click();
}

test('Legal dialog opens on the Modal primitive and Escape closes it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });

  await openHelp(page, 'app.privacy');
  const legal = page.locator('#legal-overlay');
  await expect(legal).toBeVisible();
  await expect(legal.locator('.modal-dialog.legal-dialog')).toBeVisible();
  await expect(legal.locator('.modal-close')).toBeVisible();
  // The policy describes a serverless app: no accounts, no contact form.
  await expect(legal).not.toContainText(/sign in|Supabase|contact form/i);
  await expect(legal.locator('a[href*="github.com"][target="_blank"]').first()).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(legal).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Help menu has Feedback & Support and no account or cloud entries', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });

  await page.locator('.menu-trigger', { hasText: 'Help' }).click();
  await expect(page.locator('.menu-panel button[data-action="app.feedback"]')).toBeVisible();
  await expect(page.locator('.menu-panel button[data-action="app.contact"]')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Feedback opens the tracker in a new tab (noopener) rather than a dialog. Stub
  // window.open so the test never leaves the app or depends on the network.
  await page.evaluate(() => {
    const w = window as unknown as { __opened?: unknown[] };
    window.open = ((...args: unknown[]) => { w.__opened = args; return null; }) as typeof window.open;
  });
  await openHelp(page, 'app.feedback');
  const opened = await page.evaluate(() => (window as unknown as { __opened?: unknown[] }).__opened);
  expect(opened).toEqual(['https://github.com/HowdyMoto/BuzzQuill/issues', '_blank', 'noopener']);
  await expect(page.locator('.modal-overlay')).toHaveCount(0);
});
