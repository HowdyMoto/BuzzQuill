import type { AppState } from '../core/state';
import type { AppearanceLayer, ShapeData } from '../core/types';
import { setRotation, nudgeTranslate, getRotation } from '../core/transform';
import { localBBoxInLayer, visualWorldBBox, worldToLocal, matrixBetween } from '../core/coords';
import { scalePathData } from '../core/path-model';
import { scalePoints } from '../core/shape-adapters';
import { readTextLines, writeTextLines, releaseImportedTextWidth } from '../core/text-lines';
import { isAreaText, reflowAreaText, setAreaTextBox, setAreaVAlign, areaVAlign, type AreaVAlign } from '../core/area-text';
import { fontMenuGroups, normalizeWeight } from '../fonts';
import { setupFontPicker, setFontPickerValue } from './font-picker';
import { setupWeightSlider, setWeightSlider } from './weight-slider';
import { setupOpenType, setOpenType } from './opentype-controls';
import { setupAxisSliders, setAxisSliders } from './axis-sliders';
import { bindLiveCommit, bindScrubLiveTypeCommit } from './dom';
import { setSliderValue, sliderField } from './slider-field';
import {
  hasFill, hasCornerRadius, all, common, MIXED,
  type Maybe, type ShapeType,
} from '../core/shape-props';
import { applyRectBox, readRectBox } from '../core/rect-shape';
import { reversePathData } from '../core/path-model';
import { flipTextSpan } from '../core/path-direction';

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

/** Convert SVG fill/stroke values to CSS-renderable backgrounds for preview swatches */
export function paintPreviewBg(value: string, state: AppState): string {
  if (!value || value === 'none') return 'transparent';
  if (value.startsWith('url(#grad-')) {
    const id = value.match(/url\(#(grad-\d+)\)/)?.[1];
    if (id) {
      const grad = state.getGradientById(id);
      if (grad) {
        const stops = grad.stops.map(s => `${s.color} ${Math.round(s.offset * 100)}%`).join(', ');
        if (grad.type === 'linear') {
          const dx = (grad.x2 ?? 1) - (grad.x1 ?? 0);
          const dy = (grad.y2 ?? 0) - (grad.y1 ?? 0);
          const angle = Math.round((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360);
          return `linear-gradient(${angle}deg, ${stops})`;
        }
        return `radial-gradient(circle, ${stops})`;
      }
    }
  }
  if (value.startsWith('url(#pat-')) {
    // An image pattern shows the actual image (so a fill swatch reveals its source);
    // preset patterns fall back to a neutral checker glyph.
    const id = value.match(/url\(#(pat-\d+)\)/)?.[1];
    const pat = id ? state.getPatternById(id) : undefined;
    if (pat?.type === 'image' && pat.imageDataUrl) {
      return `url("${pat.imageDataUrl}") center / cover no-repeat`;
    }
    return 'repeating-conic-gradient(#555 0% 25%, #666 0% 50%) 0 0/8px 8px';
  }
  if (value.startsWith('url(')) return '#888';
  return value;
}

// ---- Mixed-aware control helpers (used by updatePropertiesPanel) ----

const MIXED_HINT = 'Mixed';
/** Diagonal split swatch that reads as "these objects differ". */
const MIXED_SWATCH = 'linear-gradient(135deg, #9aa0ab 0 48%, #4b5160 52% 100%)';

/** A number/text field shows the shared value, or blanks with a "Mixed" placeholder.
 *  Never writes into the field the user is typing in — every keystroke live-applies,
 *  which re-renders the panel, and a rewrite mid-edit clobbers the entry. */
function setNumField(input: HTMLInputElement, v: Maybe<number>): void {
  if (document.activeElement === input) return;
  if (v === MIXED || v === undefined) { input.value = ''; input.placeholder = MIXED_HINT; }
  else { input.value = String(v); input.placeholder = ''; }
}

/** Same focus rule for direct text-field writes. */
function putVal(input: HTMLInputElement, v: string): void {
  if (document.activeElement !== input) input.value = v;
}

/** A toggle button: active / inactive / indeterminate (mixed). */
function setToggle(btn: HTMLButtonElement, v: Maybe<boolean>): void {
  if (v === MIXED || v === undefined) { btn.classList.remove('active'); btn.classList.add('indeterminate'); }
  else { btn.classList.toggle('active', v); btn.classList.remove('indeterminate'); }
}

/** A paint preview swatch: shared colour, transparent (none), or the mixed swatch. */
function setPreview(el: HTMLElement, v: Maybe<string>, state: AppState): void {
  if (v === MIXED || v === undefined) { el.style.background = MIXED_SWATCH; return; }
  el.style.background = v === 'none' ? 'transparent' : paintPreviewBg(v, state);
}

/** Show the Point-type row while node-editing and reflect the selection's type. */
function updateNodeRow(state: AppState): void {
  const row = document.getElementById('prop-node-row') as HTMLElement | null;
  if (!row) return;
  const session = state.pathEdit;
  const active = !!(state.editingPathId && session && session.selected.size > 0);
  row.style.display = active ? '' : 'none';
  if (!active) return;
  const type = session!.selectionType();
  (document.getElementById('prop-node-corner') as HTMLButtonElement).classList.toggle('active', type === 'corner');
  (document.getElementById('prop-node-smooth') as HTMLButtonElement).classList.toggle('active', type === 'smooth');
  (document.getElementById('prop-node-broken') as HTMLButtonElement).classList.toggle('active', type === 'broken');
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

/** The <text> element the type controls should edit: the shape itself when it's a
 *  plain text, or the hidden [data-ap-src] source <text> inside a multi-stroke
 *  (appearance) wrapper. Null for anything that isn't text-backed. */
function textTarget(shape: ShapeData): SVGTextElement | null {
  if (shape.type === 'text') return shape.element as unknown as SVGTextElement;
  if (shape.type === 'appearance') {
    const src = shape.element.querySelector(':scope > [data-ap-src]');
    if (src && src.tagName.toLowerCase() === 'text') return src as unknown as SVGTextElement;
  }
  return null;
}

/** True when the object is text-backed (plain text or a multi-stroke text wrapper).
 *  Exported so the inspector shows the Text panel for ANY all-text selection (one or
 *  many) — the panel's read + apply paths are already multi-selection aware. */
export function isTextShape(shape: ShapeData): boolean { return !!textTarget(shape); }

export function setupProperties(state: AppState): void {
  // Text properties are ONE thing, so fold the separate "Type settings" panel's rows
  // into the Character panel and drop the extra panel. (index.html still carries them as
  // two panels — another agent is mid-refactor there — so we consolidate at runtime;
  // the moved controls keep their ids/listeners, and inspector's now-dead
  // show('panel-type-advanced') is a harmless no-op on the removed element.)
  const advPanel = document.getElementById('panel-type-advanced');
  const charBody = document.querySelector('#panel-type .panel-body');
  const advBody = advPanel?.querySelector('.panel-body');
  if (advPanel && charBody && advBody) {
    while (advBody.firstChild) charBody.appendChild(advBody.firstChild);
    advPanel.remove();
  }
  // "Character" is Illustrator jargon; this is just the object's Text properties.
  const charHeader = document.querySelector('#panel-type .panel-header span');
  if (charHeader) charHeader.textContent = 'Text';

  // Node point-type buttons (visible only while node-editing a path).
  for (const [id, type] of [
    ['prop-node-corner', 'corner'], ['prop-node-smooth', 'smooth'], ['prop-node-broken', 'broken'],
  ] as const) {
    document.getElementById(id)?.addEventListener('click', () => {
      if (!state.pathEdit || state.pathEdit.selected.size === 0) return;
      state.pathEdit.setSelectedType(type);
      state.commitPathEdit();
    });
  }

  const fillNoneBtn = document.getElementById('prop-fill-none') as HTMLButtonElement;
  const fillOpacityInput = document.getElementById('prop-fill-opacity') as HTMLInputElement;
  const fontSizeInput = document.getElementById('prop-font-size') as HTMLInputElement;
  const textContentInput = document.getElementById('prop-text-content') as HTMLTextAreaElement;
  const italicBtn = document.getElementById('prop-italic') as HTMLButtonElement;
  const lineHeightInput = document.getElementById('prop-line-height') as HTMLInputElement;
  const letterSpacingInput = document.getElementById('prop-letter-spacing') as HTMLInputElement;
  const textAlignGroup = document.getElementById('text-align') as HTMLElement;
  const textTransformSelect = document.getElementById('prop-text-transform') as HTMLSelectElement;
  const underlineBtn = document.getElementById('prop-underline') as HTMLButtonElement;
  const strikeBtn = document.getElementById('prop-strike') as HTMLButtonElement;
  const baselineShiftInput = document.getElementById('prop-baseline-shift') as HTMLInputElement;
  const pathOffsetInput = document.getElementById('prop-path-offset') as HTMLInputElement;
  const propRx = document.getElementById('prop-rx') as HTMLInputElement;
  const propX = document.getElementById('prop-x') as HTMLInputElement;
  const propY = document.getElementById('prop-y') as HTMLInputElement;
  const propW = document.getElementById('prop-w') as HTMLInputElement;
  const propH = document.getElementById('prop-h') as HTMLInputElement;
  const propRotation = document.getElementById('prop-rotation') as HTMLInputElement;

  // ---- Per-property appliers ----
  //
  // Each control writes ONE property to EVERY selected object that supports it, as a
  // single undo step (record=true on commit). With nothing selected, the property is
  // stored on the tool defaults instead. This replaces the old "write every control
  // to the primary object" apply, which both ignored the rest of a multi-selection
  // and clobbered per-object values you weren't editing.

  /** Run `write` over each selected supporting shape; else update the tool default.
   *  Appearance-wrapped (multi-paint) shapes carry their paints in a layer stack the
   *  plain attribute writers can't touch — when `writeStack` is given they get a
   *  stack edit instead, batched through setAppearanceMulti (one rebuild + undo step,
   *  selection preserved). Without `writeStack` the writer's own skip applies. */
  const applyProp = (
    supports: (t: ShapeType) => boolean,
    write: (shape: ShapeData) => void,
    record: boolean,
    writeStack?: (layers: AppearanceLayer[]) => void,
  ): void => {
    const shapes = state.getSelectedShapes().filter(s => supports(s.type));
    // Nothing selected → no-op. New shapes use the FIXED defaultStyle; editing a panel
    // never "learns" a new default (defaults change only via the explicit Default
    // Fill/Stroke command). Panels only ever affect the selected object.
    if (shapes.length === 0) return;
    const edits: Array<{ id: string; layers: AppearanceLayer[] }> = [];
    for (const s of shapes) {
      if (s.type === 'appearance' && writeStack) {
        const layers = state.getAppearance(s.id);
        writeStack(layers);
        edits.push({ id: s.id, layers });
      } else write(s);
    }
    if (edits.length > 0) state.setAppearanceMulti(edits, [...state.selectedShapeIds], false);
    if (record) state.saveHistory();
    state.onChange_public();
  };

  // Fill on/off
  const applyFillNone = (none: boolean, record: boolean): void => applyProp(hasFill, (s) => {
    const el = s.element;
    if (none) { el.setAttribute('fill', 'none'); s.style.fill = 'none'; }
    else {
      const c = s.style.fill && s.style.fill !== 'none' ? s.style.fill : state.defaultStyle.fill;
      el.setAttribute('fill', c); s.style.fill = c;
    }
  }, record, (layers) => {
    const f = layers.find(l => l.t === 'fill');
    if (none) { if (f) f.visible = false; }
    else if (f) f.visible = true;
    else layers.push({ t: 'fill', paint: state.defaultStyle.fill, opacity: 1 });
  });
  // Fill opacity
  const applyFillOpacity = (v: number, record: boolean): void => applyProp(hasFill, (s) => {
    const el = s.element;
    if (v < 1) el.setAttribute('fill-opacity', String(v)); else el.removeAttribute('fill-opacity');
    s.style.fillOpacity = v;
  }, record, (layers) => {
    const f = layers.find(l => l.t === 'fill');
    if (f) { f.visible = true; f.opacity = v; }
    else layers.push({ t: 'fill', paint: state.defaultStyle.fill, opacity: v });
  });
  // Cap / Join / Miter are path-level; owned by the top-level Stroke-panel controls
  // (ui/markers.ts), so they're no longer wired from here.
  // Corner radius (rect only). The linked field sets all four corners; the per-corner
  // grid sets them independently (which promotes the rect to a parametric path).
  const applyRx = (rx: number, record: boolean): void => {
    if (!state.getSelectedShapes().some(s => s.type === 'rect')) return;
    state.setSelectionRectRadii([rx, rx, rx, rx], record);
  };
  const applyCornerRadii = (record: boolean): void => {
    const rd = (id: string) => Math.max(0, parseFloat((document.getElementById(id) as HTMLInputElement).value) || 0);
    state.setSelectionRectRadii([rd('prop-rx-tl'), rd('prop-rx-tr'), rd('prop-rx-br'), rd('prop-rx-bl')], record);
  };
  // Text properties. These target the shape's <text> — or, for a MULTI-STROKE text
  // (wrapped as an `appearance` group), the hidden source <text> inside it — then
  // regenerate the wrapper's render-clones. The clones deep-clone the source, so every
  // attribute-based font prop propagates for free; text-transform is set on the outer
  // element instead and rides CSS inheritance into the clones.
  const applyTextProp = (
    write: (el: SVGTextElement, shape: ShapeData) => void,
    record: boolean,
  ): void => {
    const shapes = state.getSelectedShapes();
    let touched = false;
    for (const s of shapes) {
      const el = textTarget(s);
      if (!el) continue;
      touched = true;
      write(el, s);
      if (s.type === 'appearance') state.refreshAppearance(s.id); // rebuild multi-stroke render
    }
    if (!touched) return; // nothing selected → no-op (new text uses the fixed defaults)
    if (record) state.saveHistory();
    state.onChange_public();
  };
  // Multi-line text keeps its line spacing in each <tspan>'s dy (= font-size × line-height),
  // so a size- or line-height change must re-lay-out the tspans (single-line text has none).
  // AREA text re-WRAPS instead — any metric change moves the wrap points (#120).
  const relayoutTspans = (el: SVGTextElement): void => {
    if (isAreaText(el)) { reflowAreaText(el); return; }
    const tspans = el.querySelectorAll('tspan');
    if (!tspans.length) return;
    const fs = parseFloat(el.getAttribute('font-size') ?? '24') || 24;
    const lh = parseFloat(el.getAttribute('data-line-height') ?? '') || 1.2;
    tspans.forEach((t, i) => t.setAttribute('dy', i === 0 ? '0' : String(fs * lh)));
  };
  // Contents — the string itself. Empty is allowed (the shape stays selected so the
  // user can keep typing); a Mixed multi-selection is left alone until they type.
  const applyTextContent = (record: boolean): void => {
    if (textContentInput.placeholder === MIXED_HINT && textContentInput.value === '') return;
    applyTextProp((el) => writeTextLines(el, textContentInput.value.split('\n')), record);
  };
  // Releasing an imported run's pinned width belongs ONLY on edits that change its
  // advance width — family, size, weight, italic, letter-spacing (and content, handled
  // inside writeTextLines). Doing it for every text property meant a no-op click on
  // Underline or V-align silently reflowed an imported PDF run out of alignment.
  const applyFontFamilyValue = (family: string, record: boolean): void => applyTextProp((el, shape) => {
    releaseImportedTextWidth(el);
    el.setAttribute('font-family', family); if (shape.type === 'text') shape.style.fontFamily = family;
    relayoutTspans(el); // area text re-wraps: a family change moves the wrap points
  }, record);
  const applyFontSize = (record: boolean): void => {
    const v = parseFloat(fontSizeInput.value);
    if (!Number.isFinite(v)) return; // "Mixed"/empty field: don't clobber
    applyTextProp((el, shape) => {
      releaseImportedTextWidth(el);
      el.setAttribute('font-size', String(v)); if (shape.type === 'text') shape.style.fontSize = v;
      relayoutTspans(el);
    }, record);
  };
  const applyFontWeightValue = (w: number, record: boolean): void => {
    if (!Number.isFinite(w)) return;
    applyTextProp((el, shape) => {
      releaseImportedTextWidth(el);
      el.setAttribute('font-weight', String(w)); if (shape.type === 'text') shape.style.fontWeight = String(w);
      relayoutTspans(el);
    }, record);
  };
  const applyItalic = (record: boolean): void => {
    const it = italicBtn.classList.contains('active');
    applyTextProp((el, shape) => {
      releaseImportedTextWidth(el);
      el.setAttribute('font-style', it ? 'italic' : 'normal');
      if (shape.type === 'text') shape.style.fontStyle = it ? 'italic' : 'normal';
      relayoutTspans(el);
    }, record);
  };
  const applyLineHeight = (record: boolean): void => {
    const v = parseFloat(lineHeightInput.value);
    if (!Number.isFinite(v) || v <= 0) return; // "Mixed"/empty: don't clobber
    applyTextProp((el) => { el.setAttribute('data-line-height', String(v)); relayoutTspans(el); }, record);
  };
  const applyLetterSpacing = (record: boolean): void => {
    const v = parseFloat(letterSpacingInput.value);
    if (!Number.isFinite(v)) return;
    applyTextProp((el) => {
      releaseImportedTextWidth(el);
      if (v) el.setAttribute('letter-spacing', String(v)); else el.removeAttribute('letter-spacing');
      relayoutTspans(el);
    }, record);
  };
  const applyTextAnchor = (a: 'start' | 'middle' | 'end', record: boolean): void => applyTextProp((el) => {
    if (a === 'start') el.removeAttribute('text-anchor'); else el.setAttribute('text-anchor', a);
  }, record);
  // Vertical alignment within the box — area text only (point text has no box).
  const applyVAlign = (v: AreaVAlign, record: boolean): void => applyTextProp((el) => {
    if (isAreaText(el)) setAreaVAlign(el, v);
  }, record);
  // Case → text-transform, set on the OUTER element (the text, or the multi-stroke
  // wrapper) so it renders directly and, for a wrapper, CSS-inherits to the clones.
  const applyTextTransform = (record: boolean): void => {
    const v = textTransformSelect.value;
    applyTextProp((_el, shape) => {
      const hostEl = shape.element as unknown as SVGElement;
      if (v === 'none' || !v) hostEl.style.removeProperty('text-transform'); else hostEl.style.textTransform = v;
    }, record);
  };
  // OpenType features → font-feature-settings, on the outer element (renders directly;
  // CSS-inherits to a multi-stroke wrapper's clones, which strip inline style).
  const applyFontFeatures = (settings: string): void => {
    applyTextProp((_el, shape) => {
      const hostEl = shape.element as unknown as SVGElement;
      if (settings) hostEl.style.fontFeatureSettings = settings; else hostEl.style.removeProperty('font-feature-settings');
    }, true);
  };
  // Variable-font axes → font-variation-settings (width / optical size), on the outer
  // element (renders directly; CSS-inherits to a wrapper's clones). Weight is excluded
  // (it stays on font-weight via the specimen slider), so the two compose.
  const applyFontVariations = (settings: string): void => {
    applyTextProp((_el, shape) => {
      const hostEl = shape.element as unknown as SVGElement;
      if (settings) hostEl.style.fontVariationSettings = settings; else hostEl.style.removeProperty('font-variation-settings');
    }, true);
  };
  // Decoration → text-decoration (a real SVG presentation attribute). Underline + strike combine.
  const applyDecoration = (record: boolean): void => {
    const parts: string[] = [];
    if (underlineBtn.classList.contains('active')) parts.push('underline');
    if (strikeBtn.classList.contains('active')) parts.push('line-through');
    const val = parts.join(' ');
    applyTextProp((el) => { if (val) el.setAttribute('text-decoration', val); else el.removeAttribute('text-decoration'); }, record);
  };
  const applyBaselineShift = (record: boolean): void => {
    const v = parseFloat(baselineShiftInput.value);
    if (!Number.isFinite(v)) return;
    applyTextProp((el) => { if (v) el.setAttribute('baseline-shift', String(v)); else el.removeAttribute('baseline-shift'); }, record);
  };
  // Text-on-path: startOffset (% along the path) lives on the <textPath> child.
  const applyPathOffset = (record: boolean): void => {
    const v = parseFloat(pathOffsetInput.value);
    if (!Number.isFinite(v)) return;
    applyTextProp((el) => {
      const tp = el.querySelector('textPath');
      if (tp) { if (v) tp.setAttribute('startOffset', `${v}%`); else tp.removeAttribute('startOffset'); }
    }, record);
  };
  // Flip text to the other side of the path by REVERSING the baseline (SVG's textPath
  // side="right" is unsupported in Blink/WebKit). The text keeps its span, mirrored.
  const flipTextOnPath = (): void => {
    const shape = state.getSelectedShape();
    if (!shape) return;
    const textEl = textTarget(shape);
    const tp = textEl?.querySelector('textPath');
    if (!textEl || !tp) return;
    const pathId = (tp.getAttribute('href') || tp.getAttribute('xlink:href') || '').replace(/^#/, '');
    const pathEl = pathId ? (document.getElementById(pathId) as SVGGeometryElement | null) : null;
    const oldD = pathEl?.getAttribute('d');
    if (!pathEl || !oldD) return;
    flipTextSpan(tp, pathEl);
    pathEl.setAttribute('d', reversePathData(oldD));
    if (shape.type === 'appearance') state.refreshAppearance(shape.id);
    state.saveHistory();
    state.onChange_public();
  };

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

  // ---- Wiring ----

  // Live drag-scrub / slider `input` applies with record=false (no undo spam); the
  // final `change`/release commits with record=true → one undo step. Shared helper.
  const bindLive = bindLiveCommit;

  // Fill on/off — indeterminate (mixed) resolves to "filled" on the first click.
  fillNoneBtn.addEventListener('click', () => {
    const none = fillNoneBtn.classList.contains('indeterminate') ? false : !fillNoneBtn.classList.contains('active');
    fillNoneBtn.classList.remove('indeterminate');
    fillNoneBtn.classList.toggle('active', none);
    applyFillNone(none, true);
  });
  // Swap the plain weight <select> for the specimen weight slider at runtime (keeps
  // index.html untouched). onPick applies the weight — live while dragging, committed on release.
  const weightHost = document.createElement('div');
  document.getElementById('prop-font-weight')?.replaceWith(weightHost);
  setupWeightSlider(weightHost, (w, commit) => applyFontWeightValue(w, commit));
  italicBtn.addEventListener('click', () => {
    const on = italicBtn.classList.contains('indeterminate') ? true : !italicBtn.classList.contains('active');
    italicBtn.classList.remove('indeterminate');
    italicBtn.classList.toggle('active', on);
    applyItalic(true);
  });

  fillOpacityInput.after(sliderField(fillOpacityInput, { scale: 100, unit: '%' }));
  bindLive(fillOpacityInput, () => applyFillOpacity(parseFloat(fillOpacityInput.value), false),
    () => applyFillOpacity(parseFloat(fillOpacityInput.value), true));

  bindLive(fontSizeInput, () => applyFontSize(false), () => applyFontSize(true));
  // Contents: every keystroke live-updates the canvas; blur/change records history.
  // Enter inserts a newline (multi-line text); Escape just leaves the field.
  bindLive(textContentInput, () => applyTextContent(false), () => applyTextContent(true));
  textContentInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); textContentInput.blur(); }
  });
  setupFontPicker(document.getElementById('font-family-picker')!, fontMenuGroups(), (family) => applyFontFamilyValue(family, true));
  bindLive(lineHeightInput, () => applyLineHeight(false), () => applyLineHeight(true));
  bindLive(letterSpacingInput, () => applyLetterSpacing(false), () => applyLetterSpacing(true));
  textAlignGroup.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const a = (btn.getAttribute('data-anchor') as 'start' | 'middle' | 'end') || 'start';
      textAlignGroup.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyTextAnchor(a, true);
    });
  });
  const textVAlignGroup = document.getElementById('text-valign') as HTMLElement | null;
  textVAlignGroup?.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = (btn.getAttribute('data-valign') as AreaVAlign) || 'top';
      textVAlignGroup.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyVAlign(v, true);
    });
  });
  textTransformSelect.addEventListener('change', () => applyTextTransform(true));
  const wireDecoBtn = (btn: HTMLButtonElement) => btn.addEventListener('click', () => {
    btn.classList.remove('indeterminate');
    btn.classList.toggle('active');
    applyDecoration(true);
  });
  wireDecoBtn(underlineBtn); wireDecoBtn(strikeBtn);
  bindLive(baselineShiftInput, () => applyBaselineShift(false), () => applyBaselineShift(true));
  bindLive(pathOffsetInput, () => applyPathOffset(false), () => applyPathOffset(true));
  // Flip control, appended to the path row at runtime (index.html is mid-refactor).
  const pathRowForFlip = document.getElementById('prop-path-row');
  if (pathRowForFlip && !document.getElementById('prop-path-flip')) {
    const field = document.createElement('div'); field.className = 'panel-field';
    const label = document.createElement('label'); label.textContent = 'Flip';
    const group = document.createElement('div'); group.className = 'text-style-group';
    const flipBtn = document.createElement('button');
    flipBtn.type = 'button'; flipBtn.className = 'text-style-btn'; flipBtn.id = 'prop-path-flip';
    flipBtn.title = 'Flip text to the other side of the path'; flipBtn.textContent = '⇅';
    group.appendChild(flipBtn); field.appendChild(label); field.appendChild(group);
    pathRowForFlip.appendChild(field);
    flipBtn.addEventListener('click', flipTextOnPath);
  }
  // OpenType feature chips, appended to the Text panel at runtime (font-inspected; the
  // row hides itself via CSS when the font offers no opt-in features).
  const charBodyForOt = document.querySelector('#panel-type .panel-body');
  if (charBodyForOt && !document.getElementById('prop-opentype')) {
    const otRow = document.createElement('div'); otRow.className = 'panel-row';
    const otField = document.createElement('div'); otField.className = 'panel-field full';
    const otLabel = document.createElement('label'); otLabel.textContent = 'OpenType';
    const otChips = document.createElement('div'); otChips.id = 'prop-opentype'; otChips.className = 'ot-chips';
    otField.appendChild(otLabel); otField.appendChild(otChips); otRow.appendChild(otField);
    charBodyForOt.appendChild(otRow);
    setupOpenType(otChips, (settings) => applyFontFeatures(settings));
  }
  // Variable-font axis sliders (width / optical size), appended at runtime; the row
  // hides itself when the font has no such axes.
  if (charBodyForOt && !document.getElementById('prop-axes')) {
    const axRow = document.createElement('div'); axRow.className = 'panel-row';
    const axField = document.createElement('div'); axField.className = 'panel-field full';
    const axHost = document.createElement('div'); axHost.id = 'prop-axes'; axHost.className = 'axis-list';
    axField.appendChild(axHost); axRow.appendChild(axField);
    charBodyForOt.appendChild(axRow);
    setupAxisSliders(axHost, (settings) => applyFontVariations(settings));
  }

  bindLive(propRx, () => { const v = parseFloat(propRx.value); if (Number.isFinite(v)) applyRx(v, false); },
    () => { const v = parseFloat(propRx.value); if (Number.isFinite(v)) applyRx(v, true); });
  // Per-corner radius grid + its reveal toggle.
  for (const id of ['prop-rx-tl', 'prop-rx-tr', 'prop-rx-br', 'prop-rx-bl']) {
    const inp = document.getElementById(id) as HTMLInputElement | null;
    if (inp) bindLive(inp, () => applyCornerRadii(false), () => applyCornerRadii(true));
  }
  document.getElementById('prop-corners-toggle')?.addEventListener('click', () => {
    const grid = document.getElementById('prop-corners-grid');
    const btn = document.getElementById('prop-corners-toggle');
    if (!grid || !btn) return;
    const open = grid.style.display === 'none';
    grid.style.display = open ? '' : 'none';
    btn.classList.toggle('active', open);
  });

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

/** Refresh ONLY the corner-radius fields (the linked field + the per-corner grid)
 *  from the current selection. Cheap enough to run every frame, so the panel
 *  tracks a live corner-radius handle drag the same way X/Y/W/H/R track a resize.
 *  setNumField already skips the field being typed in, so this never fights the
 *  user's own edits. No-op unless every selected shape has a corner radius. */
export function updateRadiusReadout(state: AppState): void {
  const propRx = document.getElementById('prop-rx') as HTMLInputElement | null;
  if (!propRx) return;
  const shapes = state.getSelectedShapes();
  if (shapes.length === 0 || !all(shapes, hasCornerRadius)) return;
  const boxes = shapes.map(s => readRectBox(s.element));
  const cornerIds = ['prop-rx-tl', 'prop-rx-tr', 'prop-rx-br', 'prop-rx-bl'] as const;
  cornerIds.forEach((id, ci) => {
    const inp = document.getElementById(id) as HTMLInputElement | null;
    if (inp) setNumField(inp, common(boxes, b => b.radii[ci]));
  });
  // Linked field = the single radius shared by every corner of every selected rect,
  // otherwise "Mixed".
  const flat = boxes.flatMap(b => b.radii);
  const uniform = flat.length > 0 && flat.every(v => v === flat[0]);
  setNumField(propRx, uniform ? flat[0] : MIXED);
}

/** Re-show the Text panel for a multi-stroke text (an `appearance` wrapper whose
 *  source is a <text>), which the inspector — keyed to type 'text' — otherwise hides.
 *  Must run AFTER updateInspector in the state-change cycle. */
export function syncTextPanelVisibility(state: AppState): void {
  const ids = state.selectedShapeIds;
  if (ids.length !== 1) return;
  const shape = state.findShapeById(ids[0]);
  if (shape && shape.type === 'appearance' && isTextShape(shape)) {
    const p = document.getElementById('panel-type');
    if (p) p.style.display = '';
  }
}

export function updatePropertiesPanel(state: AppState): void {
  const fillGroup = document.getElementById('fill-group') as HTMLElement | null;
  const fillNoneBtn = document.getElementById('prop-fill-none') as HTMLButtonElement;
  const fillPreview = document.getElementById('prop-fill-preview') as HTMLElement;
  const fillOpacityInput = document.getElementById('prop-fill-opacity') as HTMLInputElement;
  const fontSizeInput = document.getElementById('prop-font-size') as HTMLInputElement;
  const italicBtn = document.getElementById('prop-italic') as HTMLButtonElement;
  const lineHeightInput = document.getElementById('prop-line-height') as HTMLInputElement;
  const letterSpacingInput = document.getElementById('prop-letter-spacing') as HTMLInputElement;
  const textAlignGroup = document.getElementById('text-align') as HTMLElement;
  const textTransformSelect = document.getElementById('prop-text-transform') as HTMLSelectElement;
  const underlineBtn = document.getElementById('prop-underline') as HTMLButtonElement;
  const strikeBtn = document.getElementById('prop-strike') as HTMLButtonElement;
  const baselineShiftInput = document.getElementById('prop-baseline-shift') as HTMLInputElement;
  const pathOffsetInput = document.getElementById('prop-path-offset') as HTMLInputElement;
  const pathRow = document.getElementById('prop-path-row') as HTMLElement;
  const propRx = document.getElementById('prop-rx') as HTMLInputElement;
  const rxRow = document.getElementById('prop-corners-row') as HTMLElement;
  const propRotation = document.getElementById('prop-rotation') as HTMLInputElement;

  // Toolbar swatches
  const fillSwatch = document.querySelector('#tb-fill-swatch .swatch-inner') as HTMLElement;
  const strokeSwatch = document.querySelector('#tb-stroke-swatch .swatch-inner') as HTMLElement;

  const shapes = state.getSelectedShapes();

  if (shapes.length === 0) {
    // ---- Nothing selected: reflect the tool defaults ----
    const ds = state.defaultStyle;
    if (fillGroup) fillGroup.style.display = '';
    fillNoneBtn.classList.remove('indeterminate');
    italicBtn.classList.remove('indeterminate');
    fillNoneBtn.classList.toggle('active', state.fillNone);
    fillPreview.style.background = state.fillNone ? 'transparent' : paintPreviewBg(ds.fill, state);
    setSliderValue(fillOpacityInput, ds.fillOpacity ?? 1);
    putVal(propRx, String(ds.rx ?? 0)); propRx.placeholder = '';
    rxRow.style.display = 'none';
    updateNodeRow(state);
    const rotRow0 = document.getElementById('prop-rotation-row');
    if (rotRow0) rotRow0.style.display = '';
    fillSwatch.style.background = state.fillNone ? 'transparent' : paintPreviewBg(ds.fill, state);
    strokeSwatch.style.borderColor = state.strokeNone ? 'transparent' : (ds.stroke.startsWith('url(') ? '#888' : ds.stroke);
    return;
  }

  // ---- One or more selected: show shared value or "Mixed", per property ----
  const isMulti = shapes.length > 1;

  // Fill: for a SINGLE selection the Fills list (appearance-panel) owns fills, so the
  // legacy Fill row shows only for a MULTI-selection (where it gives the mixed display
  // + apply-to-all that the per-object stack can't). Still gated on every shape being
  // fillable.
  const showFill = all(shapes, hasFill);
  if (fillGroup) fillGroup.style.display = (showFill && isMulti) ? '' : 'none';
  if (showFill) {
    setToggle(fillNoneBtn, common(shapes, s => s.style.fill === 'none'));
    setPreview(fillPreview, common(shapes, s => (s.style.fillMixed ? MIXED : s.style.fill)), state);
    const fo = common(shapes, s => s.style.fillOpacity ?? 1);
    setSliderValue(fillOpacityInput,
      fo === MIXED || fo === undefined ? (shapes[0].style.fillOpacity ?? 1) : fo, fo === MIXED);
  }

  // Corner radius (rect only): the linked field shows the shared radius (or "Mixed"),
  // and the per-corner grid shows each corner across the selection.
  const showRx = all(shapes, hasCornerRadius);
  rxRow.style.display = showRx ? '' : 'none';
  const cornersGrid = document.getElementById('prop-corners-grid') as HTMLElement | null;
  if (showRx) {
    updateRadiusReadout(state); // shared with the live handle-drag path (see main.ts)
  } else if (cornersGrid) {
    cornersGrid.style.display = 'none';
    document.getElementById('prop-corners-toggle')?.classList.remove('active');
  }

  // Character (text only) — the panel itself is shown by the inspector.
  // Text controls: shown for plain text AND multi-stroke text (read from the inner
  // source <text> via textTarget, so a wrapped text keeps its type settings).
  if (shapes.length > 0 && shapes.every(isTextShape)) {
    const te = (s: ShapeData) => textTarget(s)!; // gate guarantees non-null
    // Contents — never rewrite the field mid-typing (each keystroke live-applies,
    // which re-renders this panel and would clobber the entry).
    const contentField = document.getElementById('prop-text-content') as HTMLTextAreaElement | null;
    if (contentField && document.activeElement !== contentField) {
      const content = common(shapes, s => readTextLines(te(s)).join('\n'));
      if (content === MIXED || content === undefined) { contentField.value = ''; contentField.placeholder = MIXED_HINT; }
      else { contentField.value = content; contentField.placeholder = 'Type text…'; }
    }
    const fam = common(shapes, s => te(s).getAttribute('font-family') ?? 'Arial');
    setFontPickerValue(fam === MIXED || fam === undefined ? '' : fam);
    setNumField(fontSizeInput, common(shapes, s => parseFloat(te(s).getAttribute('font-size') ?? '24') || 24));
    setToggle(italicBtn, common(shapes, s => te(s).getAttribute('font-style') === 'italic'));
    // Weight slider: specimen "A" per real weight of the family; thumb on the common
    // weight, or Mixed (no thumb) when the selection's weights differ.
    const famName = fam === MIXED || fam === undefined ? 'Arial' : fam;
    const cwRaw = common(shapes, s => normalizeWeight(te(s).getAttribute('font-weight')));
    const cw: number | null = cwRaw === MIXED || cwRaw == null ? null : cwRaw;
    setWeightSlider(famName, cw);
    setNumField(lineHeightInput, common(shapes, s => {
      const lh = parseFloat(te(s).getAttribute('data-line-height') ?? '');
      return Number.isFinite(lh) && lh > 0 ? lh : 1.2;
    }));
    setNumField(letterSpacingInput, common(shapes, s => parseFloat(te(s).getAttribute('letter-spacing') ?? '0') || 0));
    const anchor = common(shapes, s => te(s).getAttribute('text-anchor') || 'start');
    textAlignGroup.querySelectorAll('button').forEach(b =>
      b.classList.toggle('active', anchor !== MIXED && b.getAttribute('data-anchor') === anchor));
    // Vertical align — only for FIXED-HEIGHT area text (a box to align within);
    // hidden for point text and auto-height boxes. Reflects the common value.
    const valignRow = document.getElementById('prop-valign-row');
    const isFixedArea = (s: ShapeData) => { const el = te(s); return isAreaText(el) && el.hasAttribute('data-area-h'); };
    const showVAlign = shapes.every(isFixedArea); // shapes is non-empty here
    if (valignRow) valignRow.style.display = showVAlign ? '' : 'none';
    if (showVAlign) {
      const va = common(shapes, s => areaVAlign(te(s)));
      document.querySelectorAll('#text-valign button').forEach(b =>
        b.classList.toggle('active', va !== MIXED && b.getAttribute('data-valign') === va));
    }
    // Case is on the outer element (text or wrapper), where applyTextTransform set it.
    const tt = common(shapes, s => (s.element as unknown as SVGElement).style.textTransform || 'none');
    textTransformSelect.value = tt === MIXED || !tt ? 'none' : tt;
    // OpenType chips: rebuild for the family, reflecting the current font-feature-settings.
    const feat = common(shapes, s => (s.element as unknown as SVGElement).style.fontFeatureSettings || '');
    void setOpenType(famName, feat === MIXED || feat === undefined ? '' : feat);
    // Variable-font axis sliders (width / optical size) for the family.
    const varr = common(shapes, s => (s.element as unknown as SVGElement).style.fontVariationSettings || '');
    setAxisSliders(famName, varr === MIXED || varr === undefined ? '' : varr);
    setToggle(underlineBtn, common(shapes, s => (te(s).getAttribute('text-decoration') || '').includes('underline')));
    setToggle(strikeBtn, common(shapes, s => (te(s).getAttribute('text-decoration') || '').includes('line-through')));
    setNumField(baselineShiftInput, common(shapes, s => parseFloat(te(s).getAttribute('baseline-shift') ?? '0') || 0));
    // Path controls: only when every selected text is flowed on a path (<textPath>).
    const onPath = shapes.every(s => !!te(s).querySelector('textPath'));
    pathRow.style.display = onPath ? '' : 'none';
    if (onPath) {
      setNumField(pathOffsetInput, common(shapes, s =>
        parseFloat(te(s).querySelector('textPath')?.getAttribute('startOffset') ?? '0') || 0));
      const flipBtnEl = document.getElementById('prop-path-flip');
      if (flipBtnEl) {
        const flipped = common(shapes, s => te(s).querySelector('textPath')?.getAttribute('data-flip') === '1');
        flipBtnEl.classList.toggle('active', flipped === true);
      }
    }
  }

  updateTransformReadout(state);
  updateNodeRow(state);

  // Rotation is single-object only (frames are axis-aligned; multi uses the handle).
  const rotRow = document.getElementById('prop-rotation-row');
  if (rotRow) rotRow.style.display = (isMulti || shapes.some(s => s.type === 'frame')) ? 'none' : '';
  if (isMulti) propRotation.placeholder = '';

  // Toolbar swatches reflect the shared paint (mixed → neutral).
  const fillC = common(shapes, s => (s.style.fillMixed ? MIXED : s.style.fill));
  fillSwatch.style.background = fillC === MIXED || fillC === undefined ? MIXED_SWATCH
    : (fillC === 'none' ? 'transparent' : paintPreviewBg(fillC, state));
  const strokeC = common(shapes, s => (s.style.strokeMixed ? MIXED : s.style.stroke));
  strokeSwatch.style.borderColor = strokeC === MIXED || strokeC === undefined ? '#9aa0ab'
    : (strokeC === 'none' ? 'transparent' : (strokeC.startsWith('url(') ? '#888' : strokeC));
}
