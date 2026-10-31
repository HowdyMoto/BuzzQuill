/**
 * Clean text strokes (issue #172).
 *
 * The browser strokes a live <text> by tracing each glyph as it rasterizes it, which
 * exposes internal component seams on glyphs like R and A — ugly, and most visible
 * with NO fill (a fill would hide the seams; see the paint-order handling in
 * AppState.polishTextStrokes for the filled case). Stroking the glyphs' *opentype*
 * outline instead is clean (verified: Outline Text → stroke is seam-free).
 *
 * So for a **stroked, fill:none** <text> we keep the text fully editable but render
 * its stroke from a regenerated outline <path> cached right behind it:
 *
 *   parent
 *     ├─ <path data-text-stroke-cache …>          ← generated: fill:none + text's stroke
 *     └─ <text data-text-stroke-outlined … >      ← the real, editable text. Its browser
 *                                                    stroke is suppressed by a global CSS
 *                                                    rule keyed on that attribute
 *                                                    (`text[data-text-stroke-outlined]{
 *                                                    stroke:none}` in style.css) — NOT an
 *                                                    inline style, which readStyle's
 *                                                    flattenInlineStyle would flatten onto
 *                                                    the `stroke` attribute and clobber the
 *                                                    real colour. The `stroke` attribute
 *                                                    stays intact, so model/panels/readStyle
 *                                                    see the stroke unchanged.
 *
 * This mirrors the repo's wrapper-cache pattern (data-width / data-boolean): config
 * lives on the real element, the render child is a regenerated cache. Two differences
 * keep it low-touch: (1) no new wrapper <g> or shape TYPE — the shape stays a plain
 * <text>, so every text tool/panel/readStyle path is unchanged; (2) the cache <path>
 * is a marked, id-less sibling that rebuildShapesFromDOM skips (so it never becomes a
 * phantom layer) and export normalizes away (normalizeTextStrokesForExport).
 *
 * Regeneration is signature-gated and async (font outlining) but never blocks the
 * render loop: refreshTextStrokeOutlines() is sync, kicks outlining only when the
 * geometry signature changed, and patches the DOM when it resolves.
 */
import { effectivePaint } from './effective-paint';
import { outlineLiveText } from './text-outline';

export const TEXT_STROKE_CACHE_ATTR = 'data-text-stroke-cache';
export const TEXT_STROKE_OUTLINED_ATTR = 'data-text-stroke-outlined';
const GEOM_SIG_ATTR = 'data-geomsig';
// Field separator for the geometry signature — a control char that can't appear in an
// attribute value, so adjacent fields (incl. the leading numeric font epoch) can't
// collide into a false match.
const SIG_SEP = String.fromCharCode(31); // unit separator — never appears in an attribute value

// Stroke presentation copied from the <text> onto the cache <path> every frame
// (cheap; no re-outline needed when only these change).
const STROKE_PRESENT = [
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray',
  'stroke-dashoffset', 'stroke-linejoin', 'stroke-linecap', 'stroke-miterlimit',
];

/** In-flight guard per text id, so a slow outline pass isn't launched twice. */
const inflight = new Set<string>();

// Font-load epoch. outlineLiveText needs the font loaded to place glyphs correctly;
// if a text is outlined before its font arrives, the outline uses fallback metrics and
// would otherwise never refresh (its geometry signature wouldn't change). Bumping this
// on every font load invalidates all signatures so they re-outline with real metrics.
let fontEpoch = 0;
let lastLayer: SVGGElement | null = null;
let fontListenerReady = false;
function ensureFontListener(): void {
  if (fontListenerReady) return;
  fontListenerReady = true;
  const fonts = (document as unknown as { fonts?: FontFaceSet }).fonts;
  fonts?.addEventListener?.('loadingdone', () => {
    fontEpoch++;
    // Nothing may trigger a render after a late font load — re-run once ourselves.
    if (lastLayer) requestAnimationFrame(() => { if (lastLayer) refreshTextStrokeOutlines(lastLayer); });
  });
}

function hasVisibleStroke(t: SVGTextElement): boolean {
  const s = (t.getAttribute('stroke') ?? '').trim();
  return s !== '' && s !== 'none' && (parseFloat(t.getAttribute('stroke-width') ?? '0') || 0) > 0;
}
function hasFill(t: SVGTextElement): boolean {
  const f = (effectivePaint(t, 'fill') ?? '').trim();
  return f !== '' && f !== 'none';
}

/** A text qualifies for the outline cache when it has a stroke and NO fill — the one
 *  case the browser's own text stroking looks broken. Filled text stays on the cheap
 *  paint-order path (polishTextStrokes). */
function qualifies(t: SVGTextElement): boolean {
  return hasVisibleStroke(t) && !hasFill(t) && (t.textContent ?? '').length > 0;
}

/** Everything that changes the outline GEOMETRY (not its stroke paint). A change here
 *  forces a re-outline; stroke-paint-only changes are re-applied without re-outlining. */
function geomSignature(t: SVGTextElement): string {
  const g = (n: string) => t.getAttribute(n) ?? '';
  return [
    String(fontEpoch), // re-outline once a late-loading font becomes ready
    t.textContent ?? '',
    g('font-family'), g('font-size'), g('font-weight'), g('font-style'),
    g('letter-spacing'), g('text-anchor'), g('text-decoration'), g('transform'),
    g('x'), g('y'), g('dx'), g('dy'), g('textLength'), g('data-area-w'), g('data-area-h'),
    (t.style.textTransform || ''),
  ].join(SIG_SEP);
}

function cacheBefore(t: SVGTextElement): SVGPathElement | null {
  const prev = t.previousElementSibling;
  return prev && prev.hasAttribute(TEXT_STROKE_CACHE_ATTR) ? (prev as SVGPathElement) : null;
}

/** Restore a text to plain rendering: drop its cache path and un-suppress its stroke
 *  (removing the marker makes the CSS suppression rule stop matching). */
function clearOutline(t: SVGTextElement): void {
  cacheBefore(t)?.remove();
  t.removeAttribute(TEXT_STROKE_OUTLINED_ATTR);
}

function applyStrokePresentation(path: SVGPathElement, t: SVGTextElement): void {
  path.setAttribute('fill', 'none');
  for (const a of STROKE_PRESENT) {
    const v = t.getAttribute(a);
    if (v != null) path.setAttribute(a, v); else path.removeAttribute(a);
  }
  // Round joins/caps look best for glyph corners; only default when unset.
  if (!path.getAttribute('stroke-linejoin')) path.setAttribute('stroke-linejoin', 'round');
  if (!path.getAttribute('stroke-linecap')) path.setAttribute('stroke-linecap', 'round');
  const op = t.getAttribute('opacity');
  if (op != null) path.setAttribute('opacity', op); else path.removeAttribute('opacity');
}

/**
 * Reconcile every stroked-no-fill <text> in `layer` with its outline cache. Synchronous
 * and idempotent; re-outlines (async) only when a text's geometry signature changed.
 * Real text shapes only — clones inside appearance/width wrappers are skipped.
 */
export function refreshTextStrokeOutlines(layer: SVGGElement): void {
  ensureFontListener();
  lastLayer = layer;
  const texts = layer.getElementsByTagName('text');
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i] as SVGTextElement;
    // Only real text shapes (id-bearing, not a wrapper clone or a nested render child).
    if (!/^shape-/.test(t.id)) continue;
    if (t.closest('[data-appearance],[data-width]')) continue;

    if (!qualifies(t)) { if (cacheBefore(t) || t.hasAttribute(TEXT_STROKE_OUTLINED_ATTR)) clearOutline(t); continue; }

    // Mark it so the global CSS rule suppresses the browser's own (seam-prone) text
    // stroke — without touching the `stroke` attribute the model reads.
    if (!t.hasAttribute(TEXT_STROKE_OUTLINED_ATTR)) t.setAttribute(TEXT_STROKE_OUTLINED_ATTR, '');

    const sig = geomSignature(t);
    let path = cacheBefore(t);

    if (path && path.getAttribute(GEOM_SIG_ATTR) === sig) {
      // Geometry unchanged — just keep the stroke paint + position in sync (cheap).
      applyStrokePresentation(path, t);
      if (t.previousElementSibling !== path) t.parentNode?.insertBefore(path, t);
      continue;
    }

    // Geometry changed (or first time): re-outline off the render loop.
    if (inflight.has(t.id)) continue;
    inflight.add(t.id);
    const id = t.id;
    void outlineLiveText(t).then((res) => {
      inflight.delete(id);
      // The text may have changed/vanished while we were outlining — re-validate.
      if (!t.isConnected || !qualifies(t)) { if (t.isConnected) clearOutline(t); return; }
      if (!res || 'skip' in (res as object)) return; // can't outline (font missing) → leave suppressed? no:
      const built = res as SVGPathElement;
      const cur = cacheBefore(t);
      built.removeAttribute('id');
      built.setAttribute(TEXT_STROKE_CACHE_ATTR, '');
      built.setAttribute(GEOM_SIG_ATTR, geomSignature(t));
      built.setAttribute('pointer-events', 'none');
      applyStrokePresentation(built, t);
      if (cur) cur.replaceWith(built); else t.parentNode?.insertBefore(built, t);
    }).catch(() => { inflight.delete(id); });
  }
}

/**
 * Normalize a CLONED serialization root (save + export): drop the regenerated cache
 * paths and the suppression marker, leaving plain, standard `<text stroke=…>`. The
 * cache/suppression are live-editor state only — never persisted — so a saved or
 * exported file is self-consistent (its real stroke renders; no doubled stroke if the
 * exporter later outlines the text; no BuzzQuill-only attributes). Reopening re-derives
 * the cache. Mutates the clone in place.
 */
export function normalizeTextStrokesForExport(root: Element): void {
  root.querySelectorAll(`[${TEXT_STROKE_CACHE_ATTR}]`).forEach((p) => p.remove());
  root.querySelectorAll(`text[${TEXT_STROKE_OUTLINED_ATTR}]`)
    .forEach((t) => t.removeAttribute(TEXT_STROKE_OUTLINED_ATTR));
}
