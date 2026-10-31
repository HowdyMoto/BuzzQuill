import { BaseTool } from './base';
import type { Point } from '../core/types';
import { showGestureHud, hideGestureHud } from '../ui/gesture-hud';

export class RectTool extends BaseTool {
  name = 'rect';
  private drawing = false;
  private startPt: Point = { x: 0, y: 0 };
  private currentEl: SVGRectElement | null = null;

  onMouseDown(pt: Point, _e: MouseEvent): void {
    this.drawing = true;
    this.startPt = { ...pt };

    const el = document.createElementNS(this.NS, 'rect') as SVGRectElement;
    el.setAttribute('x', String(pt.x));
    el.setAttribute('y', String(pt.y));
    el.setAttribute('width', '0');
    el.setAttribute('height', '0');
    this.applyStyle(el);

    const guidesLayer = this.svgCanvas.querySelector('#guides-layer')!;
    guidesLayer.appendChild(el);
    this.currentEl = el;
  }

  onMouseMove(pt: Point, e: MouseEvent): void {
    if (!this.drawing || !this.currentEl) return;
    showGestureHud('rect', e);

    let dx = pt.x - this.startPt.x;
    let dy = pt.y - this.startPt.y;
    // Shift: constrain to a square.
    if (e.shiftKey) {
      const size = Math.min(Math.abs(dx), Math.abs(dy));
      dx = dx < 0 ? -size : size;
      dy = dy < 0 ? -size : size;
    }

    let x: number, y: number, w: number, h: number;
    if (e.altKey) {
      // Alt: draw from the center — startPt is the centre, grow symmetrically.
      w = Math.abs(dx) * 2; h = Math.abs(dy) * 2;
      x = this.startPt.x - Math.abs(dx);
      y = this.startPt.y - Math.abs(dy);
    } else {
      w = Math.abs(dx); h = Math.abs(dy);
      x = Math.min(this.startPt.x, this.startPt.x + dx);
      y = Math.min(this.startPt.y, this.startPt.y + dy);
    }

    this.currentEl.setAttribute('x', String(x));
    this.currentEl.setAttribute('y', String(y));
    this.currentEl.setAttribute('width', String(w));
    this.currentEl.setAttribute('height', String(h));
  }

  onMouseUp(_pt: Point, _e: MouseEvent): void {
    if (!this.drawing || !this.currentEl) return;
    this.drawing = false;
    hideGestureHud();
    const w = parseFloat(this.currentEl.getAttribute('width') ?? '0');
    const h = parseFloat(this.currentEl.getAttribute('height') ?? '0');
    this.currentEl.remove();

    if (w < 2 && h < 2) { this.currentEl = null; return; }

    const el = document.createElementNS(this.NS, 'rect') as SVGRectElement;
    const id = this.state.nextId();
    el.id = id;
    el.setAttribute('x', this.currentEl.getAttribute('x')!);
    el.setAttribute('y', this.currentEl.getAttribute('y')!);
    el.setAttribute('width', String(w));
    el.setAttribute('height', String(h));
    this.applyStyle(el);

    const name = `Rectangle ${id.replace('shape-', '')}`;
    el.setAttribute('data-name', name);

    this.state.addShape({
      id, type: 'rect', element: el, name,
      style: { ...this.state.defaultStyle, fill: this.state.fillNone ? 'none' : this.state.defaultStyle.fill, stroke: this.state.strokeNone ? 'none' : this.state.defaultStyle.stroke },
      visible: true, locked: false,
    }, this.startPt);
    this.currentEl = null;
    this.state.requestTool?.('select'); // return to Select after placing one shape
  }
}
