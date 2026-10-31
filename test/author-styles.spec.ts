import { test, expect, type Page } from '@playwright/test';

/**
 * Author `<style>` paint must hand over to the editor (core/author-styles.ts).
 *
 * Illustrator's "Internal CSS" export paints through class rules, and a class rule
 * outranks the presentation attributes the editor writes — so every Fill / Stroke
 * edit on such a file was stored, shown in the panel, and never drawn. Loading must
 * keep the rendering identical AND make the controls take effect.
 */

// Illustrator-shaped: paint only through classes, including a group fill its child
// inherits, a symbol drawn through <use>, and a property with no attribute form
// (mix-blend-mode) that has to stay in the stylesheet.
const ILLUSTRATOR = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 300 200">
<defs><style>
  .cls-1 { fill: none; stroke: #000; stroke-linejoin: round; stroke-width: 4px; }
  .cls-2 { fill: #c00; }
  .cls-3 { fill: #06c; mix-blend-mode: multiply; }
  .cls-4 { fill: #0a0; }
</style>
<symbol id="sym" viewBox="0 0 10 10"><rect id="symrect" class="cls-4" width="10" height="10"/></symbol></defs>
<path id="p" class="cls-1" d="M10 10 L290 10 L290 190 Z"/>
<g id="g" class="cls-2"><rect id="inherits" x="20" y="20" width="30" height="30"/><rect id="own" class="cls-3" x="60" y="20" width="30" height="30"/></g>
<use id="u" href="#sym" x="100" y="100" width="20" height="20"/>
</svg>`;

// The reported file's shape: a saved BuzzQuill document whose stylesheet sits in
// <defs> and whose path already carries edits the class rule was overriding.
const SAVED_DOC = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100">
<metadata class="svgmaker-state">{"app":"BuzzQuill","version":1,"artboards":[{"id":"shape-9","x":0,"y":0,"width":200,"height":100,"name":"Frame 1","grid":null,"rulers":false}],"activeFrameId":"shape-9","shapes":[],"canvasBg":null}</metadata>
<defs><style id="style1">.cls-1 { fill: none; stroke: #000; stroke-linejoin: round; stroke-width: 4px; }</style></defs>
<g class="svgmaker-doc"><g id="shape-9" data-frame="" data-name="Frame 1" data-frame-w="200" data-frame-h="100"><clipPath id="frameclip-9" clipPathUnits="userSpaceOnUse"><rect x="0" y="0" width="200" height="100"></rect></clipPath><rect class="frame-bg" x="0" y="0" width="200" height="100" fill="none" pointer-events="none"></rect><path id="layout" class="cls-1" d="M 10 10 L 190 10 L 190 90 Z" data-name="Layout" fill="none" stroke="#FFCC00" stroke-width="1"></path></g></g>
</svg>`;

type Win = { state: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as Win).state, { timeout: 15_000 });
  return errors;
}

test('class-styled import renders unchanged and every paint control takes effect', async ({ page }) => {
  const errors = await boot(page);
  const r = await page.evaluate((svg) => {
    const s = (window as unknown as Win).state;
    const cs = (id: string) => getComputedStyle(document.getElementById(id)!);
    s.importSVGContent(svg);

    const p = cs('p');
    const loaded = {
      p: [p.fill, p.stroke, p.strokeWidth, p.strokeLinejoin],
      inherits: cs('inherits').fill,
      inheritsOwnsFill: document.getElementById('inherits')!.hasAttribute('fill'),
      own: [cs('own').fill, cs('own').mixBlendMode],
      symrect: cs('symrect').fill,
      css: Array.from(document.querySelectorAll('#svg-canvas style')).map((e) => e.textContent).join('\n'),
    };

    s.selectShape('p');
    s.setSelectionStroke('#ffcc00');
    s.setSelectionFill('#00ff00');
    s.setSelectionStrokeJoin('bevel');
    const edited = [cs('p').stroke, cs('p').fill, cs('p').strokeLinejoin];
    const model = s.findShapeById('p').style.stroke;

    s.undo(); s.undo(); s.undo();
    const undone = [cs('p').stroke, cs('p').fill, cs('p').strokeLinejoin];
    s.redo();
    const redone = cs('p').stroke;

    s.selectShape('g');
    s.setSelectionFill('#123456');
    const groupFill = cs('inherits').fill;
    return { loaded, edited, model, undone, redone, groupFill };
  }, ILLUSTRATOR);

  // Loading changed nothing visible…
  expect(r.loaded.p).toEqual(['none', 'rgb(0, 0, 0)', '4px', 'round']);
  expect(r.loaded.inherits).toBe('rgb(204, 0, 0)');
  expect(r.loaded.inheritsOwnsFill, 'inherited paint stays inherited, not pinned per child').toBe(false);
  expect(r.loaded.own).toEqual(['rgb(0, 102, 204)', 'multiply']);
  expect(r.loaded.symrect).toBe('rgb(0, 170, 0)');
  // …and the stylesheet no longer claims the paint, but keeps what has no attribute form.
  expect(r.loaded.css).not.toMatch(/(^|[\s{;])(fill|stroke|stroke-width|stroke-linejoin)\s*:/);
  expect(r.loaded.css).toMatch(/mix-blend-mode:\s*multiply/);

  // Every edit is visible, and undo/redo walk it back and forth.
  expect(r.edited).toEqual(['rgb(255, 204, 0)', 'rgb(0, 255, 0)', 'bevel']);
  expect(r.model).toBe('#ffcc00');
  expect(r.undone).toEqual(['rgb(0, 0, 0)', 'none', 'round']);
  expect(r.redone).toBe('rgb(255, 204, 0)');
  expect(r.groupFill, "a class-painted group's fill reaches its inheriting child").toBe('rgb(18, 52, 86)');

  expect(errors).toEqual([]);
});

test('a saved document whose <style> overrode its edits opens editable', async ({ page }) => {
  const errors = await boot(page);
  const r = await page.evaluate(async (svg) => {
    const s = (window as unknown as Win).state;
    const { loadDocumentSVG } = await import('/src/ui/project-file.ts');
    loadDocumentSVG(s, svg);
    const cs = () => getComputedStyle(document.getElementById('layout')!);
    const loaded = [cs().stroke, cs().strokeWidth];
    s.selectShape('layout');
    s.setSelectionStroke('#ffcc00');
    return { loaded, edited: cs().stroke, frameBg: getComputedStyle(document.querySelector('.frame-bg')!).fill };
  }, SAVED_DOC);

  // It opens looking exactly as it did (the rule won), then the edit shows.
  expect(r.loaded).toEqual(['rgb(0, 0, 0)', '4px']);
  expect(r.edited).toBe('rgb(255, 204, 0)');
  expect(r.frameBg).toBe('none');
  expect(errors).toEqual([]);
});

test('appending a file whose classes collide leaves the existing art alone', async ({ page }) => {
  const errors = await boot(page);
  const doc = (color: string, id: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><style>.cls-1{fill:${color}}</style></defs>` +
    `<rect id="${id}" class="cls-1" x="10" y="10" width="40" height="40"/></svg>`;
  const r = await page.evaluate(([a, b]) => {
    const s = (window as unknown as Win).state;
    s.importSVGContent(a);
    s.appendSVGContent(b, 'B');
    const appended = s.findShapeById(s.selectedShapeIds[0]).element.querySelector('rect');
    return {
      existing: getComputedStyle(document.getElementById('a')!).fill,
      appended: getComputedStyle(appended).fill,
    };
  }, [doc('#c00', 'a'), doc('#06c', 'b')]);

  expect(r.existing).toBe('rgb(204, 0, 0)');
  expect(r.appended).toBe('rgb(0, 102, 204)');
  expect(errors).toEqual([]);
});
