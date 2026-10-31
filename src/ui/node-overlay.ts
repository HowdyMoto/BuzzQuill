import { pointMapperBetween } from '../core/coords';
import { tokens } from './tokens';
import type { AppState } from '../core/state';

const NS = 'http://www.w3.org/2000/svg';
const ACCENT = tokens.selectionAccent;

/**
 * Render the node-editing overlay (anchors + handles for the path being edited)
 * into #guides-layer. Anchors carry `data-node-anchor="sp:i"` and handle knobs
 * carry `data-node-handle="sp:i:in|out"` for hit-testing by the tools.
 *
 * Each anchor/handle POSITION is mapped through the geometry element's full CTM
 * (element-local → drawing-layer/viewBox space) so it lands correctly even when the
 * geometry sits inside a transformed WRAPPER (multi-stroke / variable-width) or a
 * moved frame — where replicating only the element's own `transform` would be off.
 * Marker SIZES are constant on-screen (÷ zoom), so a wrapper's scale never squishes
 * them and they don't shrink to nothing when you zoom out.
 */
export function renderNodeOverlay(state: AppState, guidesLayer: SVGGElement, zoom = 1): void {
  // Clear any prior node overlay (leave other guides, e.g. pen preview, intact).
  guidesLayer.querySelectorAll('[data-node-overlay]').forEach(el => el.remove());

  const session = state.pathEdit;
  if (!state.editingPathId || !session) return;
  const geomEl = state.editingGeometryEl();
  if (!geomEl) return;

  // element-local → guides-layer (viewBox) space. Matches worldToLocal's basis so
  // the drawn anchors and the hit-testing agree.
  const mapper = pointMapperBetween(guidesLayer, geomEl as unknown as SVGGraphicsElement);
  if (!mapper) return;
  const tp = (x: number, y: number): { x: number; y: number } => {
    return mapper(x, y);
  };

  const group = document.createElementNS(NS, 'g');
  group.setAttribute('data-node-overlay', '1');
  guidesLayer.appendChild(group);

  const A = 3.2 / zoom;   // anchor half-size, constant on screen
  const H = 2.6 / zoom;   // handle knob radius, constant on screen

  session.model.subpaths.forEach((sp, spi) => {
    sp.anchors.forEach((a, i) => {
      const selected = session.isSelected(spi, i);
      const ap = tp(a.x, a.y);

      // Handles + connector lines (only for selected anchors, to reduce clutter).
      if (selected) {
        for (const which of ['in', 'out'] as const) {
          const hx = which === 'in' ? a.inX : a.outX;
          const hy = which === 'in' ? a.inY : a.outY;
          if (hx === undefined || hy === undefined) continue;
          const hp = tp(hx, hy);
          const line = document.createElementNS(NS, 'line');
          line.setAttribute('x1', String(ap.x)); line.setAttribute('y1', String(ap.y));
          line.setAttribute('x2', String(hp.x)); line.setAttribute('y2', String(hp.y));
          line.setAttribute('stroke', ACCENT);
          line.setAttribute('stroke-width', '1');
          line.setAttribute('vector-effect', 'non-scaling-stroke');
          line.setAttribute('pointer-events', 'none');
          group.appendChild(line);

          const knob = document.createElementNS(NS, 'circle');
          knob.setAttribute('cx', String(hp.x)); knob.setAttribute('cy', String(hp.y));
          knob.setAttribute('r', String(H));
          knob.setAttribute('fill', ACCENT);
          knob.setAttribute('stroke', 'white');
          knob.setAttribute('stroke-width', '1');
          knob.setAttribute('vector-effect', 'non-scaling-stroke');
          knob.setAttribute('data-node-handle', `${spi}:${i}:${which}`);
          knob.setAttribute('style', 'cursor: crosshair');
          group.appendChild(knob);
        }
      }

      // Anchor marker: square for corner/broken, diamond for smooth.
      let marker: SVGElement;
      if (a.type === 'smooth') {
        marker = document.createElementNS(NS, 'path');
        const d = A * 1.3;
        marker.setAttribute('d', `M ${ap.x} ${ap.y - d} L ${ap.x + d} ${ap.y} L ${ap.x} ${ap.y + d} L ${ap.x - d} ${ap.y} Z`);
      } else {
        marker = document.createElementNS(NS, 'rect');
        marker.setAttribute('x', String(ap.x - A));
        marker.setAttribute('y', String(ap.y - A));
        marker.setAttribute('width', String(A * 2));
        marker.setAttribute('height', String(A * 2));
      }
      marker.setAttribute('fill', selected ? ACCENT : 'white');
      marker.setAttribute('stroke', ACCENT);
      marker.setAttribute('stroke-width', '1.25');
      marker.setAttribute('vector-effect', 'non-scaling-stroke');
      marker.setAttribute('data-node-anchor', `${spi}:${i}`);
      marker.setAttribute('style', 'cursor: pointer');
      group.appendChild(marker);
    });
  });
}
