import { test, expect } from '@playwright/test';

/**
 * The Transform panel is a CSS container: at normal width it spells out
 * "Width"/"Height"; when the pane is dragged narrow it collapses them to W/H
 * (and reclaims the wide label column). Driven by a @container query on
 * #panel-properties, so it responds to the panel's own width — exercised here by
 * changing --panel-w (what the panel resizer sets).
 */
test('Width/Height labels collapse to W/H when the panel is narrow', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as unknown as { state: any }).state;
    s.importSVGContent('<svg xmlns="http://www.w3.org/2000/svg"><rect id="r1" x="0" y="0" width="200" height="100" fill="#888"/></svg>');
    s.selectMultiple(['r1']);
  });

  const full = page.locator('#panel-properties .dim-lbl .dim-lg').first(); // "Width"
  const short = page.locator('#panel-properties .dim-lbl .dim-sm').first(); // "W"

  // Default width → spelled out.
  await expect(full).toBeVisible();
  await expect(short).toBeHidden();
  await expect(full).toHaveText('Width');

  // Shrink the right panel column → collapse to W/H.
  await page.evaluate(() => document.documentElement.style.setProperty('--panel-w', '180px'));
  await expect(short).toBeVisible();
  await expect(full).toBeHidden();
  await expect(short).toHaveText('W');

  // Widen again → back to spelled out (it's live, not one-way).
  await page.evaluate(() => document.documentElement.style.setProperty('--panel-w', '260px'));
  await expect(full).toBeVisible();
  await expect(short).toBeHidden();
});
