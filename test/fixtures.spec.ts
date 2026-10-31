import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Curated SVG feature / edge-case fixtures (test/fixtures/svg, committed).
 * Each isolates one behaviour; expectations live in test/fixtures/fixtures.json.
 * Regenerate with `node scripts/gen-fixtures.mjs`.
 *
 * Every fixture must: import without error or script execution, round-trip to
 * valid XML, and preserve edits. Per-file `expect` adds targeted checks
 * (stripped tags, render bounds, computed fill, reference resolution, …).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/fixtures.json'), 'utf8')) as {
  destDir: string;
  files: { file: string; focus: string; expect: Expect }[];
};

interface Expect {
  rendersBlank?: boolean;
  parserMayReject?: boolean;
  strippedTags?: string[];
  noScript?: boolean;
  noOnHandlers?: boolean;
  noJavascriptHrefs?: boolean;
  maxElements?: number;
  refsAllResolve?: boolean;
  imagesKeepHref?: boolean;
  effectiveFill?: { id: string; value: string };
  knownIssue?: string;
}

function measure(args: { txt: string; fillId: string | null }) {
  const { txt, fillId } = args;
  const w = window as unknown as { state: any; __pwned?: boolean };
  delete w.__pwned;
  const state = w.state;

  const parserRejected = !!new DOMParser().parseFromString(txt, 'image/svg+xml').querySelector('parsererror');
  const before = state.getDrawingLayerSVG();
  let importError: string | null = null;
  try { state.importSVGContent(txt); } catch (e) { importError = String((e as Error).message); }

  const canvas = document.getElementById('svg-canvas')!;
  const layer = document.getElementById('drawing-layer')!;
  const lc = (e: Element) => e.tagName.toLowerCase();

  const tagCount: Record<string, number> = {};
  canvas.querySelectorAll('*').forEach(e => { const t = lc(e); tagCount[t] = (tagCount[t] || 0) + 1; });

  let bbox = { w: 0, h: 0 };
  try { const b = (layer as unknown as SVGGraphicsElement).getBBox(); bbox = { w: b.width, h: b.height }; } catch { /* empty */ }

  const unchanged = before === state.getDrawingLayerSVG();
  const all = layer.querySelectorAll('*');
  all.forEach(e => e.setAttribute('data-edit-probe', '1'));
  const stamped = all.length;
  const body = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" `
    + `xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" `
    + `xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.0.dtd"`
    + `${state.getExtraNamespaceDecls()}>${state.getDefsBlock()}${state.getDrawingLayerSVG()}</svg>`;
  const rt = new DOMParser().parseFromString(body, 'image/svg+xml');
  const reparseError = rt.querySelector('parsererror')?.textContent?.slice(0, 200) ?? null;
  const editsSurvived = rt.querySelectorAll('[data-edit-probe]').length;

  const els = [...canvas.querySelectorAll('*')];
  const onHandlers = els.some(e => [...e.attributes].some(a => a.name.toLowerCase().startsWith('on')));
  const jsHrefs = els.some(e => {
    const h = (e.getAttribute('href') || e.getAttribute('xlink:href') || '').toLowerCase();
    return h.includes('javascript:');
  });
  const scriptCount = canvas.querySelectorAll('script').length;

  const uses = [...canvas.querySelectorAll('use')];
  const useUnresolved = uses.filter(u => {
    const h = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
    return h.startsWith('#') ? !document.getElementById(h.slice(1)) : false;
  }).length;

  const images = [...canvas.querySelectorAll('image')];
  const imagesWithHref = images.filter(i => {
    const h = i.getAttribute('href') || i.getAttribute('xlink:href') || '';
    return h.startsWith('data:') || h.startsWith('#');
  }).length;

  let effectiveFill: string | null = null;
  if (fillId) {
    const el = document.getElementById(fillId);
    if (el) effectiveFill = getComputedStyle(el).fill;
  }

  return {
    parserRejected, unchanged, importError, tagCount, bbox, stamped, editsSurvived, reparseError,
    onHandlers, jsHrefs, scriptCount, pwned: !!w.__pwned,
    useCount: uses.length, useUnresolved,
    imagesTotal: images.length, imagesWithHref,
    totalElements: layer.querySelectorAll('*').length, effectiveFill,
  };
}

for (const entry of manifest.files) {
  const path = join(ROOT, manifest.destDir, entry.file);
  const e = entry.expect;

  test(`${entry.file} — ${entry.focus}`, async ({ page }) => {
    test.skip(!existsSync(path), 'fixture missing — run `node scripts/gen-fixtures.mjs`');
    if (e.knownIssue) test.info().annotations.push({ type: 'known-issue', description: e.knownIssue });

    const pageErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));
    await page.goto('/');
    await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });

    const txt = readFileSync(path, 'utf8');
    const m = await page.evaluate(measure, { txt, fillId: e.effectiveFill?.id ?? null });

    // --- universal guarantees ---
    expect(m.importError, 'importSVGContent threw').toBeNull();
    expect(pageErrors, 'uncaught page error').toEqual([]);
    expect(m.pwned, 'untrusted SVG executed script').toBe(false);
    expect(m.reparseError, 'serialized output is not valid XML').toBeNull();
    expect(m.editsSurvived, 'edits lost across serialize').toBe(m.stamped);

    // --- targeted ---
    if (e.strippedTags) for (const tag of e.strippedTags) expect(m.tagCount[tag] ?? 0, `<${tag}> not stripped`).toBe(0);
    if (e.noScript) expect(m.scriptCount, '<script> survived').toBe(0);
    if (e.noOnHandlers) expect(m.onHandlers, 'on* handler survived').toBe(false);
    if (e.noJavascriptHrefs) expect(m.jsHrefs, 'javascript: href survived').toBe(false);
    if (e.maxElements != null) expect(m.totalElements, 'element count exceeded bound').toBeLessThanOrEqual(e.maxElements);
    if (e.refsAllResolve) expect(m.useUnresolved, 'unresolved <use> references').toBe(0);
    if (e.imagesKeepHref) expect(m.imagesWithHref, 'image lost its href').toBe(m.imagesTotal);

    if (e.parserMayReject && m.parserRejected) {
      expect(m.unchanged, 'rejected XML must leave the document untouched').toBe(true);
    } else if (e.rendersBlank) {
      expect(m.bbox.w * m.bbox.h, 'expected blank but has geometry').toBe(0);
    } else {
      expect(m.bbox.w, 'no rendered geometry (width)').toBeGreaterThan(0);
      expect(m.bbox.h, 'no rendered geometry (height)').toBeGreaterThan(0);
    }

    if (e.effectiveFill) {
      if (e.knownIssue) {
        test.info().annotations.push({ type: 'fill', description: `got ${m.effectiveFill}, want ${e.effectiveFill.value}` });
      } else {
        expect(m.effectiveFill, 'computed fill').toBe(e.effectiveFill.value);
      }
    }
  });
}
