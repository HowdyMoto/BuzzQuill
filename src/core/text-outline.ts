/**
 * Export-time text handling: convert <text> elements to vector <path> outlines
 * (universal compatibility, e.g. TraceCraft's single-path baking), or collect the
 * font files actually used so they can be embedded as @font-face in the output SVG.
 *
 * Outlining places each glyph's opentype outline at the position and rotation the
 * BROWSER laid the text out at (SVGTextContentElement.getStartPositionOfChar /
 * getRotationOfChar). Driving off the real layout — rather than re-deriving glyph
 * positions from attributes — is what makes multi-line text, wrapped area text,
 * text-on-a-path, letter-spacing, text-anchor and baseline-shift all "just work".
 * text-transform (a CSS visual, applied per-char) and font weight/style are honored
 * too. A non-rendered export fragment is measured in a throwaway offscreen <svg>.
 */
import { loadFontDataUrl, resolveBundledFamily, loadOpentypeFont, loadOpentypeFontFromBytes, loadVariableOutlineFont } from '../fonts';
import { base64ToBytes, type EmbeddedFont } from './embedded-fonts';
import { transformPathData } from './path-model';
import { carryObjectAttrs } from './wrapper-attrs';
import type * as OpenType from 'opentype.js';

type OpenTypeFont = OpenType.Font;

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface TextProcessResult {
  content: string;
  warnings: string[];
}

/** Read a property from the element's presentation attribute or inline style. */
function readProp(el: Element, name: string): string | null {
  const style = el.getAttribute('style');
  if (style) {
    const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i').exec(style);
    if (m) return m[1].trim();
  }
  return el.getAttribute(name);
}

function applyTextTransform(s: string, tt: string): string {
  switch (tt) {
    case 'uppercase': return s.toUpperCase();
    case 'lowercase': return s.toLowerCase();
    case 'capitalize': return s.replace(/(^|\s)(\p{L})/gu, (_, p, c) => p + c.toUpperCase());
    default: return s;
  }
}

/** Attributes carried from the source <text> onto its outlined <path>. Text defaults
 *  to a black fill when unset, which a bare <path> also does, so only explicit
 *  values are copied. text-decoration/transform/spacing are baked into the geometry. */
const CARRY = ['id', 'data-name', 'class', 'transform', 'opacity',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
  'stroke-opacity', 'stroke-linejoin', 'stroke-linecap', 'stroke-dasharray'];

function buildPath(text: SVGTextElement, d: string): SVGPathElement {
  const path = text.ownerDocument.createElementNS(SVG_NS, 'path') as SVGPathElement;
  path.setAttribute('d', d);
  for (const attr of CARRY) {
    const v = readProp(text, attr) ?? text.getAttribute(attr);
    if (v != null) path.setAttribute(attr, v);
  }
  // The object-level rest — clip, blur/shadow, lock, blend, library links — which a
  // paint-only list dropped: an outlined blurred title came out sharp. A text-style
  // link is meaningless on a path (it restyles fonts), so it stays behind.
  carryObjectAttrs(text, path, ['transform', 'opacity', 'data-name', 'data-text-style']);
  return path;
}

/** Underline / strikethrough rects (as path subpaths) per rendered line, from the
 *  per-char baseline positions. Approximate metrics (font-size relative) — exact for
 *  straight runs, which is where decoration is used. */
function decorationSubpaths(text: SVGTextElement, n: number, fontSize: number, deco: string): string[] {
  const under = /underline/.test(deco), strike = /line-through/.test(deco);
  if (!under && !strike) return [];
  const out: string[] = [];
  const rect = (x: number, y: number, w: number, h: number) =>
    `M${x} ${y}h${w}v${h}h${-w}Z`;
  let x0: number | null = null, x1 = 0, lineY: number | null = null;
  const flush = () => {
    if (x0 == null || lineY == null) return;
    const w = x1 - x0;
    if (w > 0.01) {
      if (under) out.push(rect(x0, lineY + fontSize * 0.12, w, fontSize * 0.06));
      if (strike) out.push(rect(x0, lineY - fontSize * 0.30, w, fontSize * 0.06));
    }
    x0 = null;
  };
  for (let i = 0; i < n; i++) {
    let s: DOMPoint, e: DOMPoint;
    try { s = text.getStartPositionOfChar(i); e = text.getEndPositionOfChar(i); } catch { continue; }
    if (lineY == null || Math.abs(s.y - lineY) > fontSize * 0.5) { flush(); x0 = s.x; lineY = s.y; }
    x1 = e.x;
  }
  flush();
  return out;
}


/** First family token, unquoted — same tokenizing resolveBundledFamily does, so an
 *  embedded id is matched the same way a bundled name is. */
function firstFamily(family: string): string {
  return (family || '').split(',')[0].trim().replace(/^['"]|['"]$/g, '');
}


/** A bundled substitute for `family`, trying each token of the chain in order, then
 *  a sane default. Used when the primary font has no glyph for a character. */
function fallbackFamily(family: string): string {
  for (const tok of (family || '').split(',')) {
    const r = resolveBundledFamily(tok);
    if (r) return r;
  }
  return 'Roboto';
}

/**
 * Resolve the opentype Font to outline `family` with.
 *
 * Fonts EMBEDDED in the document (a PDF import stores its subsetted programs under
 * content-derived `bqpdf-…` ids) are tried first: they have no file on disk and no
 * FONT_FILES entry, so `resolveBundledFamily` returns null for them and the run used
 * to be abandoned as live text — which is why exporting an imported PDF silently
 * substituted Helvetica for its real typeface. Their bytes are right there in the
 * document, so outline from those.
 */
function fontForFamily(
  family: string, weight: number, italic: boolean, embedded: Map<string, EmbeddedFont>,
): { font: Promise<OpenTypeFont>; } | { skip: string } {
  const first = firstFamily(family);
  const emb = embedded.get(first);
  if (emb) {
    try {
      return { font: loadOpentypeFontFromBytes(emb.id, base64ToBytes(emb.b64)) };
    } catch {
      return { skip: `embedded font "${first}" could not be parsed` };
    }
  }
  const resolved = resolveBundledFamily(family);
  if (!resolved) return { skip: `no bundled font for "${first}"` };
  const p = loadOpentypeFont(resolved, weight, italic);
  if (!p) return { skip: `font "${first}" failed to load` };
  return { font: p };
}

/** One typeface as outlining sees it: does it have a glyph for a character, and
 *  that glyph's outline at the baseline origin as path data (y down, at size). */
interface GlyphFace { has(ch: string): boolean; draw(ch: string): string }

/** A face drawn with opentype.js — at a point in its design space when `variation`
 *  names one (a variable font), else as the file's own single instance. */
function opentypeFace(font: OpenTypeFont, fontSize: number, variation?: Record<string, number>): GlyphFace {
  // opentype.js 2 applies `variation` (its typings predate it).
  const opts = (variation ? { variation } : undefined) as unknown as Parameters<OpenType.Glyph['getPath']>[3];
  return {
    has: (ch) => font.charToGlyph(ch).index !== 0,
    draw: (ch) => font.charToGlyph(ch).getPath(0, 0, fontSize, opts, font).toPathData(3),
  };
}

/**
 * The point in a variable font's design space the browser drew the text at: weight
 * from font-weight, optical size from the font size (CSS `font-optical-sizing: auto`,
 * the default, sets opsz to the size in px), width from font-stretch — then any
 * explicit `font-variation-settings`, which win. Each clamped to the font's axis.
 */
function variationFor(font: OpenTypeFont, cs: CSSStyleDeclaration, fontSize: number, weight: number): Record<string, number> {
  const axes = ((font.tables as { fvar?: { axes?: { tag: string; minValue: number; defaultValue: number; maxValue: number }[] } }).fvar?.axes) ?? [];
  const out: Record<string, number> = {};
  for (const a of axes) out[a.tag] = a.defaultValue;
  const set = (tag: string, v: number): void => {
    const a = axes.find((x) => x.tag === tag);
    if (a && Number.isFinite(v)) out[tag] = Math.min(a.maxValue, Math.max(a.minValue, v));
  };
  set('wght', weight);
  if ((cs.fontOpticalSizing || 'auto') !== 'none') set('opsz', fontSize);
  set('wdth', parseFloat(cs.fontStretch));
  for (const m of (cs.fontVariationSettings || '').matchAll(/["']([\x20-\x7e]{4})["']\s+(-?[\d.]+)/g)) set(m[1], parseFloat(m[2]));
  return out;
}

/**
 * Outline one RENDERED <text> element (it must be in a laid-out document) to a single
 * path `d`, honoring weight/italic, text-transform, decoration, and the browser's own
 * per-glyph layout (lines, wrapping, on-path rotation, spacing, anchor). Returns the
 * `d` string, or a `{ skip }` reason when the family isn't bundled / can't load, or
 * null when there's nothing to draw.
 */
async function outlineRenderedText(
  text: SVGTextElement, embedded: Map<string, EmbeddedFont>,
): Promise<{ d: string } | { skip: string } | null> {
  const cs = getComputedStyle(text);
  const family = cs.fontFamily || readProp(text, 'font-family') || 'Roboto';
  const fontSize = parseFloat(cs.fontSize) || parseFloat(readProp(text, 'font-size') || '24') || 24;
  const wRaw = (cs.fontWeight || readProp(text, 'font-weight') || '400').toLowerCase();
  const weight = wRaw === 'bold' ? 700 : wRaw === 'normal' ? 400 : (parseInt(wRaw, 10) || 400);
  const italic = /italic|oblique/.test(cs.fontStyle || readProp(text, 'font-style') || '');
  // A family the canvas draws from a VARIABLE face is outlined from that face, at
  // the instance the browser used: the static file is a single fixed instance, and
  // Inter at 48px renders with the opsz-32 display design, not the static opsz-14.
  let face: GlyphFace | null = null;
  const variable = embedded.has(firstFamily(family)) ? null : loadVariableOutlineFont(family, italic);
  if (variable) {
    try {
      const vf = await variable;
      face = opentypeFace(vf, fontSize, variationFor(vf, cs, fontSize, weight));
    } catch { face = null; } // fall back to the static file below
  }
  if (!face) {
    const picked = fontForFamily(family, weight, italic, embedded);
    if ('skip' in picked) return picked;
    try { face = opentypeFace(await picked.font, fontSize); } catch { return { skip: `font "${firstFamily(family)}" failed to load` }; }
  }

  const n = (text as SVGTextContentElement).getNumberOfChars();
  if (n === 0) return null;
  const raw = text.textContent ?? '';
  const content = applyTextTransform(raw, cs.textTransform || 'none');

  // A font can simply not contain a character. That is the NORMAL case for an
  // embedded PDF font: it is SUBSETTED to the glyphs the original document used, so
  // the moment the user edits that run the new characters are missing and
  // charToGlyph returns .notdef — which outlined to blanks and boxes in the exported
  // PDF while the canvas looked fine, because the browser quietly falls back per
  // character. Mirror that: substitute a bundled font for the missing glyphs only.
  // Positions come from the browser's own layout either way, so the run stays put.
  const missing = [...content].some(ch => !/\s/.test(ch) && !face.has(ch));
  let fallback: GlyphFace | null = null;
  if (missing) {
    try {
      const f = await (loadOpentypeFont(fallbackFamily(family), weight, italic) ?? Promise.resolve(null));
      fallback = f ? opentypeFace(f, fontSize) : null;
    } catch { fallback = null; }
  }

  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const ch = content[i] ?? raw[i] ?? '';
    if (!ch || /\s/.test(ch)) continue; // spaces carry no outline (position handled by layout)
    let pos: DOMPoint, rot = 0;
    try { pos = text.getStartPositionOfChar(i); rot = text.getRotationOfChar(i); } catch { continue; }
    const from = !face.has(ch) && fallback?.has(ch) ? fallback : face;
    const gd = from.draw(ch);
    if (!gd) continue;
    // glyph is drawn at the baseline origin; move+rotate it to where the browser put it.
    const m = new DOMMatrix().translateSelf(pos.x, pos.y).rotateSelf(rot);
    parts.push(transformPathData(gd, m as unknown as DOMMatrix));
  }
  const deco = readProp(text, 'text-decoration') || cs.textDecorationLine || '';
  parts.push(...decorationSubpaths(text, n, fontSize, deco));
  if (parts.length === 0) return null;
  return { d: parts.join(' ') };
}

/**
 * Outline every <text> in the fragment to a <path>, honoring layout & styles.
 * The fragment isn't rendered, so it's measured in a hidden offscreen <svg> (fonts
 * loaded there) and the outlined markup re-serialized.
 */
export async function outlineText(
  fragment: string, embeddedFonts: readonly EmbeddedFont[] = [],
): Promise<TextProcessResult> {
  if (!/<text[\s>]/.test(fragment)) return { content: fragment, warnings: [] };
  const embedded = new Map(embeddedFonts.map(f => [f.id, f]));
  // Skips are aggregated by REASON, not one per run: a PDF page is hundreds of
  // separate <text> runs, and one warning each produced an unreadable, un-dismissable
  // wall of near-identical lines (and it was the default outcome before embedded
  // fonts could be outlined at all).
  const skips = new Map<string, number>();

  const host = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  host.setAttribute('style', 'position:fixed;left:-99999px;top:0;width:3000px;height:3000px;opacity:0;pointer-events:none;');
  // Parse in the SVG namespace (DOMParser), then move the nodes into the live host so
  // the browser lays them out and textPath/refs inside the fragment resolve.
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink">${fragment}</svg>`,
    'image/svg+xml',
  );
  for (const child of Array.from(doc.documentElement.childNodes)) host.appendChild(document.importNode(child, true));
  document.body.appendChild(host);

  try {
    // Ensure the referenced fonts are actually loaded before measuring (fallback
    // metrics would misplace glyphs). Kicks a load per family, then waits.
    for (const t of Array.from(host.querySelectorAll('text'))) {
      const declared = (t as SVGElement).getAttribute('font-family') || getComputedStyle(t).fontFamily || '';
      // Embedded families are registered with document.fonts under their own id, so
      // warm those directly — resolveBundledFamily can't see them.
      const fam = embedded.has(firstFamily(declared)) ? firstFamily(declared) : resolveBundledFamily(declared);
      if (fam) { try { await document.fonts.load(`${getComputedStyle(t).fontStyle} ${getComputedStyle(t).fontWeight} ${parseFloat(getComputedStyle(t).fontSize) || 24}px "${fam}"`); } catch { /* best-effort */ } }
    }
    await document.fonts.ready;
    void host.getBBox(); // force a layout flush before querying char positions

    for (const text of Array.from(host.querySelectorAll('text'))) {
      const res = await outlineRenderedText(text as SVGTextElement, embedded);
      if (!res) { text.remove(); continue; }
      if ('skip' in res) { skips.set(res.skip, (skips.get(res.skip) ?? 0) + 1); continue; }
      text.replaceWith(buildPath(text as SVGTextElement, res.d));
    }

    const warnings = [...skips].map(([reason, n]) =>
      `Couldn't outline ${n} text ${n === 1 ? 'run' : 'runs'} — ${reason}; left as live text.`);
    const serializer = new XMLSerializer();
    const content = Array.from(host.childNodes).map(node => serializer.serializeToString(node)).join('');
    return { content, warnings };
  } finally {
    host.remove();
  }
}

/**
 * Outline one LIVE (already rendered) <text> element to a <path>, for the in-canvas
 * Outline Text command. Returns the built path, a `{ skip }` reason, or null (empty).
 * No offscreen render needed — the element is on screen with its font loaded.
 */
export async function outlineLiveText(text: SVGTextElement): Promise<SVGPathElement | { skip: string } | null> {
  const res = await outlineRenderedText(text, new Map());
  if (!res || 'skip' in (res as object)) return res as { skip: string } | null;
  return buildPath(text, (res as { d: string }).d);
}

/**
 * Build a <style> block with @font-face rules embedding (as base64 WOFF) every bundled
 * family used by <text> in the fragment, so the exported SVG renders identically offline.
 * Returns '' if no embeddable text is present.
 */
export async function buildEmbeddedFontStyle(fragment: string): Promise<{ style: string; warnings: string[] }> {
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink">${fragment}</svg>`,
    'image/svg+xml',
  );
  const root = doc.documentElement;
  const warnings: string[] = [];
  const families = new Set<string>();

  for (const text of Array.from(root.querySelectorAll('text'))) {
    if (!(text.textContent ?? '').trim()) continue;
    const family = readProp(text, 'font-family') || 'Roboto';
    const requested = family.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
    if (resolveBundledFamily(family) === requested) families.add(requested);
    else warnings.push(`Can't embed "${requested}" — not a bundled font; relying on the viewer's system fonts.`);
  }

  if (families.size === 0) return { style: '', warnings };

  const faces: string[] = [];
  for (const family of families) {
    const dataUrl = await loadFontDataUrl(family);
    if (!dataUrl) continue;
    faces.push(
      `@font-face{font-family:'${family}';font-style:normal;font-weight:400;` +
      `src:url(${dataUrl}) format('woff');}`,
    );
  }

  return { style: `<style>\n${faces.join('\n')}\n</style>`, warnings };
}

/**
 * Build @font-face rules for the document's EMBEDDED fonts (e.g. extracted from an
 * imported PDF) that the fragment's text actually references — so exported text
 * renders in its real typeface. Unlike bundled fonts these have no system/viewer
 * fallback, so they must travel with the file in EVERY text mode (keep/outline/
 * embed). Returns '' (no <style>) when none are used. Pure string in/out.
 */
export function embeddedFontFaceStyle(fonts: EmbeddedFont[], fragment: string): string {
  if (!fonts.length) return '';
  const byId = new Map(fonts.map((f) => [f.id, f]));
  const used = new Set<string>();
  // Match font-family values (quoted or bare) against known embedded ids.
  for (const m of fragment.matchAll(/font-family="([^"]*)"/g)) {
    const fam = m[1].replace(/^['"]|['"]$/g, '');
    if (byId.has(fam)) used.add(fam);
  }
  if (used.size === 0) return '';
  const faces = [...used].map((id) => {
    const f = byId.get(id)!;
    return `@font-face{font-family:'${id}';src:url(data:${f.mime || 'font/opentype'};base64,${f.b64}) format('opentype');}`;
  });
  return `<style>\n${faces.join('\n')}\n</style>`;
}
