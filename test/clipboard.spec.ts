import { test, expect } from '@playwright/test';

/**
 * Characterization test for the internal clipboard (copy / cut / paste) driven
 * through AppState. Pins paste-offset, re-id-on-paste, selection-after-paste,
 * and cut semantics so extracting the Clipboard subsystem out of AppState can't
 * regress them. Uses only the in-app clipboard (not navigator.clipboard) to
 * avoid headless permission flakiness.
 *
 * Written BEFORE the ClipboardManager extraction; must stay green across it.
 */

const ONE_RECT =
  '<svg xmlns="http://www.w3.org/2000/svg">' +
  '<rect id="r1" x="0" y="0" width="10" height="10" fill="red"/></svg>';

test('copy / paste duplicates the selection with a new id and selects the paste', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });

  const r = await page.evaluate((svg) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as unknown as { state: any }).state;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ids = () => s.shapes.map((x: any) => x.id);

    const emptyPaste = s.pasteClipboard();          // nothing copied yet → false

    s.importSVGContent(svg);
    const afterImport = ids();
    s.selectMultiple(afterImport);
    s.copySelected();

    const pasted1 = s.pasteClipboard();             // +1 shape, selects the copy
    const afterPaste1 = ids();
    const selAfterPaste1 = [...s.selectedShapeIds];

    const pasted2 = s.pasteClipboard();             // +1 more (offset grows)
    const afterPaste2 = ids();

    return {
      emptyPaste, afterImport, pasted1, afterPaste1, selAfterPaste1, pasted2, afterPaste2,
      // the pasted shape must be a fresh id, not the source id
      pastedIsFreshId: selAfterPaste1.length === 1 && !afterImport.includes(selAfterPaste1[0]),
    };
  }, ONE_RECT);

  expect(pageErrors, 'uncaught page error').toEqual([]);
  expect(r.emptyPaste, 'paste with empty clipboard should be a no-op').toBe(false);
  expect(r.afterImport.length).toBe(1);

  expect(r.pasted1).toBe(true);
  expect(r.afterPaste1.length, 'paste should add one shape').toBe(2);
  expect(r.selAfterPaste1.length, 'paste should select exactly the new shape').toBe(1);
  expect(r.pastedIsFreshId, 'pasted shape must get a new id').toBe(true);

  expect(r.pasted2).toBe(true);
  expect(r.afterPaste2.length, 'second paste should add another shape').toBe(3);
});

test('cut removes the selection but leaves it on the clipboard for paste', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });

  const r = await page.evaluate((svg) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as unknown as { state: any }).state;
    s.importSVGContent(svg);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.selectMultiple(s.shapes.map((x: any) => x.id));
    s.cutSelected();
    const afterCut = s.shapes.length;
    const pasted = s.pasteClipboard();
    const afterPaste = s.shapes.length;
    return { afterCut, pasted, afterPaste };
  }, ONE_RECT);

  expect(pageErrors, 'uncaught page error').toEqual([]);
  expect(r.afterCut, 'cut should remove the selected shape').toBe(0);
  expect(r.pasted, 'cut content should still be pasteable').toBe(true);
  expect(r.afterPaste, 'paste after cut restores a shape').toBe(1);
});
