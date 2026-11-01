import { pointMapperBetween } from '../core/coords';
import { tokens } from './tokens';
import type { AppState } from '../core/state';
import type { SubPath } from '../core/path-model';

const NS = 'http://www.w3.org/2000/svg';
const ACCENT = tokens.selectionAccent;
// Rendering happens on zoom, selection and drag as well as entry. Keep one
// timeline per editing session so rebuilding the overlay never restarts it.
const reveals = new WeakMap<NonNullable<AppState['pathEdit']>, { started: number; canceled: boolean }>();

/** A short stroke highlight whose head reaches each anchor at its pulse peak.
 * Measure each mapped curve separately so unequal segment lengths and transforms
 * do not desynchronize the stroke from the evenly staggered point pulses.
 */
function revealStroke(group: SVGGElement, sp: SubPath, spi: number,
  map: (x: number, y: number) => { x: number; y: number },
  step: number, elapsed: number, zoom: number): void {
  const count = sp.closed ? sp.anchors.length : sp.anchors.length - 1;
  const duration = count * step + 280;
  if (count < 1 || elapsed >= duration) return;
  const point = (x: number, y: number) => { const p = map(x, y); return `${p.x} ${p.y}`; };
  let d = `M ${point(sp.anchors[0].x, sp.anchors[0].y)}`;
  const distances = [0];
  const measure = document.createElementNS(NS, 'path');
  for (let i = 0; i < count; i++) {
    const a = sp.anchors[i], b = sp.anchors[(i + 1) % sp.anchors.length];
    const segment = a.outX === undefined && b.inX === undefined
      ? `L ${point(b.x, b.y)}`
      : `C ${point(a.outX ?? a.x, a.outY ?? a.y)} ${point(b.inX ?? b.x, b.inY ?? b.y)} ${point(b.x, b.y)}`;
    measure.setAttribute('d', `M ${point(a.x, a.y)} ${segment}`);
    distances.push(distances[i] + measure.getTotalLength());
    d += ` ${segment}`;
  }
  const length = distances[count];
  if (!(length > 0)) return;
  // Keep the tail short on screen; never wrap around the beginning of a loop.
  const tail = Math.min(0.18, 36 / (length * zoom));
  // Overlapping, progressively shorter dashes create a fade ALONG the curve.
  // A linear SVG gradient would fade in screen space and point the wrong way on
  // bends or mirrored artwork. Rounded caps soften the small overlapping steps.
  const layers: { span: number; stroke: string; width: number; alpha: number }[] = Array.from({ length: 12 }, (_, i) => ({
    span: tail * (1 - i / 12), stroke: ACCENT,
    width: 2 + 3 * i / 11, alpha: i === 0 ? 0.035 : 0.14,
  }));
  layers.push(
    { span: Math.min(tail / 4, 7 / (length * zoom)), stroke: 'white', width: 2.5, alpha: 0.35 },
    { span: Math.min(tail / 10, 3 / (length * zoom)), stroke: 'white', width: 2, alpha: 1 },
  );
  for (const { span, stroke, width, alpha } of layers) {
    const frames: Keyframe[] = [
      { offset: 0, strokeDashoffset: String(span), opacity: 0 },
      ...distances.map((distance, i) => ({
        offset: (84 + i * step) / duration,
        strokeDashoffset: String(span - distance / length), opacity: 1,
      })),
      { offset: 1, strokeDashoffset: String(span - 1), opacity: 0 },
    ];
    const trail = document.createElementNS(NS, 'path');
    trail.setAttribute('d', d);
    trail.setAttribute('fill', 'none');
    trail.setAttribute('stroke', stroke);
    trail.setAttribute('stroke-width', String(width));
    trail.setAttribute('stroke-opacity', String(alpha));
    trail.setAttribute('stroke-linecap', 'round');
    trail.setAttribute('vector-effect', 'non-scaling-stroke');
    trail.setAttribute('pathLength', '1');
    trail.setAttribute('stroke-dasharray', `${span} ${1 + tail}`);
    trail.setAttribute('pointer-events', 'none');
    trail.setAttribute('aria-hidden', 'true');
    trail.setAttribute('data-node-direction-stroke', String(spi));
    group.appendChild(trail);
    const animation = trail.animate(frames, { duration, easing: 'linear', fill: 'both' });
    animation.currentTime = elapsed;
    animation.onfinish = () => trail.remove();
  }
}

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
  let reveal = reveals.get(session);
  if (!reveal) {
    reveal = { started: performance.now(), canceled: false };
    reveals.set(session, reveal);
  }
  if (state.interactive || matchMedia('(prefers-reduced-motion: reduce)').matches) reveal.canceled = true;
  const elapsed = performance.now() - reveal.started;

  session.model.subpaths.forEach((sp, spi) => {
    // Separate subpaths have separate directions: run them in parallel instead
    // of suggesting a connecting segment between them. Bound dense-path duration.
    const step = Math.min(90, 800 / Math.max(1, sp.anchors.length - (sp.closed ? 0 : 1)));
    if (!reveal.canceled) revealStroke(group, sp, spi, tp, step, elapsed, zoom);
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

      // Non-interactive halo behind the real anchor. All anchors remain visible
      // and hittable from the first frame; no geometry or history is changed.
      const delay = i * step - elapsed;
      if (!reveal.canceled && delay > -280) {
        const halo = document.createElementNS(NS, 'circle');
        halo.setAttribute('cx', String(ap.x)); halo.setAttribute('cy', String(ap.y));
        halo.setAttribute('r', String(6 / zoom));
        halo.style.setProperty('--node-pulse-radius', `${6 / zoom}px`);
        halo.setAttribute('fill', ACCENT);
        halo.setAttribute('pointer-events', 'none');
        halo.setAttribute('aria-hidden', 'true');
        halo.setAttribute('data-node-direction', `${spi}:${i}`);
        halo.classList.add('node-direction-pulse');
        halo.style.animationDelay = `${delay}ms`;
        halo.addEventListener('animationend', () => halo.remove(), { once: true });
        group.appendChild(halo);
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
