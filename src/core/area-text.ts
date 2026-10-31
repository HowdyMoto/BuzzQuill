// ---------------------------------------------------------------------------
// Area text (issue #120) — a fixed-width text box that wraps automatically
// (Illustrator's Area Type / Figma's fixed-size text).
//
// SVG has no native wrapping, so it's computed here: the RAW text (hard line
// breaks only) lives in `data-area-text`, the box in `data-area-w` (+ optional
// `data-area-h`), and reflow greedily word-wraps the raw text into <tspan>
// lines at the box width. Everything is attributes + tspans, so it round-trips
// the history snapshot and save for free; re-flow runs on width change,
// font/line-height changes, and content edits (all routed through
// writeTextLines, which defers to this module for area text).
//
// Measurement uses canvas measureText with the element's font spec (+ letter-
// spacing) — the same metrics source the Type tool's overlay editor uses, so
// the editor and the committed wrap agree.
// ---------------------------------------------------------------------------

import { textLineHeight } from './text-lines';

const NS = 'http://www.w3.org/2000/svg';

let ctx: CanvasRenderingContext2D | null = null;

export function isAreaText(el: Element): boolean {
  return el.hasAttribute('data-area-w');
}

/** The canonical (unwrapped) text: hard breaks only. */
export function areaTextRaw(el: SVGTextElement): string {
  return el.getAttribute('data-area-text') ?? (el.textContent ?? '');
}

/** Measure a string's advance width in the element's font. */
function makeMeasure(el: SVGTextElement): (s: string) => number {
  ctx ??= document.createElement('canvas').getContext('2d');
  const fs = parseFloat(el.getAttribute('font-size') ?? '24') || 24;
  const family = el.getAttribute('font-family') ?? 'Arial';
  const weight = el.getAttribute('font-weight') ?? 'normal';
  const italic = el.getAttribute('font-style') === 'italic';
  const ls = parseFloat(el.getAttribute('letter-spacing') ?? '0') || 0;
  if (!ctx) return (s) => s.length * fs * 0.6; // no canvas — crude fallback
  ctx.font = `${italic ? 'italic ' : ''}${weight} ${fs}px ${family}`;
  const c = ctx;
  return (s) => c.measureText(s).width + ls * s.length;
}

/** Greedy word-wrap of one paragraph at `maxW`; over-long words hard-break. */
function wrapParagraph(para: string, maxW: number, width: (s: string) => number): string[] {
  if (para === '') return [''];
  const words = para.split(/\s+/).filter(w => w.length > 0);
  const lines: string[] = [];
  let line = '';
  const pushChunks = (word: string): string => {
    // A single word wider than the box: emit maximal fitting prefixes.
    while (width(word) > maxW && word.length > 1) {
      let n = word.length - 1;
      while (n > 1 && width(word.slice(0, n)) > maxW) n--;
      lines.push(word.slice(0, n));
      word = word.slice(n);
    }
    return word;
  };
  for (let word of words) {
    const cand = line ? `${line} ${word}` : word;
    if (width(cand) <= maxW) { line = cand; continue; }
    if (line) lines.push(line);
    word = pushChunks(word);
    line = word;
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

/**
 * Re-wrap the element's raw text into <tspan> lines at the box width, and set
 * (or clear) `data-area-overflow` when a fixed height can't hold the result.
 * Call after any change to the box, the content, or the typography.
 */
export type AreaVAlign = 'top' | 'middle' | 'bottom';

/** The box's vertical alignment (only meaningful with a fixed height). */
export function areaVAlign(el: Element): AreaVAlign {
  const v = el.getAttribute('data-area-valign');
  return v === 'middle' || v === 'bottom' ? v : 'top';
}

export function reflowAreaText(el: SVGTextElement): void {
  const w = parseFloat(el.getAttribute('data-area-w') ?? '0') || 0;
  if (w <= 0) return;
  const raw = areaTextRaw(el);
  el.setAttribute('data-area-text', raw); // ensure the canonical copy exists
  const width = makeMeasure(el);
  const lines = raw.split('\n').flatMap(p => wrapParagraph(p, w, width));

  const x = parseFloat(el.getAttribute('x') ?? '0') || 0;
  const fs = parseFloat(el.getAttribute('font-size') ?? '24') || 24;
  const lh = textLineHeight(el);
  const h = parseFloat(el.getAttribute('data-area-h') ?? '0') || 0;
  const contentH = fs + (lines.length - 1) * fs * lh; // first ascent-ish + advances

  // Vertical alignment offsets the FIRST line down by the free space in a
  // fixed-height box, so the block sits top/middle/bottom WITHOUT moving the box
  // anchor (`y` stays the top-aligned first baseline). Clamped ≥ 0 so an
  // overflowing block always spills downward, matching the overflow indicator.
  const valign = areaVAlign(el);
  const free = h > 0 ? Math.max(0, h - contentH) : 0;
  const vOffset = valign === 'middle' ? free / 2 : valign === 'bottom' ? free : 0;

  while (el.firstChild) el.removeChild(el.firstChild);
  lines.forEach((line, i) => {
    const t = document.createElementNS(NS, 'tspan');
    t.setAttribute('x', String(x));
    t.setAttribute('dy', i === 0 ? String(vOffset) : String(fs * lh));
    // An empty paragraph still needs the line advance; a space keeps the tspan
    // from collapsing to zero extent.
    t.textContent = line === '' ? ' ' : line;
    el.appendChild(t);
  });

  if (h > 0 && contentH > h + 0.5) el.setAttribute('data-area-overflow', '1');
  else el.removeAttribute('data-area-overflow');
}

/** Replace the raw content (hard breaks only) and re-wrap. */
export function setAreaTextContent(el: SVGTextElement, raw: string): void {
  el.setAttribute('data-area-text', raw);
  reflowAreaText(el);
}

/** Resize the box (world units) and re-wrap. Height is optional (auto-height). */
export function setAreaTextBox(el: SVGTextElement, w: number, h?: number): void {
  el.setAttribute('data-area-w', String(Math.max(1, w)));
  if (h != null && h > 0) el.setAttribute('data-area-h', String(h));
  reflowAreaText(el);
}

/** Set the box's vertical alignment (top/middle/bottom) and re-flow. */
export function setAreaVAlign(el: SVGTextElement, valign: AreaVAlign): void {
  if (valign === 'top') el.removeAttribute('data-area-valign');
  else el.setAttribute('data-area-valign', valign);
  reflowAreaText(el);
}
