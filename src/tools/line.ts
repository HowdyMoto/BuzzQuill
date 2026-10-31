import { BaseTool } from './base';
import type { Point } from '../core/types';
import { showGestureHud, hideGestureHud } from '../ui/gesture-hud';

export class LineTool extends BaseTool {
  name = 'line';
  private drawing = false;
  private startPt: Point = { x: 0, y: 0 };
  private currentEl: SVGLineElement | null = null;
  /** When true (the Arrow tool subclass), the finished line gets an arrowhead marker. */
  protected arrowhead = false;

  onMouseDown(pt: Point, _e: MouseEvent): void {
    this.drawing = true;
    this.startPt = { ...pt };

    const el = document.createElementNS(this.NS, 'line') as SVGLineElement;
    el.setAttribute('x1', String(pt.x));
    el.setAttribute('y1', String(pt.y));
    el.setAttribute('x2', String(pt.x));
    el.setAttribute('y2', String(pt.y));
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', this.state.strokeNone ? 'none' : this.state.defaultStyle.stroke);
    el.setAttribute('stroke-width', String(this.state.defaultStyle.strokeWidth));

    const guidesLayer = this.svgCanvas.querySelector('#guides-layer')!;
    guidesLayer.appendChild(el);
    this.currentEl = el;
  }

  onMouseMove(pt: Point, e: MouseEvent): void {
    if (!this.drawing || !this.currentEl) return;
    showGestureHud('line', e);

    let x2 = pt.x;
    let y2 = pt.y;

    if (e.shiftKey) {
      const dx = pt.x - this.startPt.x;
      const dy = pt.y - this.startPt.y;
      const angle = Math.atan2(dy, dx);
      const snapAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
      const dist = Math.sqrt(dx * dx + dy * dy);
      x2 = this.startPt.x + Math.cos(snapAngle) * dist;
      y2 = this.startPt.y + Math.sin(snapAngle) * dist;
    }

    this.currentEl.setAttribute('x2', String(x2));
    this.currentEl.setAttribute('y2', String(y2));
  }

  onMouseUp(_pt: Point, _e: MouseEvent): void {
    if (!this.drawing || !this.currentEl) return;
    this.drawing = false;
    hideGestureHud();
    const x1 = parseFloat(this.currentEl.getAttribute('x1')!);
    const y1 = parseFloat(this.currentEl.getAttribute('y1')!);
    const x2 = parseFloat(this.currentEl.getAttribute('x2')!);
    const y2 = parseFloat(this.currentEl.getAttribute('y2')!);
    this.currentEl.remove();

    const dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
    if (dist < 2) { this.currentEl = null; return; }

    const el = document.createElementNS(this.NS, 'line') as SVGLineElement;
    const id = this.state.nextId();
    el.id = id;
    el.setAttribute('x1', String(x1));
    el.setAttribute('y1', String(y1));
    el.setAttribute('x2', String(x2));
    el.setAttribute('y2', String(y2));
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', this.state.strokeNone ? 'none' : this.state.defaultStyle.stroke);
    el.setAttribute('stroke-width', String(this.state.defaultStyle.strokeWidth));
    if (this.state.defaultStyle.opacity !== 1) el.setAttribute('opacity', String(this.state.defaultStyle.opacity));

    // An arrow is just a line with the shared arrowhead marker (fill="context-stroke",
    // so it tracks the stroke colour). marker-end round-trips through history; the
    // <marker> def is rebuilt by ensureMarkerDefs after each restore.
    if (this.arrowhead) {
      this.state.ensureMarkerDefs();
      el.setAttribute('marker-end', 'url(#mk-arrow)');
    }

    const name = `${this.arrowhead ? 'Arrow' : 'Line'} ${id.replace('shape-', '')}`;
    el.setAttribute('data-name', name);

    this.state.addShape({
      id, type: 'line', element: el, name,
      style: { ...this.state.defaultStyle, fill: 'none', stroke: this.state.strokeNone ? 'none' : this.state.defaultStyle.stroke },
      visible: true, locked: false,
    }, this.startPt);
    this.currentEl = null;
    this.state.requestTool?.('select'); // return to Select after placing one shape
  }
}
