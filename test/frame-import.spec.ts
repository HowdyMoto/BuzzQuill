import { test, expect } from '@playwright/test';

/**
 * Opening a foreign SVG wraps its content into a single frame
 * (migrateContentToFrames). Regression: a top-level group whose getBBox() is
 * huge because it holds a *clipped* decorative path (common in Illustrator
 * exports) must still land INSIDE the frame — the old center-in-frame test
 * excluded it, leaving it orphaned behind the frame's background where it
 * vanished. Everything top-level should end up in the frame.
 */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <defs><clipPath id="cp"><rect x="10" y="120" width="60" height="60"/></clipPath></defs>
  <g id="bg"><rect width="200" height="200" fill="#0088cc"/></g>
  <g id="art">
    <path clip-path="url(#cp)" d="M-6000,-6000 L6000,-6000 L6000,6000 L-6000,6000 Z" fill="#eee"/>
    <circle cx="150" cy="150" r="20" fill="#e33"/>
  </g>
</svg>`;

test('foreign import wraps ALL top-level content into the frame (clipped huge-bbox group included)', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });

  const r = await page.evaluate(async (svg) => {
    const m = await import('/src/ui/project-file.ts');
    m.loadDocumentSVG((window as unknown as { state: any }).state, svg);
    const layer = document.getElementById('drawing-layer')!;
    const top = [...layer.children];
    const frames = top.filter(c => (c as SVGElement).hasAttribute('data-frame'));
    const frame = frames[0] as SVGElement | undefined;
    return {
      topCount: top.length,
      frameCount: frames.length,
      orphans: top.filter(c => !(c as SVGElement).hasAttribute('data-frame')).length,
      frameHasArt: !!frame?.querySelector('#art'),
      frameHasBg: !!frame?.querySelector('#bg'),
      circleInFrame: !!frame?.querySelector('circle'),
    };
  }, SVG);

  expect(r.frameCount, 'exactly one frame created').toBe(1);
  expect(r.orphans, 'no content left orphaned outside the frame').toBe(0);
  expect(r.topCount, 'the frame is the only top-level element').toBe(1);
  expect(r.frameHasBg, 'background group inside frame').toBe(true);
  expect(r.frameHasArt, 'clipped-artwork group inside frame (not orphaned behind it)').toBe(true);
  expect(r.circleInFrame, 'artwork children moved in with their group').toBe(true);
});
