// ---------------------------------------------------------------------------
// Reading & writing a <text> element's line structure — shared by the canvas
// Type tool and the Properties panel's Contents field, so both produce the
// exact same markup: single line = plain textContent; multi-line = one
// absolute-x <tspan> per line with dy = font-size × line-height; a
// text-on-a-path keeps its single <textPath> string.
// ---------------------------------------------------------------------------

import { isAreaText, areaTextRaw, setAreaTextContent } from './area-text';

const NS = 'http://www.w3.org/2000/svg';

/** Default line-height multiple between baselines. */
export const TEXT_LINE_HEIGHT = 1.2;

/** The text's line-height multiple — user-set via `data-line-height`, else the default. */
export function textLineHeight(el: SVGTextElement): number {
  const lh = parseFloat(el.getAttribute('data-line-height') ?? '');
  return Number.isFinite(lh) && lh > 0 ? lh : TEXT_LINE_HEIGHT;
}

/** Read a text element's lines from its <tspan>s (or plain textContent).
 *  For AREA text this is the raw content (hard breaks only) — the tspans hold
 *  soft wrap breaks that must not round-trip into the editable string. */
export function readTextLines(el: SVGTextElement): string[] {
  const tp = el.querySelector('textPath');
  if (tp) return [tp.textContent ?? '']; // text-on-a-path is a single string
  if (isAreaText(el)) return areaTextRaw(el).split('\n');
  const tspans = el.querySelectorAll('tspan');
  if (tspans.length) return Array.from(tspans).map(t => t.textContent ?? '');
  return (el.textContent ?? '').split('\n');
}

/**
 * Release the PDF-import width pin, if this run carries one.
 *
 * Vector PDF import pins every imported run to the PDF's exact advance width with
 * `textLength` + `lengthAdjust="spacingAndGlyphs"` (see `core/pdf-vector.ts`), so a
 * substituted font puts its glyphs precisely where the embedded one did and
 * justified lines stay inside their margins. That's an import-FIDELITY device, not
 * an authoring property: `textLength` is a hard constraint on rendered width, so the
 * moment the string or its typography changes, the browser squeezes or stretches the
 * new glyphs to fill the old run's width — replace a long word with a short one and
 * it comes out grotesquely wide. Any edit to the run therefore drops the pin and
 * lets the run size naturally from its own font-size.
 *
 * Both attribute spellings are removed: SVG parses case-sensitively (the import
 * emits `textLength` via `image/svg+xml`), but a document that ever round-tripped
 * through an HTML parse would carry the lowercased name.
 */
export function releaseImportedTextWidth(el: SVGTextElement): void {
  for (const node of [el, ...Array.from(el.querySelectorAll('tspan, textPath'))]) {
    for (const a of ['textLength', 'textlength', 'lengthAdjust', 'lengthadjust']) {
      node.removeAttribute(a);
    }
  }
}

/** Render lines into a text element. Reads the line origin (x) and font-size off
 *  the element, so set those attributes before calling. */
export function writeTextLines(el: SVGTextElement, lines: string[]): void {
  // Only release when the string ACTUALLY changes. This runs on paths that rewrite
  // the same content — the Type tool's Escape/cancel restore, and a Contents edit
  // typed and undone — and those record no history entry, so releasing there
  // destroyed the pin with no way to undo it and no dirty flag to hint at it.
  if (readTextLines(el).join('\n') !== lines.join('\n')) releaseImportedTextWidth(el);
  // Preserve a text-on-a-path: just update the <textPath> string (no tspans).
  const tp = el.querySelector('textPath');
  if (tp) { tp.textContent = lines.join(' '); return; }
  // Area text stores the raw string and re-wraps at its box width instead of
  // taking the lines literally (they'd become hard breaks).
  if (isAreaText(el)) { setAreaTextContent(el, lines.join('\n')); return; }
  const x = parseFloat(el.getAttribute('x') ?? '0') || 0;
  const fs = parseFloat(el.getAttribute('font-size') ?? '24') || 24;
  const lh = textLineHeight(el);
  while (el.firstChild) el.removeChild(el.firstChild);
  if (lines.length <= 1) { el.textContent = lines[0] ?? ''; return; }
  lines.forEach((line, i) => {
    const t = document.createElementNS(NS, 'tspan');
    t.setAttribute('x', String(x));
    t.setAttribute('dy', i === 0 ? '0' : String(fs * lh));
    t.textContent = line;
    el.appendChild(t);
  });
}
