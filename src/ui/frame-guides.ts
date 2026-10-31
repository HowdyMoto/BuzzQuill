// ---------------------------------------------------------------------------
// Per-frame guides — the editor grid + optional rulers a frame carries (Figma's
// Layout Grid + rulers). Both are drawn in an overlay ABOVE the frame content (so
// the frame's own white background can't hide them, and, like Figma, the layout
// grid sits over the artwork). Editor chrome only — never exported.
//
// Rulers hug a frame's top & left edges and measure in the frame's OWN coordinates
// (0 at the frame origin) — measurements relative to the artwork, which is what a
// designer reads ("18px from the frame's left edge"). This replaces the old global
// canvas-edge rulers.
//
// Everything is drawn in SVG world space (so it pans/zooms with the frame) but
// sized in screen units via non-scaling strokes and a 1/zoom font, so tick spacing
// and labels stay constant on screen. Re-rendered on document + view changes.
// ---------------------------------------------------------------------------

import type { AppState } from '../core/state';
import type { Artboard } from '../core/types';
import { gridSteps } from '../core/frame-chrome';

const NS = 'http://www.w3.org/2000/svg';

/** Draw a frame's grid as crisp (non-scaling) lines aligned to the frame origin.
 *  px mode: minor lines every `size`, every `subdivisions`-th line stronger.
 *  divisions mode: exactly cols × rows major cells spanning the frame (spacing
 *  derived from the CURRENT frame size), each split into `subdivisions` minor
 *  cells — division boundaries always draw as major lines.
 *  Skipped when the grid would be too dense to be useful. */
function drawFrameGrid(layer: SVGGElement, ab: Artboard): void {
  const g = ab.grid!;
  const { sx, sy } = gridSteps(g, ab.width, ab.height);
  if (sx <= 0 || sy <= 0 || ab.width / sx > 2000 || ab.height / sy > 2000) return; // too fine
  const divisions = g.mode === 'divisions';
  const sub = Math.max(1, g.subdivisions);
  // divisions mode: exact line counts (no float-accumulation stragglers at the edge)
  const nx = divisions ? Math.max(1, g.cols) * sub : Math.floor(ab.width / sx);
  const ny = divisions ? Math.max(1, g.rows) * sub : Math.floor(ab.height / sy);
  const isMajor = (i: number) => (divisions ? i % sub === 0 : g.subdivisions > 1 && i % g.subdivisions === 0);
  const minor: string[] = [], major: string[] = [];
  for (let i = 0; i <= nx; i++) {
    const x = ab.x + i * sx;
    (isMajor(i) ? major : minor).push(`M${x} ${ab.y}V${ab.y + ab.height}`);
  }
  for (let j = 0; j <= ny; j++) {
    const y = ab.y + j * sy;
    (isMajor(j) ? major : minor).push(`M${ab.x} ${y}H${ab.x + ab.width}`);
  }
  const line = (d: string, opacity: string) => {
    if (!d) return;
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', g.color);
    p.setAttribute('stroke-width', '1');
    p.setAttribute('stroke-opacity', opacity);
    p.setAttribute('vector-effect', 'non-scaling-stroke');
    p.setAttribute('pointer-events', 'none');
    layer.appendChild(p);
  };
  line(minor.join(''), '0.16');
  line(major.join(''), '0.3');
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** A "nice" ruler step (…1,2,5,10,20,50…) whose on-screen spacing is ≥ minPx. */
function niceStep(zoom: number, minPx = 46): number {
  const raw = minPx / zoom;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

function layerFor(svgCanvas: SVGSVGElement): SVGGElement {
  let layer = svgCanvas.querySelector('#frame-guides-layer') as SVGGElement | null;
  if (!layer) {
    layer = document.createElementNS(NS, 'g') as SVGGElement;
    layer.id = 'frame-guides-layer';
    layer.setAttribute('pointer-events', 'none');
    const selection = svgCanvas.querySelector('#selection-layer');
    if (selection) svgCanvas.insertBefore(layer, selection);
    else svgCanvas.appendChild(layer);
  }
  return layer;
}

export function renderFrameGuides(state: AppState, svgCanvas: SVGSVGElement, zoom: number): void {
  const layer = layerFor(svgCanvas);
  layer.innerHTML = '';
  if (zoom <= 0) return;

  // Grids first (under the rulers), then rulers on top.
  for (const ab of state.artboards) {
    if (ab.grid && ab.grid.visible) drawFrameGrid(layer, ab);
  }

  const bg = cssVar('--ai-panel-darker', '#171a20');
  const border = cssVar('--ai-border-light', '#3b414f');
  const ink = cssVar('--ai-text-dim', '#868d9b');
  const t = 16 / zoom;        // strip thickness (≈16 screen px)
  const tick = 5 / zoom;      // major tick length
  const font = 10 / zoom;     // ≈10 screen px
  const step = niceStep(zoom);
  // Visible world rect — ticks are clipped to it so a fine grid at high zoom can't
  // generate thousands of off-screen tick/label nodes on every pan.
  const vb = svgCanvas.viewBox.baseVal;
  const hasVB = vb && vb.width > 0 && vb.height > 0;

  for (const ab of state.artboards) {
    if (!ab.rulers) continue;
    const g = document.createElementNS(NS, 'g');

    const strip = (x: number, y: number, w: number, h: number) => {
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', String(x)); r.setAttribute('y', String(y));
      r.setAttribute('width', String(w)); r.setAttribute('height', String(h));
      r.setAttribute('fill', bg);
      r.setAttribute('stroke', border);
      r.setAttribute('stroke-width', '1');
      r.setAttribute('vector-effect', 'non-scaling-stroke');
      g.appendChild(r);
    };
    strip(ab.x, ab.y - t, ab.width, t);       // top
    strip(ab.x - t, ab.y, t, ab.height);      // left
    strip(ab.x - t, ab.y - t, t, t);          // corner

    const tickLine = (x1: number, y1: number, x2: number, y2: number) => {
      const l = document.createElementNS(NS, 'line');
      l.setAttribute('x1', String(x1)); l.setAttribute('y1', String(y1));
      l.setAttribute('x2', String(x2)); l.setAttribute('y2', String(y2));
      l.setAttribute('stroke', ink);
      l.setAttribute('stroke-width', '1');
      l.setAttribute('vector-effect', 'non-scaling-stroke');
      g.appendChild(l);
    };
    const label = (text: string, x: number, y: number, rotate?: number) => {
      const el = document.createElementNS(NS, 'text');
      el.setAttribute('x', String(x)); el.setAttribute('y', String(y));
      el.setAttribute('font-size', String(font));
      el.setAttribute('font-family', 'Arial, sans-serif');
      el.setAttribute('fill', ink);
      if (rotate) el.setAttribute('transform', `rotate(${rotate} ${x} ${y})`);
      el.textContent = text;
      g.appendChild(el);
    };

    // Only step over the ticks that fall in the visible viewport (clamped to the
    // frame), so tick count tracks screen size, not frame-size ÷ step.
    const loX = hasVB ? Math.max(0, Math.floor((vb.x - ab.x) / step) * step) : 0;
    const hiX = hasVB ? Math.min(ab.width, vb.x + vb.width - ab.x) : ab.width;
    const loY = hasVB ? Math.max(0, Math.floor((vb.y - ab.y) / step) * step) : 0;
    const hiY = hasVB ? Math.min(ab.height, vb.y + vb.height - ab.y) : ab.height;

    // Top ruler: ticks + labels at frame-local X values.
    for (let v = loX; v <= hiX + 0.5; v += step) {
      const x = ab.x + v;
      tickLine(x, ab.y - tick, x, ab.y);
      label(String(Math.round(v)), x + 2 / zoom, ab.y - t + font);
    }
    // Left ruler: ticks + vertical labels at frame-local Y values.
    for (let v = loY; v <= hiY + 0.5; v += step) {
      const y = ab.y + v;
      tickLine(ab.x - tick, y, ab.x, y);
      label(String(Math.round(v)), ab.x - t + font, y - 2 / zoom, -90);
    }

    layer.appendChild(g);
  }
}
