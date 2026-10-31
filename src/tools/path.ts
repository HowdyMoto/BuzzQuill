import { tokens } from '../ui/tokens';
import { BaseTool } from './base';
import type { Point } from '../core/types';
import { worldToLocal } from '../core/coords';
import { PathEditSession } from '../core/path-edit';
import { showGestureHud, hideGestureHud } from '../ui/gesture-hud';

interface PathNode {
  point: Point;
  controlIn?: Point;
  controlOut?: Point;
}

export class PathTool extends BaseTool {
  name = 'pen';
  private nodes: PathNode[] = [];
  private previewEl: SVGPathElement | null = null;
  private guidesLayer: Element | null = null;
  private dotEls: SVGElement[] = [];
  private handleEls: SVGElement[] = [];
  private isDragging = false;
  private dragStart: Point | null = null;
  private currentNode: PathNode | null = null;
  private closed = false;

  activate(): void { this.nodes = []; this.closed = false; this.cleanup(); }
  deactivate(): void { this.finishPath(); }

  onMouseDown(pt: Point, e: MouseEvent): void {
    if (e.detail === 2) { if (this.finishPath()) this.state.requestTool?.('select'); return; }

    if (this.nodes.length === 0) {
      // Not mid-draw: clicking on the selected path's anchor deletes it and on
      // a segment inserts a point (Illustrator's Pen +/- behavior).
      if (this.tryEditSelectedPath(pt)) return;
    } else {
      // Mid-draw: clicking near the first node closes the loop — once there are
      // three points to enclose something. Before that a click on the start is
      // nothing (it used to make a zero-area sliver, or discard the path).
      const first = this.nodes[0].point;
      if (Math.hypot(pt.x - first.x, pt.y - first.y) <= this.tolerance()) {
        if (this.nodes.length < 3) return;
        this.closed = true;
        if (this.finishPath()) this.state.requestTool?.('select');
        return;
      }
    }

    this.isDragging = true;
    this.dragStart = { ...pt };
    this.removeDragHandles(); // a new point starts — drop the previous point's tangent chrome
    const constrainedPt = e.shiftKey ? this.constrainToAxis(pt, this.nodes.length > 0 ? this.nodes[this.nodes.length - 1].point : pt) : pt;
    const node: PathNode = { point: { ...constrainedPt } };
    this.currentNode = node;
    this.nodes.push(node);
    showGestureHud(this.penGesture(), e);

    if (!this.guidesLayer) this.guidesLayer = this.svgCanvas.querySelector('#guides-layer')!;
    const dot = document.createElementNS(this.NS, 'circle') as SVGCircleElement;
    dot.setAttribute('cx', String(constrainedPt.x));
    dot.setAttribute('cy', String(constrainedPt.y));
    // Keep the node dot a constant on-screen size: radius in world units = 3 / zoom,
    // and non-scaling-stroke holds its outline at 1px regardless of zoom.
    dot.setAttribute('r', String(3 / this.canvas.getZoom()));
    dot.setAttribute('fill', tokens.selectionAccent);
    dot.setAttribute('stroke', 'white');
    dot.setAttribute('stroke-width', '1');
    dot.setAttribute('vector-effect', 'non-scaling-stroke');
    this.guidesLayer.appendChild(dot);
    this.dotEls.push(dot);
  }

  onMouseMove(pt: Point, e: MouseEvent): void {
    if (this.isDragging && this.currentNode && this.dragStart) {
      let dx = pt.x - this.currentNode.point.x;
      let dy = pt.y - this.currentNode.point.y;

      // Apply shift-constraint to the control handles (perpendicular-snap to horizontal/vertical).
      if (e.shiftKey) {
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        if (absDx > absDy) {
          dy = 0; // snap to horizontal
        } else {
          dx = 0; // snap to vertical
        }
      }

      this.currentNode.controlOut = { x: this.currentNode.point.x + dx, y: this.currentNode.point.y + dy };
      this.currentNode.controlIn = { x: this.currentNode.point.x - dx, y: this.currentNode.point.y - dy };
      this.drawDragHandles(); // show the tangent being pulled out, like Illustrator/Figma
    }
    if (this.nodes.length > 0) { showGestureHud(this.penGesture(), e); this.updatePreview(pt, e); }
  }

  onMouseUp(_pt: Point, _e: MouseEvent): void {
    this.isDragging = false;
    this.dragStart = null;
    this.currentNode = null;
  }

  onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter') { if (this.finishPath()) this.state.requestTool?.('select'); }
    else if (e.key === 'Escape') this.cancelPath();
  }

  /** The gesture chips: the close hint appears only once a close would enclose something. */
  private penGesture(): 'pen' | 'pen-start' {
    return this.nodes.length >= 3 ? 'pen' : 'pen-start';
  }

  /** Abandon the in-progress path without committing a shape. */
  private cancelPath(): void {
    this.cleanup();
    this.nodes = [];
    this.closed = false;
  }

  private buildPathD(nodes: PathNode[], trailingPt?: Point): string {
    if (nodes.length === 0) return '';
    let d = `M ${nodes[0].point.x} ${nodes[0].point.y}`;
    for (let i = 1; i < nodes.length; i++) {
      const prev = nodes[i - 1];
      const curr = nodes[i];
      if (prev.controlOut || curr.controlIn) {
        const cp1 = prev.controlOut ?? prev.point;
        const cp2 = curr.controlIn ?? curr.point;
        d += ` C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${curr.point.x} ${curr.point.y}`;
      } else {
        d += ` L ${curr.point.x} ${curr.point.y}`;
      }
    }
    if (trailingPt && nodes.length > 0) {
      const last = nodes[nodes.length - 1];
      if (last.controlOut) {
        d += ` C ${last.controlOut.x} ${last.controlOut.y}, ${trailingPt.x} ${trailingPt.y}, ${trailingPt.x} ${trailingPt.y}`;
      } else {
        d += ` L ${trailingPt.x} ${trailingPt.y}`;
      }
    }
    return d;
  }

  private updatePreview(currentPt: Point, e?: MouseEvent): void {
    if (!this.guidesLayer) this.guidesLayer = this.svgCanvas.querySelector('#guides-layer')!;
    if (!this.previewEl) {
      this.previewEl = document.createElementNS(this.NS, 'path') as SVGPathElement;
      this.previewEl.setAttribute('fill', 'none');
      this.previewEl.setAttribute('stroke', tokens.selectionAccent);
      this.previewEl.setAttribute('stroke-width', '1.5');
      this.previewEl.setAttribute('stroke-dasharray', '5,5');
      this.previewEl.setAttribute('vector-effect', 'non-scaling-stroke'); // constant 1.5px on screen at any zoom
      this.guidesLayer.appendChild(this.previewEl);
    }

    // If currently dragging with Shift held, snap the trailing preview to nearest axis.
    let trailingPt = currentPt;
    if (this.isDragging && e?.shiftKey && this.dragStart && this.nodes.length > 0) {
      trailingPt = this.constrainToAxis(currentPt, this.nodes[this.nodes.length - 1].point);
    }

    this.previewEl.setAttribute('d', this.buildPathD(this.nodes, this.isDragging ? undefined : trailingPt));
  }

  /** Commit the pen path (returns true) or bail with too few nodes (false). User-
   *  finish gestures switch to Select on true; deactivate() ignores the result. */
  private finishPath(): boolean {
    this.cleanup();
    if (this.nodes.length < 2) { this.nodes = []; this.closed = false; return false; }

    const el = document.createElementNS(this.NS, 'path') as SVGPathElement;
    const id = this.state.nextId();
    el.id = id;
    el.setAttribute('d', this.buildPathD(this.nodes) + (this.closed ? ' Z' : ''));
    el.setAttribute('fill', this.state.fillNone ? 'none' : this.state.defaultStyle.fill);
    el.setAttribute('stroke', this.state.strokeNone ? 'none' : this.state.defaultStyle.stroke);
    el.setAttribute('stroke-width', String(this.state.defaultStyle.strokeWidth));
    if (this.state.defaultStyle.opacity !== 1) el.setAttribute('opacity', String(this.state.defaultStyle.opacity));

    const name = `Path ${id.replace('shape-', '')}`;
    el.setAttribute('data-name', name);

    this.state.addShape({
      id, type: 'path', element: el, name,
      style: { ...this.state.defaultStyle, fill: this.state.fillNone ? 'none' : this.state.defaultStyle.fill, stroke: this.state.strokeNone ? 'none' : this.state.defaultStyle.stroke },
      visible: true, locked: false,
    });
    this.nodes = [];
    this.closed = false;
    return true;
  }

  private cleanup(): void {
    if (this.previewEl) { this.previewEl.remove(); this.previewEl = null; }
    for (const dot of this.dotEls) dot.remove();
    this.dotEls = [];
    this.removeDragHandles();
    hideGestureHud();
  }

  /** Draw the tangent handles of the point being dragged — a line through the anchor
   *  from controlIn to controlOut with a knob at each end — so pulling a smooth curve
   *  out of a click gives the same live feedback as the Pen in Illustrator/Figma. The
   *  chrome stays a constant on-screen size (non-scaling-stroke + zoom-scaled radii).
   *  It persists after release until the next point is placed (see onMouseDown). */
  private drawDragHandles(): void {
    this.removeDragHandles();
    const n = this.currentNode;
    if (!n || (!n.controlIn && !n.controlOut)) return;
    if (!this.guidesLayer) this.guidesLayer = this.svgCanvas.querySelector('#guides-layer')!;
    const ci = n.controlIn ?? n.point, co = n.controlOut ?? n.point;
    const line = document.createElementNS(this.NS, 'line') as SVGLineElement;
    line.setAttribute('x1', String(ci.x)); line.setAttribute('y1', String(ci.y));
    line.setAttribute('x2', String(co.x)); line.setAttribute('y2', String(co.y));
    line.setAttribute('stroke', tokens.selectionAccent);
    line.setAttribute('stroke-width', '1');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    this.guidesLayer.appendChild(line);
    this.handleEls.push(line);
    const rad = 2.6 / this.canvas.getZoom();
    for (const p of [ci, co]) {
      const k = document.createElementNS(this.NS, 'circle') as SVGCircleElement;
      k.setAttribute('cx', String(p.x)); k.setAttribute('cy', String(p.y));
      k.setAttribute('r', String(rad));
      k.setAttribute('fill', 'white');
      k.setAttribute('stroke', tokens.selectionAccent);
      k.setAttribute('stroke-width', '1');
      k.setAttribute('vector-effect', 'non-scaling-stroke');
      this.guidesLayer.appendChild(k);
      this.handleEls.push(k);
    }
  }

  private removeDragHandles(): void {
    for (const el of this.handleEls) el.remove();
    this.handleEls = [];
  }

  /** Constrain a point to the nearest horizontal or vertical line from a reference point. */
  private constrainToAxis(pt: Point, refPt: Point): Point {
    const dx = Math.abs(pt.x - refPt.x);
    const dy = Math.abs(pt.y - refPt.y);
    if (dx > dy) {
      return { x: pt.x, y: refPt.y }; // snap to horizontal
    } else {
      return { x: refPt.x, y: pt.y }; // snap to vertical
    }
  }

  /** Pixel hit tolerance in svg-user units. */
  private tolerance(): number {
    return 8 / this.canvas.getZoom();
  }

  /**
   * Convert an svg-user point (viewBox coords) to an element's local space.
   * Mapping relative to the drawing layer cancels the viewBox offset baked into
   * getCTM().
   */
  private toLocal(pt: Point, el: SVGElement): Point {
    return worldToLocal(this.svgCanvas, el, pt);
  }

  /**
   * If a path is selected and the click lands on one of its anchors or segments,
   * delete/insert a node respectively. Returns true if it handled the click.
   */
  private tryEditSelectedPath(pt: Point): boolean {
    const sel = this.state.getSelectedShape();
    if (!sel || sel.type !== 'path' || sel.locked) return false;
    const d = sel.element.getAttribute('d');
    if (!d) return false;

    const session = new PathEditSession(d);
    const local = this.toLocal(pt, sel.element);
    const tol = this.tolerance();

    const a = session.hitAnchor(local.x, local.y, tol);
    if (a) {
      session.selectOnly(a.sp, a.i);
      if (!session.deleteSelected()) return false;
      this.commitTo(sel.element, session);
      return true;
    }

    const seg = session.hitSegment(local.x, local.y, tol);
    if (seg) {
      session.insertAt(seg);
      this.commitTo(sel.element, session);
      return true;
    }

    return false;
  }

  private commitTo(el: SVGElement, session: PathEditSession): void {
    if (session.isEmpty) {
      this.state.removeShape(el.id);
      return;
    }
    el.setAttribute('d', session.commit());
    this.state.saveHistory();
    this.state.onChange_public();
  }
}
