import { test, expect } from '@playwright/test';

/**
 * Transform panel fields are grouped Position (X, Y) then Size (W, H) then
 * Rotation, so keyboard Tab flows X→Y→W→H→R rather than interleaving position
 * and size. Tab order follows document order here (no tabindex overrides), so we
 * assert the transform inputs appear in that sequence in the DOM.
 */
test('Transform fields tab in order X, Y, W, H, R', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });

  const idx = await page.evaluate(() => {
    const all = [...document.querySelectorAll('input[type="number"]')];
    const pos = (id: string) => all.indexOf(document.getElementById(id) as HTMLInputElement);
    return ['prop-x', 'prop-y', 'prop-w', 'prop-h', 'prop-rotation'].map(pos);
  });

  expect(idx.every((v) => v >= 0), 'all transform fields present').toBe(true);
  // Strictly increasing → X before Y before W before H before R in tab order.
  const sorted = [...idx].sort((a, b) => a - b);
  expect(idx).toEqual(sorted);
});
