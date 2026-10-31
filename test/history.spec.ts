import { test, expect } from '@playwright/test';

/**
 * Characterization test for the undo/redo stack (core/history.ts, driven through
 * AppState). It pins the snapshot-history semantics — branch-on-edit, dirty
 * tracking, canUndo/canRedo — so the ongoing AppState decomposition (and a
 * future patch-based undo) can't silently change observable behaviour.
 *
 * Drives the public API through the dev-only `window.state` handle, same as
 * fixtures.spec.ts.
 */

const ONE_RECT =
  '<svg xmlns="http://www.w3.org/2000/svg">' +
  '<rect id="r1" x="0" y="0" width="10" height="10" fill="red"/></svg>';

test('undo/redo restores document state and tracks dirty / canUndo / canRedo', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });

  const r = await page.evaluate((svg) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as unknown as { state: any }).state;
    const seq: Array<{ label: string; shapes: number; dirty: boolean; canUndo: boolean; canRedo: boolean }> = [];
    const snap = (label: string) =>
      seq.push({ label, shapes: s.shapes.length, dirty: s.dirty, canUndo: s.canUndo, canRedo: s.canRedo });

    snap('initial');                                   // fresh doc: clean, nothing to undo
    s.importSVGContent(svg);                           // +1 shape, records a step
    snap('after-import');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.selectMultiple(s.shapes.map((x: any) => x.id));
    s.removeSelected();                                // 0 shapes, records a step
    snap('after-delete');
    const u1 = s.undo();                               // → 1 shape
    snap('after-undo');
    const u2 = s.undo();                               // → 0 shapes (empty initial)
    snap('after-undo2');
    const r1 = s.redo();                               // → 1 shape
    snap('after-redo');
    s.markClean();                                     // baseline = current
    const dirtyAfterClean = s.dirty;
    const r2 = s.redo();                               // → 0 shapes; redo still available after undo
    snap('after-redo2');
    // Branch-on-edit: a fresh edit after undoing must drop the redo tail.
    s.undo();
    s.importSVGContent(svg);
    snap('after-branch');
    return { seq, u1, u2, r1, r2, dirtyAfterClean };
  }, ONE_RECT);

  expect(pageErrors, 'uncaught page error').toEqual([]);
  const at = (label: string) => r.seq.find((x) => x.label === label)!;

  // Fresh document is clean with an empty undo stack. (A new doc may start with a
  // default frame, so treat its shape count as the baseline rather than assuming 0;
  // importSVGContent replaces the whole doc, so the other counts are absolute.)
  const base = at('initial').shapes;
  expect(at('initial').canUndo).toBe(false);
  expect(at('initial').dirty).toBe(false);

  // Edits accumulate and mark the document dirty.
  expect(at('after-import').shapes).toBe(1);
  expect(at('after-import').dirty).toBe(true);
  expect(at('after-import').canUndo).toBe(true);
  expect(at('after-delete').shapes).toBe(0);

  // Undo walks back through each recorded step; redo walks forward.
  expect(r.u1).toBe(true);
  expect(at('after-undo').shapes).toBe(1);
  expect(at('after-undo').canRedo).toBe(true);
  expect(r.u2).toBe(true);
  expect(at('after-undo2').shapes).toBe(base); // undone past the import → back to the initial doc
  expect(r.r1).toBe(true);
  expect(at('after-redo').shapes).toBe(1);

  // markClean resets the dirty baseline to the current step.
  expect(r.dirtyAfterClean).toBe(false);
  expect(r.r2).toBe(true);
  expect(at('after-redo2').shapes).toBe(0);

  // A new edit after an undo truncates the redo branch (no stale redo).
  expect(at('after-branch').shapes).toBe(1);
  expect(at('after-branch').canRedo).toBe(false);
});
