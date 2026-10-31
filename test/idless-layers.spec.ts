import { test, expect } from '@playwright/test';

/**
 * Regression: id-less imported elements must become layers.
 *
 * Foreign SVGs (and our own clean/TraceCraft exports that strip editor ids)
 * commonly have elements with no `id`. They render on the canvas, but
 * rebuildShapesFromDOM used to drop any id-less element from the model — so the
 * artwork showed with an EMPTY Layers panel. Every renderable element should now
 * get an id and appear as a selectable layer.
 */

// No ids anywhere; a nested group with id-less children too.
const IDLESS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="0" y="0" width="20" height="10" fill="red"/>
  <path d="M0 0 L10 10" stroke="black"/>
  <g><circle cx="5" cy="5" r="3"/><ellipse cx="10" cy="10" rx="4" ry="2"/></g>
</svg>`;

test('id-less imported SVG produces layers (each element gets an id)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });

  const r = await page.evaluate((svg) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as unknown as { state: any }).state;
    s.importSVGContent(svg);
    const list = document.getElementById('layers-list');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flat = (arr: any[]): any[] => arr.flatMap((x) => [x, ...(x.children ? flat(x.children) : [])]);
    const all = flat(s.shapes);
    return {
      topLevel: s.shapes.length,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      topTypes: s.shapes.map((x: any) => x.type),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      everyShapeHasId: all.every((x: any) => !!x.id && !!x.element.id),
      layerRows: list?.childElementCount ?? -1,
    };
  }, IDLESS);

  expect(errors).toEqual([]);
  // rect, path, and the group are the three top-level layers.
  expect(r.topLevel).toBe(3);
  expect(r.topTypes).toEqual(['rect', 'path', 'group']);
  // Every element (incl. the group's id-less children) got an id.
  expect(r.everyShapeHasId).toBe(true);
  // The panel actually rendered rows (top level + expanded group children).
  expect(r.layerRows).toBeGreaterThan(0);
});
