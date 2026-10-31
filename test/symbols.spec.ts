import { test, expect } from '@playwright/test';

/**
 * Characterization test for the symbols subsystem (create-from-shape, place
 * instance, detach, remove) driven through AppState. Pins the shape↔<use>↔<defs>
 * transformations so extracting the Symbols subsystem out of AppState can't
 * regress them.
 *
 * Written BEFORE the SymbolRegistry extraction; must stay green across it.
 */

const ONE_RECT =
  '<svg xmlns="http://www.w3.org/2000/svg">' +
  '<rect id="r1" x="0" y="0" width="20" height="10" fill="red"/></svg>';

test('symbol lifecycle: create from shape → place instance → detach → remove', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });

  const r = await page.evaluate((svg) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as unknown as { state: any }).state;
    const byId = (id: string) => document.getElementById(id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const typeOf = (id: string) => s.shapes.find((x: any) => x.id === id)?.type ?? null;

    s.importSVGContent(svg);

    // --- create symbol from the rect ---
    const def = s.createSymbolFromShape('r1');
    const symId = def?.id ?? null;
    const useId = s.selectedShapeIds[0];                 // create selects the new <use>
    const symEl = symId ? byId(symId) : null;
    const created = {
      symId,
      symbolCount: s.symbols.length,
      symbolTag: symEl?.tagName.toLowerCase() ?? null,
      useType: typeOf(useId),
      useHref: byId(useId)?.getAttribute('href') ?? null,
      shapeCount: s.shapes.length,
    };

    // --- place a second instance ---
    s.placeSymbolInstance(symId);
    const afterPlaceCount = s.shapes.length;

    // --- detach the first instance back into a concrete shape ---
    s.detachSymbolInstance(useId);
    const detachedId = s.selectedShapeIds[0];
    const detached = {
      type: typeOf(detachedId),
      symbolStillExists: !!byId(symId),                  // detach must not delete the symbol def
    };

    // --- remove the symbol definition ---
    s.removeSymbol(symId);
    const removed = { symbolCount: s.symbols.length, domGone: byId(symId) === null };

    return { created, afterPlaceCount, detached, removed };
  }, ONE_RECT);

  expect(pageErrors, 'uncaught page error').toEqual([]);

  // create-from-shape turns the rect into a <use> and registers a <symbol>.
  expect(r.created.symId).toBeTruthy();
  expect(r.created.symbolCount).toBe(1);
  expect(r.created.symbolTag).toBe('symbol');
  expect(r.created.useType).toBe('use');
  expect(r.created.useHref).toBe(`#${r.created.symId}`);
  expect(r.created.shapeCount).toBe(1);

  // place adds another instance.
  expect(r.afterPlaceCount).toBe(2);

  // detach converts the instance back to a concrete shape, symbol def survives.
  expect(r.detached.type).toBe('rect');
  expect(r.detached.symbolStillExists).toBe(true);

  // remove drops the model entry and the <symbol> element.
  expect(r.removed.symbolCount).toBe(0);
  expect(r.removed.domGone).toBe(true);
});
