import { isContainerEl } from '../core/shape-props';
import { isLockedEl } from '../core/locks';
import { createMarqueeRect } from '../ui/overlay-chrome';
import { BaseTool } from './base';
import type { Point, ShapeData, BBox } from '../core/types';
import { scalePathData } from '../core/path-model';
import { resizeBox, resizeAnchor, translateShapeGeometry, scalePoints } from '../core/shape-adapters';
import { nudgeTranslate, setRotation, getRotation } from '../core/transform';
import {
  collectSnapTargets, computeSnap, computeResizeSnap, computeResizeSnapProportional,
  drawSnapGuides, clearSnapGuides, SNAP_PX, grabAnchor, collectPointTargets, computePointSnap,
  type SnapTargets,
} from '../core/snapping';
import { localBBoxInLayer, visualWorldBBox, visualLocalBBox, worldToLocal, pathMidFrame, layerDeltaToLocal, layerRotationOf, localBBoxIn, matrixBetween } from '../core/coords';
import { bakeOwnTransform } from '../core/bake';
import { isAreaText, setAreaTextBox } from '../core/area-text';
import { readTextLines } from '../core/text-lines';
import { applyRectBox, setRectRadii } from '../core/rect-shape';
import { regenerateWith, regenerateRing, ringInner } from '../core/parametric';
import { showGestureHud, hideGestureHud } from '../ui/gesture-hud';
import { openFrameRename } from '../ui/frame-renderer';
import { clearFocusedStyle } from '../ui/style-panel';

// Arrow-key nudge tuning. A held key auto-repeats: every NUDGE_RAMP repeats the
// step grows by 1×, capped at NUDGE_MAX_MULT× (so it speeds up but tops out).
// The run commits NUDGE_COMMIT_MS after the last press; the HUD hides NUDGE_HUD_MS after.
const NUDGE_MAX_MULT = 8;
const NUDGE_RAMP = 3;
const NUDGE_COMMIT_MS = 220;
const NUDGE_HUD_MS = 1000;

export class SelectTool extends BaseTool {
  name = 'select';

  // Drag-move state
  private dragging = false;
  // Shapes being dragged, resolved once at drag start so the per-frame move
  // loop doesn't re-walk the shape tree (findShapeById is O(n)) every mousemove.
  private dragShapes: ShapeData[] = [];

  // Smart-guide (snapping) state, captured once at gesture start. Drag uses an
  // absolute-from-origin model (dragStartPt/BBox + appliedDx/Dy) so snapping can
  // align to absolute target lines and we re-derive the incremental translate.
  private dragStartPt: Point = { x: 0, y: 0 };
  private dragStartBBox: BBox | null = null;
  private appliedDx = 0;
  private appliedDy = 0;
  private snapTargets: SnapTargets | null = null;
  // Point snap: the anchor the drag was grabbed by (null when the press wasn't on
  // one) and every other shape's anchors, collected only when there is a grab.
  private grabPoint: Point | null = null;
  private pointTargets: Point[] | null = null;
  private _guidesLayer: SVGGElement | null = null;

  // Resize state
  private resizing = false;
  private resizeHandle = '';
  private resizeOrigBBox: DOMRect | null = null;
  // Local→world translation of resizeOrigBBox. For a single shape it's captured from
  // getBBox() (LOCAL, pre-ancestor-transform), but the snap targets are drawing-layer
  // (world) space; this offset shifts the box into world for the snap comparison so a
  // shape inside a frame doesn't snap to lines offset by the frame's translate. Zero
  // for the multi/frame paths, whose origBBox is already world. (Snap deltas are
  // translation-invariant, so applyResize keeps using the LOCAL box unchanged.)
  /**
   * The resized element's box in DRAWING-LAYER space at drag start.
   *
   * Resize speaks two spaces and they must not be mixed. A LEAF's geometry
   * attributes live in its own user space, so its box and the drag delta are both
   * converted there. A CONTAINER (group/frame) carries a transform rather than
   * geometry, so it scales in world/parent space. Snapping and the grid are always
   * world, and use this box.
   *
   * This replaced a translate-only local→world correction, which silently assumed
   * the mapping between the two spaces was a pure translate: any ancestor scale
   * then multiplied the resize by exactly that scale (a rect inside scale(2) grew
   * 80 units for a 40-unit drag), and compounded when a transform survived between
   * drags.
   */
  private resizeWorldBox: BBox | null = null;
  /** A CONTAINER's box in its PARENT's space — the space its transform is written
   *  in. Null for leaves, which resize in their own space instead. */
  private resizeParentBox: BBox | null = null;

  // Text-on-path start-offset drag: pull the handle along the path to set where text begins.
  private textPathOffsetting = false;
  private textPathEl: SVGTextElement | null = null;
  private textPathGeom: SVGGeometryElement | null = null;
  private resizeStart: Point = { x: 0, y: 0 };
  // Original geometry (path `d` / poly `points`) captured at resize start, so
  // each mousemove scales from the original rather than compounding.
  private resizeOrigGeometry: string | null = null;
  // Original `transform` captured at resize start, used to scale groups (which
  // have no editable geometry) without compounding across mousemoves.
  private resizeOrigTransform: string | null = null;
  // Original text font-size captured at resize start, so font scaling is
  // computed from the start size rather than compounding every mousemove.
  private resizeOrigFontSize = 0;
  // Text baseline offset (baseline y − bbox top) at resize start. The `y` attribute is
  // the BASELINE, not the box bottom, so we re-anchor via this offset — otherwise a
  // horizontal resize (bbox height unchanged) would jump the text down by the descender.
  private resizeOrigBaselineOff = 0;
  // ROTATED-shape resize (single non-group shapes). The overlay's handles sit on the
  // rotated box, so the drag delta must be mapped into the shape's LOCAL (unrotated)
  // axes before the box math — and after each geometry write the rotation is
  // re-pivoted about the NEW bbox centre (the app's canonical pivot), pinning the
  // anchored corner's measured drawing-layer position so the shape never drifts.
  private resizeRotation = 0;
  /** The angle the HANDLES sit at: the element's own rotation composed with every
   *  ancestor's. Distinct from resizeRotation, which is the element's own and is
   *  what gets re-pinned onto the element after a rotated resize. */
  private resizeDeltaAngle = 0;
  private resizeAnchorLocal: Point | null = null;  // fixed corner, element-local
  private resizeAnchorLayer: Point | null = null;  // same corner, drawing-layer space

  // Rotation state
  private rotating = false;
  private rotateCenter: Point = { x: 0, y: 0 };
  private rotateStartAngle = 0;
  private rotateOrigAngle = 0;
  // Local-space rotation pivot, snapshotted at rotate start. The geometry bbox
  // doesn't change while rotating, so this avoids a getBBox() reflow per frame.
  private rotatePivotLocal: Point | null = null;
  // Screen position of a handle mousedown — a release within 3px is a CLICK, not
  // a grab, and falls through to selecting what is under the handle (#223).
  private handleDownScreen: Point | null = null;
  // The shapes a handle gesture (resize / rotate / corner radius) acts on, fixed at
  // mousedown — the handle counterpart of `dragShapes`. Reading the LIVE selection
  // on every mousemove let a selection change mid-drag retarget the gesture: Select
  // All with the mouse still down switched a two-shape resize over to the frame,
  // and Escape froze it half-done (#258).
  private gestureShapes: ShapeData[] = [];

  // Corner-radius drag state (rounded-rect live corner handles)
  private radiusing = false;
  private radiusHandle = '';
  private radiusOrigBBox: DOMRect | null = null;

  // On-canvas offset-stroke drag state (appearance offset handles)
  private offsetting = false;
  private offsetShapeId = '';
  private offsetLayerIdx = -1;
  private offsetSrcEl: SVGElement | null = null;
  private offsetBase: Point = { x: 0, y: 0 };  // path midpoint, local space
  private offsetPerp: Point = { x: 0, y: 0 };  // unit perpendicular, local space

  // Multi-transform state
  private multiOrigTransforms: Map<string, string> = new Map();
  private multiOrigBBoxes: Map<string, DOMRect> = new Map();
  private multiCombinedBBox: DOMRect | null = null;

  // Marquee (rubber-band) selection state
  private marquee = false;
  private marqueeStart: Point = { x: 0, y: 0 };
  private marqueeRect: SVGRectElement | null = null;

  private get guidesLayer(): SVGGElement {
    if (!this._guidesLayer) {
      this._guidesLayer = this.svgCanvas.querySelector('#guides-layer') as SVGGElement;
    }
    return this._guidesLayer;
  }

  /** Capture the snap baseline at drag start: origin point, the combined bbox of
   *  the dragged shapes, and the snap targets (artboard + other objects). */
  private initDragSnap(pt: Point): void {
    this.dragStartPt = { ...pt };
    this.appliedDx = 0;
    this.appliedDy = 0;
    this.dragStartBBox = this.getScreenSpaceBBox(this.dragShapes);
    const movingIds = new Set(this.dragShapes.map(s => s.id));
    this.snapTargets = collectSnapTargets(this.state, movingIds, this.svgCanvas);
    this.grabPoint = grabAnchor(this.dragShapes, pt, SNAP_PX / this.canvas.getZoom(), this.svgCanvas);
    this.pointTargets = this.grabPoint ? collectPointTargets(this.state, movingIds, this.svgCanvas) : null;
  }

  onMouseDown(pt: Point, e: MouseEvent): void {
    // --- Click on a frame's name label selects the frame itself ---
    // Frames are containers: clicking inside selects their contents, so the label
    // is the on-canvas handle for selecting the frame (Figma-style). ⌘/Ctrl still
    // resolves normally so you can reach whatever's under the label if needed.
    const frameLabel = (e.target as Element).closest?.('[data-frame-select]') as SVGElement | null;
    if (frameLabel && !e.metaKey && !e.ctrlKey) {
      const fid = frameLabel.getAttribute('data-frame-select')!;
      if (e.shiftKey) { this.state.toggleMultiSelect(fid); return; }
      this.state.selectShape(fid);
      // The label is the frame's move handle: dragging it moves the frame (a click
      // with no movement just leaves it selected). Clicking inside a frame grabs its
      // contents, so this is the on-canvas way to reposition the frame itself.
      // A locked frame is still selected by its label, but stays put.
      const frame = this.state.findShapeById(fid);
      if (frame && !isLockedEl(frame.element)) {
        this.dragging = true;
        this.state.setInteractive(true);
        this.dragShapes = [frame];
        this.initDragSnap(pt);
      }
      return;
    }

    // --- Handle click on resize/rotate handle ---
    // The overlay draws no handles for a selection holding a locked shape; refuse
    // one anyway, so a stale overlay can't reach past the lock.
    const handle = (e.target as SVGElement).getAttribute?.('data-handle');
    if (handle && this.state.selectedShapeId && !this.getSelectedShapes().some(s => isLockedEl(s.element))) {
      // Screen anchor for the zero-drag click-through check in onMouseUp (#223).
      this.handleDownScreen = { x: e.clientX, y: e.clientY };
      const isMulti = this.state.selectedShapeIds.length > 1;
      const shapes = this.getSelectedShapes();
      this.gestureShapes = shapes;

      // Snapshot original transforms for multi-transform operations
      if (isMulti) {
        this.multiOrigTransforms.clear();
        this.multiOrigBBoxes.clear();
        for (const s of shapes) {
          this.multiOrigTransforms.set(s.id, s.element.getAttribute('transform') ?? '');
          try {
            this.multiOrigBBoxes.set(s.id, s.element.getBBox());
          } catch { /* skip */ }
        }
        this.multiCombinedBBox = this.getScreenSpaceBBox(shapes);
      }

      if (handle.startsWith('radius-')) {
        // Live corner-radius drag — single rounded-rect only.
        this.radiusing = true;
        this.state.setInteractive(true);
        this.radiusHandle = handle;
        this.radiusOrigBBox = shapes[0].element.getBBox();
        return;
      }

      if (handle.startsWith('offset-')) {
        // Live parallel-offset drag — pull an offset stroke's line sideways.
        if (this.beginOffsetDrag(handle, shapes[0])) return;
      }

      if (handle === 'text-path-offset') {
        // Live drag of a text-on-path's start offset along the path.
        if (this.beginTextPathOffsetDrag(shapes[0])) return;
      }

      if (handle === 'rotate') {
        // Frames stay axis-aligned (export/rulers/grid depend on it), so no rotate
        // handle is drawn for them; guard here too in case one is ever triggered.
        if (shapes.some(s => s.type === 'frame')) return;
        this.rotating = true;
        this.state.setInteractive(true);
        if (isMulti) {
          const cb = this.multiCombinedBBox!;
          this.rotateCenter = { x: cb.x + cb.width / 2, y: cb.y + cb.height / 2 };
          this.rotateStartAngle = Math.atan2(pt.y - this.rotateCenter.y, pt.x - this.rotateCenter.x) * 180 / Math.PI;
          this.rotateOrigAngle = 0;
        } else {
          const shape = shapes[0];
          const bbox = shape.element.getBBox();
          this.rotateCenter = { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
          this.rotatePivotLocal = { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
          this.rotateStartAngle = Math.atan2(pt.y - this.rotateCenter.y, pt.x - this.rotateCenter.x) * 180 / Math.PI;
          this.rotateOrigAngle = shape.rotation ?? 0;
        }
        return;
      }

      this.resizing = true;
      this.state.setInteractive(true);
      this.resizeHandle = handle;
      this.resizeStart = { ...pt };
      this.resizeOrigGeometry = null;
      this.resizeOrigTransform = null;
      this.resizeRotation = 0;
      this.resizeDeltaAngle = 0;
      this.resizeWorldBox = null;
      this.resizeParentBox = null;
      this.resizeAnchorLocal = null;
      this.resizeAnchorLayer = null;
      if (isMulti) {
        this.resizeOrigBBox = this.multiCombinedBBox!;
        // Already world — a multi-selection has no single local space.
        this.resizeWorldBox = { x: this.resizeOrigBBox.x, y: this.resizeOrigBBox.y,
                                width: this.resizeOrigBBox.width, height: this.resizeOrigBBox.height };
      } else if (shapes[0].type === 'frame') {
        // A frame resizes its own bounds (not its children), so start from its WORLD
        // rect — getBBox() would return the children's union (incl. overflow).
        const ab = this.state.getArtboardById(shapes[0].id);
        this.resizeOrigBBox = ab
          ? new DOMRect(ab.x, ab.y, ab.width, ab.height)
          : shapes[0].element.getBBox();
        // The artboard rect is already world space.
        this.resizeWorldBox = { x: this.resizeOrigBBox.x, y: this.resizeOrigBBox.y,
                                width: this.resizeOrigBBox.width, height: this.resizeOrigBBox.height };
      } else {
        const el = shapes[0].element;
        // Resize from the VISIBLE box (crop viewport / clip-group mask ∩ content) so
        // the handles match the selection box; plain getBBox for ordinary shapes.
        const raw = el.getBBox();
        this.resizeOrigBBox = visualLocalBBox(el) ?? raw;
        // getBBox() is LOCAL; capture the local→world translate (from the raw box, which
        // localBBoxInLayer also derives from) so the resize snap isn't offset by the frame.
        // The TRUE world box — not the local one nudged by a translate. Snapping,
        // the grid and container scaling all measure against this.
        this.resizeWorldBox = localBBoxInLayer(this.svgCanvas, el);
        const tag = el.tagName.toLowerCase();
        if (tag === 'path') this.resizeOrigGeometry = el.getAttribute('d');
        else if (tag === 'polyline' || tag === 'polygon') this.resizeOrigGeometry = el.getAttribute('points');
        else if (tag === 'g') this.resizeOrigTransform = el.getAttribute('transform');
        else if (tag === 'text') {
          this.resizeOrigFontSize = parseFloat(el.getAttribute('font-size') ?? '24');
          this.resizeOrigBaselineOff = (parseFloat(el.getAttribute('y') ?? '0') || 0) - (this.resizeOrigBBox?.y ?? 0);
        }
        // Rotated shape (not a group — groups resize via their composed transform):
        // capture the angle and the anchored corner, both element-local and where it
        // sits in the drawing layer, so each frame can re-pin it after re-pivoting.
        this.resizeRotation = tag !== 'g' ? getRotation(el) : 0;
        // The overlay draws the handles on the element's local box mapped through
        // the FULL local→layer matrix, so the drag must be de-rotated by that whole
        // angle. Using only the element's own rotation left an ancestor's rotation
        // in the delta, which then projected onto the local axis and lost
        // cos(theta) — the shape lagged the pointer inside a rotated group (#273).
        // A CONTAINER writes a transform in its PARENT's space, so that — not world
        // space — is where its box and delta belong. Its handles sit at the parent's
        // rotation (the group's own transform carries no rotation: resizeRotation is
        // forced to 0 for a <g>), so that is the angle to de-rotate the drag by.
        const parentEl = el.parentNode as unknown as SVGGraphicsElement | null;
        this.resizeParentBox = tag === 'g' && parentEl
          ? localBBoxIn(parentEl, el)
          : null;
        this.resizeDeltaAngle = tag !== 'g'
          ? layerRotationOf(this.svgCanvas, el)
          : (parentEl ? layerRotationOf(this.svgCanvas, parentEl) : 0);
        if (this.resizeRotation && this.resizeOrigBBox) {
          const a = resizeAnchor(this.resizeOrigBBox, handle);
          this.resizeAnchorLocal = { x: a.fx, y: a.fy };
          this.resizeAnchorLayer = this.localPointToLayer(el, a.fx, a.fy);
        } else {
          this.resizeAnchorLocal = null;
          this.resizeAnchorLayer = null;
        }
      }
      this.snapTargets = collectSnapTargets(
        this.state, new Set(this.state.selectedShapeIds), this.svgCanvas,
      );
      return;
    }

    // --- Check if clicking on a shape ---
    // Seen through locked artwork: a press on a locked shape lands on what's under it.
    const target = this.unlockedTarget(e.target as SVGElement, e);

    // If you press on something that's already selected, drag the CURRENT
    // selection as-is instead of re-resolving the click to a group. Without this,
    // selecting a subset of a group's children (e.g. in the Layers panel) and
    // dragging would collapse to "the whole group" and move every sibling. Also
    // lets a single child picked in the panel be moved without a double-click.
    // Shift/Alt/⌘/Ctrl keep their normal roles (extend selection / deep-select).
    // Locked members never drag — a locked image picked in the Layers panel is
    // nested in its frame, so this path used to move it on the first press.
    if (!e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && this.state.selectedShapeIds.length >= 1) {
      const selected = this.getSelectedShapes().filter(s => !isLockedEl(s.element));
      const pressedSelected = selected.some(s => s.element.contains(target));
      // Only short-circuit when it changes the outcome: a multi-selection, or a
      // single nested child (whose click would otherwise resolve to its group).
      if (pressedSelected && (selected.length > 1 || !!selected[0]?.parentId)) {
        this.dragging = true;
        this.state.setInteractive(true);
        this.dragShapes = selected;
        this.initDragSnap(pt);
        return;
      }
    }

    // Alt-click OR ⌘/Ctrl-click selects the innermost object under the cursor
    // directly (Figma's deep select) — no drilling through group levels.
    const deep = (e.altKey || e.metaKey || e.ctrlKey) && !e.shiftKey;
    let shapeEl = this.findShapeElement(target, { deep });

    // A closed path with fill:none is only a few stroke pixels wide to the browser's
    // native SVG hit-test. That made outlined imported artwork look selectable but
    // behave like empty canvas unless the user landed exactly on its hairline (#260).
    // When the native target found no artwork (or only the click-transparent frame),
    // fall back to the topmost closed outline whose rendered box contains the point.
    // Feed the leaf back through normal group/isolation resolution so this changes
    // only hit detection, not the editor's selection semantics.
    if (!shapeEl || shapeEl.hasAttribute('data-frame')) {
      const outline = this.topmostClosedOutlineAt(pt);
      if (outline) shapeEl = this.findShapeElement(outline.element, { deep });
    }

    // Clicking outside the entered group leaves isolation, then re-resolves at
    // the top level so the click selects whatever was actually hit.
    if (this.state.activeGroupId && shapeEl && !this.isInActiveGroup(shapeEl)) {
      this.state.exitGroupIsolation();
      shapeEl = this.findShapeElement(target, { deep });
    }

    // The SELECTION BOX is a grab area. A press inside the selected shapes' box
    // that landed on nothing selectable — or fell through to the click-transparent
    // frame background — drags the selection instead of deselecting / selecting
    // the frame. Without this a stroke-only path (fill:none) can't be grabbed at
    // all except by hitting its hairline stroke: its hollow interior isn't hit-
    // tested. A real shape under the point still wins (it's what you see).
    if (!e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && e.button === 0 &&
        (!shapeEl || shapeEl.hasAttribute('data-frame')) && this.state.selectedShapeIds.length >= 1) {
      const selected = this.getSelectedShapes().filter(s => s.type !== 'frame' && !isLockedEl(s.element));
      if (selected.length > 0) {
        const box = this.getScreenSpaceBBox(selected);
        if (pt.x >= box.x && pt.x <= box.x + box.width && pt.y >= box.y && pt.y <= box.y + box.height) {
          this.dragging = true;
          this.state.setInteractive(true);
          this.dragShapes = selected;
          this.initDragSnap(pt);
          return;
        }
      }
    }

    if (shapeEl) {
      // Adobe-style: Shift+click toggles add/remove from selection
      if (e.shiftKey) {
        this.state.toggleMultiSelect(shapeEl.id);
      } else {
        // If clicking on an already-selected shape in a multi-selection, keep multi
        if (this.state.selectedShapeIds.includes(shapeEl.id) && this.state.selectedShapeIds.length > 1) {
          // Don't change selection, just start dragging the group
        } else {
          this.state.selectShape(shapeEl.id);
        }
      }

      this.dragging = true;
      this.state.setInteractive(true);
      // Resolve the dragged shapes once; reused every mousemove frame. Locked
      // members of a multi-selection stay put while the rest move.
      this.dragShapes = this.state.selectedShapeIds
        .map(id => this.state.findShapeById(id))
        .filter((s): s is ShapeData => s !== null && !isLockedEl(s.element));
      this.initDragSnap(pt);
    } else {
      // Clicked on empty space
      const isCanvas = target.id === 'canvas-bg' || target.id === 'canvas-grid' ||
        target.closest('#canvas-bg') !== null || target.closest('#canvas-grid') !== null ||
        target.closest('#artboards-layer') !== null || target.id === 'pasteboard';

      if (isCanvas) {
        // Clicking empty canvas leaves group isolation.
        this.state.exitGroupIsolation();
        if (e.button === 1) {
          this.canvas.startPan(e.clientX, e.clientY);
        } else {
          // Clicking empty canvas is the universal "clear" gesture, so it also drops
          // the library style being edited — nothing ever cleared it before, and the
          // Style panel stuck around forever.
          //
          // Only on EMPTY canvas, never on a shape: the Style panel's own button says
          // "Select objects on the canvas first", so clicking a shape while a style is
          // focused is a step IN that flow, not an exit from it.
          //
          // Outside the shift guard on purpose. Shift preserves the SHAPE selection;
          // it says nothing about the style being edited, and having the two disagree
          // would be a distinction no one could predict.
          clearFocusedStyle();
          // Start marquee selection (unless shift is held, which preserves existing selection)
          if (!e.shiftKey) {
            this.state.selectShape(null);
          }
          this.marquee = true;
          this.marqueeStart = { ...pt };
          this.createMarqueeRect(pt);
        }
      }
    }
  }

  onMouseMove(pt: Point, e: MouseEvent): void {
    // --- Marquee drag ---
    if (this.marquee) {
      this.updateMarqueeRect(pt);
      return;
    }

    // Publish the active gesture so the selection overlay's dimension badge can show
    // the angle while rotating / position while moving instead of W×H (cleared on up).
    this.state.activeGesture = this.rotating ? 'rotate' : this.resizing ? 'resize' : this.dragging ? 'move' : null;

    // --- Corner radius ---
    if (this.radiusing && this.radiusOrigBBox) {
      const shape = this.gestureShapes[0];
      if (!shape) return;
      const bb = this.radiusOrigBBox;
      const corner = this.radiusHandle.slice(7); // 'radius-' is 7 chars
      // Inward distance from the dragged corner along each axis (best-fit radius
      // is the average, so the handle tracks the cursor down the diagonal).
      const sx = corner.includes('w') ? pt.x - bb.x : (bb.x + bb.width) - pt.x;
      const sy = corner.includes('n') ? pt.y - bb.y : (bb.y + bb.height) - pt.y;
      const maxR = Math.min(bb.width, bb.height) / 2;
      let r = Math.max(0, Math.min((sx + sy) / 2, maxR));
      r = Math.round(r * 10) / 10;
      // Uniform radius via the on-canvas handle — works whether the shape is a plain
      // <rect> or a parametric per-corner <path data-rect> (sets all four corners).
      setRectRadii(shape.element, [r, r, r, r]);
      shape.style.rx = r;
      this.state.onChange_public();
      return;
    }

    // --- Offset stroke drag ---
    if (this.offsetting) { this.updateOffsetDrag(pt, false); return; }
    if (this.textPathOffsetting) { this.updateTextPathOffset(pt, false); return; }

    // --- Rotation ---
    if (this.rotating) {
      showGestureHud('rotate', e);
      const currentAngle = Math.atan2(pt.y - this.rotateCenter.y, pt.x - this.rotateCenter.x) * 180 / Math.PI;
      let deltaAngle = currentAngle - this.rotateStartAngle;
      if (e.shiftKey) {
        deltaAngle = Math.round((this.rotateOrigAngle + deltaAngle) / 15) * 15 - this.rotateOrigAngle;
      }
      deltaAngle = Math.round(deltaAngle * 10) / 10;

      if (this.gestureShapes.length > 1) {
        this.applyMultiRotation(deltaAngle);
      } else {
        const shape = this.gestureShapes[0];
        if (!shape) return;
        shape.rotation = this.rotateOrigAngle + deltaAngle;
        this.applyRotation(shape, this.rotatePivotLocal ?? undefined);
      }
      this.state.onChange_public();
      return;
    }

    // --- Resize ---
    if (this.resizing && this.resizeOrigBBox) {
      let dx = pt.x - this.resizeStart.x;
      let dy = pt.y - this.resizeStart.y;
      if (Math.hypot(dx, dy) > 3 / this.canvas.getZoom()) showGestureHud('resize', e); // a real drag, not a jittery click
      // ROTATED box: the handles sit on it, so the drag must act along the shape's
      // LOCAL axes — rotate the world delta by −angle before any box math. The angle
      // is the whole local→layer rotation, so it covers a rotation held by an
      // ANCESTOR just as well as one on the element. (World-axis grid/edge snapping
      // is skipped below: a rotated box has no world-aligned edges to snap.)
      if (this.resizeDeltaAngle) {
        const r = (this.resizeDeltaAngle * Math.PI) / 180;
        const cos = Math.cos(r), sin = Math.sin(r);
        const ldx = cos * dx + sin * dy;
        const ldy = -sin * dx + cos * dy;
        dx = ldx; dy = ldy;
      }
      // Constrain proportions when the aspect lock (issue #106) is on, OR Shift is
      // held — and Shift INVERTS the lock, so it's the momentary "free resize"
      // escape hatch while locked (Illustrator-style).
      const proportional = this.state.aspectLocked !== e.shiftKey;
      if (proportional) {
        const c = this.constrainProportional(dx, dy);
        dx = c.dx; dy = c.dy;
      }
      // Smart-guide snapping of the dragged edge(s). When proportional we still
      // snap, but proportionally so the ratio is preserved. Grid snap is skipped
      // while proportional (it would fight the ratio); both bypass ⌘/Ctrl.
      const gridR = !(e.metaKey || e.ctrlKey) && !proportional && !this.resizeDeltaAngle
        ? this.state.activeGridSnap() : null;
      const snapResize = this.state.snapEnabled && !(e.metaKey || e.ctrlKey) && !this.resizeDeltaAngle;
      if (gridR) {
        // Quantize the moving edge(s) of the resize to the frame grid (per-axis
        // spacing — a divisions grid's columns and rows can differ). The grid is
        // world space, so measure the moving edge on the WORLD box.
        const h = this.resizeHandle, o = this.resizeWorldBox ?? this.resizeOrigBBox;
        const q = (v: number, base: number, s: number) => base + Math.round((v - base) / s) * s;
        if (h.includes('e')) { const edge = o.x + o.width + dx; dx += q(edge, gridR.ox, gridR.sx) - edge; }
        else if (h.includes('w')) { const edge = o.x + dx; dx += q(edge, gridR.ox, gridR.sx) - edge; }
        if (h.includes('s')) { const edge = o.y + o.height + dy; dy += q(edge, gridR.oy, gridR.sy) - edge; }
        else if (h.includes('n')) { const edge = o.y + dy; dy += q(edge, gridR.oy, gridR.sy) - edge; }
        clearSnapGuides(this.guidesLayer);
      } else if (snapResize && this.snapTargets) {
        // Snap targets are world space, and so is the box we measure against.
        const worldOrig: BBox = this.resizeWorldBox ?? {
          x: this.resizeOrigBBox.x, y: this.resizeOrigBBox.y,
          width: this.resizeOrigBBox.width, height: this.resizeOrigBBox.height,
        };
        const r = proportional
          ? computeResizeSnapProportional(
              worldOrig, dx, dy, this.resizeHandle,
              this.snapTargets, SNAP_PX / this.canvas.getZoom(),
            )
          : computeResizeSnap(
              worldOrig, dx, dy, this.resizeHandle,
              this.snapTargets, SNAP_PX / this.canvas.getZoom(),
            );
        dx = r.dx; dy = r.dy;
        drawSnapGuides(this.guidesLayer, r.guides);
      } else {
        clearSnapGuides(this.guidesLayer);
      }
      if (this.gestureShapes.length > 1) {
        this.applyMultiResize(dx, dy);
      } else {
        const shape = this.gestureShapes[0];
        if (!shape) return;
        // ONE rule, applied here so applyResize never has to guess: a CONTAINER
        // (group/frame) writes a transform, so it scales in world space against its
        // world box; a LEAF writes geometry, so both its box and the delta belong in
        // its own user space. Mixing the two is what made an ancestor's scale
        // multiply every drag.
        const el = shape.element;
        const container = shape.type === 'frame' || el.tagName.toLowerCase() === 'g';
        let box: DOMRect = this.resizeOrigBBox;
        let ddx = dx, ddy = dy;
        if (container) {
          // Parent space for both, so the ratio is a true ratio in the space the
          // transform is written in. Measuring the box in WORLD space while the
          // handles sat on an ancestor-rotated box is what cost the drag cos(theta)
          // for groups (#273). Frames are top-level, so for them the two coincide.
          const parentEl = el.parentNode as unknown as SVGGraphicsElement | null;
          const pb = this.resizeParentBox;
          if (pb && parentEl) {
            box = new DOMRect(pb.x, pb.y, pb.width, pb.height);
            const conv = this.resizeDeltaToLocal(parentEl, dx, dy);
            ddx = conv.dx; ddy = conv.dy;
          } else {
            const wb = this.resizeWorldBox;
            if (wb) box = new DOMRect(wb.x, wb.y, wb.width, wb.height);
          }
        } else {
          // The element's own rotation is already folded into the delta above, so
          // strip it from the mapping here or it would be applied twice.
          const conv = this.resizeDeltaToLocal(el, dx, dy);
          ddx = conv.dx; ddy = conv.dy;
        }
        this.applyResize(shape.element, shape.type, box, ddx, ddy, this.resizeHandle);
        if (this.resizeRotation) this.fixRotatedResizePivot(shape.element);
      }
      this.state.onChange_public();
      return;
    }

    // --- Drag move (snap-aware, absolute-from-origin) ---
    if (this.dragging) {
      const rawDx = pt.x - this.dragStartPt.x;
      const rawDy = pt.y - this.dragStartPt.y;
      if (Math.hypot(rawDx, rawDy) > 3 / this.canvas.getZoom()) showGestureHud('move', e); // a real drag, not a jittery click
      let totalDx = rawDx, totalDy = rawDy;

      // Grid snap (active frame's grid) takes precedence: it quantizes the edge of
      // the selection FACING the drag direction to the grid (#109) — moving right
      // snaps the right edge onto a gridline, moving left the left edge, and same
      // vertically — continuously while dragging. Bypassed with ⌘/Ctrl.
      const grid = !(e.metaKey || e.ctrlKey) ? this.state.activeGridSnap() : null;
      const snapOn = this.state.snapEnabled && !(e.metaKey || e.ctrlKey);
      // A drag grabbed by an anchor snaps that anchor onto another shape's anchor
      // first: landing point-on-point is exact, which neither the grid nor box
      // alignment can promise for shapes whose boxes differ.
      const pointSnap = snapOn && this.grabPoint && this.pointTargets
        ? computePointSnap(this.grabPoint, rawDx, rawDy, this.pointTargets, SNAP_PX / this.canvas.getZoom())
        : null;
      if (pointSnap) {
        totalDx += pointSnap.dx;
        totalDy += pointSnap.dy;
        drawSnapGuides(this.guidesLayer, pointSnap.guides);
      } else if (grid && this.dragStartBBox) {
        const bb = this.dragStartBBox;
        const q = (v: number, o: number, s: number) => o + Math.round((v - o) / s) * s;
        const edgeX = rawDx > 0 ? bb.x + bb.width : bb.x;
        const edgeY = rawDy > 0 ? bb.y + bb.height : bb.y;
        totalDx = q(edgeX + rawDx, grid.ox, grid.sx) - edgeX;
        totalDy = q(edgeY + rawDy, grid.oy, grid.sy) - edgeY;
        clearSnapGuides(this.guidesLayer);
      } else if (snapOn && this.dragStartBBox && this.snapTargets) {
        const moving: BBox = {
          x: this.dragStartBBox.x + rawDx,
          y: this.dragStartBBox.y + rawDy,
          width: this.dragStartBBox.width,
          height: this.dragStartBBox.height,
        };
        const snap = computeSnap(moving, this.snapTargets, SNAP_PX / this.canvas.getZoom());
        totalDx += snap.dx;
        totalDy += snap.dy;
        drawSnapGuides(this.guidesLayer, snap.guides);
      } else {
        clearSnapGuides(this.guidesLayer);
      }

      // Shift constrains the move to a straight horizontal/vertical line, locking
      // whichever axis the pointer has travelled less along. Applied after snap so
      // the locked axis stays exactly on its origin.
      if (e.shiftKey) {
        if (Math.abs(rawDx) >= Math.abs(rawDy)) totalDy = 0;
        else totalDx = 0;
      }

      // Re-derive the incremental delta to feed translateElement().
      const incDx = totalDx - this.appliedDx;
      const incDy = totalDy - this.appliedDy;
      if (incDx !== 0 || incDy !== 0) {
        for (const s of this.dragShapes) this.translateElement(s.element, incDx, incDy);
        this.appliedDx = totalDx;
        this.appliedDy = totalDy;
        // A dragged frame moves its <g> directly; resync the artboards cache so its
        // border/label/dimension chrome (drawn from the cache) follows.
        if (this.dragShapes.some(s => s.type === 'frame')) this.state.syncFrames();
        this.state.onChange_public();
      }

      // Highlight the frame the selection would drop into — but only when it differs
      // from where the items already live, so nudging within a frame isn't noisy.
      if (this.dragStartBBox) {
        const bb = this.dragStartBBox;
        const target = this.state.frameIdForWorldBBox(bb.x + totalDx, bb.y + totalDy, bb.width, bb.height);
        const curFrame = this.dragShapes[0]?.element.parentElement;
        const curFrameId = curFrame?.hasAttribute('data-frame') ? curFrame.id : null;
        this.showDropFrameHint(target && target !== curFrameId ? target : null);
      }
    }
  }

  /** Accent overlay on the frame a drag would drop into (cleared with null). */
  private showDropFrameHint(frameId: string | null): void {
    const layer = this.guidesLayer;
    let hint = layer.querySelector('#drop-frame-hint') as SVGRectElement | null;
    if (!frameId) { hint?.remove(); return; }
    const ab = this.state.getArtboardById(frameId);
    if (!ab) { hint?.remove(); return; }
    if (!hint) {
      hint = document.createElementNS(this.NS, 'rect') as SVGRectElement;
      hint.id = 'drop-frame-hint';
      hint.setAttribute('fill', 'rgba(45,127,249,0.08)');
      hint.setAttribute('stroke', '#2d7ff9');
      hint.setAttribute('stroke-width', '2');
      hint.setAttribute('vector-effect', 'non-scaling-stroke');
      hint.setAttribute('pointer-events', 'none');
      layer.appendChild(hint);
    }
    hint.setAttribute('x', String(ab.x));
    hint.setAttribute('y', String(ab.y));
    hint.setAttribute('width', String(ab.width));
    hint.setAttribute('height', String(ab.height));
  }

  /** Start dragging an offset stroke's on-canvas handle. Returns false (so the
   *  caller falls through to a normal handle) if the geometry can't be measured. */
  private beginOffsetDrag(handle: string, shape: ShapeData): boolean {
    if (shape.type !== 'appearance') return false;
    const idx = parseInt(handle.slice('offset-'.length), 10);
    if (!Number.isFinite(idx)) return false;
    const src = shape.element.querySelector(':scope > [data-ap-src]') as SVGElement | null;
    if (!src) return false;
    const frame = pathMidFrame(src);
    if (!frame) return false;
    this.offsetting = true;
    this.offsetShapeId = shape.id;
    this.offsetLayerIdx = idx;
    this.offsetSrcEl = src;
    this.offsetBase = frame.base;
    // Reversing the path turned `perp` round; the stroke itself stayed put.
    const turned = !!this.state.getAppearance(shape.id)[idx]?.offsetReversed;
    this.offsetPerp = turned ? { x: -frame.perp.x, y: -frame.perp.y } : frame.perp;
    this.state.setInteractive(true);
    return true;
  }

  /** Set the dragged stroke's offset = signed perpendicular distance of the cursor
   *  from the path midpoint (both in the src's local space). */
  private updateOffsetDrag(pt: Point, commit: boolean): void {
    if (!this.offsetSrcEl) return;
    const local = worldToLocal(this.svgCanvas, this.offsetSrcEl, pt);
    const d = (local.x - this.offsetBase.x) * this.offsetPerp.x + (local.y - this.offsetBase.y) * this.offsetPerp.y;
    const offset = Math.round(d * 10) / 10;
    const layers = this.state.getAppearance(this.offsetShapeId);
    const L = layers[this.offsetLayerIdx];
    if (!L || L.t !== 'stroke') return;
    L.offset = offset || undefined;
    this.state.setAppearance(this.offsetShapeId, layers, commit);
  }

  private beginTextPathOffsetDrag(shape: ShapeData): boolean {
    if (shape.type !== 'text') return false;
    const tp = shape.element.querySelector('textPath');
    if (!tp) return false;
    const pathId = (tp.getAttribute('href') || tp.getAttribute('xlink:href') || '').replace(/^#/, '');
    const geom = pathId ? (document.getElementById(pathId) as SVGGeometryElement | null) : null;
    if (!geom || typeof geom.getTotalLength !== 'function') return false;
    this.textPathOffsetting = true;
    this.textPathEl = shape.element as SVGTextElement;
    this.textPathGeom = geom;
    this.state.setInteractive(true);
    return true;
  }

  /** Snap the cursor to the nearest point on the path and set the <textPath>
   *  startOffset (% of path length) — where the text begins along the path. */
  private updateTextPathOffset(pt: Point, commit: boolean): void {
    const geom = this.textPathGeom, textEl = this.textPathEl;
    if (!geom || !textEl) return;
    const total = geom.getTotalLength();
    if (!total) return;
    const local = worldToLocal(this.svgCanvas, geom, pt); // cursor in the path's local space
    let best = 0, bestD = Infinity;
    const N = 256;
    for (let i = 0; i <= N; i++) {
      const len = (total * i) / N;
      const p = geom.getPointAtLength(len);
      const d = (p.x - local.x) ** 2 + (p.y - local.y) ** 2;
      if (d < bestD) { bestD = d; best = len; }
    }
    const pct = Math.round((best / total) * 1000) / 10; // 0.1% precision
    const tp = textEl.querySelector('textPath');
    if (tp) { if (pct) tp.setAttribute('startOffset', `${pct}%`); else tp.removeAttribute('startOffset'); }
    if (commit) this.state.saveHistory();
    this.state.onChange_public();
  }

  onMouseUp(pt: Point, e: MouseEvent): void {
    // --- Finish marquee ---
    if (this.marquee) {
      this.finishMarquee(pt, e.shiftKey);
      this.marquee = false;
      this.removeMarqueeRect();
      return;
    }

    // --- Finish offset-stroke drag ---
    if (this.offsetting) {
      this.updateOffsetDrag(pt, true); // final value → one undo step
      this.offsetting = false;
      this.offsetSrcEl = null;
      hideGestureHud();
      this.state.setInteractive(false);
      this.canvas.endPan();
      return;
    }

    // --- Finish text-on-path start-offset drag ---
    if (this.textPathOffsetting) {
      this.updateTextPathOffset(pt, true); // final value → one undo step
      this.textPathOffsetting = false;
      this.textPathEl = null;
      this.textPathGeom = null;
      this.state.setInteractive(false);
      return;
    }

    // A zero-drag CLICK on a resize/rotate handle falls through to selecting the
    // shape underneath (#223): the rotate dot floats over the canvas and on
    // small shapes the handles outsize the shape, so clicks aimed at a NEIGHBOR
    // land on them. A genuine handle grab always moves, and selection only
    // changes when the click resolves to a shape that isn't already selected.
    if ((this.resizing || this.rotating) && this.handleDownScreen &&
        Math.hypot(e.clientX - this.handleDownScreen.x, e.clientY - this.handleDownScreen.y) < 3) {
      const under = document.elementsFromPoint(e.clientX, e.clientY)
        .find(n => n.closest?.('#drawing-layer')) as SVGElement | undefined;
      const deep = (e.altKey || e.metaKey || e.ctrlKey) && !e.shiftKey;
      const shapeEl = under ? this.findShapeElement(under, { deep }) : null;
      if (shapeEl && !this.state.selectedShapeIds.includes(shapeEl.id)) {
        this.resizing = false;
        this.rotating = false;
        this.handleDownScreen = null;
        this.gestureShapes = [];
        this.state.activeGesture = null;
        this.state.setInteractive(false);
        if (e.shiftKey) this.state.toggleMultiSelect(shapeEl.id);
        else this.state.selectShape(shapeEl.id);
        this.state.onChange_public();
        return;
      }
    }
    this.handleDownScreen = null;

    if (this.dragging || this.resizing || this.rotating || this.radiusing) {
      const isMove = this.dragging && !this.resizing && !this.rotating && !this.radiusing;
      // A plain move feeds step-and-repeat: if it nudged the last duplicate, its
      // delta becomes the ⌘D offset (any other move breaks the chain).
      if (isMove) this.state.notifyMovedSelection(this.appliedDx, this.appliedDy);
      // #105 (on-canvas half): multi-select and group resize move shapes by writing
      // a residual scale() transform while stroke-width stays raw, so the rendered
      // stroke diverges from the panel's number. Fold that scale into geometry +
      // stroke at commit (clean cases only — rotated shapes/wrappers keep theirs),
      // then resync the model so the panel reads the real numbers.
      if (this.resizing) {
        let baked = false;
        for (const s of this.gestureShapes) {
          // preserveCornerRadius: a resize must not stretch an authored corner
          // radius — 8px stays 8px however far the box is dragged.
          if (s.type !== 'frame') baked = bakeOwnTransform(s.element, { preserveCornerRadius: true }) || baked;
        }
        if (baked) this.state.rebuildShapesFromDOM();
      }
      // Moves commit through the move seam (frame auto-parenting + history in
      // one — #222); every other gesture records plain history and never
      // re-parents. A ZERO-delta "move" — a plain click-select, or a drag
      // returned to its origin — changed nothing and commits nothing (this used
      // to push a no-op undo entry on every click).
      if (isMove && (this.appliedDx !== 0 || this.appliedDy !== 0)) this.state.commitMove();
      else if (!isMove) this.state.saveHistory();
      this.state.activeGesture = null;
      this.dragging = false;
      this.resizing = false;
      this.rotating = false;
      this.radiusing = false;
      this.radiusOrigBBox = null;
      this.resizeOrigBBox = null;
      this.resizeOrigGeometry = null;
      this.resizeOrigTransform = null;
      this.resizeOrigFontSize = 0;
      this.resizeRotation = 0;
      this.resizeDeltaAngle = 0;
      this.resizeWorldBox = null;
      this.resizeParentBox = null;
      this.resizeAnchorLocal = null;
      this.resizeAnchorLayer = null;
      this.gestureShapes = [];
      // Clear smart-guide overlay and snap baseline; dismiss the gesture HUD.
      clearSnapGuides(this.guidesLayer);
      this.showDropFrameHint(null); // clear the drop-target frame highlight
      hideGestureHud();
      this.snapTargets = null;
      this.grabPoint = null;
      this.pointTargets = null;
      this.dragStartBBox = null;
      // Gesture done: leave interactive mode and do one full render so the side
      // panels catch up with the final geometry.
      this.state.setInteractive(false);
      this.state.onChange_public();
    }
    this.canvas.endPan();
  }

  /**
   * Double-click drills one level toward the clicked shape: it enters the group
   * currently selectable under the cursor (Adobe-style isolation) and selects
   * that group's child on the click path. Repeated double-clicks descend deeper;
   * double-clicking empty canvas exits isolation.
   */
  onDoubleClick(pt: Point, e: MouseEvent): void {
    // Through locked artwork, as a press is: no editing a locked text or entering a locked group.
    const target = this.unlockedTarget(e.target as SVGElement, e);

    // Double-clicking a frame's name label renames it in place (single-click
    // selects, drag moves — the label is the frame's on-canvas handle).
    const frameLabel = target.closest?.('[data-frame-select]') as SVGElement | null;
    if (frameLabel) {
      openFrameRename(this.state, this.svgCanvas, frameLabel.getAttribute('data-frame-select')!);
      return;
    }

    // Double-clicking text edits it — at ANY nesting depth. Text is a terminal
    // leaf: drilling one group level per double-click just to reach the editor
    // was pure friction, so the level-by-level descent (kept for groups below)
    // is skipped and the Text tool takes over directly.
    const textLeaf = target.closest?.('text') as SVGTextElement | null;
    if (textLeaf?.id && this.state.findShapeById(textLeaf.id)?.type === 'text') {
      this.startTextEdit(textLeaf.id);
      return;
    }

    const chain = this.shapeChain(target);

    // Text is mostly whitespace, so a double-click aimed at it often lands between
    // glyphs (hitting nothing) or on a shape behind them. Rescue both cases by BOX,
    // in intent order: a selected text under the point wins (they picked it, now
    // they're editing it); otherwise, if the click-path found nothing, the topmost
    // text whose box contains the point.
    const selId = this.state.selectedShapeIds.length === 1 ? this.state.selectedShapeIds[0] : null;
    const selShape = selId ? this.state.findShapeById(selId) : null;
    if (selShape && selShape.type === 'text' && !selShape.locked && this.pointInShapeBox(pt, selShape)) {
      this.startTextEdit(selShape.id);
      return;
    }
    if (chain.length === 0) {
      const hit = this.topmostTextAt(pt);
      if (hit) { this.startTextEdit(hit.id); return; }
      this.state.exitGroupIsolation();
      return;
    }

    const deepest = chain[0];
    const current = this.findShapeElement(target); // selectable element at this level
    if (!current) {
      // Click-transparent hit — same glyph-gap rescue.
      const hit = this.topmostTextAt(pt);
      if (hit) { this.startTextEdit(hit.id); return; }
      this.state.exitGroupIsolation();
      return;
    }

    // A double-click that resolved to a FRAME usually means it fell through a
    // text's glyph gaps onto the frame background — rescue that before treating
    // it as a frame double-click.
    if (this.state.findShapeById(current.id)?.type === 'frame') {
      const hit = this.topmostTextAt(pt);
      if (hit) { this.startTextEdit(hit.id); return; }
    }

    // A live boolean reads as a leaf (operands are hidden), but double-click should
    // enter it for operand editing rather than just re-selecting the result.
    if (this.state.findShapeById(current.id)?.type === 'boolean') {
      this.state.enterGroup(current.id);
      this.state.selectShape(null);
      return;
    }

    // Double-clicking a MASK edits its cutter shape (the clip stays live, so reshaping
    // updates the masked result in place) — rather than entering it to pick content.
    if (this.state.findShapeById(current.id)?.element.hasAttribute('data-clip-group')) {
      this.state.enterMaskEdit(current.id);
      return;
    }

    // Already at the leaf — nothing deeper to enter. If it's a vector (a path or a
    // primitive that converts to one), double-click drops straight into point
    // editing (Figma-style: no separate Direct Selection tool). The node tool is the
    // engine; nodeEditReturnTool tells it to hop back to Select when the edit ends.
    if (current === deepest) {
      if (this.state.canNodeEdit(current.id)) {
        this.state.selectShape(current.id);
        this.state.nodeEditReturnTool = 'select';
        this.state.requestTool?.('directSelect');
        return;
      }
      // Double-clicking a raster image enters the Crop tool (Figma-style).
      if (this.state.findShapeById(current.id)?.type === 'image') {
        this.state.selectShape(current.id);
        this.state.cropReturnTool = 'select';
        this.state.requestTool?.('crop');
        return;
      }
      // Double-clicking text drops into text editing (Illustrator/Figma-style: no need
      // to switch to the Type tool first). The Text tool edits it and returns here.
      if (this.state.findShapeById(current.id)?.type === 'text') {
        this.startTextEdit(current.id);
        return;
      }
      this.state.selectShape(current.id);
      return;
    }

    // `current` is a group (or a repeat grid — its SOURCE is a modeled child) with
    // deeper content on the path: enter it and select the next level down.
    const curType = this.state.findShapeById(current.id)?.type;
    if (curType === 'group' || curType === 'repeat') {
      this.state.enterGroup(current.id);
      const child = this.findShapeElement(target); // now scoped one level deeper
      this.state.selectShape(child && child !== current ? child.id : current.id);
    } else {
      this.state.selectShape(current.id);
    }
  }

  /** Hand a text shape to the Text tool for in-place editing; it returns here on commit. */
  private startTextEdit(id: string): void {
    this.state.selectShape(id);
    this.state.textEditTarget = id;
    this.state.requestTool?.('text');
  }

  /** Map an element-local point into drawing-layer space via the full CTM chain. */
  private localPointToLayer(el: SVGGraphicsElement, lx: number, ly: number): Point | null {
    const layer = this.svgCanvas.querySelector('#drawing-layer') as unknown as SVGGraphicsElement | null;
    const m = layer ? matrixBetween(layer, el) : null;
    if (!m) return null;
    const p = new DOMPoint(lx, ly).matrixTransform(m);
    return { x: p.x, y: p.y };
  }

  /** After a rotated shape's geometry changed mid-resize: re-pivot its rotation
   *  about the NEW local bbox centre (the canonical pivot every other rotation
   *  path assumes), then cancel the world drift that re-pivoting causes by
   *  measuring where the anchored corner ended up and nudging it back. Measured
   *  rather than derived, so it's exact for every per-type resize branch. */
  private fixRotatedResizePivot(el: SVGGraphicsElement): void {
    if (!this.resizeRotation || !this.resizeAnchorLocal || !this.resizeAnchorLayer) return;
    let bb: DOMRect;
    try { bb = el.getBBox(); } catch { return; }
    setRotation(el, this.resizeRotation, bb.x + bb.width / 2, bb.y + bb.height / 2);
    const now = this.localPointToLayer(el,
      this.resizeAnchorLocal.x, this.resizeAnchorLocal.y);
    if (!now) return;
    const parent = el.parentElement as unknown as SVGGraphicsElement | null;
    let ddx = this.resizeAnchorLayer.x - now.x;
    let ddy = this.resizeAnchorLayer.y - now.y;
    if (parent) {
      const conv = layerDeltaToLocal(this.svgCanvas, parent, ddx, ddy);
      ddx = conv.dx; ddy = conv.dy;
    }
    if (ddx !== 0 || ddy !== 0) nudgeTranslate(el, ddx, ddy);
  }

  /** Whether a drawing-layer-space point falls inside the shape's rendered box. */
  private pointInShapeBox(pt: Point, shape: ShapeData): boolean {
    const b = localBBoxInLayer(this.svgCanvas, shape.element);
    return !!b && pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height;
  }

  /** Topmost unfilled, closed leaf whose AREA contains `pt`.
   *
   *  The area is the shape's real geometry, not its bounding box. A box test
   *  selected a U-shaped outline when you clicked in its notch and a ring when you
   *  clicked in its hole — empty canvas on screen. `isPointInFill` tests the fill
   *  geometry regardless of the paint (so it works for fill:none) and honours
   *  fill-rule, so holes stay holes.
   *
   *  Open paths/polylines deliberately keep stroke-only hit-testing: an open path's
   *  implicit fill region isn't something anyone sees as its inside. */
  private topmostClosedOutlineAt(pt: Point): ShapeData | null {
    const candidates: ShapeData[] = [];
    const walk = (list: ShapeData[], blocked = false): void => {
      for (const shape of list) {
        const unavailable = blocked || !shape.visible || shape.locked;
        if (!unavailable) {
          const tag = shape.element.tagName.toLowerCase();
          const closed = tag === 'rect' || tag === 'circle' || tag === 'ellipse' || tag === 'polygon' ||
            (tag === 'path' && /z\s*$/i.test(shape.element.getAttribute('d') ?? ''));
          // The COMPUTED fill: exactly what the browser's own hit-test consults when
          // it misses the interior, whether none came from an attribute, a style
          // attribute, a class, or an ancestor.
          if (closed && getComputedStyle(shape.element).fill === 'none') candidates.push(shape);
        }
        if (shape.children) walk(shape.children, unavailable);
      }
    };
    walk(this.state.shapes);
    for (let i = candidates.length - 1; i >= 0; i--) {
      const el = candidates[i].element as unknown as SVGGeometryElement;
      if (typeof el.isPointInFill !== 'function') continue;
      const local = worldToLocal(this.svgCanvas, el, pt);
      if (el.isPointInFill(new DOMPoint(local.x, local.y))) return candidates[i];
    }
    return null;
  }

  /** The topmost editable text shape whose box contains the point (any nesting depth). */
  private topmostTextAt(pt: Point): ShapeData | null {
    const texts: ShapeData[] = [];
    const walk = (list: ShapeData[]): void => list.forEach(s => {
      if (s.type === 'text' && s.visible && !s.locked) texts.push(s);
      if (s.children) walk(s.children);
    });
    walk(this.state.shapes);
    // The tree is DOM-ordered, so a later entry renders on top — scan from the end.
    for (let i = texts.length - 1; i >= 0; i--) {
      if (this.pointInShapeBox(pt, texts[i])) return texts[i];
    }
    return null;
  }

  onKeyDown(e: KeyboardEvent): void {
    // Enter starts editing the selected text (Figma-style) — a keyboard route into
    // text editing that doesn't require aiming a double-click at thin glyphs.
    if (e.key === 'Enter' && !e.repeat) {
      const ids = this.state.selectedShapeIds;
      const s = ids.length === 1 ? this.state.findShapeById(ids[0]) : null;
      if (s && s.type === 'text' && !s.locked) {
        e.preventDefault();
        this.startTextEdit(s.id);
        return;
      }
    }

    // Arrow keys nudge the selection, Figma/Illustrator-style: 1 unit per press,
    // 10 with Shift, accelerating while held. (Reaches here via main.ts's tool-key
    // fallback; the Direct Selection tool has its own arrow handling for nodes.)
    if (e.key.startsWith('Arrow')) {
      if (this.state.selectedShapeIds.length === 0) return;
      const base = e.shiftKey ? 10 : 1;
      let dx = 0, dy = 0;
      if (e.key === 'ArrowLeft') dx = -base;
      else if (e.key === 'ArrowRight') dx = base;
      else if (e.key === 'ArrowUp') dy = -base;
      else if (e.key === 'ArrowDown') dy = base;
      else return;
      e.preventDefault();
      this.nudgeSelection(dx, dy, e);
      return;
    }

    if (e.key !== 'Escape') return;
    const g = this.state.activeGroupId;
    if (!g) {
      // Not inside a group: Escape DESELECTS (Figma/Illustrator muscle memory).
      // It used to do nothing at all here, leaving Mod+Shift+A as the only way
      // to drop a selection (#197).
      if (this.state.selectedShapeIds.length > 0) {
        e.preventDefault();
        this.state.selectShape(null);
      }
      return;
    }

    // Step up one level: select the group we were editing inside (clear visual
    // feedback — the selection jumps from the child to the whole group), and move
    // isolation to that group's own parent so a further Esc steps up again. A
    // parent that can't isolate (a frame — where most groups live) means we're at
    // the top: leave isolation, or Esc would be stuck inside the group for good.
    const parentId = this.state.findShapeById(g)?.parentId ?? null;
    this.state.selectShape(g);
    if (!parentId || !this.state.enterGroup(parentId)) this.state.exitGroupIsolation();
  }

  // --- Arrow-key nudge state ---
  private nudgeRepeat = 0;        // consecutive auto-repeats (drives acceleration)
  private nudgeRunOpen = false;   // an undo entry exists for the current run
  private nudgeHeld = false;      // the run included held repeats (needs amend on commit)
  private nudgeCommitTimer = 0;
  private nudgeHudTimer = 0;

  /**
   * Move the selection by a canvas-space delta (keyboard nudge, base dx/dy).
   * Uses the same rotation/nesting-aware translate as a drag, so it behaves like a
   * tiny drag. A discrete press is its own undo step; a HELD key auto-repeats,
   * accelerating (capped) and folding the whole hold into a SINGLE undo step.
   * Locked shapes are skipped. Shows the gesture-hint HUD.
   */
  private nudgeSelection(dx: number, dy: number, e: KeyboardEvent): void {
    const shapes = this.state.selectedShapeIds
      .map((id) => this.state.findShapeById(id))
      .filter((s): s is ShapeData => !!s && !s.locked);
    if (shapes.length === 0) return;

    if (e.repeat) {
      // Held key: accelerate, and skip panel rebuilds until the run commits.
      this.nudgeRepeat++;
      this.nudgeHeld = true;
      this.state.setInteractive(true);
    } else {
      // Fresh press: close any previous run so each tap is its own undo step.
      this.commitNudgeRun();
      this.nudgeRepeat = 0;
    }

    const mult = Math.min(NUDGE_MAX_MULT, 1 + Math.floor(this.nudgeRepeat / NUDGE_RAMP));
    for (const s of shapes) this.translateElement(s.element, dx * mult, dy * mult);
    // A moved frame carries the derived artboards cache — resync it (as a drag does).
    if (shapes.some((s) => s.type === 'frame')) this.state.syncFrames();

    if (!this.nudgeRunOpen) {
      this.state.saveHistory(); // first move of this run → one undo entry
      this.nudgeRunOpen = true;
    }
    this.state.onChange_public();

    // Commit the run shortly after movement stops (ends the held-run undo step).
    clearTimeout(this.nudgeCommitTimer);
    this.nudgeCommitTimer = window.setTimeout(() => this.commitNudgeRun(), NUDGE_COMMIT_MS);

    // Teaching HUD — auto-hides a beat after nudging stops.
    showGestureHud('nudge', e);
    clearTimeout(this.nudgeHudTimer);
    this.nudgeHudTimer = window.setTimeout(() => hideGestureHud(), NUDGE_HUD_MS);
  }

  /** Finalize the current nudge run: a nudge is a move like any drag, so it
   *  commits through the move seam — amending, so the run's movement + any
   *  reparent stay one undo entry (#222). */
  private commitNudgeRun(): void {
    if (!this.nudgeRunOpen) return;
    this.nudgeRunOpen = false;
    clearTimeout(this.nudgeCommitTimer);
    this.state.commitMove(undefined, { amend: true });
    if (this.nudgeHeld) {
      this.state.setInteractive(false);
      this.nudgeHeld = false;
    }
    this.state.onChange_public(); // full render — side panels catch up
  }

  deactivate(): void {
    // Finalize any in-flight nudge run and clear its HUD so nothing lingers when
    // the user switches tools mid-nudge.
    this.commitNudgeRun();
    clearTimeout(this.nudgeHudTimer);
    hideGestureHud();
  }

  // ---- Marquee helpers ----

  private createMarqueeRect(pt: Point): void {
    const selLayer = this.svgCanvas.querySelector('#selection-layer') as SVGGElement;
    if (!selLayer) return;
    // Shared constant-size chrome (non-scaling stroke + dashes) — see ui/overlay-chrome.
    const rect = createMarqueeRect();
    rect.setAttribute('x', String(pt.x));
    rect.setAttribute('y', String(pt.y));
    rect.setAttribute('width', '0');
    rect.setAttribute('height', '0');
    selLayer.appendChild(rect);
    this.marqueeRect = rect;
  }

  private updateMarqueeRect(pt: Point): void {
    if (!this.marqueeRect) return;
    const x = Math.min(pt.x, this.marqueeStart.x);
    const y = Math.min(pt.y, this.marqueeStart.y);
    const w = Math.abs(pt.x - this.marqueeStart.x);
    const h = Math.abs(pt.y - this.marqueeStart.y);
    this.marqueeRect.setAttribute('x', String(x));
    this.marqueeRect.setAttribute('y', String(y));
    this.marqueeRect.setAttribute('width', String(w));
    this.marqueeRect.setAttribute('height', String(h));
  }

  private removeMarqueeRect(): void {
    this.marqueeRect?.remove();
    this.marqueeRect = null;
  }

  private finishMarquee(pt: Point, additive: boolean): void {
    const mx = Math.min(pt.x, this.marqueeStart.x);
    const my = Math.min(pt.y, this.marqueeStart.y);
    const mw = Math.abs(pt.x - this.marqueeStart.x);
    const mh = Math.abs(pt.y - this.marqueeStart.y);

    // Minimum drag distance to count as marquee (not accidental click)
    if (mw < 3 && mh < 3) return;

    // Candidates: frames are transparent containers — a marquee selects the shapes
    // INSIDE a frame, never the frame itself (else any drag touching the big frame
    // grabs it and you can't rubber-band its contents). Recurse through frames;
    // treat everything else (groups/booleans/leaves) as a selectable unit.
    const collect = (shapes: ShapeData[]): ShapeData[] => {
      const out: ShapeData[] = [];
      for (const s of shapes) {
        if (s.type === 'frame') { if (s.children) out.push(...collect(s.children)); }
        else out.push(s);
      }
      return out;
    };

    const hitIds: string[] = [];
    for (const shape of collect(this.state.shapes)) {
      if (!shape.visible || shape.locked) continue;
      // World-space bbox (marquee coords are drawing-layer space via screenToSVG),
      // so it's correct for shapes nested/transformed inside frames.
      const bb = localBBoxInLayer(this.svgCanvas, shape.element);
      if (bb && this.rectsIntersect(mx, my, mw, mh, bb.x, bb.y, bb.width, bb.height)) {
        hitIds.push(shape.id);
      }
    }

    if (hitIds.length === 0) return;

    if (additive) {
      // Shift+marquee: add to existing selection
      const combined = new Set([...this.state.selectedShapeIds, ...hitIds]);
      this.state.selectMultiple([...combined]);
    } else {
      this.state.selectMultiple(hitIds);
    }
  }

  private rectsIntersect(
    ax: number, ay: number, aw: number, ah: number,
    bx: number, by: number, bw: number, bh: number,
  ): boolean {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  // ---- Shape finding ----

  /** The chain of `shape-*` ancestors of `target`, innermost first, up to (and
   *  not past) #drawing-layer. Empty when the click isn't on a shape. */
  private shapeChain(target: SVGElement): SVGElement[] {
    const chain: SVGElement[] = [];
    let el: SVGElement | null = target;
    while (el) {
      // Ask the model, not the id's spelling: an imported document's shapes keep
      // their authored ids (c1 / track / marker1), and name-matching made them
      // unselectable — a click fell through to the enclosing frame.
      if (el.id && this.state.findShapeById(el.id)) chain.push(el);
      if (el.id === 'drawing-layer') break;
      el = el.parentElement as SVGElement | null;
    }
    return chain;
  }

  /**
   * Resolve a click target to the shape it should select. By default this is the
   * outermost group (top of the z-stack), so a group drags as a unit. Two things
   * change that:
   *  - `opts.deep` (Alt-click): select the innermost shape directly, ignoring grouping.
   *  - group isolation (state.activeGroupId, set by double-click): select the
   *    direct child of the entered group along the click path, so children can be
   *    picked and moved individually. Clicks outside the entered group fall back
   *    to top-level resolution.
   */
  /**
   * A world drag delta expressed in the element's OWN user space — the space its
   * geometry attributes live in, and the space getBBox() reports.
   *
   * Only the SCALE part of the local→world mapping is removed. The element's own
   * rotation was already folded into the delta by the caller (the handles sit on
   * the rotated box, so the drag is measured along local axes); applying the full
   * matrix here would rotate it a second time.
   */
  private resizeDeltaToLocal(el: SVGGraphicsElement, dx: number, dy: number): { dx: number; dy: number } {
    const elCtm = el.getCTM?.();
    const layerCtm = (document.getElementById('drawing-layer') as unknown as SVGGraphicsElement | null)?.getCTM?.();
    if (!elCtm || !layerCtm) return { dx, dy };
    const m = layerCtm.inverse().multiply(elCtm); // el-local → drawing-layer
    const sx = Math.hypot(m.a, m.b), sy = Math.hypot(m.c, m.d);
    if (!sx || !sy || !Number.isFinite(sx) || !Number.isFinite(sy)) return { dx, dy };
    return { dx: dx / sx, dy: dy / sy };
  }

  private findShapeElement(target: SVGElement, opts: { deep?: boolean } = {}): SVGElement | null {
    const chain = this.shapeChain(target);
    if (chain.length === 0) return null;
    if (opts.deep) return chain[0];

    const activeId = this.state.activeGroupId;
    if (activeId) {
      const activeEl = chain.find(s => s.id === activeId);
      if (activeEl) {
        // One level into the entered group, along the click path.
        return chain.find(s => (s.parentElement as Element | null) === activeEl) ?? activeEl;
      }
      // Target is outside the entered group → unscoped (top-level) resolution.
    }
    // Top-level resolution: resolve a click up through GROUPS (Adobe-style: click
    // selects the outermost group, double-click enters it). But CONTAINERS are not
    // selectable-as-a-unit groups — clicking their contents must select the
    // contents (Figma & Illustrator both do this). Two kinds qualify: a FRAME
    // (artboard), and an imported editor LAYER (`data-layer`, an Inkscape
    // `groupmode="layer"` wrapper), which is an organisational construct wrapping a
    // whole file rather than artwork the user grouped. So return the top-most
    // non-container ancestor, falling back to the container only if that's all that
    // was hit.
    const nonContainer = chain.filter(el => !isContainerEl(el));
    return nonContainer.length ? nonContainer[nonContainer.length - 1] : chain[chain.length - 1];
  }

  /** Is `el` a descendant of the currently-entered group? */
  private isInActiveGroup(el: SVGElement | null): boolean {
    const activeId = this.state.activeGroupId;
    if (!activeId || !el) return false;
    const activeEl = document.getElementById(activeId) as Element | null;
    return !!activeEl && activeEl !== el && activeEl.contains(el);
  }

  private getSelectedShapes(): ShapeData[] {
    return this.state.selectedShapeIds
      .map(id => this.state.findShapeById(id))
      .filter((s): s is ShapeData => s !== null);
  }


  // ---- Position helpers ----

  /** Move element by dx,dy (given in #drawing-layer / canvas space). Works for
   *  rotated elements and for children nested inside transformed groups. */
  private translateElement(el: SVGElement, dx: number, dy: number): void {
    const tag = el.tagName.toLowerCase();

    // A child's geometry lives in its PARENT group's coordinate space. If that
    // group is scaled/rotated, the canvas-space delta must be mapped into the
    // group's local space first (a no-op for top-level shapes and identity groups).
    const parent = el.parentElement as unknown as SVGGraphicsElement | null;
    const parentId = (parent as unknown as SVGElement | null)?.id;
    if (parent && parentId && this.state.findShapeById(parentId)) {
      const conv = this.toParentDelta(parent, dx, dy);
      dx = conv.dx; dy = conv.dy;
    }

    // Rotated elements (and groups/paths) move via the typed transform list so
    // any existing rotate/matrix is preserved and composed correctly.
    if (getRotation(el) !== 0 || tag === 'g' || tag === 'path') {
      nudgeTranslate(el, dx, dy);
      return;
    }

    // For non-rotated primitives, adjust position attributes directly (more
    // precise than a transform). Per-type logic lives in core/shape-adapters so
    // move / resize / snap / bake all dispatch shape types from one place.
    if (!translateShapeGeometry(el, dx, dy)) {
      // Match alignment/nudging for shapes without direct position attributes.
      nudgeTranslate(el, dx, dy);
    }
  }

  /**
   * Map a delta vector from #drawing-layer (canvas) space into `parentEl`'s local
   * coordinate space, so a child nested under a scaled/rotated group drags 1:1
   * with the cursor. Identity ancestors (the common case) return the delta as-is.
   */
  private toParentDelta(parentEl: SVGGraphicsElement, dx: number, dy: number): { dx: number; dy: number } {
    return layerDeltaToLocal(this.svgCanvas, parentEl, dx, dy);
  }


  // ---- Screen-space bbox (accounts for transforms) ----

  private getScreenSpaceBBox(shapes: ShapeData[]): DOMRect {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of shapes) {
      const bb = visualWorldBBox(this.svgCanvas, s.element);
      if (!bb) continue;
      minX = Math.min(minX, bb.x);
      minY = Math.min(minY, bb.y);
      maxX = Math.max(maxX, bb.x + bb.width);
      maxY = Math.max(maxY, bb.y + bb.height);
    }
    return new DOMRect(minX, minY, maxX - minX, maxY - minY);
  }

  // ---- Multi-transform operations ----

  private applyMultiRotation(deltaAngle: number): void {
    const cx = this.rotateCenter.x;
    const cy = this.rotateCenter.y;
    const rad = deltaAngle * Math.PI / 180;
    const cosA = Math.cos(rad);
    const sinA = Math.sin(rad);

    for (const s of this.gestureShapes) {
      const origTransform = this.multiOrigTransforms.get(s.id) ?? '';
      const origBBox = this.multiOrigBBoxes.get(s.id);
      if (!origBBox) continue;

      // Element center in local space
      const ex = origBBox.x + origBBox.width / 2;
      const ey = origBBox.y + origBBox.height / 2;

      // Rotate element center around the group center
      const dx = ex - cx;
      const dy = ey - cy;
      const newCx = cx + dx * cosA - dy * sinA;
      const newCy = cy + dx * sinA + dy * cosA;
      const tx = newCx - ex;
      const ty = newCy - ey;

      // Build new transform: translate to new position + rotate by delta + original transform
      let newTransform = '';
      if (tx !== 0 || ty !== 0) newTransform += `translate(${tx}, ${ty}) `;
      newTransform += `rotate(${deltaAngle}, ${ex}, ${ey})`;
      if (origTransform) newTransform += ` ${origTransform}`;

      s.element.setAttribute('transform', newTransform.trim());

      // Update shape rotation tracking
      const origRotMatch = origTransform.match(/rotate\(([-\d.]+)/);
      const origRot = origRotMatch ? parseFloat(origRotMatch[1]) : 0;
      s.rotation = origRot + deltaAngle;
    }
  }

  private applyMultiResize(dx: number, dy: number): void {
    const orig = this.resizeOrigBBox;
    if (!orig || orig.width === 0 || orig.height === 0) return;

    // Compute new combined bbox from handle drag
    let newX = orig.x, newY = orig.y, newW = orig.width, newH = orig.height;
    const handle = this.resizeHandle;
    if (handle.includes('e')) newW += dx;
    if (handle.includes('w')) { newX += dx; newW -= dx; }
    if (handle.includes('s')) newH += dy;
    if (handle.includes('n')) { newY += dy; newH -= dy; }
    if (newW < 1) newW = 1;
    if (newH < 1) newH = 1;

    const sx = newW / orig.width;
    const sy = newH / orig.height;

    // Anchor point (opposite corner of the handle)
    const ax = handle.includes('w') ? orig.x + orig.width : orig.x;
    const ay = handle.includes('n') ? orig.y + orig.height : orig.y;

    // One scale ABOUT THE ANCHOR, prepended to whatever transform the element already
    // had. `translate(a) scale(s) translate(-a)` maps every point p to a + (p-a)*s —
    // which is simultaneously the element's own growth AND the movement of its
    // position within the selection, in one operation.
    //
    // The previous form was `translate(tx,ty) scale(s)`, and that double-counted:
    // a bare scale() acts about the element's LOCAL ORIGIN, so it already displaced
    // the element by ex*(s-1) before the translate — which was computed as if the
    // element had stayed at ex. Every shape drifted by its own distance from the
    // origin, growing with each one further out, so the selection appeared to have
    // its relative spacing scaled a second time.
    //
    // The anchor is in drawing-layer space but `transform` maps element-local into
    // its PARENT's space, so convert per element: shapes inside a frame have a
    // translated parent, and using the raw world anchor there would offset them by
    // the frame's position. (The old code compared a world anchor against a
    // getBBox() centre — a LOCAL, pre-own-transform box — which mixed the two spaces
    // as well; deriving the anchor per parent removes the need for that box.)
    for (const s of this.gestureShapes) {
      const origTransform = this.multiOrigTransforms.get(s.id) ?? '';
      const parent = s.element.parentElement as unknown as SVGElement | null;
      const a = worldToLocal(this.svgCanvas, parent, { x: ax, y: ay });
      const t = `translate(${a.x}, ${a.y}) scale(${sx}, ${sy}) translate(${-a.x}, ${-a.y})`;
      s.element.setAttribute('transform', (origTransform ? `${t} ${origTransform}` : t).trim());
    }
  }

  // ---- Transform helpers ----

  /**
   * Constrain a corner-handle drag so the selection scales uniformly (locks
   * aspect ratio). The axis dragged farther (proportionally) drives the scale;
   * the other follows. Edge handles are returned unchanged.
   */
  private constrainProportional(dx: number, dy: number): { dx: number; dy: number } {
    const bb = this.resizeOrigBBox;
    const h = this.resizeHandle;
    if (!bb || bb.width <= 0 || bb.height <= 0) return { dx, dy };
    const hasE = h.includes('e'), hasW = h.includes('w'), hasN = h.includes('n'), hasS = h.includes('s');
    if (!((hasE || hasW) && (hasN || hasS))) return { dx, dy }; // corners only

    // Signed growth of width/height implied by the drag.
    let dW = hasE ? dx : -dx;
    let dH = hasS ? dy : -dy;
    const rel = Math.abs(dW / bb.width) >= Math.abs(dH / bb.height) ? dW / bb.width : dH / bb.height;
    dW = rel * bb.width;
    dH = rel * bb.height;
    return { dx: hasE ? dW : -dW, dy: hasS ? dH : -dH };
  }

  private applyRotation(shape: { element: SVGGraphicsElement; rotation?: number }, pivot?: Point): void {
    const el = shape.element;
    let cx = pivot?.x;
    let cy = pivot?.y;
    if (cx === undefined || cy === undefined) {
      const bbox = el.getBBox();
      cx = bbox.x + bbox.width / 2;
      cy = bbox.y + bbox.height / 2;
    }
    setRotation(el, shape.rotation ?? 0, cx, cy);
  }

  private applyResize(el: SVGElement, _type: string, origBBox: DOMRect, dx: number, dy: number, handle: string): void {
    const box = resizeBox(origBBox, dx, dy, handle);
    const newX = box.x;
    const newY = box.y;
    const newW = Math.max(1, box.width);
    const newH = Math.max(1, box.height);

    const tag = el.tagName.toLowerCase();

    // Frames resize their OWN bounds (data-frame-w/h + clip + bg + overflow mask),
    // keeping their content world-fixed — never scaled like a group would be
    // (scaling a frame would distort its children and break export/rulers/grid).
    if (el.hasAttribute('data-frame')) {
      this.state.updateArtboard(el.id, { x: newX, y: newY, width: newW, height: newH }, { keepChildrenFixed: true });
      return;
    }

    // Parametric PATH shapes (pie/arc/ring): regenerate the true arc/ellipse from the
    // new circle box + stored params — never scale the `d`, which would bézier-
    // approximate the arcs and lose their roundness. origBBox is the circle box
    // (visualLocalBBox), so newX/Y/W/H describe the new circle. (Point-based
    // parametric shapes — polygon/star/plus — fall through to point scaling below.)
    const shapeKindAttr = el.getAttribute('data-shape');
    if (shapeKindAttr === 'pie' || shapeKindAttr === 'arc') {
      regenerateWith(el, { cx: newX + newW / 2, cy: newY + newH / 2, rx: newW / 2, ry: newH / 2 });
      return;
    }
    if (shapeKindAttr === 'ring') {
      regenerateRing(el, { cx: newX + newW / 2, cy: newY + newH / 2, rx: newW / 2, ry: newH / 2 }, ringInner(el));
      return;
    }

    // Paths and polylines/polygons: scale their baked-in geometry about the
    // fixed (opposite) corner, recomputed from the original captured at start.
    //
    // A parametric rect is a <path> but must NOT come through here: scaling its
    // baked `d` stretched the corner arcs (and in fact dropped them entirely),
    // and left its data-rect-* box stale so a later radius edit snapped the shape
    // back to its old size. It falls through to the rect branch below, which
    // regenerates `d` from the new box with the radii intact.
    if ((tag === 'path' || tag === 'polyline' || tag === 'polygon')
        && !el.hasAttribute('data-rect')
        && this.resizeOrigGeometry !== null) {
      const sx = origBBox.width !== 0 ? newW / origBBox.width : 1;
      const sy = origBBox.height !== 0 ? newH / origBBox.height : 1;
      const fx = handle.includes('w') ? origBBox.x + origBBox.width : origBBox.x;
      const fy = handle.includes('n') ? origBBox.y + origBBox.height : origBBox.y;
      if (tag === 'path') {
        el.setAttribute('d', scalePathData(this.resizeOrigGeometry, fx, fy, sx, sy));
      } else {
        el.setAttribute('points', scalePoints(this.resizeOrigGeometry, fx, fy, sx, sy));
      }
      return;
    }

    // Groups have no editable geometry: scale them about the fixed corner via a
    // transform composed in front of the group's original transform (captured
    // once at start). Lets a group selected on the canvas be resized as a unit.
    if (tag === 'g') {
      // A container carries a transform, not geometry: `origBBox` and the delta
      // arrive in the group's PARENT space (see the dispatch in onMouseMove) — the
      // same space this transform is written in — so the ratio is a true ratio and
      // the anchor needs no mapping. It used to arrive in WORLD space and get mapped
      // across here, which was consistent only while no ancestor rotated (#273).
      const sx = origBBox.width !== 0 ? newW / origBBox.width : 1;
      const sy = origBBox.height !== 0 ? newH / origBBox.height : 1;
      const fx = handle.includes('w') ? origBBox.x + origBBox.width : origBBox.x;
      const fy = handle.includes('n') ? origBBox.y + origBBox.height : origBBox.y;
      const tx = fx * (1 - sx);
      const ty = fy * (1 - sy);
      const orig = this.resizeOrigTransform ? ' ' + this.resizeOrigTransform : '';
      // PREPEND: the resize acts in the parent's space, so it wraps the group's own
      // transform instead of sitting inside it (where the world-space translate
      // would be pushed through whatever the group already carried).
      el.setAttribute('transform', `translate(${tx}, ${ty}) scale(${sx}, ${sy})${orig}`);
      return;
    }

    if (tag === 'rect' || el.hasAttribute('data-rect')) {
      // Handles both a plain <rect> and a parametric per-corner <path data-rect>
      // (regenerates its `d` for the new box, preserving the radii).
      applyRectBox(el, newX, newY, newW, newH);
    } else if (tag === 'ellipse') {
      el.setAttribute('cx', String(newX + newW / 2));
      el.setAttribute('cy', String(newY + newH / 2));
      el.setAttribute('rx', String(newW / 2));
      el.setAttribute('ry', String(newH / 2));
    } else if (tag === 'line') {
      if (handle.includes('e') || handle.includes('s')) {
        el.setAttribute('x2', String(origBBox.x + origBBox.width + dx));
        el.setAttribute('y2', String(origBBox.y + origBBox.height + dy));
      }
      if (handle.includes('w') || handle.includes('n')) {
        el.setAttribute('x1', String(origBBox.x + dx));
        el.setAttribute('y1', String(origBBox.y + dy));
      }
    } else if (tag === 'text' && isAreaText(el)) {
      // AREA text: the handles resize the BOX and the content re-wraps — the
      // glyphs never scale (#120). `y` stays the first baseline below the top.
      el.setAttribute('x', String(newX));
      el.setAttribute('y', String(newY + this.resizeOrigBaselineOff));
      setAreaTextBox(el as SVGTextElement, newW, el.hasAttribute('data-area-h') ? newH : undefined);
    } else if (tag === 'text' && (handle === 'e' || handle === 'w')) {
      // Dragging a SIDE handle gives point text a wrap box (Figma's auto→fixed
      // width): glyphs keep their size, the text re-wraps at the dragged width.
      // Capture the raw lines BEFORE flipping to area text — areaTextRaw's
      // textContent fallback would concatenate multi-line tspans without breaks.
      if (!el.hasAttribute('data-area-text')) {
        el.setAttribute('data-area-text', readTextLines(el as SVGTextElement).join('\n'));
      }
      el.setAttribute('x', String(newX));
      el.setAttribute('y', String(newY + this.resizeOrigBaselineOff));
      setAreaTextBox(el as SVGTextElement, newW);
    } else if (tag === 'text') {
      // Corner / vertical handles: scale from the size captured at resize start,
      // not the live (already scaled) size — otherwise each mousemove compounds
      // and the text explodes.
      const scaleFactor = origBBox.height !== 0 ? newH / origBBox.height : 1;
      el.setAttribute('x', String(newX));
      // `y` is the BASELINE — anchor it via the captured offset (scaled), NOT the box
      // bottom, so a horizontal drag (newH unchanged) leaves the text where it is.
      el.setAttribute('y', String(newY + this.resizeOrigBaselineOff * scaleFactor));
      el.setAttribute('font-size', String(this.resizeOrigFontSize * scaleFactor));
      // Multi-line tspans share the parent x — keep them aligned to the new origin.
      el.querySelectorAll('tspan').forEach((t) => { if (t.getAttribute('x') !== null) t.setAttribute('x', String(newX)); });
    } else if (tag === 'image' || tag === 'use' || tag === 'svg') {
      // A cropped image is a nested <svg> whose viewBox stays fixed, so writing
      // width/height scales its content (the crop) instead of revealing more.
      el.setAttribute('x', String(newX));
      el.setAttribute('y', String(newY));
      el.setAttribute('width', String(newW));
      el.setAttribute('height', String(newH));
    }
  }
}
