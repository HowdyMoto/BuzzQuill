import { createMarqueeRect } from '../ui/overlay-chrome';
import { BaseTool } from './base';
import type { Point } from '../core/types';
import { worldToLocal } from '../core/coords';
import type { AnchorRef, HandleHit } from '../core/path-edit';

/**
 * Direct Selection tool (Illustrator's white arrow). Clicking a path enters a
 * node-editing session; anchors and handles can then be selected, moved, and
 * deleted. Handle drags respect the anchor's type (smooth mirrors, broken/Alt
 * is independent). Alt-dragging a CORNER anchor pulls symmetric tangent handles
 * out of it (Convert Anchor Point — turns it into a smooth spline point, like the
 * Pen tool). Geometry round-trips through the shared {@link PathEditSession}.
 */
export class NodeEditTool extends BaseTool {
  name = 'directSelect';

  private dragAnchor: AnchorRef | null = null;
  private dragHandle: HandleHit | null = null;
  private dragAlt = false;
  // True while an Alt-drag is CONVERTING a corner anchor to smooth (pulling tangents
  // out of it). Distinct from dragAlt: here the held Alt must NOT break the handle —
  // the two tangents mirror as they emerge — so moveHandle is forced into mirror mode.
  private dragConvert = false;
  // Grab offset (anchor − pointer, local space) so a grid-snapped anchor drag keeps
  // the grab point under the cursor instead of teleporting the anchor to it.
  private dragGrabOffset: Point = { x: 0, y: 0 };
  // Grid snap is only sound when the editing element's local space is a pure
  // translation of world space (a rotated/scaled path's local grid would lie).
  private dragSnapOk = false;
  private dirty = false;

  // Rubber-band node selection (coords in svg-user / viewBox space).
  private marquee = false;
  private marqueeStart: Point = { x: 0, y: 0 };
  private marqueeMoved = false;
  private marqueeAdditive = false;
  private marqueeFromEmpty = false;
  private marqueeRect: SVGRectElement | null = null;

  activate(): void {
    // If an editable shape is already selected, jump straight into editing it.
    // enterPathEdit converts a primitive (rect/ellipse/polygon/star/line) to a
    // path; it no-ops (returns false) for shapes that can't be node-edited.
    const sel = this.state.getSelectedShape();
    if (sel) this.state.enterPathEdit(sel.id);
  }

  deactivate(): void {
    // Drop the double-click-return marker FIRST: we're already switching tools, so
    // ending the session below must not ask for a switch of its own (exitPathEdit
    // honours the marker). Harmless during the intended return (already null).
    this.state.nodeEditReturnTool = null;
    if (this.dirty) this.state.commitPathEdit();
    this.resetDrag();
    this.state.exitPathEdit();
  }

  onMouseDown(pt: Point, e: MouseEvent): void {
    // The second press of a double-click reveals the control points (onDoubleClick);
    // don't let it start a marquee or clear the node selection here.
    if (e.detail >= 2) return;

    const session = this.state.pathEdit;
    const editingEl = this.editingElement();

    // ---- Not editing yet: a single click just SELECTS (Figma-style). Selection is
    // frame-transparent — clicking a shape inside a frame selects the SHAPE, not the
    // frame. (The old code entered node-editing immediately AND resolved to the
    // outermost shape ancestor, i.e. the frame, so nothing inside a frame could be
    // picked.) Double-click (onDoubleClick) is what reveals the control points.
    if (!session || !editingEl) {
      const el = this.pickSelect(this.unlockedTarget(e.target as SVGElement, e));
      this.state.selectShape(el?.id ?? null);
      return;
    }

    const local = this.toLocal(pt);
    const tol = this.tolerance();

    // 1) Control handle of a selected anchor.
    const h = session.hitHandle(local.x, local.y, tol * 1.3);
    if (h) {
      this.dragHandle = h;
      this.dragAlt = e.altKey;
      this.dragSnapOk = this.translationOnlySpace();
      this.state.setInteractive(true);
      return;
    }

    // 2) Anchor.
    const a = session.hitAnchor(local.x, local.y, tol);
    if (a) {
      const an = session.anchor(a);
      // Alt-drag a CORNER anchor = Convert Anchor Point: seed coincident tangents,
      // mark it smooth, and start dragging the OUT handle so moveHandle's mirroring
      // pulls symmetric tangents out of the point (like the Pen). A plain drag still
      // just moves the anchor; a no-move Alt-click reverts to corner (see onMouseUp).
      if (e.altKey && an && an.type === 'corner') {
        session.selectOnly(a.sp, a.i);
        an.inX = an.x; an.inY = an.y; an.outX = an.x; an.outY = an.y;
        an.type = 'smooth';
        this.dragHandle = { sp: a.sp, i: a.i, which: 'out' };
        this.dragConvert = true;
        this.dragSnapOk = this.translationOnlySpace();
        this.state.setInteractive(true);
        this.state.onChange_public();
        return;
      }
      if (e.shiftKey) session.toggleSelect(a.sp, a.i);
      else if (!session.isSelected(a.sp, a.i)) session.selectOnly(a.sp, a.i);
      this.dragAnchor = a;
      this.dragGrabOffset = an ? { x: an.x - local.x, y: an.y - local.y } : { x: 0, y: 0 };
      this.dragSnapOk = this.translationOnlySpace();
      this.state.setInteractive(true);
      this.state.onChange_public();
      return;
    }

    // 3) Clicked a DIFFERENT shape while editing: leave vector-edit and select it
    // (single click selects; a double-click would enter ITS control points).
    // Not when the press is within reach of the editing path's own outline, though:
    // that's a press ON it, whatever is topmost under the pointer. Otherwise the
    // first click of a double-click meant to insert a point left the session — over
    // a background image it selected the image (and the double-click opened Crop);
    // where another path overlaps (shared track sections) it switched to that path.
    // Same tolerance onDoubleClick inserts with, so the two always agree.
    const onOwnOutline = session.hitSegment(local.x, local.y, tol * 1.6) !== null;
    const other = onOwnOutline ? null : this.pickSelect(this.unlockedTarget(e.target as SVGElement, e));
    if (other && other.id !== this.state.editingPathId) {
      this.state.exitPathEdit(); // hops back to Select if that's where the edit began
      this.state.selectShape(other.id);
      return;
    }

    // 4) On the editing path's body or empty space: begin a rubber-band select.
    // A drag selects the enclosed nodes; a plain click (no drag) clears the
    // node selection — or, from empty space, exits the path (handled on mouseup).
    this.marquee = true;
    this.marqueeStart = { ...pt };
    this.marqueeMoved = false;
    this.marqueeAdditive = e.shiftKey;
    this.marqueeFromEmpty = !other && !onOwnOutline;
  }

  onMouseMove(pt: Point, e: MouseEvent): void {
    const session = this.state.pathEdit;
    if (!session) return;

    if (this.marquee) {
      const t = 3 / this.canvas.getZoom(); // ~3px drag threshold before it counts
      if (!this.marqueeMoved &&
          (Math.abs(pt.x - this.marqueeStart.x) > t || Math.abs(pt.y - this.marqueeStart.y) > t)) {
        this.marqueeMoved = true;
        this.createMarqueeRect();
      }
      if (this.marqueeMoved) this.updateMarqueeRect(pt);
      return;
    }

    const local = this.toLocal(pt);

    if (this.dragHandle) {
      const { sp, i, which } = this.dragHandle;
      // While CONVERTING a corner (Alt held), force mirror mode — the held Alt must
      // not break the emerging tangents. Otherwise Alt = break an existing handle.
      const alt = this.dragConvert ? false : (this.dragAlt || e.altKey);
      // Spline handles snap to the active frame's grid too (#109); ⌘/Ctrl bypasses.
      const target = this.snapToGrid(local, pt, local, e);
      session.moveHandle(sp, i, which, target.x, target.y, alt);
      this.livePreview();
      return;
    }
    if (this.dragAnchor) {
      const an = session.anchor(this.dragAnchor);
      if (!an) return;
      // Absolute-from-grab targeting: the grabbed anchor tracks the pointer (plus the
      // grab offset) and snaps to the active frame's grid (#109); the rest of the node
      // selection moves rigidly with it. No incremental-delta error accumulates.
      const target = this.snapToGrid(
        { x: local.x + this.dragGrabOffset.x, y: local.y + this.dragGrabOffset.y }, pt, local, e);
      const dx = target.x - an.x;
      const dy = target.y - an.y;
      if (dx !== 0 || dy !== 0) {
        session.moveSelected(dx, dy);
        this.livePreview();
      }
    }
  }

  onMouseUp(pt: Point, _e: MouseEvent): void {
    if (this.marquee) {
      const moved = this.marqueeMoved;
      this.removeMarqueeRect();
      this.marquee = false;
      this.marqueeMoved = false;
      if (moved) this.selectNodesInRect(pt);
      else this.handleMarqueeClick();
      return;
    }
    const wasDragging = !!(this.dragHandle || this.dragAnchor);
    if (wasDragging) this.state.setInteractive(false); // before commit, so it renders fully
    // An Alt-click on a corner that never dragged would leave a degenerate
    // zero-length smooth point — revert it to a corner so the click is a no-op.
    if (this.dragConvert && !this.dirty && this.dragHandle) {
      const an = this.state.pathEdit?.anchor({ sp: this.dragHandle.sp, i: this.dragHandle.i });
      if (an) { an.type = 'corner'; an.inX = an.inY = an.outX = an.outY = undefined; }
      this.state.onChange_public();
    }
    if (this.dirty) this.state.commitPathEdit();
    this.resetDrag();
    if (wasDragging) this.state.onChange_public();
  }

  onKeyDown(e: KeyboardEvent): void {
    const session = this.state.pathEdit;
    if (!session) return;
    if (e.key === 'Escape') { this.state.exitPathEdit(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (session.selected.size > 0 && session.deleteSelected()) {
        this.state.commitPathEdit();
      }
      return;
    }
    // Arrow keys nudge the selected nodes (Shift = 10× step) in the path's local
    // units; each press commits so it's individually undoable.
    if (e.key.startsWith('Arrow') && session.selected.size > 0) {
      const step = e.shiftKey ? 10 : 1;
      let dx = 0, dy = 0;
      if (e.key === 'ArrowLeft') dx = -step;
      else if (e.key === 'ArrowRight') dx = step;
      else if (e.key === 'ArrowUp') dy = -step;
      else if (e.key === 'ArrowDown') dy = step;
      else return;
      e.preventDefault();
      session.moveSelected(dx, dy);
      this.state.commitPathEdit();
    }
  }

  /**
   * Double-click adds or converts: on an anchor it toggles smooth ↔ corner; on a
   * segment it inserts a new anchor at the click point and selects it. Both
   * commit so the change is undoable.
   */
  onDoubleClick(pt: Point, e: MouseEvent): void {
    const session = this.state.pathEdit;

    // Not editing yet: double-click a shape to reveal its control points (enter
    // node-editing, converting a primitive to a path). Shapes that can't be
    // node-edited (group / text / image / frame) simply stay selected.
    if (!session || !this.editingElement()) {
      // Through locked artwork (core/locks.ts): a locked shape's points can't be revealed.
      const el = this.pickEdit(this.unlockedTarget(e.target as SVGElement, e));
      const shape = el ? this.state.findShapeById(el.id) : null;
      if (shape && !this.state.enterPathEdit(shape.id)) this.state.selectShape(shape.id);
      return;
    }

    const local = this.toLocal(pt);
    const tol = this.tolerance();

    const a = session.hitAnchor(local.x, local.y, tol);
    if (a) {
      session.selectOnly(a.sp, a.i);
      const cur = session.anchor(a)?.type;
      session.setSelectedType(cur === 'smooth' ? 'corner' : 'smooth');
      this.state.commitPathEdit();
      return;
    }

    const seg = session.hitSegment(local.x, local.y, tol * 1.6);
    if (seg) {
      const ref = session.insertAt(seg);
      session.selectOnly(ref.sp, ref.i);
      this.state.commitPathEdit();
    }
  }

  // ---- helpers ----

  private livePreview(): void {
    const session = this.state.pathEdit;
    if (!session || !this.editingElement()) return;
    // Write geometry via state so a wrapped vector (variable-width / multi-stroke)
    // updates its SOURCE path AND regenerates its rendered output every frame.
    this.state.applyEditGeometry(session.commit());
    this.dirty = true;
    this.state.onChange_public();
  }

  private resetDrag(): void {
    this.dragAnchor = null;
    this.dragHandle = null;
    this.dragAlt = false;
    this.dragConvert = false;
    this.dirty = false;
    this.marquee = false;
    this.marqueeMoved = false;
    this.removeMarqueeRect();
  }

  // ---- node marquee selection ----

  /** A click (no drag): clear the node selection, or exit if from empty space. */
  private handleMarqueeClick(): void {
    const session = this.state.pathEdit;
    if (!session) return;
    if (this.marqueeFromEmpty) {
      this.state.exitPathEdit();
      this.state.selectShape(null);
    } else {
      session.clearSelection();
      this.state.onChange_public();
    }
  }

  /** Select every anchor whose point falls inside the dragged rectangle. */
  private selectNodesInRect(end: Point): void {
    const session = this.state.pathEdit;
    if (!session) return;
    const a = this.toLocal(this.marqueeStart);
    const b = this.toLocal(end);
    const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    if (!this.marqueeAdditive) session.clearSelection();
    session.model.subpaths.forEach((sp, spi) => {
      sp.anchors.forEach((an, i) => {
        if (an.x >= minX && an.x <= maxX && an.y >= minY && an.y <= maxY) session.addSelect(spi, i);
      });
    });
    this.state.onChange_public();
  }

  private selectionLayer(): SVGGElement | null {
    return this.svgCanvas.querySelector('#selection-layer');
  }

  private createMarqueeRect(): void {
    const layer = this.selectionLayer();
    if (!layer) return;
    const rect = createMarqueeRect(); // shared constant-size chrome — see ui/overlay-chrome
    layer.appendChild(rect);
    this.marqueeRect = rect;
  }

  private updateMarqueeRect(pt: Point): void {
    if (!this.marqueeRect) return;
    const x = Math.min(pt.x, this.marqueeStart.x);
    const y = Math.min(pt.y, this.marqueeStart.y);
    this.marqueeRect.setAttribute('x', String(x));
    this.marqueeRect.setAttribute('y', String(y));
    this.marqueeRect.setAttribute('width', String(Math.abs(pt.x - this.marqueeStart.x)));
    this.marqueeRect.setAttribute('height', String(Math.abs(pt.y - this.marqueeStart.y)));
  }

  private removeMarqueeRect(): void {
    this.marqueeRect?.remove();
    this.marqueeRect = null;
  }

  private editingElement(): SVGElement | null {
    if (!this.state.editingPathId) return null;
    // The GEOMETRY element — the inner source path for a wrapped vector — so pointer
    // math and `d` writes target the actual editable geometry, not the wrapper `<g>`.
    return this.state.editingGeometryEl();
  }

  /** Pixel hit tolerance converted to the path's local units. */
  private tolerance(): number {
    return 7 / this.canvas.getZoom();
  }

  /** True when the editing element's local space is world space plus a pure
   *  translation (unit scale, no rotation/skew) — the only case where snapping
   *  local coordinates to the world-space frame grid is geometrically sound. */
  private translationOnlySpace(): boolean {
    const o = this.toLocal({ x: 0, y: 0 });
    const ux = this.toLocal({ x: 1, y: 0 });
    const uy = this.toLocal({ x: 0, y: 1 });
    const E = 1e-6;
    return Math.abs(ux.x - o.x - 1) < E && Math.abs(ux.y - o.y) < E &&
           Math.abs(uy.x - o.x) < E && Math.abs(uy.y - o.y - 1) < E;
  }

  /** Quantize a local-space target point to the active frame's grid (#109), like the
   *  select tool's drag/resize snap: only when the frame's grid has snapping on, and
   *  bypassed with ⌘/Ctrl. `world`/`local` are the SAME pointer position in the two
   *  spaces — their difference is the (pure) translation between the spaces. */
  private snapToGrid(target: Point, world: Point, local: Point, e: MouseEvent): Point {
    if (!this.dragSnapOk || e.metaKey || e.ctrlKey) return target;
    const grid = this.state.activeGridSnap();
    if (!grid) return target;
    const tx = world.x - local.x, ty = world.y - local.y;
    const q = (v: number, o: number, s: number) => o + Math.round((v - o) / s) * s;
    return { x: q(target.x + tx, grid.ox, grid.sx) - tx, y: q(target.y + ty, grid.oy, grid.sy) - ty };
  }

  /**
   * Convert an svg-user-space point (from canvas.screenToSVG, i.e. viewBox
   * coordinates) to the editing element's local space. Mapping relative to the
   * drawing layer cancels the viewBox offset that getCTM() bakes in.
   */
  private toLocal(pt: Point): Point {
    return worldToLocal(this.svgCanvas, this.editingElement(), pt);
  }

  /** The `shape-*` ancestors of `target`, innermost first, up to #drawing-layer. */
  private shapeChain(target: SVGElement | null): SVGElement[] {
    const chain: SVGElement[] = [];
    let el: SVGElement | null = target;
    while (el) {
      if (el.id && this.state.findShapeById(el.id)) chain.push(el);
      if (el.id === 'drawing-layer') break;
      el = el.parentElement as SVGElement | null;
    }
    return chain;
  }

  /** Shape to SELECT on a click — frame-transparent and group-as-a-unit, matching
   *  the Selection tool: the OUTERMOST non-frame ancestor (so a shape inside a frame
   *  selects the shape, not the frame), or the frame only if nothing else was hit. */
  private pickSelect(target: SVGElement | null): SVGElement | null {
    const chain = this.shapeChain(target);
    if (!chain.length) return null;
    const nonFrame = chain.filter(el => !el.hasAttribute('data-frame'));
    return nonFrame.length ? nonFrame[nonFrame.length - 1] : chain[chain.length - 1];
  }

  /** Shape to node-EDIT on a double-click — the INNERMOST editable (non-frame)
   *  shape under the cursor, so you drill straight to the vector you clicked. */
  private pickEdit(target: SVGElement | null): SVGElement | null {
    const chain = this.shapeChain(target);
    const nonFrame = chain.filter(el => !el.hasAttribute('data-frame'));
    return nonFrame.length ? nonFrame[0] : null;
  }
}
