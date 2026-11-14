import { test, expect } from '@playwright/test';

for (const variant of ['break', 'extract', 'width', 'appearance']) {
  const extract = variant !== 'break';
  test(`${variant} segment preserves geometry, undo and saved SVG`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await page.waitForFunction(() => !!(window as any).state);
    const id = await page.evaluate(() => {
      const s = (window as any).state;
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      el.id = s.nextId(); el.setAttribute('d', 'M100 100 L300 100 L300 300 L100 300 Z');
      el.setAttribute('fill', 'none'); el.setAttribute('stroke', '#4488aa'); el.setAttribute('stroke-width', '4');
      document.getElementById(s.artboards[0].id)!.append(el);
      s.rebuildShapesFromDOM(); s.saveHistory(); s.selectShape(el.id); return el.id;
    });
    if (variant === 'width' || variant === 'appearance') {
      await page.evaluate(({ id, variant }) => {
        const s = (window as any).state;
        if (variant === 'width') s.setWidthProfile(id, [{ t: 0, w: 10 }, { t: 1, w: 2 }], 10);
        else s.setAppearance(id, [{ t: 'stroke', paint: '#4488aa', width: 4 }, { t: 'stroke', paint: '#000', width: 2 }]);
        s.selectShape(id);
      }, { id, variant });
    }
    const geometry = variant === 'width' ? ' > [data-width-src]' : variant === 'appearance' ? ' > [data-ap-src]' : '';
    const original = page.locator(`[id="${id}"]${geometry}`);
    await page.keyboard.press('a');
    await page.locator('[data-node-anchor="0:1"]').click();
    await page.locator('[data-node-anchor="0:2"]').click({ modifiers: ['Shift'] });
    await page.locator('#tool-hint').getByRole('button', { name: extract ? 'Extract segment as new path' : 'Break segment', exact: true }).click();
    const expected = 'M 300 300 L 100 300 L 100 100 L 300 100';
    await expect(original).toHaveAttribute('d', expected);
    const piece = page.locator(`[data-name="Extracted segment"]${geometry}`);
    if (extract) {
      await expect(piece).toHaveAttribute('d', 'M 300 100 L 300 300');
      if (variant === 'extract') await expect(piece).toHaveAttribute('stroke', '#4488aa');
    }
    await page.evaluate(() => (window as any).state.undo());
    await expect(original).toHaveAttribute('d', 'M100 100 L300 100 L300 300 L100 300 Z');
    await expect(piece).toHaveCount(0);
    await page.evaluate(() => (window as any).state.redo());
    await expect(original).toHaveAttribute('d', expected);
    await page.evaluate(async () => {
      const s = (window as any).state;
      const { serializeDocumentSVG, loadDocumentSVG } = await import('/src/core/document-codec.ts');
      loadDocumentSVG(s, serializeDocumentSVG(s));
    });
    await expect(original).toHaveAttribute('d', expected);
    await expect(piece).toHaveCount(extract ? 1 : 0);
    expect(errors).toEqual([]);
  });
}
