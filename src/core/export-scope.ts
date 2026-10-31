// ---------------------------------------------------------------------------
// What an export contains, and where its edges are.
//
// - Hidden layers stay out of the file. A tracing image hidden before export, or
//   the other alternate layouts of a track hidden while one is exported, used to
//   ride along as `display:none` markup — megabytes of base64, and paths that a
//   consumer reading every `d` would pick up anyway.
// - "Fit to paths" bounds: the exported canvas hugs the visible artwork instead of
//   the frame, so the outermost path touches the edge. Only the viewBox moves; the
//   artwork keeps the document's coordinates, so files exported from one frame
//   still share one coordinate space.
// ---------------------------------------------------------------------------

import type { AppState } from './state';
import type { Artboard, BBox, ShapeData } from './types';
import { matrixBetween, visualLocalBBox } from './coords';
import { shapeToPathData } from './shape-adapters';
import { transformPathData } from './path-model';

/** Where an export's canvas edges sit: the frame, or the tight bounds of the
 *  visible path geometry inside it (strokes not included). */
export type ExportBounds = 'frame' | 'paths';

const NS = 'http://www.w3.org/2000/svg';

/** Containers whose children are definitions, not rendered artwork: a hidden
 *  element in one of these still matters to whatever references it. */
const DEFINITION_TAGS = new Set(['defs', 'clippath', 'mask', 'pattern', 'symbol', 'marker', 'filter']);

const isHidden = (el: Element): boolean =>
  el.getAttribute('display') === 'none' || (el as SVGElement).style?.display === 'none';

/**
 * Remove hidden artwork from an export clone of the drawing layer. Anything inside a
 * definition container is left alone, and so is a hidden element something in the
 * clone points at by id (a `<use>` template, a clip source) — removing those would
 * change what renders.
 */
export function stripHiddenForExport(root: Element): void {
  const markup = root.innerHTML;
  const referenced = (id: string) => markup.includes(`#${id}"`) || markup.includes(`#${id})`) || markup.includes(`#${id}'`);
  const visit = (el: Element): void => {
    for (const child of Array.from(el.children)) {
      if (DEFINITION_TAGS.has(child.tagName.toLowerCase())) continue;
      if (isHidden(child) && !(child.id && referenced(child.id))) { child.remove(); continue; }
      visit(child);
    }
  };
  visit(root);
}

const PRIMITIVES = new Set(['path', 'rect', 'ellipse', 'circle', 'line', 'polyline', 'polygon']);

/** A throwaway rendered <svg> to measure transformed geometry in, outside the
 *  document so nothing watching the drawing layer sees it. */
function withScratchPath<T>(d: string, measure: (p: SVGPathElement) => T): T {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('style', 'position:absolute;left:-10px;top:-10px;width:1px;height:1px;overflow:hidden;visibility:hidden');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d);
  svg.appendChild(p);
  document.body.appendChild(svg);
  try { return measure(p); } finally { svg.remove(); }
}

/** Tight geometry bounds of one leaf in drawing-layer space. Under a rotation or
 *  skew a path's own box mapped through the matrix is loose, so its outline is
 *  transformed first and measured as it lands; curves are measured at their true
 *  extremes, never their control points. */
function leafGeometryBox(el: SVGGraphicsElement, layer: SVGGraphicsElement): BBox | null {
  const m = matrixBetween(layer, el);
  if (!m) return null;
  const tag = el.tagName.toLowerCase();
  const turned = Math.abs(m.b) > 1e-9 || Math.abs(m.c) > 1e-9;
  if (PRIMITIVES.has(tag) && turned) {
    const d = shapeToPathData(el);
    if (!d.trim()) return null;
    const b = withScratchPath(transformPathData(d, m), (p) => p.getBBox());
    return b.width > 0 || b.height > 0 ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
  }
  let b: DOMRect | null;
  try { b = PRIMITIVES.has(tag) ? el.getBBox() : visualLocalBBox(el); } catch { return null; }
  if (!b || (b.width <= 0 && b.height <= 0)) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]) {
    const px = m.a * x + m.c * y + m.e, py = m.b * x + m.d * y + m.f;
    minX = Math.min(minX, px); minY = Math.min(minY, py);
    maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * The tight bounds of the visible path geometry inside a frame, in world space,
 * clipped to the frame (what lies outside it isn't exported). Hidden layers and
 * everything under them are skipped. Null when nothing visible has geometry.
 */
export function contentBounds(state: AppState, ab: Artboard): BBox | null {
  const frame = state.findShapeById(ab.id);
  const layer = document.getElementById('drawing-layer') as unknown as SVGGraphicsElement | null;
  if (!frame || !layer) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (shapes: ShapeData[] | undefined): void => {
    for (const s of shapes ?? []) {
      if (!s.visible || isHidden(s.element)) continue;
      if ((s.type === 'group' || s.type === 'frame') && s.children) { visit(s.children); continue; }
      const b = leafGeometryBox(s.element as SVGGraphicsElement, layer);
      if (!b) continue;
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
    }
  };
  visit(frame.children);
  // Clip to the frame.
  minX = Math.max(minX, ab.x); minY = Math.max(minY, ab.y);
  maxX = Math.min(maxX, ab.x + ab.width); maxY = Math.min(maxY, ab.y + ab.height);
  if (!(maxX > minX || maxY > minY) || !Number.isFinite(minX + minY + maxX + maxY)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Round a box OUTWARD to 4 decimals, so it reads cleanly in a viewBox without
 *  shaving the artwork it was measured from. A zero-thickness side (a straight
 *  horizontal path) is given a hairline so the file still has a canvas. */
function outward(b: BBox): BBox {
  const lo = (v: number) => Math.floor(v * 1e4) / 1e4;
  const hi = (v: number) => Math.ceil(v * 1e4) / 1e4;
  const x = lo(b.x), y = lo(b.y);
  const w = Math.max(1e-4, +(hi(b.x + b.width) - x).toFixed(4));
  const h = Math.max(1e-4, +(hi(b.y + b.height) - y).toFixed(4));
  return { x, y, width: w, height: h };
}

/**
 * The rectangle an export of `ab` should cover: the frame itself, or for 'paths'
 * the frame narrowed to its visible path geometry. Returned as an Artboard (same
 * id and name) so every size/viewBox computation downstream works unchanged. Falls
 * back to the frame, with a note, when the frame has no visible geometry.
 */
export function exportRect(state: AppState, ab: Artboard, bounds: ExportBounds | undefined): { rect: Artboard; note?: string } {
  if (bounds !== 'paths') return { rect: ab };
  const b = contentBounds(state, ab);
  if (!b) return { rect: ab, note: `“${ab.name}” has no visible paths to fit — exported at the frame size.` };
  return { rect: { ...ab, ...outward(b) } };
}
