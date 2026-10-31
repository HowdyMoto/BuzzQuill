// ---------------------------------------------------------------------------
// Selection style — the writers behind the paint, stroke and effect controls.
//
//   • Fill / stroke paint on specific shapes or the selection, for plain elements
//     and appearance-wrapped (multi-paint) shapes alike, including the plain-group
//     rule that a leaf's own paint must be cleared for the group's to show.
//   • The Eyedropper's sampled apply (fill + stroke + weight in one undo step).
//   • Stroke cap / join / alignment, and corner radii, across the selection.
//   • Blur + drop shadow on the selection or specific shapes, reconciling any
//     linked library style a manual edit detaches.
//
// These never change `defaultStyle`'s paints: styling the selection is not how new
// shapes learn their look (the explicit Default Fill/Stroke command is). The one
// exception is stroke alignment, which has always been remembered as the default.
//
// Extracted from AppState as a collaborator behind a SelectionStyleHost seam (#192).
// ---------------------------------------------------------------------------

import type { AppearanceLayer, ObjectShadow, ShapeData, ShapeStyle } from './types';
import { isPlainGroup, ownedPaint, paintableLeaves } from './effective-paint';
import { setRectRadii, type Radii } from './rect-shape';
import { applyStrokeAlignment } from './stroke-align';

type LayerEdit = { id: string; layers: AppearanceLayer[] };

export interface SelectionStyleHost {
  /** The live selection, in selection order. */
  selectedIds(): string[];
  findShape(id: string): ShapeData | null;
  selectedShapes(): ShapeData[];
  getAppearance(id: string): AppearanceLayer[];
  setAppearanceMulti(edits: LayerEdit[], selectionAfter: string[], record: boolean): void;
  /** Detach any linked library style the given shapes no longer match. */
  reconcileStyleLinks(ids: Iterable<string>): void;
  defaultStyle(): ShapeStyle;
  setEffectsOnElements(els: SVGGraphicsElement[], blur: number, shadow: ObjectShadow | null, record: boolean): void;
  /** Effects on the selection, WITHOUT recording (the caller reconciles, then records). */
  setSelectionBlur(stdDev: number): void;
  setSelectionShadow(shadow: ObjectShadow | null): void;
  rebuild(): void;
  saveHistory(): void;
  onChange(): void;
}

export class SelectionStyleManager {
  private host: SelectionStyleHost;
  constructor(host: SelectionStyleHost) { this.host = host; }

  // ---- Paint ----

  /** Apply a solid/gradient/pattern paint to specific shapes (plain + appearance-
   *  wrapped), one undo step — the linked paint-style propagation path. */
  applyFillToShapes(ids: string[], paint: string, record = true): void {
    const edits: LayerEdit[] = [];
    for (const id of ids) {
      const shape = this.host.findShape(id);
      if (!shape) continue;
      if (shape.type === 'appearance') {
        const layers = this.host.getAppearance(id);
        const f = layers.find((l: AppearanceLayer) => l.t === 'fill');
        if (paint === 'none') { if (f) f.visible = false; }
        else if (f) { f.paint = paint; f.visible = true; }
        else layers.push({ t: 'fill', paint, opacity: 1 });
        edits.push({ id, layers });
      } else {
        shape.element.setAttribute('fill', paint);
        shape.style.fill = paint;
        // A plain group's leaves usually own their own fill (that's how imported
        // artwork is written), and a leaf's own paint beats the group's — so
        // painting only the <g> looked like nothing happened. Clear the leaves'
        // own fill so the group's becomes the live one. An explicit `none` is
        // LEFT ALONE: icon sets ship an invisible <path fill="none"> spacer to
        // pin the viewBox, and filling that would drop a solid block over the art.
        if (shape.type === 'group' && isPlainGroup(shape.element)) {
          for (const leaf of paintableLeaves(shape.element)) {
            if (ownedPaint(leaf, 'fill') !== null && ownedPaint(leaf, 'fill') !== 'none') {
              leaf.removeAttribute('fill');
              (leaf as unknown as ElementCSSInlineStyle).style?.removeProperty('fill');
            }
          }
        }
      }
    }
    if (edits.length) this.host.setAppearanceMulti(edits, [...this.host.selectedIds()], false);
    // Reconcile EVERY id, not just the appearance-wrapped ones: a plain shape takes
    // the branch above and never reaches setAppearanceMulti, so the colour picker /
    // swatches left it linked-but-diverged. Before saveHistory, so the detach is
    // inside the snapshot and redo can't resurrect the link.
    this.host.reconcileStyleLinks(ids);
    if (record) this.host.saveHistory();
    this.host.onChange();
  }

  /** Apply a fill paint to every selected object in one undo step (Swatches panel +
   *  the properties Fill picker). For appearance-wrapped shapes, repaints (or adds)
   *  the stack's fill layer; 'none' hides it. */
  setSelectionFill(value: string): void {
    // Styles the selection only — it does NOT change defaultStyle. New shapes keep the
    // fixed default fill; a paint here never "learns" a new default.
    // One shared writer with applyFillToShapes: this used to be a second, near-verbatim
    // copy of that loop, which is exactly how the two drifted apart.
    this.applyFillToShapes([...this.host.selectedIds()], value);
  }

  /** Apply a stroke paint to specific shapes. For appearance-wrapped (multi-stroke)
   *  shapes, updates the topmost stroke layer. The `record` flag lets a caller batch
   *  this with other writes into ONE undo step (the Eyedropper's sampled apply). */
  applyStrokeToShapes(ids: string[], value: string, record = true): void {
    const edits: LayerEdit[] = [];
    for (const shapeId of ids) {
      const shape = this.host.findShape(shapeId);
      if (!shape) continue;
      if (shape.type === 'appearance') {
        const layers = this.host.getAppearance(shapeId);
        const topStroke = layers.find((l: AppearanceLayer) => l.t === 'stroke' && !l.cut);
        if (topStroke) topStroke.paint = value;
        edits.push({ id: shapeId, layers });
      } else {
        shape.element.setAttribute('stroke', value);
        shape.style.stroke = value;
        // Same as fill: a leaf's own stroke beats the group's (see applyFillToShapes).
        if (shape.type === 'group' && isPlainGroup(shape.element)) {
          for (const leaf of paintableLeaves(shape.element)) {
            if (ownedPaint(leaf, 'stroke') !== null && ownedPaint(leaf, 'stroke') !== 'none') {
              leaf.removeAttribute('stroke');
              (leaf as unknown as ElementCSSInlineStyle).style?.removeProperty('stroke');
            }
          }
        }
      }
    }
    if (edits.length > 0) {
      this.host.setAppearanceMulti(edits, [...this.host.selectedIds()], false);
    }
    if (record) this.host.saveHistory();
    this.host.onChange();
  }

  /** Apply a stroke paint to every selected object in one undo step. */
  setSelectionStroke(value: string): void {
    // Styles the selection only — it does NOT change defaultStyle (see setSelectionFill).
    // One shared writer with applyStrokeToShapes (see setSelectionFill's note on drift).
    this.applyStrokeToShapes([...this.host.selectedIds()], value);
  }

  /**
   * Apply a SAMPLED appearance (the Eyedropper) to shapes in ONE undo step: the
   * paints that actually render, plus the stroke weight, so "pick that look" copies
   * the look rather than just a colour. Absent fields are left alone. Stroke width
   * goes through applyStrokeAlignment so an inside/outside-aligned stroke keeps its
   * emulation clip in sync (writing the attribute raw would desync it).
   */
  applySampledStyle(ids: string[], sample: { fill?: string; stroke?: string; strokeWidth?: number }): void {
    const targets = ids.filter((id) => !!this.host.findShape(id));
    if (targets.length === 0) return;
    if (sample.fill !== undefined) this.applyFillToShapes(targets, sample.fill, false);
    if (sample.stroke !== undefined) this.applyStrokeToShapes(targets, sample.stroke, false);
    if (sample.strokeWidth !== undefined && Number.isFinite(sample.strokeWidth)) {
      for (const id of targets) {
        const shape = this.host.findShape(id);
        if (!shape) continue;
        shape.style.strokeWidth = sample.strokeWidth;
        applyStrokeAlignment(shape.element, shape.type, shape.style.strokeAlign ?? 'center', sample.strokeWidth);
      }
    }
    this.host.saveHistory();
    this.host.onChange();
  }

  // ---- Stroke geometry ----

  /** Set the line-end cap ('butt' | 'round' | 'square') on EVERY stroke of every
   *  selected object, in one undo step — the top-level Stroke-panel Cap control.
   *  Handles both appearance-wrapped (multi-stroke) shapes and plain elements. */
  setSelectionStrokeCap(cap: 'butt' | 'round' | 'square'): void {
    this.onEveryStroke(
      (l) => { l.cap = cap === 'butt' ? undefined : cap; },
      (shape) => {
        if (cap === 'butt') shape.element.removeAttribute('stroke-linecap');
        else shape.element.setAttribute('stroke-linecap', cap);
        shape.style.strokeLinecap = cap;
      },
    );
  }

  /** Set the corner join ('miter' | 'round' | 'bevel') on EVERY stroke of every
   *  selected object, in one undo step — the top-level Stroke-panel Corners
   *  control. Handles appearance-wrapped and plain elements. (The miter LIMIT
   *  keeps its SVG default of 4, which auto-bevels only extremely sharp corners.) */
  setSelectionStrokeJoin(join: 'miter' | 'round' | 'bevel'): void {
    this.onEveryStroke(
      (l) => { l.join = join === 'miter' ? undefined : join; },
      (shape) => {
        if (join === 'miter') shape.element.removeAttribute('stroke-linejoin');
        else shape.element.setAttribute('stroke-linejoin', join);
        shape.style.strokeLinejoin = join;
      },
    );
  }

  /** Cap and Join were two copies of one loop: write every stroke LAYER of an
   *  appearance-wrapped shape, or the attribute of a plain one, then record once. */
  private onEveryStroke(writeLayer: (l: AppearanceLayer) => void, writePlain: (shape: ShapeData) => void): void {
    const edits: LayerEdit[] = [];
    for (const shapeId of this.host.selectedIds()) {
      const shape = this.host.findShape(shapeId);
      if (!shape) continue;
      if (shape.type === 'appearance') {
        const layers = this.host.getAppearance(shapeId);
        for (const l of layers) if (l.t === 'stroke') writeLayer(l);
        edits.push({ id: shapeId, layers });
      } else {
        writePlain(shape);
      }
    }
    if (edits.length > 0) this.host.setAppearanceMulti(edits, [...this.host.selectedIds()], false);
    this.host.saveHistory();
    this.host.onChange();
  }

  /** Apply a stroke alignment (center/inside/outside) to every selected plain shape
   *  in one undo step. Appearance-wrapped (multi-stroke) shapes are skipped — the
   *  emulation has no per-layer equivalent (their layers use offsets instead). */
  setSelectionStrokeAlign(align: 'center' | 'inside' | 'outside'): void {
    this.host.defaultStyle().strokeAlign = align;
    for (const id of this.host.selectedIds()) {
      const s = this.host.findShape(id);
      if (!s || s.type === 'appearance') continue;
      s.style.strokeAlign = align;
      applyStrokeAlignment(s.element, s.type, align, s.style.strokeWidth ?? 0);
    }
    this.host.saveHistory();
    this.host.onChange();
  }

  /** Set corner radii (uniform or per-corner: [tl, tr, br, bl]) on every selected
   *  rectangle. Non-uniform radii promote a plain <rect> to a parametric
   *  `<path data-rect>`; the model is rebuilt when any element was swapped. One undo
   *  step when `record`. */
  setSelectionRectRadii(radii: Radii, record = true): void {
    const rects = this.host.selectedShapes().filter(s => s.type === 'rect');
    if (!rects.length) return;
    let swapped = false;
    for (const s of rects) {
      const newEl = setRectRadii(s.element, radii);
      if (newEl !== s.element) swapped = true;
      else s.style.rx = radii[0];
    }
    if (swapped) this.host.rebuild();
    if (record) this.host.saveHistory();
    this.host.onChange();
  }

  // ---- Effects ----

  /** Set blur + drop-shadow on specific shapes, one undo step — the linked
   *  effect-style propagation path. */
  applyEffectToShapes(ids: string[], blur: number, shadow: ObjectShadow | null, record = true): void {
    const els = ids.map((id) => this.host.findShape(id)?.element).filter((e): e is SVGGraphicsElement => !!e);
    this.host.setEffectsOnElements(els, blur, shadow, record);
  }

  setSelectionBlur(stdDev: number, record = true): void {
    this.host.setSelectionBlur(stdDev);
    this.host.reconcileStyleLinks([...this.host.selectedIds()]); // a manual edit detaches
    if (record) this.host.saveHistory();
  }

  setSelectionShadow(shadow: ObjectShadow | null, record = true): void {
    this.host.setSelectionShadow(shadow);
    this.host.reconcileStyleLinks([...this.host.selectedIds()]);
    if (record) this.host.saveHistory();
  }
}
