import type { Point } from '../core/types';

/** Modifier state that influences a radial-shape drag. */
export interface DragMods { shiftKey: boolean; altKey: boolean }

/**
 * Centre + radii for a radial shape (ellipse / polygon / star) dragged from
 * `startPt` to `pt`, shared so every radial tool draws identically.
 *
 *  - Default: corner-to-corner — `startPt` is one corner of the bounding box,
 *    the shape fills the box (so rx/ry can differ).
 *  - Alt: draw from the centre — `startPt` is the centre, the box grows
 *    symmetrically.
 *  - Shift: constrain to 1:1 (square box → circle / regular polygon), anchored
 *    so the origin never drifts as the mouse moves.
 */
export function radialDrag(
  startPt: Point,
  pt: Point,
  e: DragMods,
): { cx: number; cy: number; rx: number; ry: number } {
  const dx = pt.x - startPt.x;
  const dy = pt.y - startPt.y;

  let rx: number, ry: number, cx: number, cy: number;
  if (e.altKey) {
    rx = Math.abs(dx); ry = Math.abs(dy);
    cx = startPt.x; cy = startPt.y;
  } else {
    rx = Math.abs(dx) / 2; ry = Math.abs(dy) / 2;
    cx = startPt.x + dx / 2; cy = startPt.y + dy / 2;
  }

  if (e.shiftKey) {
    const r = Math.min(rx, ry);
    rx = r; ry = r;
    // Corner mode: re-anchor to the starting corner so the centre (and thus the
    // shape's origin) doesn't slide while the radius is clamped. In centre mode
    // the centre is already pinned to startPt, so nothing to re-anchor.
    if (!e.altKey) {
      cx = startPt.x + Math.sign(dx) * r;
      cy = startPt.y + Math.sign(dy) * r;
    }
  }

  return { cx, cy, rx, ry };
}
