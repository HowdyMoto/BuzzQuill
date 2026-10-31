/**
 * Bake element transforms into geometry, producing transform-free drawing-layer
 * markup. Some consumers (e.g. TraceCraft) read only raw coordinates and ignore
 * transform attributes, so "Bake Transforms on Export" flattens every rotation/
 * scale/translate into the numbers themselves.
 *
 * Free-geometry shapes (path, polyline, polygon, line) bake exactly — Béziers
 * are affine-invariant. Position/size shapes (rect, ellipse, image, text, use)
 * fold a translate + axis-aligned scale into their attributes; a rotation/skew
 * (or non-uniform text scale) can't be expressed that way, so those keep a
 * single consolidated matrix and are surfaced in `warnings`.
 *
 * The per-type folding itself lives in core/shape-adapters (canFoldMatrix /
 * foldMatrixIntoGeometry) — shared with the resize-commit bake below, so the
 * two can never disagree about what a type can absorb. This module owns POLICY:
 * what to do when a fold isn't possible (export keeps a consolidated matrix and
 * warns; the resize bake leaves the element untouched).
 */

import { stripBooleanOperands } from './boolean';
import { normalizeTextStrokesForExport } from './text-stroke';
import { stripHiddenForExport } from './export-scope';
import { canFoldMatrix, foldMatrixIntoGeometry, type Mat2D, type FoldOpts } from './shape-adapters';

const EPS = 1e-6;

function isApproxIdentity(m: Mat2D): boolean {
  return Math.abs(m.a - 1) < EPS && Math.abs(m.b) < EPS && Math.abs(m.c) < EPS &&
    Math.abs(m.d - 1) < EPS && Math.abs(m.e) < EPS && Math.abs(m.f) < EPS;
}

function r(n: number): string {
  const v = Math.round(n * 1e4) / 1e4;
  return String(v === 0 ? 0 : v);
}

// Tags the fold understands at all — an element outside this set keeps a matrix
// silently (it's not artwork we know how to rewrite; visual result is identical).
const FOLDABLE_TAGS = new Set(['path', 'polyline', 'polygon', 'line', 'rect', 'ellipse', 'circle', 'image', 'use', 'text']);

// ---------------------------------------------------------------------------
// In-place residual-scale baking — the ON-CANVAS half of issue #105.
//
// Multi-select resize (and single resize of a group) moves shapes by writing a
// `translate(…) scale(…)` transform while `stroke-width` stays raw, so the
// rendered stroke silently diverges from the panel's number. At resize commit
// the select tool calls bakeOwnTransform() on each affected shape to fold that
// residual transform into geometry + stroke, exactly like the export bake.
//
// Deliberately conservative: only a translate + axis-aligned scale on plain
// geometry (and plain <g>s whose descendants ALL bake) is folded. Rotated
// shapes (rotation legitimately lives in the transform), wrapper groups
// (frame/boolean/appearance/width/clip/repeat), stroke-align emulation, area
// text, and text-on-a-path keep their transform — they render correctly either
// way.
// ---------------------------------------------------------------------------

const WRAPPER_ATTRS = ['data-frame', 'data-boolean', 'data-appearance', 'data-width', 'data-clip-group', 'data-repeat'];

/** The element's OWN consolidated transform matrix (not ancestors), or null.
 *  Computed by multiplying the items — NEVER via SVGTransformList.consolidate(),
 *  which MUTATES the list into a single matrix item. This runs as a probe at
 *  every resize commit, and that mutation silently destroyed the canonical
 *  `translate(…) rotate(…)` form (getRotation then read 0 on a still-rotated
 *  shape, breaking every later rotation-aware gesture). */
function ownMatrix(el: SVGElement): DOMMatrix | null {
  const list = (el as unknown as SVGGraphicsElement).transform?.baseVal;
  if (!list || list.numberOfItems === 0) return null;
  let m = new DOMMatrix();
  for (let i = 0; i < list.numberOfItems; i++) {
    const im = list.getItem(i).matrix;
    m = m.multiply(new DOMMatrix([im.a, im.b, im.c, im.d, im.e, im.f]));
  }
  return m;
}

/** Can `el` fold matrix `m` cleanly into its geometry (recursing into plain groups)?
 *  Layers the resize bake's conservative POLICY on top of the type capability. */
function canBakeInto(el: SVGElement, m: DOMMatrix): boolean {
  if (el.hasAttribute('data-stroke-align')) return false; // emulated clip would go stale
  // Same hazard, imported rather than generated: a clipPath's contents (and a
  // mask's) are in USER SPACE by default, so folding the geometry moves the artwork
  // out from under a clip that stays exactly where it was. An imported icon whose
  // group carried clip-path vanished completely on resize — geometry rewritten to
  // ~(9..150), clip still sitting at ~(606..637) — while its selection outline and
  // layer rows remained, because the shapes were still there and simply clipped to
  // nothing. Leaving the transform live keeps the clip scaling with the content.
  if (el.hasAttribute('clip-path') || el.hasAttribute('mask')) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'g') {
    if (WRAPPER_ATTRS.some(a => el.hasAttribute(a))) return false;
    // A group-level stroke inherits into children: their geometry would scale
    // while the inherited width stayed raw — leave such groups alone.
    if (el.hasAttribute('stroke-width') || el.hasAttribute('stroke-dasharray')) return false;
    return Array.from(el.children).every(c => {
      const child = c as SVGElement;
      const cm = ownMatrix(child);
      return canBakeInto(child, cm ? m.multiply(cm) : m);
    });
  }
  // Free-geometry types CAN fold rotation, but the resize bake never wants to:
  // rotation legitimately lives in the transform (the app's rotation model).
  if (Math.abs(m.b) > EPS || Math.abs(m.c) > EPS) return false;
  if (tag === 'text' && el.hasAttribute('data-area-w')) return false; // box + wrap need re-flow
  if (!FOLDABLE_TAGS.has(tag)) return false;
  return canFoldMatrix(el, m);
}

/** Fold `m` into `el`'s geometry + stroke (assumes canBakeInto passed). */
function applyBakeInto(el: SVGElement, m: DOMMatrix, opts: FoldOpts = {}): void {
  if (el.tagName.toLowerCase() === 'g') {
    for (const c of Array.from(el.children)) {
      const child = c as SVGElement;
      const cm = ownMatrix(child);
      applyBakeInto(child, cm ? m.multiply(cm) : m, opts);
    }
    el.removeAttribute('transform');
    return;
  }
  foldMatrixIntoGeometry(el, m, opts);
  el.removeAttribute('transform');
}

/**
 * Fold an element's own residual transform (from a multi/group resize) into its
 * geometry and stroke-width, in place. Returns true if the transform was fully
 * folded away; false leaves the element untouched (still renders correctly —
 * baking is a consistency fix, not a requirement).
 */
export function bakeOwnTransform(el: SVGElement, opts: FoldOpts = {}): boolean {
  const m = ownMatrix(el);
  if (!m) return true; // nothing to fold
  if (isApproxIdentity(m)) { el.removeAttribute('transform'); return true; }
  if (!canBakeInto(el, m)) return false;
  applyBakeInto(el, m, opts);
  return true;
}

// ---------------------------------------------------------------------------
// Export baking — flatten a CLONE of the drawing layer for transform-free output.
// ---------------------------------------------------------------------------

export function bakeLayerContent(live: SVGGElement): { content: string; warnings: string[] } {
  const layerCtm = live.getScreenCTM();
  if (!layerCtm) return { content: live.innerHTML, warnings: [] };
  const layerInv = layerCtm.inverse();
  const warnings = new Set<string>();
  const clone = live.cloneNode(true) as SVGGElement;
  bakeChildren(live, clone, layerInv, warnings);
  flattenStrokeAlign(clone, warnings);
  // Live booleans export as just their (now-baked) result path. Strip AFTER the
  // bake walk, which pairs live/clone children by index — removing operands early
  // would misalign that walk for the wrapper.
  stripBooleanOperands(clone);
  // Text-stroke outline caches + their suppression marker are live-editor state; drop
  // them so a baked export is plain <text stroke=…> (otherwise, with no app stylesheet
  // to suppress the text's own stroke, it would double the cache path's stroke).
  normalizeTextStrokesForExport(clone);
  // Hidden layers stay out of the file — after the bake walk, which pairs live and
  // clone children by index.
  stripHiddenForExport(clone);
  return { content: clone.innerHTML, warnings: [...warnings] };
}

/**
 * Inside/outside stroke alignment is emulated with a clip-path + doubled width
 * (see stroke-align.ts). A baked single path can't carry a clip, so revert to a
 * plain centered stroke at the authored width and warn.
 */
function flattenStrokeAlign(root: Element, warnings: Set<string>): void {
  const aligned = root.querySelectorAll('[data-stroke-align]');
  aligned.forEach(el => {
    const w = parseFloat(el.getAttribute('stroke-width') ?? '0');
    if (Number.isFinite(w)) el.setAttribute('stroke-width', String(w / 2));
    el.removeAttribute('data-stroke-align');
    el.removeAttribute('clip-path');
    (el as SVGElement).style?.removeProperty('paint-order');
    if (!el.getAttribute('style')?.trim()) el.removeAttribute('style');
  });
  if (aligned.length) {
    warnings.add('Inside/outside stroke alignment was flattened to centered — a baked single path cannot represent it.');
  }
}

function bakeChildren(live: Element, clone: Element, layerInv: DOMMatrix, warnings: Set<string>): void {
  const lk = live.children, ck = clone.children;
  for (let i = 0; i < lk.length && i < ck.length; i++) {
    bakeElement(lk[i] as SVGElement, ck[i] as SVGElement, layerInv, warnings);
  }
}

function bakeElement(live: SVGElement, clone: SVGElement, layerInv: DOMMatrix, warnings: Set<string>): void {
  const tag = live.tagName.toLowerCase();

  // Groups carry no geometry: strip their transform and bake the children with
  // the full ancestor-inclusive matrix (so position is preserved).
  if (tag === 'g') {
    clone.removeAttribute('transform');
    bakeChildren(live, clone, layerInv, warnings);
    // A frame's editor overflow-dimming mask (url(#framemask-N)) must not survive
    // export: its full-opacity window is at frame-local 0..w/h, but baking just moved
    // the frame's content into WORLD space, so a translated frame's content lands in
    // the mask's dimmed region — every non-origin frame would export at 28% opacity.
    // Drop the mask and hard-clip to the frame bounds instead, baking the frame's own
    // transform into the clip rect so it lands in the same world space as the content.
    if (live.hasAttribute('data-frame')) {
      clone.removeAttribute('mask');
      const screen = (live as unknown as SVGGraphicsElement).getScreenCTM?.();
      const clip = clone.querySelector(':scope > clipPath') as SVGElement | null;
      const rect = clip?.querySelector('rect') as SVGElement | null;
      if (screen && clip?.id && rect) {
        const m = layerInv.multiply(screen); // frame-local -> world (frames are axis-aligned)
        const x = parseFloat(rect.getAttribute('x') || '0'), y = parseFloat(rect.getAttribute('y') || '0');
        const w = parseFloat(rect.getAttribute('width') || '0'), h = parseFloat(rect.getAttribute('height') || '0');
        const p0 = new DOMPoint(x, y).matrixTransform(m), p1 = new DOMPoint(x + w, y + h).matrixTransform(m);
        rect.setAttribute('x', r(Math.min(p0.x, p1.x))); rect.setAttribute('y', r(Math.min(p0.y, p1.y)));
        rect.setAttribute('width', r(Math.abs(p1.x - p0.x))); rect.setAttribute('height', r(Math.abs(p1.y - p0.y)));
        clone.setAttribute('clip-path', `url(#${clip.id})`);
      }
    }
    return;
  }

  const screen = (live as unknown as SVGGraphicsElement).getScreenCTM?.();
  if (!screen) return; // not rendered (e.g. display:none) — leave untouched
  const m = layerInv.multiply(screen); // element-local -> artboard space
  if (isApproxIdentity(m)) { clone.removeAttribute('transform'); return; }

  if (FOLDABLE_TAGS.has(tag) && canFoldMatrix(clone, m)) {
    foldMatrixIntoGeometry(clone, m);
    clone.removeAttribute('transform');
    return;
  }

  // Can't fold (rotation/skew on an attribute-box type, non-uniform text, or an
  // unknown element) — keep a single consolidated matrix so it stays visually
  // correct, and surface known-artwork cases in the warnings.
  clone.setAttribute('transform', `matrix(${r(m.a)} ${r(m.b)} ${r(m.c)} ${r(m.d)} ${r(m.e)} ${r(m.f)})`);
  if (FOLDABLE_TAGS.has(tag)) {
    warnings.add(`<${tag}> kept a transform — its rotation/scale can't bake into ${tag} geometry.`);
  }
}
