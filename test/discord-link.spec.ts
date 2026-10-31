import { test, expect } from '@playwright/test';

/**
 * Issue #104: a visible Discord affordance for help & feedback — in the tab-bar
 * identity cluster, not buried in a menu. Opens the invite in a new tab, safely.
 */
test('Discord link is a visible tab-bar affordance with the right target', async ({ page }) => {
  await page.goto('/');
  const link = page.locator('#discord-link');
  await expect(link).toBeVisible();
  await expect(link).toContainText('Discord');
  await expect(link).toHaveAttribute('href', 'https://discord.gg/2M4HYxqDG3');
  await expect(link).toHaveAttribute('target', '_blank');       // new tab
  await expect(link).toHaveAttribute('rel', /noopener/);        // no opener leakage
  // It lives in the tab-bar identity cluster, not inside a dropdown menu-panel.
  await expect(page.locator('#chrome-actions #discord-link')).toHaveCount(1);
  await expect(page.locator('.menu-panel #discord-link')).toHaveCount(0);
});
