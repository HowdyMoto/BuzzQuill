import { BaseTool } from './base';
import type { Point } from '../core/types';
import { showGestureHud, hideGestureHud } from '../ui/gesture-hud';
import { radialDrag } from './radial-drag';

export class EllipseTool extends BaseTool {
  name = 'ellipse';
  private drawing = false;
  private startPt: Point = { x: 0, y: 0 };
  private currentEl: SVGEllipseElement | null = null;

  onMouseDown(pt: Point, _e: MouseEvent): void {
    this.drawing = true;
    this.startPt = { ...pt };

    const el = document.createElementNS(this.NS, 'ellipse') as SVGEllipseElement;
    el.setAttribute('cx', String(pt.x));
    el.setAttribute('cy', String(pt.y));
    el.setAttribute('rx', '0');
    el.setAttribute('ry', '0');
    this.applyStyle(el);

    const guidesLayer = this.svgCanvas.querySelector('#guides-layer')!;
    guidesLayer.appendChild(el);
    this.currentEl = el;
  }

  onMouseMove(pt: Point, e: MouseEvent): void {
    if (!this.drawing || !this.currentEl) return;
    showGestureHud('ellipse', e);

    const { cx, cy, rx, ry } = radialDrag(this.startPt, pt, e);
    this.currentEl.setAttribute('cx', String(cx));
    this.currentEl.setAttribute('cy', String(cy));
    this.currentEl.setAttribute('rx', String(rx));
    this.currentEl.setAttribute('ry', String(ry));
  }

  onMouseUp(_pt: Point, _e: MouseEvent): void {
    if (!this.drawing || !this.currentEl) return;
    this.drawing = false;
    hideGestureHud();
    const rx = parseFloat(this.currentEl.getAttribute('rx') ?? '0');
    const ry = parseFloat(this.currentEl.getAttribute('ry') ?? '0');
    this.currentEl.remove();

    if (rx < 1 && ry < 1) { this.currentEl = null; return; }

    const el = document.createElementNS(this.NS, 'ellipse') as SVGEllipseElement;
    const id = this.state.nextId();
    el.id = id;
    el.setAttribute('cx', this.currentEl.getAttribute('cx')!);
    el.setAttribute('cy', this.currentEl.getAttribute('cy')!);
    el.setAttribute('rx', String(rx));
    el.setAttribute('ry', String(ry));
    this.applyStyle(el);

    const name = `Ellipse ${id.replace('shape-', '')}`;
    el.setAttribute('data-name', name);

    this.state.addShape({
      id, type: 'ellipse', element: el, name,
      style: { ...this.state.defaultStyle, fill: this.state.fillNone ? 'none' : this.state.defaultStyle.fill, stroke: this.state.strokeNone ? 'none' : this.state.defaultStyle.stroke },
      visible: true, locked: false,
    }, this.startPt);
    this.currentEl = null;
    this.state.requestTool?.('select'); // return to Select after placing one shape
  }
}
