import { test, expect } from '@playwright/test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Broad smoke tier: run generic load/round-trip assertions over the entire W3C
 * SVG 1.1 conformance suite (hundreds of files). Not committed — `npm run
 * smoke:fetch` first. Assertions are deliberately lenient (these are diverse
 * spec-feature files, many referencing external resources we don't ship): each
 * file must import without throwing and re-serialize to valid XML. The goal is
 * "nothing crashes the importer", not pixel fidelity.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'test/smoke/svg');
const files = existsSync(DIR) ? readdirSync(DIR).filter(f => f.endsWith('.svg')) : [];

test('W3C SVG 1.1 suite imports and round-trips without crashing', async ({ page }) => {
  test.skip(files.length === 0, 'smoke corpus missing — run `npm run smoke:fetch`');

  const pageErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(e.message.slice(0, 120)));
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });

  const payload = files.map(f => ({ name: f, text: readFileSync(join(DIR, f), 'utf8') }));

  const res = await page.evaluate((items) => {
    const NS = 'xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.0.dtd"';
    const state = (window as unknown as { state: { importSVGContent: (s: string) => void; getDefsBlock: () => string; getDrawingLayerSVG: () => string; getExtraNamespaceDecls: () => string } }).state;
    const failures: { name: string; error: string }[] = [];
    for (const { name, text } of items) {
      try {
        state.importSVGContent(text);
        const body = `<svg xmlns="http://www.w3.org/2000/svg" ${NS}${state.getExtraNamespaceDecls()}>`
          + state.getDefsBlock() + state.getDrawingLayerSVG() + '</svg>';
        const rt = new DOMParser().parseFromString(body, 'image/svg+xml');
        const pe = rt.querySelector('parsererror');
        if (pe) failures.push({ name, error: 'roundtrip XML: ' + (pe.textContent || '').replace(/\s+/g, ' ').slice(0, 80) });
      } catch (e) {
        failures.push({ name, error: 'import threw: ' + String((e as Error).message).slice(0, 80) });
      }
    }
    return { total: items.length, failures };
  }, payload);

  const ok = res.total - res.failures.length;
  console.log(`\nW3C smoke: ${ok}/${res.total} imported + round-tripped cleanly`);
  if (res.failures.length) {
    console.log('Failures:');
    for (const f of res.failures.slice(0, 40)) console.log(`  ${f.name} — ${f.error}`);
    if (res.failures.length > 40) console.log(`  …and ${res.failures.length - 40} more`);
  }

  expect(pageErrors, 'uncaught page errors during import').toEqual([]);
  expect(res.failures, 'files that failed to import or round-trip').toEqual([]);
});
