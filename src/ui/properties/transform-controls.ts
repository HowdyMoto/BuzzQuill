import type { AppState } from '../../core/state';
import type { ShapeData } from '../../core/types';
import { setRotation, nudgeTranslate, getRotation } from '../../core/transform';
import { localBBoxInLayer, visualWorldBBox, worldToLocal, matrixBetween } from '../../core/coords';
import { scalePathData } from '../../core/path-model';
import { scalePoints } from '../../core/shape-adapters';

import { isAreaText, setAreaTextBox } from '../../core/area-text';

import { bindScrubLiveTypeCommit } from '../dom';

import { applyRectBox } from '../../core/rect-shape';

/** Width/height ratio of the current selection, refreshed whenever the Transform
 *  readout syncs. When the aspect lock is on, editing W/H uses this to derive the
 *  other dimension. 0 = not usable (no selection / zero height). */
let aspectRatio = 0;

/** World-space bbox of an element (includes its own transform); null on failure. */
function worldBBox(el: SVGGraphicsElement): { x: number; y: number; width: number; height: number } | null {
  const svg = el.ownerSVGElement;
  return svg ? localBBoxInLayer(svg, el) : null;
}

/** The element's OWN (unrotated) size in drawing-layer units — the geometry
 *  dimensions, NOT the axis-aligned world box a rotation inflates. Rotation is
 *  orthonormal, so the CTM's column norms recover the pure scale regardless of
 *  rotation; multiplying the local getBBox by them gives Figma-style W/H that
 *  stay constant as the shape spins. Null on failure. */
function geometrySize(el: SVGGraphicsElement): { w: number; h: number } | null {
  const g = el;
  const layer = el.closest('#drawing-layer') as SVGGraphicsElement | null;
  let lb: DOMRect;
  try { lb = g.getBBox(); } catch { return null; }
  const m = layer ? matrixBetween(layer, g) : null; // element → drawing-layer
  if (!m) return { w: lb.width, h: lb.height };
  return { w: lb.width * Math.hypot(m.a, m.b), h: lb.height * Math.hypot(m.c, m.d) };
}

/** An element's VISIBLE world box — the crop viewport (cropped image) or mask ∩
 *  content (clip-group) in drawing-layer space (coords.visualWorldBBox owns the
 *  corner-mapping); falls back to the full world bbox when it has no visible box. */
function visualWorldBox(el: SVGGraphicsElement): { x: number; y: number; width: number; height: number } | null {
  const svg = el.ownerSVGElement;
  const box = svg ? visualWorldBBox(svg, el) : null;
  return box ?? worldBBox(el);
}

/** A shape's world box — the frame's OWN bounds for a frame (getBBox would be its
 *  children's union), the VISIBLE box for a cropped image / clip-group mask, else
 *  the element's world bbox. */
function shapeWorldBox(state: AppState, s: ShapeData): { x: number; y: number; width: number; height: number } | null {
  if (s.type === 'frame') {
    const ab = state.getArtboardById(s.id);
    if (ab) return { x: ab.x, y: ab.y, width: ab.width, height: ab.height };
  }
  const el = s.element;
  const cropped = s.type === 'image' && el.tagName.toLowerCase() === 'svg' && el.hasAttribute('data-crop');
  if (cropped || el.hasAttribute('data-clip-group')) return visualWorldBox(el);
  return worldBBox(s.element);
}

/** Union of several shapes' world boxes (the combined selection bounds). */
function unionWorldBBox(state: AppState, shapes: ShapeData[]): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of shapes) {
    const b = shapeWorldBox(state, s);
    if (!b) continue;
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
}

/**
 * Convert a WORLD-space box into the element's PARENT coordinate space.
 *
 * The attribute-writing branches of setShapeWorldBox set x/y/cx/cy directly, and
 * those attributes are read in the element's parent space — not the world. For a
 * shape sitting straight in #drawing-layer the two coincide, which is why this went
 * unnoticed; inside a frame at translate(600 300) writing a world x of 660 put the
 * shape at world 1260, so nudging X by 10 flung it 610px away.
 *
 * Both corners are mapped rather than just the origin, so an ancestor scale is
 * folded into w/h too (frames only translate today, but the panel shouldn't rely on
 * that staying true).
 */
function worldBoxToParent(el: SVGElement, x: number, y: number, w: number, h: number):
    { x: number; y: number; w: number; h: number } {
  const svg = el.ownerSVGElement;
  const parent = el.parentElement as unknown as SVGElement | null;
  if (!svg || !parent) return { x, y, w, h };
  const a = worldToLocal(svg, parent, { x, y });
  const b = worldToLocal(svg, parent, { x: x + w, y: y + h });
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
}

/**
 * Origin the Transform panel reports X/Y against — Figma's rule.
 *
 * Figma measures a shape from its containing FRAME, not the canvas: move the frame
 * and its children's X/Y don't change. Only something with no frame above it reads
 * in absolute page coordinates.
 *
 * GROUPS are transparent here, deliberately. In Figma a group is a bounding-box
 * convenience, not a coordinate space, so a rect inside a group inside a frame still
 * reads against the frame. BuzzQuill's groups ARE real <g> coordinate spaces, so
 * this walks past them and stops at the first [data-frame] ancestor rather than
 * taking whatever the immediate DOM parent happens to be.
 *
 * Returns world (drawing-layer) coordinates; {0,0} when there's no frame above.
 */
function reportingOrigin(el: SVGElement): { x: number; y: number } {
  const layerEl = document.getElementById('drawing-layer') as unknown as SVGGraphicsElement | null;
  if (!layerEl) return { x: 0, y: 0 };
  let n: Element | null = el.parentElement;
  while (n && n !== (layerEl as unknown as Element)) {
    if (n.hasAttribute?.('data-frame')) {
      const m = matrixBetween(layerEl, n as unknown as SVGGraphicsElement);
      return m ? { x: m.e, y: m.f } : { x: 0, y: 0 };   // frames translate only
    }
    n = n.parentElement;
  }
  return { x: 0, y: 0 };
}

/** A Transform readout value: up to two decimals (Figma's precision). Whole numbers
 *  hid sub-unit offsets — two paths a third of a unit apart both read "8", so there
 *  was no way to see, let alone type, the difference. */
function fmtTransform(v: number): string {
  const r = Math.round(v * 100) / 100;
  return String(r === 0 ? 0 : r); // never "-0"
}

/** Transform fields the user has typed into, scrubbed or stepped since the readout
 *  last wrote them. An untouched field re-applies the shape's EXACT value (its readout
 *  is rounded, and an edit in one field must not nudge the others by the rounding
 *  error); an edited one applies what it shows. That has to be tracked, not inferred
 *  from "the value equals the rounded readout": inferring it made typing the "8" a
 *  field already showed, into a shape really at 7.5, silently do nothing. */
const editedTransformFields = new WeakSet<HTMLInputElement>();

/** The origin a MULTI-selection reports against: the frame they all share, else
 *  absolute. Mixing frames has no single meaningful local space, and silently
 *  picking one shape's frame would make the other shapes' numbers lies. */
function sharedReportingOrigin(shapes: ShapeData[]): { x: number; y: number } {
  if (shapes.length === 0) return { x: 0, y: 0 };
  const first = reportingOrigin(shapes[0].element);
  for (let i = 1; i < shapes.length; i++) {
    const o = reportingOrigin(shapes[i].element);
    if (Math.abs(o.x - first.x) > 1e-6 || Math.abs(o.y - first.y) > 1e-6) return { x: 0, y: 0 };
  }
  return first;
}

/** Write a target WORLD box onto one shape (geometry only — no rotation). Mirrors the
 *  per-type logic the single-select Transform used, so multi-resize reuses it. */
function setShapeWorldBox(state: AppState, shape: ShapeData, x: number, y: number, w: number, h: number): void {
  const el = shape.element;
  const tag = el.tagName.toLowerCase();
  if (shape.type === 'frame') {
    const cur = state.getArtboardById(shape.id);
    const sizeChanged = !!cur && (Math.round(cur.width) !== Math.round(w) || Math.round(cur.height) !== Math.round(h));
    state.updateArtboard(shape.id, { x, y, width: w, height: h }, { keepChildrenFixed: sizeChanged });
    return;
  }
  // These branches write LOCAL geometry attributes, so the world target has to be
  // brought into the element's parent space first (see worldBoxToParent). The
  // path/polyline/group branch below stays in world space — it positions by a
  // measured world bbox and a delta, which needs no conversion.
  const L = worldBoxToParent(el, x, y, w, h);
  if (tag === 'rect' || el.hasAttribute('data-rect')) {
    applyRectBox(el, L.x, L.y, L.w, L.h); // <rect> or parametric per-corner <path data-rect>
  } else if (tag === 'image' || tag === 'use' || tag === 'svg') {
    // 'svg' = a cropped image; its viewBox is fixed, so width/height scale the content.
    el.setAttribute('x', String(L.x)); el.setAttribute('y', String(L.y));
    el.setAttribute('width', String(L.w)); el.setAttribute('height', String(L.h));
  } else if (tag === 'ellipse') {
    el.setAttribute('cx', String(L.x + L.w / 2)); el.setAttribute('cy', String(L.y + L.h / 2));
    el.setAttribute('rx', String(L.w / 2)); el.setAttribute('ry', String(L.h / 2));
  } else if (tag === 'text') {
    // `y` is the BASELINE (above the box bottom by the descender) — anchor it via the
    // baseline's offset within the current box, not y + h, so the text doesn't jump down.
    const bb = el.getBBox();
    const baseOff = (parseFloat(el.getAttribute('y') ?? '0') || 0) - bb.y;
    el.setAttribute('x', String(L.x)); el.setAttribute('y', String(L.y + baseOff));
    // Multi-line tspans share the text's absolute x — move them to the new origin too.
    (el as SVGTextElement).querySelectorAll('tspan').forEach((t) => {
      if (t.getAttribute('x') !== null) t.setAttribute('x', String(L.x));
    });
    // Area text: W/H resize the BOX (re-wrapping the content), never the glyphs.
    if (isAreaText(el)) setAreaTextBox(el as SVGTextElement, L.w, el.hasAttribute('data-area-h') ? L.h : undefined);
  } else if (tag === 'g') {
    // Groups and wrapper leaves (boolean / width / appearance / repeat) have no
    // editable geometry — compose a scale about the local top-left, exactly like
    // the corner-handle path in select.ts. The panel used to skip these, so a
    // typed W/H silently no-oped while the field kept the value (#214). Factors
    // come from the WORLD box (not the local bbox) so an already-transformed
    // wrapper resizes to the typed size.
    const gb0 = worldBBox(el);
    const sx = gb0 && gb0.width !== 0 ? w / gb0.width : 1;
    const sy = gb0 && gb0.height !== 0 ? h / gb0.height : 1;
    if (Math.abs(sx - 1) > 1e-6 || Math.abs(sy - 1) > 1e-6) {
      const lb = el.getBBox();
      const pre = `translate(${lb.x * (1 - sx)}, ${lb.y * (1 - sy)}) scale(${sx}, ${sy})`;
      const orig = el.getAttribute('transform');
      el.setAttribute('transform', orig ? `${orig} ${pre}` : pre);
    }
    const gb = worldBBox(el);
    if (gb) nudgeTranslate(el, x - gb.x, y - gb.y);
  } else {
    // path / polyline / polygon / line: scale geometry about the local
    // top-left, then translate so the WORLD bbox top-left lands at (x, y).
    const lb = el.getBBox();
    const sx = lb.width !== 0 ? w / lb.width : 1;
    const sy = lb.height !== 0 ? h / lb.height : 1;
    if (Math.abs(sx - 1) > 1e-6 || Math.abs(sy - 1) > 1e-6) {
      if (tag === 'path') {
        const d = el.getAttribute('d');
        if (d) el.setAttribute('d', scalePathData(d, lb.x, lb.y, sx, sy));
      } else if (tag === 'polyline' || tag === 'polygon') {
        el.setAttribute('points', scalePoints(el.getAttribute('points') ?? '', lb.x, lb.y, sx, sy));
      } else if (tag === 'line') {
        for (const [ax, ay] of [['x1', 'y1'], ['x2', 'y2']] as const) {
          el.setAttribute(ax, String(lb.x + (parseFloat(el.getAttribute(ax) ?? '0') - lb.x) * sx));
          el.setAttribute(ay, String(lb.y + (parseFloat(el.getAttribute(ay) ?? '0') - lb.y) * sy));
        }
      }
    }
    const gb = worldBBox(el);
    if (gb) nudgeTranslate(el, x - gb.x, y - gb.y);
  }
}

/** Update just the X/Y/W/H/R transform readout from the current selection (single =
 *  its bbox + rotation; multi = the combined union box, rotation blank). Cheap enough
 *  to call every frame, so it stays live during a canvas drag/resize/rotate.
 *  NEVER writes into the field the user is typing in — each keystroke live-applies,
 *  which re-runs this; rewriting the focused field made the next digit append to the
 *  refreshed value (typing "150" over "94" became 941 → 9415 → …). */
export function updateTransformReadout(state: AppState): void {
  const shapes = state.getSelectedShapes();
  if (shapes.length === 0) return;
  const propX = document.getElementById('prop-x') as HTMLInputElement | null;
  const propY = document.getElementById('prop-y') as HTMLInputElement | null;
  const propW = document.getElementById('prop-w') as HTMLInputElement | null;
  const propH = document.getElementById('prop-h') as HTMLInputElement | null;
  const propRotation = document.getElementById('prop-rotation') as HTMLInputElement | null;
  if (!propX || !propY || !propW || !propH || !propRotation) return;
  const put = (input: HTMLInputElement, v: string): void => {
    if (document.activeElement === input) return;
    input.value = v;
    editedTransformFields.delete(input); // it shows the readout again, not an edit
  };

  if (shapes.length > 1) {
    const U = unionWorldBBox(state, shapes);
    if (!U) return;
    const mo = sharedReportingOrigin(shapes);
    put(propX, fmtTransform(U.x - mo.x)); put(propY, fmtTransform(U.y - mo.y));
    put(propW, fmtTransform(U.width)); put(propH, fmtTransform(U.height));
    aspectRatio = U.height > 0 ? U.width / U.height : 0;
    put(propRotation, ''); // rotation is disabled for multi-selection
    return;
  }

  const shape = shapes[0];
  if (shape.type === 'frame') {
    const ab = state.getArtboardById(shape.id);
    if (ab) {
      put(propX, fmtTransform(ab.x)); put(propY, fmtTransform(ab.y));
      put(propW, fmtTransform(ab.width)); put(propH, fmtTransform(ab.height));
      aspectRatio = ab.height > 0 ? ab.width / ab.height : 0;
      put(propRotation, '0');
      return;
    }
  }
  try {
    const bbox = shapeWorldBox(state, shape) ?? shape.element.getBBox();
    // Figma semantics: X/Y are the bounding-box position; W/H are the shape's OWN
    // (unrotated) dimensions, so they stay constant as it rotates. For an unrotated
    // shape geometry == bbox, so this is behaviour-identical there.
    const rot = getRotation(shape.element);
    const geo = rot !== 0 ? geometrySize(shape.element) : null;
    const w = geo ? geo.w : bbox.width, h = geo ? geo.h : bbox.height;
    const o = reportingOrigin(shape.element);
    put(propX, fmtTransform(bbox.x - o.x)); put(propY, fmtTransform(bbox.y - o.y));
    put(propW, fmtTransform(w)); put(propH, fmtTransform(h));
    aspectRatio = h > 0 ? w / h : 0;
    put(propRotation, fmtTransform(rot));
  } catch { /* ignore */ }
}

export function setupTransformProperties(state: AppState): void {
  const propX = document.getElementById('prop-x') as HTMLInputElement;
  const propY = document.getElementById('prop-y') as HTMLInputElement;
  const propW = document.getElementById('prop-w') as HTMLInputElement;
  const propH = document.getElementById('prop-h') as HTMLInputElement;
  const propRotation = document.getElementById('prop-rotation') as HTMLInputElement;

  // ---- Transform (X / Y / W / H / R) ----
  //
  // Single selection: absolute box + rotation (frames route through updateArtboard).
  // Multi selection: X/Y move the whole selection; W/H scale it about the union
  // top-left; rotation is disabled (the on-canvas handle does group rotation).

  const applyPositionSingle = (shape: ShapeData, record: boolean): void => {
    // Typed X/Y are FRAME-relative (Figma semantics); everything below works in
    // world space, so lift them out of the frame first.
    const o = reportingOrigin(shape.element);
    // An untouched axis re-applies its EXACT value (see editedTransformFields), or an
    // edit in one field would nudge/scale the others by the readout's rounding.
    const cur = shapeWorldBox(state, shape);
    const pick = (input: HTMLInputElement, curV: number | undefined): number => {
      const n = parseFloat(input.value);
      if (curV === undefined || !Number.isFinite(curV)) return n;
      if (!Number.isFinite(n) || !editedTransformFields.has(input)) return curV;
      return n;
    };
    const x = pick(propX, cur ? cur.x - o.x : undefined) + o.x;
    const y = pick(propY, cur ? cur.y - o.y : undefined) + o.y;
    const w = pick(propW, cur?.width), h = pick(propH, cur?.height);
    if (shape.type === 'frame') {
      const cur = state.getArtboardById(shape.id);
      // Exact: `pick` re-applied untouched sides exactly. Comparing ROUNDED sides made
      // an X-only edit of a frame with a fractional size (408.67 tall) read as a resize.
      const sizeChanged = !!cur && (cur.width !== w || cur.height !== h);
      // Frames are top-level, so their X/Y are absolute either way (o is 0,0).
      state.updateArtboard(shape.id, { x, y, width: w, height: h }, { keepChildrenFixed: sizeChanged });
      if (record) state.saveHistory();
      return;
    }
    const el = shape.element;
    const rot = getRotation(el);
    if (rot === 0) {
      setShapeWorldBox(state, shape, x, y, w, h); // unrotated: box == geometry
    } else {
      // Figma semantics: W/H are the geometry dims, X/Y the AABB top-left. Apply the
      // geometry in the shape's UNROTATED frame (setShapeWorldBox is only correct
      // there), then re-rotate about the new geometry centre. The AABB of a box
      // rotated about its centre is (|w·cos|+|h·sin|) × (|w·sin|+|h·cos|); placing
      // the geometry so that box's top-left lands at (x, y) keeps the readout and
      // the edit in exact round-trip (issue #133 sibling — rotated resize/move).
      setRotation(el, 0, 0, 0);
      const rad = rot * Math.PI / 180;
      const aw = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
      const ah = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
      setShapeWorldBox(state, shape, x + (aw - w) / 2, y + (ah - h) / 2, w, h);
      const bb = el.getBBox();
      setRotation(el, rot, bb.x + bb.width / 2, bb.y + bb.height / 2);
    }
    shape.rotation = rot;
    if (record) {
      // Containment follows MOVES only: an X/Y change commits through the move
      // seam (frame auto-parenting + history — typing a shape "back over" a
      // frame used to strand it outside, #222); a pure W/H edit records plain
      // history and never re-parents. `pick` re-applied untouched axes exactly,
      // so this comparison is exact, not rounding-sensitive. Commit-only either
      // way: reparenting mid-keystroke would change the frame-relative origin
      // under the user's cursor while they type.
      if (!cur || x !== cur.x || y !== cur.y) state.commitMove([shape.id]);
      else state.saveHistory();
    }
    state.onChange_public();
  };

  // Rotation is its OWN gesture — it must never re-run setShapeWorldBox. The W/H
  // readout of a rotated shape is its axis-aligned WORLD box (bigger than the
  // geometry), so routing rotation through applyPositionSingle baked that inflated
  // box back into the geometry every keystroke, ballooning the shape (issue #133).
  // Here we only spin the element about its own local-geometry centre, leaving
  // geometry and the outermost translate untouched.
  const applyRotationSingle = (shape: ShapeData, record: boolean): void => {
    if (shape.type === 'frame') return; // frames are axis-aligned, never rotated
    const rotation = parseFloat(propRotation.value) || 0;
    shape.rotation = rotation;
    // getBBox is the LOCAL, pre-own-transform geometry box, so its centre is stable
    // regardless of the current rotation — the same anchor the on-canvas handle uses.
    const bbox = shape.element.getBBox();
    setRotation(shape.element, rotation, bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
    if (record) state.saveHistory();
    state.onChange_public();
  };
  const applyRotation = (record: boolean): void => {
    const shapes = state.getSelectedShapes();
    if (shapes.length === 1) applyRotationSingle(shapes[0], record); // R is single-select only
  };

  const applyTransform = (record: boolean): void => {
    const shapes = state.getSelectedShapes();
    if (shapes.length === 0) return;
    if (shapes.length === 1) { applyPositionSingle(shapes[0], record); return; }

    const U = unionWorldBBox(state, shapes);
    if (!U) return;
    // An untouched axis re-applies its EXACT value (see editedTransformFields), or
    // every keystroke in another field would nudge/scale the selection by the rounding.
    const pick = (input: HTMLInputElement, cur: number): number => {
      const n = parseFloat(input.value);
      return Number.isFinite(n) && editedTransformFields.has(input) ? n : cur;
    };
    // The fields show frame-relative numbers, so convert against the shared origin.
    const o = sharedReportingOrigin(shapes);
    const tX = pick(propX, U.x - o.x) + o.x, tY = pick(propY, U.y - o.y) + o.y;
    const tW = pick(propW, U.width), tH = pick(propH, U.height);
    const sx = U.width !== 0 ? tW / U.width : 1;
    const sy = U.height !== 0 ? tH / U.height : 1;
    // Snapshot boxes first — writes below mutate the DOM the boxes are read from.
    const boxes = shapes.map(s => shapeWorldBox(state, s));
    shapes.forEach((s, i) => {
      const b = boxes[i];
      if (!b) return;
      const nx = tX + (b.x - U.x) * sx, ny = tY + (b.y - U.y) * sy;
      setShapeWorldBox(state, s, nx, ny, b.width * sx, b.height * sy);
    });
    if (record) {
      // Same MOVE-only rule as the single path (#222): an X/Y change commits
      // through the move seam; a pure W/H scale is a resize and never re-parents.
      if (tX !== U.x || tY !== U.y) state.commitMove(shapes.map(s => s.id));
      else state.saveHistory();
    }
    state.onChange_public();
  };

  // A field counts as edited from its first keystroke, scrub tick or arrow step.
  // Registered BEFORE the live/commit bindings below so the mark is in place by
  // the time a scrub tick applies.
  const transformFields = [propX, propY, propW, propH, propRotation];
  for (const f of transformFields) f.addEventListener('input', () => editedTransformFields.add(f));
  // The browser fires no `change` when a field commits the value it held on focus,
  // so retyping the "8" a field shows over a shape really at 7.997 reached no
  // handler at all. Commit that retype ourselves, once, on Enter or blur.
  const commitRetype = (f: HTMLInputElement, commit: () => void): void => {
    let atFocus = '';
    f.addEventListener('focus', () => { atFocus = f.value; });
    const maybe = (): void => {
      if (!editedTransformFields.has(f) || f.value !== atFocus) return; // `change` covers it
      commit();
      editedTransformFields.delete(f); // committed: Enter-then-blur must not commit twice
    };
    f.addEventListener('keydown', (e) => { if (e.key === 'Enter') maybe(); });
    f.addEventListener('blur', maybe);
  };

  // Transform fields: typed digits apply on COMMIT only (Enter/blur), never per
  // keystroke — typing the "5" of "50" into X must not teleport the shape to
  // x=5 (#218). Drag-scrub and arrow-stepping still apply live.
  bindScrubLiveTypeCommit(propX, () => applyTransform(false), () => applyTransform(true));
  bindScrubLiveTypeCommit(propY, () => applyTransform(false), () => applyTransform(true));
  // When the aspect lock is on, editing one dimension derives the other from the
  // captured ratio before the resize is applied (issue #106). Off → normal.
  const linkFromW = (): void => {
    if (!state.aspectLocked || aspectRatio <= 0) return;
    const w = parseFloat(propW.value);
    if (isFinite(w)) { propH.value = fmtTransform(w / aspectRatio); editedTransformFields.add(propH); }
  };
  const linkFromH = (): void => {
    if (!state.aspectLocked || aspectRatio <= 0) return;
    const h = parseFloat(propH.value);
    if (isFinite(h)) { propW.value = fmtTransform(h * aspectRatio); editedTransformFields.add(propW); }
  };
  bindScrubLiveTypeCommit(propW, () => { linkFromW(); applyTransform(false); }, () => { linkFromW(); applyTransform(true); });
  bindScrubLiveTypeCommit(propH, () => { linkFromH(); applyTransform(false); }, () => { linkFromH(); applyTransform(true); });
  bindScrubLiveTypeCommit(propRotation, () => applyRotation(false), () => applyRotation(true));
  commitRetype(propX, () => applyTransform(true));
  commitRetype(propY, () => applyTransform(true));
  commitRetype(propW, () => { linkFromW(); applyTransform(true); });
  commitRetype(propH, () => { linkFromH(); applyTransform(true); });
  commitRetype(propRotation, () => applyRotation(true));

  // Aspect-ratio lock toggle (Transform panel). Governs both these fields and
  // drag-resize (see SelectTool). Persisted on AppState.
  const lockBtn = document.getElementById('prop-lock-ratio');
  if (lockBtn) {
    const syncLock = () => {
      lockBtn.classList.toggle('active', state.aspectLocked);
      lockBtn.setAttribute('aria-pressed', String(state.aspectLocked));
    };
    syncLock();
    lockBtn.addEventListener('click', () => { state.setAspectLocked(!state.aspectLocked); syncLock(); });
  }
}
