import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).state);
});

test('blocked detached roots, prefixed elements and foreign namespaces never reach live defs', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { sanitizeSvgElement } = await import('/src/core/svg-sanitize.ts');
    const root = new DOMParser().parseFromString('<s:script xmlns:s="http://www.w3.org/2000/svg" href="/payload.js">window.bad=true</s:script>', 'image/svg+xml').documentElement;
    const accepted = sanitizeSvgElement(root);
    const state = (window as any).state;
    state.importDefsFrom(new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg">
      <defs><script id="bad-root">bad()</script><s:script id="bad-prefix">bad()</s:script>
      <foreignObject id="bad-foreign"><div xmlns="http://www.w3.org/1999/xhtml">bad</div></foreignObject>
      <g id="bad-html" xmlns="http://www.w3.org/1999/xhtml"><script>bad()</script></g>
      <linearGradient id="good-gradient"><stop offset="0" stop-color="red"/></linearGradient></defs></svg>`, 'image/svg+xml').documentElement);
    return { accepted, text: root.textContent, attrs: root.attributes.length,
      bad: document.querySelectorAll('#bad-root,#bad-prefix,#bad-foreign,#bad-html').length,
      good: !!document.getElementById('good-gradient') };
  });
  expect(result).toEqual({ accepted: false, text: '', attrs: 0, bad: 0, good: true });
});

test('retained imported pattern artwork is sanitized again when edited', async ({ page }) => {
  const result = await page.evaluate(() => {
    const state = (window as any).state;
    state.importSVGContent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <defs><pattern id="test-pattern" data-pat-type="object" width="20" height="20" patternUnits="userSpaceOnUse">
        <g data-pat-src=""><script id="bad-pattern">bad()</script><rect width="10" height="10" onload="bad()" fill="red"/></g>
      </pattern></defs><rect width="100" height="100" fill="url(#test-pattern)"/></svg>`);
    const pattern = state.getPatternById('test-pattern');
    const retained = pattern.sourceMarkup;
    // Also model a legacy saved pattern whose retained state predates sanitizing.
    pattern.sourceMarkup += '<script id="bad-secondary">bad()</script><rect width="2" height="2" onload="bad()"/>';
    const id = state.editPatternArtwork('test-pattern');
    const artwork = document.getElementById(id)!;
    return { retained, scripts: artwork.querySelectorAll('script').length, handlers: artwork.querySelectorAll('[onload]').length, rects: artwork.querySelectorAll('rect').length };
  });
  expect(result.retained).not.toMatch(/script|onload/);
  expect(result.scripts).toBe(0);
  expect(result.handlers).toBe(0);
  expect(result.rects).toBe(2);
});

test('imported CSS cannot restyle editor controls and remains editable', async ({ page }) => {
  const before = await page.locator('#toolbar').evaluate(el => getComputedStyle(el).opacity).catch(() => '1');
  const result = await page.evaluate(() => {
    (window as any).state.importSVGContent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>
      body, button, #toolbar { opacity: 0 !important; pointer-events: none !important; }
      .art { fill: rgb(255, 0, 0); }
      </style><rect id="painted" class="art" width="40" height="40"/></svg>`);
    return { body: getComputedStyle(document.body).opacity,
      menu: getComputedStyle(document.querySelector('.menu-trigger')!).opacity,
      paint: getComputedStyle(document.getElementById('painted')!).fill };
  });
  expect(before).toBe('1');
  expect(result).toEqual({ body: '1', menu: '1', paint: 'rgb(255, 0, 0)' });
});
