// ---------------------------------------------------------------------------
// Constant-size overlay chrome — THE RULE for every tool that draws selection,
// transform, marquee, or preview outlines on the canvas.
//
// The overlay layers (#selection-layer, guides, etc.) live INSIDE the zoomed
// viewBox, so a raw `stroke-width: 1` chrome stroke renders `zoom`× too thick — an
// 8px-thick "ridiculous box" with giant dashes at 800% zoom. `vector-effect:
// non-scaling-stroke` pins the stroke width AND the dash pattern to device pixels
// at any zoom. (Handle SIZES — radii, box side, font size — are the other half of
// the rule and are scaled per-tool by ÷zoom / the selection overlay's `vscale`.)
//
// Use these helpers instead of hand-setting stroke attributes on chrome, so no
// tool can forget the rule again. Colours come from ui/tokens.ts.
// ---------------------------------------------------------------------------

import { tokens } from './tokens';

const NS = 'http://www.w3.org/2000/svg';

/** Shared id for the drag-select marquee rect (one at a time, across all tools). */
export const MARQUEE_ID = 'marquee-rect';

/**
 * Mark an overlay stroke constant-on-screen: its width and dash pattern stay a
 * fixed device-pixel size at any zoom. Apply to every selection / transform /
 * marquee / preview outline drawn in the canvas overlay layers.
 */
export function markNonScalingStroke(el: SVGElement): void {
  el.setAttribute('vector-effect', 'non-scaling-stroke');
}

/**
 * The one true drag-select marquee rect: a dashed accent box whose border stays a
 * constant width at any zoom. Shared by every marquee tool (Select, Node-edit,
 * Text area box) so they can't drift in style or forget the non-scaling-stroke
 * rule. The caller positions it (x/y/width/height) and appends it to the layer.
 */
export function createMarqueeRect(): SVGRectElement {
  const rect = document.createElementNS(NS, 'rect') as SVGRectElement;
  rect.id = MARQUEE_ID;
  rect.setAttribute('fill', 'rgba(32, 160, 255, 0.08)');
  rect.setAttribute('stroke', tokens.selectionAccent);
  rect.setAttribute('stroke-width', '1');
  rect.setAttribute('stroke-dasharray', '4,3');
  rect.setAttribute('pointer-events', 'none');
  markNonScalingStroke(rect);
  return rect;
}
