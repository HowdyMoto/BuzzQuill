/**
 * Persistent MASK container outlines on the canvas — the mask counterpart to the
 * frame border. Every mask (clip-group), nested or not, gets a quiet violet DASHED
 * rounded outline hugging its visible (clipped) region, so masks read as containers
 * the same way frames do — without touching the artwork. Bright/labelled state on
 * select/enter is handled by the selection overlay; this is the always-on chrome.
 *
 * Modeled 1:1 on frame-guides.ts: its own #mask-guides-layer (above content, below
 * the selection layer), cleared + fully rebuilt each render, and wired in main.ts on
 * BOTH onStateChange and the view-change hook so it survives undo/redo/rebuild and
 * stays glued to the shapes on pan/zoom.
 */

import type { AppState } from '../core/state';
import { tokens } from './tokens';
import { visualLocalBBox, matrixBetween, matrixAttr } from '../core/coords';

const NS = 'http://www.w3.org/2000/svg';

function layerFor(svgCanvas: SVGSVGElement): SVGGElement {
  let layer = svgCanvas.querySelector('#mask-guides-layer') as SVGGElement | null;
  if (!layer) {
    layer = document.createElementNS(NS, 'g');
    layer.id = 'mask-guides-layer';
    layer.setAttribute('pointer-events', 'none');
    const sel = svgCanvas.querySelector('#selection-layer');
    if (sel?.parentNode) sel.parentNode.insertBefore(layer, sel); // above content, below selection chrome
    else svgCanvas.appendChild(layer);
  }
  return layer;
}

// `_state` is accepted (and passed by callers) for call-site symmetry with
// renderFrameGuides; masks are enumerated straight from the DOM, so it's unused.
export function renderMaskGuides(_state: AppState, svgCanvas: SVGSVGElement, zoom: number): void {
  const layer = layerFor(svgCanvas);
  layer.innerHTML = '';
  if (zoom <= 0) return;
  const drawingLayer = svgCanvas.querySelector('#drawing-layer');
  if (!drawingLayer) return;
  const rx = 2 / zoom; // ~2px rounded corners on screen at any zoom

  drawingLayer.querySelectorAll('g[data-clip-group]').forEach((maskEl) => {
    const el = maskEl as unknown as SVGGraphicsElement;
    const bbox = visualLocalBBox(el); // the VISIBLE clipped region, not the full content
    if (!bbox || (bbox.width === 0 && bbox.height === 0)) return;
    // Place via the mask's full transform chain so a mask nested inside a frame lands correctly.
    const m = matrixBetween(layer, el);
    if (!m) return;
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('transform', matrixAttr(m));
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', String(bbox.x)); rect.setAttribute('y', String(bbox.y));
    rect.setAttribute('width', String(bbox.width)); rect.setAttribute('height', String(bbox.height));
    rect.setAttribute('rx', String(rx)); rect.setAttribute('ry', String(rx));
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', tokens.maskChrome);
    rect.setAttribute('stroke-width', '1');
    rect.setAttribute('stroke-dasharray', '4,3'); // DASHED = mask (redundant with the violet hue)
    rect.setAttribute('opacity', '0.55');
    rect.setAttribute('vector-effect', 'non-scaling-stroke');
    rect.setAttribute('pointer-events', 'none');
    g.appendChild(rect);
    layer.appendChild(g);
  });
}
