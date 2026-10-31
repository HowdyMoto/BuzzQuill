import { test, expect } from '@playwright/test';
import { gzipSync } from 'node:zlib';

/**
 * File-decode tier: the import/round-trip tests feed `importSVGContent` a string,
 * but real files on disk reach the app as BYTES. These check the byte→text step
 * (`readSvgFile`) handles the two things a naive UTF-8 read gets wrong: gzipped
 * `.svgz`, and non-UTF-8 encodings (declared ISO-8859-1, or a UTF-16 BOM).
 */

// 'é' and 'ü' are representable in ISO-8859-1 (single bytes), so the latin1 case
// is lossless; avoid characters outside Latin-1 here.
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
  + '<rect width="100" height="100" fill="#3a9"/>'
  + '<text x="10" y="50">café Zürich</text></svg>';

async function decode(page: import('@playwright/test').Page, bytes: Uint8Array) {
  return page.evaluate(async (arr) => {
    const fa = await import('/src/core/file-access.ts');
    const text = await fa.readSvgFile(new Blob([new Uint8Array(arr)]));
    let importError: string | null = null;
    let bbox = { w: 0, h: 0 };
    try {
      (window as unknown as { state: { importSVGContent: (s: string) => void } }).state.importSVGContent(text);
      const b = (document.getElementById('drawing-layer') as unknown as SVGGraphicsElement).getBBox();
      bbox = { w: b.width, h: b.height };
    } catch (e) { importError = String((e as Error).message); }
    return { text, importError, bbox };
  }, Array.from(bytes));
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });
});

test('gzipped .svgz inflates, loads and renders', async ({ page }) => {
  const r = await decode(page, new Uint8Array(gzipSync(Buffer.from(SVG, 'utf8'))));
  expect(r.text).toContain('<rect');
  expect(r.importError).toBeNull();
  expect(r.bbox.w).toBeGreaterThan(0);
});

test('ISO-8859-1 declared encoding decodes accents (no mojibake)', async ({ page }) => {
  const xml = '<?xml version="1.0" encoding="ISO-8859-1"?>\n' + SVG;
  const r = await decode(page, new Uint8Array(Buffer.from(xml, 'latin1')));
  expect(r.text).toContain('café Zürich');
  expect(r.text).not.toContain('�'); // U+FFFD = decode failure
  expect(r.importError).toBeNull();
});

test('UTF-16LE with BOM decodes correctly', async ({ page }) => {
  const r = await decode(page, new Uint8Array(Buffer.from('﻿' + SVG, 'utf16le')));
  expect(r.text).toContain('café Zürich');
  expect(r.importError).toBeNull();
  expect(r.bbox.w).toBeGreaterThan(0);
});
