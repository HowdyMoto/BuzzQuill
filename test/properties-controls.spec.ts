import { test, expect } from '@playwright/test';

test('text controls update selected text and preserve a committed content edit through undo/redo', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).state);
  await page.evaluate(() => {
    const s = (window as any).state;
    s.importSVGContent('<svg xmlns="http://www.w3.org/2000/svg"><text id="label" x="200" y="150" font-size="24">Original</text></svg>');
    s.selectMultiple(['label']);
  });
  const content = page.locator('#prop-text-content');
  await expect(content).toHaveValue('Original');
  await content.fill('Changed\nsecond line');
  await content.blur();
  const text = () => page.evaluate(async () => {
    const { readTextLines } = await import('/src/core/text-lines.ts');
    return readTextLines(document.getElementById('label') as unknown as SVGTextElement);
  });
  expect(await text()).toEqual(['Changed','second line']);
  await page.evaluate(() => (window as any).state.undo());
  expect(await text()).toEqual(['Original']);
  await page.evaluate(() => (window as any).state.redo());
  expect(await text()).toEqual(['Changed','second line']);
  await page.evaluate(() => (window as any).state.selectMultiple(['label']));
  const size = page.locator('#prop-font-size');
  await size.fill('36'); await size.blur();
  await expect(page.locator('#label')).toHaveAttribute('font-size','36');
  expect(errors).toEqual([]);
});
