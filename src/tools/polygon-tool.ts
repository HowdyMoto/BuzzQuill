import { BaseTool } from './base';
import type { Point } from '../core/types';
import { showGestureHud, hideGestureHud } from '../ui/gesture-hud';
import { radialDrag, type DragMods } from './radial-drag';

export class PolygonShapeTool extends BaseTool {
  name = 'polygon';
  private drawing = false;
  private startPt: Point = { x: 0, y: 0 };
  private lastPt: Point = { x: 0, y: 0 };
  private mods: DragMods = { shiftKey: false, altKey: false };
  private previewEl: SVGPolygonElement | null = null;
  private sides = 6;

  onMouseDown(pt: Point, _e: MouseEvent): void {
    this.drawing = true;
    this.startPt = { ...pt };
    this.lastPt = { ...pt };

    const el = document.createElementNS(this.NS, 'polygon') as SVGPolygonElement;
    this.applyStyle(el);
    const guidesLayer = this.svgCanvas.querySelector('#guides-layer')!;
    guidesLayer.appendChild(el);
    this.previewEl = el;
  }

  onMouseMove(pt: Point, e: MouseEvent): void {
    if (!this.drawing || !this.previewEl) return;
    this.lastPt = { ...pt };
    this.mods = { shiftKey: e.shiftKey, altKey: e.altKey };
    showGestureHud('polygon', e);
    this.redraw();
  }

  // Up/Down arrows add or remove polygon sides while drawing; re-render from the
  // last cursor position so it updates without needing a mouse move.
  onKeyDown(e: KeyboardEvent): void {
    if (!this.drawing || !this.previewEl) return;
    if (e.key === 'ArrowUp') this.sides = Math.min(this.sides + 1, 60);
    else if (e.key === 'ArrowDown') this.sides = Math.max(this.sides - 1, 3);
    else return;
    this.mods = { shiftKey: e.shiftKey, altKey: e.altKey };
    e.preventDefault();
    this.redraw();
  }

  private redraw(): void {
    if (!this.previewEl) return;
    // Drag a bounding box from the start corner (Alt = from centre); the polygon
    // fills it, upright. Shift makes the box square → a regular polygon.
    const { cx, cy, rx, ry } = radialDrag(this.startPt, this.lastPt, this.mods);
    const pts = this.calcPolygonPoints(cx, cy, rx, ry, this.sides, -Math.PI / 2);
    this.previewEl.setAttribute('points', pts);
  }

  onMouseUp(_pt: Point, _e: MouseEvent): void {
    if (!this.drawing || !this.previewEl) return;
    this.drawing = false;
    hideGestureHud();
    const ptsStr = this.previewEl.getAttribute('points') ?? '';
    this.previewEl.remove();

    if (!ptsStr || ptsStr.trim().length < 3) {
      this.previewEl = null;
      return;
    }

    const el = document.createElementNS(this.NS, 'polygon') as SVGPolygonElement;
    const id = this.state.nextId();
    el.id = id;
    el.setAttribute('points', ptsStr);
    this.applyStyle(el);
    const name = `polygon ${id.replace('shape-', '#')}`;
    el.setAttribute('data-name', name);

    this.state.addShape({
      id, type: 'polygon', element: el, name,
      style: { ...this.state.defaultStyle, fill: this.state.fillNone ? 'none' : this.state.defaultStyle.fill, stroke: this.state.strokeNone ? 'none' : this.state.defaultStyle.stroke },
      visible: true, locked: false,
    }, this.startPt);
    this.previewEl = null;
    this.state.requestTool?.('select'); // return to Select after placing one shape
  }

  private calcPolygonPoints(
    cx: number, cy: number, rx: number, ry: number, sides: number, startAngle: number,
  ): string {
    const pts: string[] = [];
    for (let i = 0; i < sides; i++) {
      const angle = startAngle + (i * 2 * Math.PI) / sides;
      pts.push(`${cx + rx * Math.cos(angle)},${cy + ry * Math.sin(angle)}`);
    }
    return pts.join(' ');
  }
}
