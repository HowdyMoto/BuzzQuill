import { test, expect } from '@playwright/test';

/**
 * Characterization test for the paint registry (gradients & patterns) driven
 * through AppState. Pins the observable behaviour — model CRUD, the live <defs>
 * elements they sync, and import tracking — so the extraction of this subsystem
 * out of the AppState god object can't silently regress it.
 *
 * Written BEFORE the PaintRegistry extraction and must stay green across it.
 */

const RECT_WITH_GRADIENT =
  '<svg xmlns="http://www.w3.org/2000/svg">' +
  '<defs><linearGradient id="imported-grad">' +
  '<stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/>' +
  '</linearGradient></defs>' +
  '<rect id="r" x="0" y="0" width="10" height="10" fill="url(#imported-grad)"/></svg>';

test('gradient & pattern registry: create / update / remove sync the live <defs>', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });

  const r = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as unknown as { state: any }).state;
    const defEl = (id: string) => document.getElementById(id);

    // --- gradient lifecycle ---
    const g = s.createGradient('linear');
    const gradId = g.id;
    const gradEl = defEl(gradId);
    const createdGradient = {
      id: gradId,
      type: g.type,
      stops: g.stops.length,
      tag: gradEl?.tagName.toLowerCase() ?? null,
      stopCount: gradEl?.querySelectorAll('stop').length ?? -1,
    };

    // mutate a stop colour and push it through updateGradient
    g.stops[0].color = '#123456';
    s.updateGradient(g);
    const afterUpdateStopColor = defEl(gradId)?.querySelector('stop')?.getAttribute('stop-color') ?? null;
    const lookupFound = s.getGradientById(gradId)?.stops[0].color ?? null;

    s.removeGradient(gradId);
    const gradAfterRemove = { dom: defEl(gradId), lookup: s.getGradientById(gradId) ?? null };

    // --- pattern lifecycle ---
    const p = s.createPattern({ type: 'preset', preset: 'dots', presetColor: '#00ff00' });
    const patId = p.id;
    const patEl = defEl(patId);
    const createdPattern = {
      id: patId,
      tag: patEl?.tagName.toLowerCase() ?? null,
      hasCircle: !!patEl?.querySelector('circle'),
    };
    s.removePattern(patId);
    const patAfterRemove = defEl(patId);

    return {
      createdGradient, afterUpdateStopColor, lookupFound, gradAfterRemove,
      createdPattern, patAfterRemove,
    };
  });

  expect(pageErrors, 'uncaught page error').toEqual([]);

  // Gradient is created with defaults and synced to a real <linearGradient> with stops.
  expect(r.createdGradient.type).toBe('linear');
  expect(r.createdGradient.stops).toBe(2);
  expect(r.createdGradient.tag).toBe('lineargradient');
  expect(r.createdGradient.stopCount).toBe(2);

  // updateGradient re-syncs the DOM and the model lookup reflects the change.
  expect(r.afterUpdateStopColor).toBe('#123456');
  expect(r.lookupFound).toBe('#123456');

  // removeGradient drops both the DOM node and the model entry.
  expect(r.gradAfterRemove.dom).toBeNull();
  expect(r.gradAfterRemove.lookup).toBeNull();

  // Preset pattern syncs to a real <pattern> with generated content; remove clears it.
  expect(r.createdPattern.tag).toBe('pattern');
  expect(r.createdPattern.hasCircle).toBe(true);
  expect(r.patAfterRemove).toBeNull();
});

test('importing an SVG tracks its gradient in the registry and live <defs>', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });

  const r = await page.evaluate((svg) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as unknown as { state: any }).state;
    s.importSVGContent(svg);
    return {
      tracked: !!s.getGradientById('imported-grad'),
      inDefs: !!document.getElementById('imported-grad'),
      stopCount: document.getElementById('imported-grad')?.querySelectorAll('stop').length ?? -1,
    };
  }, RECT_WITH_GRADIENT);

  expect(pageErrors, 'uncaught page error').toEqual([]);
  expect(r.tracked, 'imported gradient not tracked in registry').toBe(true);
  expect(r.inDefs, 'imported gradient missing from <defs>').toBe(true);
  expect(r.stopCount).toBe(2);
});
