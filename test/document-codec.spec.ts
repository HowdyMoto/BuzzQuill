import { test, expect } from '@playwright/test';

test('document codec preserves legacy metadata and reports import warnings without UI feedback', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).state);
  const result = await page.evaluate(async () => {
    const codec = await import('/src/core/document-codec.ts');
    const ui = await import('/src/ui/project-file.ts');
    const state = (window as any).state;
    const warnings: string[] = [];
    codec.loadDocumentSVG(state, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect id="shape-900" width="20" height="30" fill="red"><animate attributeName="x" to="50" dur="1s"/></rect>
    </svg>`, message => warnings.push(message));
    const svg = codec.serializeDocumentSVG(state);
    const metadata = JSON.parse(new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('metadata')!.textContent!);
    // Old branded SVG files must remain readable after the module move.
    codec.loadDocumentString(state, svg.replace('"app":"BuzzQuill"', '"app":"SVGMaker"').replace('&quot;app&quot;:&quot;BuzzQuill&quot;', '&quot;app&quot;:&quot;SVGMaker&quot;'));
    const afterSvg = !!state.findShapeById('shape-900');
    // Exercise the distinct legacy JSON decoder as well.
    codec.loadDocumentString(state, JSON.stringify({
      ...metadata, app: 'SVGMaker', svgContent: '<rect id="shape-901" width="17" height="23" fill="blue"/>', shapes: [],
    }));
    return {
      warnings, afterSvg, afterJson: !!state.findShapeById('shape-901'), dirty: state.dirty,
      compatibility: ui.serializeDocumentSVG === codec.serializeDocumentSVG && ui.loadProject === codec.loadProject,
    };
  });
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toContain('SMIL animation');
  expect(result).toMatchObject({ afterSvg: true, afterJson: true, dirty: false, compatibility: true });
  expect(errors).toEqual([]);
});
