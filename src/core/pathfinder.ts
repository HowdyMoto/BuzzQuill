// ---------------------------------------------------------------------------
// Pathfinder — boolean compound shapes + Shape Builder + Outline Stroke / Offset
// Path. All the orchestration around the Paper.js engine (core/boolean.ts): it
// collects operands from the selection, runs the op, and builds the result into
// the shape tree.
//
// The single-output booleans build a LIVE `<g data-boolean>` whose operands stay
// editable and whose cached `[data-bool-result]` path recomputes on edit (and on
// history restore). Extracted from AppState as a collaborator; it reaches the shape
// tree only through PathfinderHost. A few genuinely-shared tree helpers
// (selectedInDomOrder / commonParentOf / convertShapeToPath) stay in AppState
// (grouping and clipping use them too) and are surfaced through the host.
// ---------------------------------------------------------------------------

import { effectivePaint } from './effective-paint';
import type { ShapeData } from './types';
import { carryObjectAttrs, moveObjectAttrs, composeOpacity, getBlend } from './wrapper-attrs';
import {
  type BooleanOp, type StrokeJoin, type StrokeCap,
  ensureBooleanEngine, booleanEngineReady, computeBoolean, elementPathData,
  localPathData, strokeOrderPathData, ensureOffsetEngine, offsetPathData, outlineStrokeData, pathEndFrames,
} from './boolean';
import { markerPieces } from './marker-geometry';
import { transformPathData } from './path-model';
import { shapeToClosedPathD } from './stroke-align';

const SVG = 'http://www.w3.org/2000/svg';

/** Layers read as document structure, not debug output: the op NOUN, with no
 *  internal id counter baked in ("Union", never "Unite #13" — #225). Copies
 *  still get counters via copyName ("Union 2"). */
const BOOLEAN_LAYER_NAMES: Record<BooleanOp, string> = {
  unite: 'Union', subtract: 'Subtract', intersect: 'Intersect', exclude: 'Exclude', divide: 'Divide',
};

/** An element's own transform as a DOMMatrix (identity when it has none). */
function ownMatrix(el: SVGElement): DOMMatrix {
  const t = (el as SVGGraphicsElement).transform?.baseVal?.consolidate?.();
  const m = t?.matrix;
  return m ? new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]) : new DOMMatrix();
}

const VECTOR_LEAF_TAGS = new Set(['path', 'rect', 'ellipse', 'circle', 'line', 'polygon', 'polyline']);

interface MaskLeaf { d: string; el: SVGElement; toGroup: DOMMatrix }

/** Things a plain path can't reproduce once the mask's clip is baked into its
 *  geometry: an effect or blend (they apply BEFORE the clip, so a blurred shape
 *  clipped by a mask is not a blurred clipped shape), or a clip of its own. */
function resistsBaking(el: SVGElement): boolean {
  if (el.hasAttribute('filter') || el.hasAttribute('data-fx-blur') || el.hasAttribute('data-fx-shadow')) return true;
  if (el.hasAttribute('mask') || getBlend(el)) return true;
  const clip = el.getAttribute('clip-path');
  return !!clip && !clip.includes('sa-clip-'); // a stroke-align clip IS baked (strokeInk)
}

/** The same question for the MASK element, whose clip-path is the mask itself. */
function resistsBakingAsMask(group: SVGElement): boolean {
  return group.hasAttribute('filter') || group.hasAttribute('data-fx-blur') || group.hasAttribute('data-fx-shadow');
}

/** Collect every vector leaf under `el` (recursing into `<g>`), each with its
 *  geometry mapped into a common space via `toParent` (which already folds in
 *  `el`'s own transform). `flags.hasRaster` is set if anything can't become a
 *  plain path without changing how it renders (image/text/use, or content with
 *  an effect, blend or clip of its own) — such masks stay lossless on flatten. */
function collectMaskLeaves(
  el: SVGElement,
  toParent: DOMMatrix,
  out: MaskLeaf[],
  flags: { hasRaster: boolean },
): void {
  const tag = el.tagName.toLowerCase();
  // Non-render metadata never counts as droppable content.
  if (tag === 'clippath' || tag === 'defs' || tag === 'title' || tag === 'metadata' || tag === 'desc') return;
  if (resistsBaking(el)) flags.hasRaster = true;
  if (tag === 'g') {
    for (const child of Array.from(el.children) as SVGElement[]) {
      collectMaskLeaves(child, toParent.multiply(ownMatrix(child)), out, flags);
    }
    return;
  }
  if (VECTOR_LEAF_TAGS.has(tag)) {
    const d = elementPathData(el, toParent);
    if (d.trim()) out.push({ d, el, toGroup: toParent });
    return;
  }
  // Everything else (image/text/use/foreignObject/…) is real content we can't vectorize.
  flags.hasRaster = true;
}

/** The composited opacity of `src` and every ancestor up to — but not including —
 *  the mask `group`. Opacity doesn't inherit; it composites per element. */
function chainOpacity(src: SVGElement, group: SVGElement): number {
  let op = 1;
  for (let n: Element | null = src; n && n !== group; n = n.parentElement) {
    const v = parseFloat(getComputedStyle(n as SVGElement).opacity || '1');
    if (Number.isFinite(v)) op *= v;
  }
  return op;
}

/** The shape type stroke alignment is decided by, for a bare element. */
function alignTypeOf(el: SVGElement): ShapeData['type'] {
  const tag = el.tagName.toLowerCase();
  if (tag === 'path') return el.hasAttribute('data-rect') ? 'rect' : 'path';
  return (tag === 'circle' ? 'ellipse' : tag) as ShapeData['type'];
}

/** One filled region standing in for part of a stroke. `ink` marks the regions
 *  painted with the stroke's own paint (they take its stroke-opacity). */
interface InkPiece { d: string; paint: string; ink: boolean }

/**
 * An element's stroke as filled regions in its own local space, split into what
 * sits BELOW its fill and what sits above — i.e. what the stroke RENDERED, not
 * just its centre line widened: the dash pattern is cut into dashes, arrowheads
 * become geometry, square caps and the miter limit are honoured, and an
 * inside/outside alignment — emulated on screen as a doubled stroke with half of
 * it hidden — is redone as a boolean. Null when there is no visible stroke.
 * Requires the offset engine.
 */
function strokeInk(el: SVGElement, type: ShapeData['type'], boundary?: Element | null): { below: InkPiece[]; above: InkPiece[] } | null {
  const ink = effectivePaint(el, 'stroke', boundary);
  // The width as DRAWN — doubled while an inside/outside alignment is emulated.
  const width = parseFloat(effectivePaint(el, 'stroke-width', boundary) ?? '1');
  if (!ink || ink === 'none' || !(width > 0)) return null;
  const localD = el.tagName.toLowerCase() === 'path' ? (el.getAttribute('d') ?? '') : strokeOrderPathData(el);
  if (!localD.trim()) return null;
  const rawJoin = effectivePaint(el, 'stroke-linejoin', boundary);
  const join: StrokeJoin = rawJoin === 'round' || rawJoin === 'bevel' ? rawJoin : 'miter';
  const rawCap = effectivePaint(el, 'stroke-linecap', boundary);
  const cap: StrokeCap = rawCap === 'round' || rawCap === 'square' ? rawCap : 'butt';
  const limit = parseFloat(el.getAttribute('stroke-miterlimit') ?? '');
  const dash = (effectivePaint(el, 'stroke-dasharray', boundary) ?? '').split(/[\s,]+/).filter(Boolean).map(parseFloat);
  let renderedLength: number | undefined;
  if (dash.length) {
    try { renderedLength = (el as unknown as SVGGeometryElement).getTotalLength(); } catch { /* not rendered */ }
  }
  let strokeD = outlineStrokeData(localD, width, join, cap, {
    miterLimit: Number.isFinite(limit) ? limit : undefined,
    dash,
    dashOffset: parseFloat(el.getAttribute('stroke-dashoffset') ?? '0') || 0,
    renderedLength,
  });
  if (!strokeD.trim()) return null;

  const fill = effectivePaint(el, 'fill', boundary);
  const clip = el.getAttribute('clip-path');

  // Stroke alignment (stroke-align.ts): the doubled stroke was shown clipped to
  // the shape (inside), clipped to everything else (outside, no fill), or painted
  // UNDER the fill so the fill hid its inner half (outside, with a fill).
  const align = el.getAttribute('data-stroke-align');
  const shapeD = align === 'inside' || align === 'outside' ? shapeToClosedPathD(el, type) : null;
  const cut = (d: string, op: BooleanOp): string => (shapeD ? (computeBoolean([d, shapeD], op)[0] ?? '') : d);
  let markerOp: BooleanOp | null = null; // a clip on the element cut its markers too
  let under = false;                      // the outline belongs beneath the fill body
  if (shapeD && align === 'inside') { strokeD = cut(strokeD, 'intersect'); markerOp = 'intersect'; }
  else if (shapeD && clip?.includes('sa-clip-')) { strokeD = cut(strokeD, 'subtract'); markerOp = 'subtract'; }
  else if (shapeD) {
    // Only an opaque fill truly hid the inner half; through a translucent one it
    // still shows, so the whole ring stays, underneath.
    const cs = getComputedStyle(el);
    if (parseFloat(cs.fillOpacity || '1') >= 1 && /^rgb\(/.test(cs.fill)) strokeD = cut(strokeD, 'subtract');
    else under = true;
  }

  // Arrowheads: the same ink as the stroke joins the outline; a marker with its
  // own colour stays a separate region.
  const sameInk: string[] = [];
  const otherInk: InkPiece[] = [];
  const frames = el.hasAttribute('marker-start') || el.hasAttribute('marker-end') ? pathEndFrames(localD) : null;
  if (frames) {
    for (const pos of ['start', 'end'] as const) {
      const ref = el.getAttribute(`marker-${pos}`)?.match(/url\(\s*["']?#([^"')\s]+)/)?.[1];
      const marker = ref ? el.ownerDocument.getElementById(ref) : null;
      if (!marker || marker.tagName.toLowerCase() !== 'marker') continue;
      for (const piece of markerPieces(marker, frames[pos], width, pos === 'start')) {
        const paint: string = piece.paint === 'context-stroke' ? ink
          : piece.paint === 'context-fill' ? (fill ?? '#000000') : piece.paint;
        const d = markerOp ? cut(piece.d, markerOp) : piece.d;
        if (paint === 'none' || !d.trim()) continue;
        if (paint === ink) sameInk.push(d); else otherInk.push({ d, paint, ink: false });
      }
    }
  }

  const below: InkPiece[] = [], above: InkPiece[] = [];
  const unite = (ds: string[]): string => (ds.length > 1 ? (computeBoolean(ds, 'unite')[0] ?? ds[0]) : ds[0]);
  if (under) {
    if (strokeD.trim()) below.push({ d: strokeD, paint: ink, ink: true });
    if (sameInk.length) above.push({ d: unite(sameInk), paint: ink, ink: true });
  } else {
    const all = [strokeD, ...sameInk].filter((d) => d.trim());
    if (all.length) above.push({ d: unite(all), paint: ink, ink: true });
  }
  above.push(...otherInk);
  return below.length + above.length ? { below, above } : null;
}

/** A filled `<path>` for one region. */
function inkPath(d: string, paint: string, fillOpacity: string | null): SVGPathElement {
  const p = document.createElementNS(SVG, 'path') as SVGPathElement;
  p.setAttribute('d', d);
  p.setAttribute('fill', paint);
  p.setAttribute('fill-rule', 'nonzero');
  if (fillOpacity && fillOpacity !== '1') p.setAttribute('fill-opacity', fillOpacity);
  return p;
}

/**
 * One clipped leaf of a mask as plain geometry: its fill and its stroke, each cut
 * to the mask shape, painted as the leaf rendered them. The stroke becomes filled
 * regions — a live stroke on the cut-down shape would run along the cut edge too,
 * where there never was one. Null when nothing of the leaf shows through the mask.
 */
function flattenLeaf(leaf: MaskLeaf, cutterD: string, group: SVGElement): SVGElement | null {
  const clipTo = (d: string): string => (d.trim() ? (computeBoolean([d, cutterD], 'intersect')[0] ?? '') : '');
  const cs = getComputedStyle(leaf.el);
  const parts: SVGPathElement[] = [];
  const stroke = cs.stroke && cs.stroke !== 'none'
    ? strokeInk(leaf.el, alignTypeOf(leaf.el), group.parentElement) : null;
  const addInk = (pieces: InkPiece[]): void => {
    for (const p of pieces) {
      const d = clipTo(transformPathData(p.d, leaf.toGroup));
      if (d.trim()) parts.push(inkPath(d, p.ink ? cs.stroke : p.paint, p.ink ? cs.strokeOpacity : null));
    }
  };
  if (stroke) addInk(stroke.below);
  if (cs.fill && cs.fill !== 'none') {
    const d = clipTo(leaf.d);
    if (d.trim()) {
      const body = inkPath(d, cs.fill, cs.fillOpacity);
      if (cs.fillRule && cs.fillRule !== 'nonzero') body.setAttribute('fill-rule', cs.fillRule);
      parts.push(body);
    }
  }
  if (stroke) addInk(stroke.above);
  if (parts.length === 0) return null;

  // Fill and stroke composited as ONE object under the leaf's opacity; two
  // separately-faded paths would double up where the stroke overlaps the fill.
  const op = chainOpacity(leaf.el, group);
  let out: SVGElement = parts[0];
  if (parts.length > 1) {
    out = document.createElementNS(SVG, 'g');
    out.append(...parts);
  }
  if (op < 0.999) out.setAttribute('opacity', String(Math.round(op * 1000) / 1000));
  return out;
}

const PATHABLE: ReadonlyArray<ShapeData['type']> =
  ['path', 'rect', 'ellipse', 'line', 'polyline', 'polygon'];
// Types with no path geometry to feed the boolean engine. Including one of these
// in a boolean silently dropped its operand and rendered garbage (an image + shape
// became just the shape, filled black) — so booleans refuse these outright. Raster
// images pair with a shape via Crop / Mask instead.
export const NON_BOOLEANABLE: ReadonlyArray<ShapeData['type']> = ['image', 'text', 'use', 'frame'];

/** True when a selection can be combined with a boolean op (all vector geometry). */
export function selectionIsBooleanable(shapes: ShapeData[]): boolean {
  return shapes.length >= 2 && !shapes.some((s) => NON_BOOLEANABLE.includes(s.type));
}

export interface PathfinderHost {
  getShapes(): ShapeData[];
  getSelectedIds(): string[];
  setSelection(ids: string[]): void;
  getDrawingLayer(): SVGGElement;
  findShape(id: string): ShapeData | null;
  nextId(): string;
  /** Selected shapes resolved anywhere in the tree, bottom→top (DOM order). */
  selectedInDomOrder(): ShapeData[];
  /** The element all shapes share as a direct parent, else the drawing layer. */
  commonParentOf(shapes: ShapeData[]): SVGElement;
  /** Replace a primitive with an equivalent <path> in place; false if not convertible. */
  convertShapeToPath(shape: ShapeData): boolean;
  detachShape(id: string): boolean;
  exitGroupIsolation(): void;
  rebuild(): void;
  saveHistory(): void;
  onChange(): void;
}

export class PathfinderManager {
  private host: PathfinderHost;
  constructor(host: PathfinderHost) { this.host = host; }

  /**
   * Combine the current selection with a Pathfinder op. The four single-output ops
   * build a LIVE `<g data-boolean>` whose operands stay editable and whose cached
   * result path recomputes on edit. `divide` produces a plain group of the disjoint
   * pieces. Operands are taken in document order (bottom→top z), which defines
   * subtract. Returns false when fewer than two shapes are selected or the result
   * is empty.
   */
  async booleanSelection(op: BooleanOp, reverse = false): Promise<boolean> {
    let operands = this.host.selectedInDomOrder();
    if (!selectionIsBooleanable(operands)) return false; // e.g. a raster image has no path geometry
    if (reverse) operands.reverse(); // Subtract "swap": flip which shape is the cutter.

    await ensureBooleanEngine();

    // Operate in the operands' COMMON PARENT space, so the result lands in the same
    // container (e.g. the frame) with correct coordinates.
    const parent = this.host.commonParentOf(operands);
    const operandDs = this.operandDsInParentSpace(operands, parent);
    if (!operandDs) return false;
    const resultDs = computeBoolean(operandDs, op);
    if (resultDs.length === 0 || resultDs.every((d) => !d.trim())) return false;

    // A Subtract that cuts NOTHING (the cutter never overlaps the base) is a
    // destructive no-op: the geometry is unchanged, but the cutter is still
    // swallowed into the wrapper, so the user just watches a shape vanish for no
    // reason. Detect it by XOR-ing the result against the base — an empty
    // symmetric difference means nothing was removed — and refuse. Comparing
    // geometry rather than bounding boxes keeps it right for concave shapes and
    // for 3+ operands, where only some cutters may miss.
    if (op === 'subtract' && resultDs.length === 1) {
      const unchanged = computeBoolean([resultDs[0], operandDs[0]], 'exclude');
      if (unchanged.length === 0 || unchanged.every((d) => !d.trim())) return false;
    }

    const insertBefore = operands[operands.length - 1].element.nextSibling as SVGElement | null;
    const newId = op === 'divide'
      ? this.buildDivideGroup(operands, resultDs, parent, insertBefore)
      : this.buildBooleanShape(op, operands, resultDs[0], parent, insertBefore);

    this.host.rebuild(); // resync (operands may have been nested)
    this.host.setSelection([newId]);
    this.host.saveHistory();
    this.host.onChange();
    return true;
  }

  /** Operand geometry as `d` strings in a target parent's local space. */
  private operandDsInParentSpace(operands: ShapeData[], parentEl: SVGElement): string[] | null {
    const pctm = (parentEl as unknown as SVGGraphicsElement).getScreenCTM();
    if (!pctm) return null;
    const inv = pctm.inverse();
    return operands.map((s) => {
      const ctm = s.element.getScreenCTM();
      return ctm ? elementPathData(s.element, inv.multiply(ctm)) : '';
    });
  }

  /** Operand geometry in drawing-layer (world) space — for the hover preview ghost. */
  private operandDsInLayerSpace(operands: ShapeData[]): string[] | null {
    return this.operandDsInParentSpace(operands, this.host.getDrawingLayer());
  }

  /**
   * Non-mutating preview of a boolean over the current selection, in drawing-layer
   * space — used by the Pathfinder panel to ghost the result on hover. Synchronous;
   * returns [] if the engine isn't loaded yet or fewer than two shapes are selected.
   */
  previewSelectionBoolean(op: BooleanOp, reverse = false): string[] {
    if (!booleanEngineReady()) return [];
    // Resolve operands anywhere in the tree (incl. inside frames/groups) in the SAME
    // order booleanSelection uses, so the ghost matches what the commit produces —
    // getShapes() is top-level only, which missed selections nested in a frame.
    const operands = this.host.selectedInDomOrder();
    if (!selectionIsBooleanable(operands)) return [];
    if (reverse) operands.reverse();
    const operandDs = this.operandDsInLayerSpace(operands);
    if (!operandDs) return [];
    return computeBoolean(operandDs, op);
  }

  /**
   * Decompose the current selection into its arrangement faces (the atomic regions
   * of the overlapping shapes), in drawing-layer space. Used by the Shape Builder
   * tool. Returns null if fewer than two shapes are selected.
   */
  async selectionFaces(): Promise<{ faces: string[]; ids: string[] } | null> {
    // Resolve anywhere in the tree (incl. inside frames), not just top-level.
    const operands = this.host.selectedInDomOrder().filter((s) =>
      ['path', 'rect', 'ellipse', 'polygon', 'polyline', 'line', 'boolean', 'group'].includes(s.type));
    if (operands.length < 2) return null;
    await ensureBooleanEngine();
    const ds = this.operandDsInLayerSpace(operands);
    if (!ds) return null;
    const faces = computeBoolean(ds, 'divide').filter((d) => d.trim());
    if (faces.length === 0) return null;
    return { faces, ids: operands.map((s) => s.id) };
  }

  /**
   * Commit a Shape Builder session: remove the original shapes and add the built
   * result paths (already in drawing-layer space), each filled with `fill`. Selects
   * the results.
   */
  replaceShapesWithPaths(originalIds: string[], resultDs: string[], fill: string): void {
    for (const id of originalIds) this.host.detachShape(id); // remove without per-shape history

    const newIds: string[] = [];
    for (const d of resultDs) {
      if (!d.trim()) continue;
      const el = document.createElementNS(SVG, 'path');
      const id = this.host.nextId();
      el.id = id;
      el.setAttribute('d', d);
      el.setAttribute('fill', fill);
      el.setAttribute('fill-rule', 'evenodd');
      el.setAttribute('data-name', 'Shape');
      this.host.getDrawingLayer().appendChild(el);
      newIds.push(id);
    }
    this.host.setSelection(newIds);
    this.host.rebuild();
    this.host.setSelection(newIds);
    this.host.saveHistory();
    this.host.onChange();
  }

  /** Assemble the live `<g data-boolean>` wrapper from operand shapes. */
  private buildBooleanShape(
    op: BooleanOp, operands: ShapeData[], resultD: string, parent: SVGElement, insertBefore: SVGElement | null,
  ): string {
    const gEl = document.createElementNS(SVG, 'g');
    const id = this.host.nextId();
    gEl.id = id;
    gEl.setAttribute('data-name', BOOLEAN_LAYER_NAMES[op] ?? op);
    gEl.setAttribute('data-boolean', op);
    gEl.setAttribute('fill-rule', 'evenodd');
    // Result paint comes from the wrapper, seeded from the bottom operand.
    const base = operands[0].element;
    for (const attr of ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity']) {
      const v = base.getAttribute(attr);
      if (v != null) gEl.setAttribute(attr, v);
    }
    parent.insertBefore(gEl, insertBefore);
    for (const s of operands) {
      s.element.setAttribute('data-bool-operand', '');
      gEl.appendChild(s.element);
    }
    const resultEl = document.createElementNS(SVG, 'path');
    resultEl.setAttribute('data-bool-result', '');
    resultEl.setAttribute('d', resultD);
    gEl.appendChild(resultEl);
    return id;
  }

  /** Divide: replace operands with a plain group of the disjoint region paths. */
  private buildDivideGroup(
    operands: ShapeData[], pieceDs: string[], parent: SVGElement, insertBefore: SVGElement | null,
  ): string {
    const gEl = document.createElementNS(SVG, 'g');
    const id = this.host.nextId();
    gEl.id = id;
    gEl.setAttribute('data-name', 'Divide');
    // Resolve inherited paint: an operand inside a filled <g> owns no fill
    // attribute, and seeding from the raw attribute turned it grey (#208).
    const fill = effectivePaint(operands[0].element, 'fill') ?? '#cccccc';

    for (const d of pieceDs) {
      if (!d.trim()) continue;
      const pEl = document.createElementNS(SVG, 'path');
      const pid = this.host.nextId();
      pEl.id = pid;
      pEl.setAttribute('d', d);
      pEl.setAttribute('fill', fill);
      pEl.setAttribute('fill-rule', 'evenodd');
      pEl.setAttribute('data-name', 'Piece');
      gEl.appendChild(pEl);
    }
    for (const s of operands) s.element.remove(); // consumed by Divide
    parent.insertBefore(gEl, insertBefore);
    return id;
  }

  /**
   * Regenerate a live boolean's cached result path from its current operands.
   * Operands are read in the wrapper's local space. No-op if the engine isn't loaded
   * or operands aren't currently rendered (so it never clobbers with stale data).
   */
  recompute(wrapperEl: SVGElement): void {
    if (!booleanEngineReady()) return;
    const op = (wrapperEl.getAttribute('data-boolean') as BooleanOp) || 'unite';
    const wrapperCtm = (wrapperEl as unknown as SVGGraphicsElement).getScreenCTM();
    if (!wrapperCtm) return;
    const wInv = wrapperCtm.inverse();
    const operandDs: string[] = [];
    let resultEl: SVGElement | null = null;
    for (const child of Array.from(wrapperEl.children)) {
      const el = child as SVGElement;
      if (el.hasAttribute('data-bool-result')) { resultEl = el; continue; }
      if (!el.hasAttribute('data-bool-operand')) continue;
      const ctm = (el as unknown as SVGGraphicsElement).getScreenCTM();
      if (!ctm) return; // an operand isn't rendered → abort rather than clobber
      operandDs.push(elementPathData(el, wInv.multiply(ctm)));
    }
    if (!resultEl || operandDs.length < 2) return;
    const out = computeBoolean(operandDs, op);
    if (out[0]) resultEl.setAttribute('d', out[0]);
  }

  /** Commit a live boolean to a plain editable `<path>`, discarding operands. */
  flatten(id: string): void {
    const shape = this.host.findShape(id);
    if (!shape || shape.type !== 'boolean') return;
    const wrapper = shape.element;
    if (booleanEngineReady()) this.recompute(wrapper);
    const result = wrapper.querySelector('[data-bool-result]');
    const d = result?.getAttribute('d') ?? '';
    const path = document.createElementNS(SVG, 'path');
    // Everything the live boolean carried transfers — its paint, and above all its
    // transform: the result is computed in the wrapper's LOCAL space, so without
    // it a moved or rotated boolean snapped back to where it was built. Only the
    // live-boolean bookkeeping stays behind.
    for (const a of Array.from(wrapper.attributes)) {
      if (a.name === 'id' || a.name.startsWith('data-bool')) continue;
      path.setAttribute(a.name, a.value);
    }
    path.id = id;
    path.setAttribute('d', d);
    this.host.exitGroupIsolation();
    wrapper.replaceWith(path);
    this.host.rebuild();
    this.host.setSelection([id]);
    this.host.saveHistory();
    this.host.onChange();
  }

  /** True when a mask (clip-group) can be flattened: its cutter is a vector shape
   *  and it has at least one clipped VECTOR leaf — including leaves nested inside
   *  grouped content (an illustration clipped to a shape). Raster/text-only masks
   *  stay disabled (there's nothing to bake to geometry; use Crop for images). */
  canFlattenMask(el: SVGElement): boolean {
    if (!el.hasAttribute('data-clip-group')) return false;
    const clipPathEl = Array.from(el.children).find(c => c.tagName.toLowerCase() === 'clippath');
    const cutter = clipPathEl?.firstElementChild as SVGElement | null;
    if (!cutter || !localPathData(cutter).trim()) return false;
    const flags = { hasRaster: false };
    const leaves: MaskLeaf[] = [];
    for (const c of Array.from(el.children)) {
      if (c === clipPathEl) continue;
      collectMaskLeaves(c as SVGElement, new DOMMatrix(), leaves, flags);
    }
    return leaves.length > 0;
  }

  /**
   * Bake a mask (clip-group) into its shown appearance.
   *
   * When every clipped leaf is vector geometry (paths/primitives, incl. leaves
   * nested inside grouped content), each becomes a plain `<path>` of its
   * intersection with the cutter, keeping its resolved paint — one leaf → a single
   * path, several → a plain group. This is the clean, fully-flat result.
   *
   * When the mask also contains content that can't become a path (image/text),
   * baking to geometry would drop it — so instead we COMMIT the clip: the wrapper
   * becomes a plain group that keeps every child and retains the cutter as an
   * inline clip. Either way the result looks identical to what was on screen — the
   * old behavior silently dropped grouped/raster content, which is the bug this
   * fixes. No-op if there's no vector leaf to flatten (guard with {@link canFlattenMask}).
   */
  async flattenMask(id: string): Promise<void> {
    const shape = this.host.findShape(id);
    if (!shape || !shape.element.hasAttribute('data-clip-group')) return;
    const group = shape.element;
    const clipPathEl = Array.from(group.children).find(c => c.tagName.toLowerCase() === 'clippath');
    const cutter = clipPathEl?.firstElementChild as SVGElement | null;
    const content = Array.from(group.children).filter(c => c !== clipPathEl) as SVGElement[];
    if (!cutter || content.length === 0) return;

    await ensureBooleanEngine();
    // Map each shape's local geometry into the group's OWN space (element transforms
    // only); the group's transform then rides across onto the result. Baking it into
    // the geometry instead left the mask's effects in the wrong space — a rotated
    // mask's shadow turned, a scaled one's blur shrank — and thinned every stroke.
    const groupM = new DOMMatrix();
    const cutterD = elementPathData(cutter, groupM.multiply(ownMatrix(cutter)));
    if (!cutterD.trim()) return;

    // Gather every vector leaf (recursing into groups), plus whether any content
    // can't be vectorized (image/text/use/…).
    // An effect or blend on the mask ITSELF was applied before its clip (one element:
    // filter, then clip-path), so the clip cut it off. A path can't reproduce that
    // either; such a mask commits its clip instead.
    const flags = { hasRaster: resistsBakingAsMask(group) };
    const leaves: MaskLeaf[] = [];
    for (const c of content) collectMaskLeaves(c, groupM.multiply(ownMatrix(c)), leaves, flags);
    if (leaves.length === 0) return; // nothing vector to flatten (guarded by canFlattenMask)

    const baseName = group.getAttribute('data-name') ?? '';
    this.host.exitGroupIsolation();

    if (flags.hasRaster) {
      // Lossless commit: keep all children clipped, just stop being an editable mask.
      group.removeAttribute('data-clip-group');
      group.setAttribute('data-name', baseName.replace(/^Mask/, 'Group') || 'Group');
      // The cutter is no longer a separately-editable node — and the group is no
      // longer a wrapper-leaf, so its clip's shape-ids would otherwise read as
      // unmodeled layers. Strip them (clipping references the clipPath's own id).
      clipPathEl?.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
      this.host.rebuild();
      this.host.setSelection([id]);
      this.host.saveHistory();
      this.host.onChange();
      return;
    }

    // All-vector: intersect each leaf with the cutter into clean geometry.
    if (leaves.some((l) => { const st = getComputedStyle(l.el).stroke; return !!st && st !== 'none'; })) {
      await ensureOffsetEngine(); // strokes become filled regions
    }
    const results: SVGElement[] = [];
    for (const leaf of leaves) {
      const made = flattenLeaf(leaf, cutterD, group);
      if (made) results.push(made);
    }
    if (results.length === 0) return;

    let replacement: SVGElement;
    if (results.length === 1) {
      replacement = results[0];
      replacement.setAttribute('data-name', baseName.replace(/^Mask/, 'Path') || 'Path');
    } else {
      replacement = document.createElementNS(SVG, 'g');
      results.forEach(p => replacement.appendChild(p));
      replacement.setAttribute('data-name', baseName.replace(/^Mask/, 'Group') || `Group ${id.replace('shape-', '#')}`);
    }
    // The mask's own object-level attributes apply to the whole shown result, in the
    // same space (the geometry is in the group's own space). Its clip is what
    // flattening consumes; everything else comes across — its opacity above all,
    // which applyResolvedPaint deliberately stops short of (it folds the chain BELOW
    // the mask). One path takes the product; a group takes the mask's own value.
    carryObjectAttrs(group, replacement, ['clip-path', 'data-name', 'opacity']);
    const op = composeOpacity(group.getAttribute('opacity'),
      results.length === 1 ? replacement.getAttribute('opacity') : null);
    if (op) replacement.setAttribute('opacity', op); else replacement.removeAttribute('opacity');
    replacement.id = id;
    group.replaceWith(replacement);
    this.host.rebuild();
    this.host.setSelection([id]);
    this.host.saveHistory();
    this.host.onChange();
  }

  /**
   * Convert the stroke of each selected stroked object into a filled outline path
   * (Illustrator's Outline Stroke). Returns false if nothing had an outline-able
   * stroke.
   */
  async outlineSelectedStroke(): Promise<boolean> {
    const targets = this.host.getSelectedIds()
      .map(id => this.host.findShape(id))
      .filter((s): s is ShapeData => !!s && PATHABLE.includes(s.type))
      .filter(s => {
        const stroke = s.element.getAttribute('stroke');
        const w = parseFloat(s.element.getAttribute('stroke-width') ?? '0');
        return !!stroke && stroke !== 'none' && w > 0;
      });
    if (targets.length === 0) return false;

    await ensureOffsetEngine();
    const resultIds: string[] = [];
    for (const s of targets) {
      const id = this.outlineOneStroke(s);
      if (id) resultIds.push(id);
    }
    if (resultIds.length === 0) return false; // nothing could be outlined: no undo step
    this.host.rebuild();
    this.host.setSelection(resultIds);
    this.host.saveHistory();
    this.host.onChange();
    return true;
  }

  /** Outline one shape's stroke (see {@link strokeInk} for what "the stroke" covers);
   *  returns the id of the resulting top-level element. */
  private outlineOneStroke(shape: ShapeData): string | null {
    const el = shape.element;
    const parts = strokeInk(el, shape.type);
    if (!parts) return null;
    const so = el.getAttribute('stroke-opacity');
    const mk = (p: InkPiece): SVGPathElement => inkPath(p.d, p.paint, p.ink ? so : null);
    const below = parts.below.map(mk), above = parts.above.map(mk);

    const fill = effectivePaint(el, 'fill');
    const hasFill = !!fill && fill !== 'none';
    // An emulated stroke-align clip (see stroke-align.ts) only shaped the stroke
    // being outlined; a clip the user applied is part of the object and stays.
    const clip = el.getAttribute('clip-path');
    const userClip = clip && !clip.includes('sa-clip-') ? clip : null;
    // A linked PAINT style describes the fill. The outline's fill is the old stroke
    // colour, so the link must not follow it (reconciling would repaint the outline
    // in the style's fill); it stays with the fill body, if there is one.
    const NOT_CARRIED = ['clip-path', 'data-paint-style'];

    if (!hasFill && below.length + above.length === 1) {
      // No fill body and one piece of ink: the outline simply replaces the shape,
      // and inherits every object-level attribute — opacity, effects, lock — not
      // just the transform (it used to come out fully opaque).
      const outline = above[0] ?? below[0];
      carryObjectAttrs(el, outline, NOT_CARRIED);
      if (userClip) outline.setAttribute('clip-path', userClip);
      outline.id = shape.id;
      el.replaceWith(outline);
      return shape.id;
    }
    // Several pieces: the fill body (minus its stroke), the outline, and any
    // differently-coloured arrowheads, grouped. The object-level attributes MOVE
    // to the group so the pieces composite as one object, exactly as the single
    // stroked element did: a 50%-opacity shape becomes a 50%-opacity group, not
    // two 50% layers that double up where the stroke overlapped the fill. All the
    // children stay in the shape's local space.
    const g = document.createElementNS(SVG, 'g');
    if (userClip) g.setAttribute('clip-path', userClip);
    for (const p of [...below, ...above]) p.id = this.host.nextId();
    if (!hasFill) {
      carryObjectAttrs(el, g, [...NOT_CARRIED, 'data-name']);
      // Nothing of the original survives: the group takes its place and its name.
      const name = el.getAttribute('data-name');
      if (name) g.setAttribute('data-name', name);
      g.id = shape.id;
      g.append(...below, ...above);
      el.replaceWith(g);
      return shape.id;
    }
    moveObjectAttrs(el, g, [...NOT_CARRIED, 'data-name']);
    el.style.removeProperty('paint-order'); // the outside-alignment emulation
    if (!el.getAttribute('style')?.trim()) el.removeAttribute('style');
    for (const a of ['stroke', 'stroke-width', 'stroke-linejoin', 'stroke-linecap', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'data-stroke-align', 'clip-path', 'marker-start', 'marker-mid', 'marker-end']) {
      el.removeAttribute(a);
    }
    const gid = this.host.nextId();
    g.id = gid;
    g.setAttribute('data-name', 'Outlined Stroke');
    el.replaceWith(g);
    g.append(...below, el, ...above);
    return gid;
  }

  /**
   * Offset every selected path outward (positive) or inward (negative) by `delta`,
   * in place, preserving curves. Primitives are converted to paths first. Returns
   * false if nothing changed.
   */
  async offsetSelectedPath(delta: number): Promise<boolean> {
    if (!delta) return false;
    const shapes = this.host.getSelectedIds()
      .map(id => this.host.findShape(id))
      .filter((s): s is ShapeData => !!s && PATHABLE.includes(s.type));
    if (shapes.length === 0) return false;

    await ensureOffsetEngine();
    let changed = false;
    for (const s of shapes) {
      if (s.type !== 'path' && !this.host.convertShapeToPath(s)) continue;
      const d = s.element.getAttribute('d') ?? '';
      const out = offsetPathData(d, delta, 'miter');
      if (out.trim()) { s.element.setAttribute('d', out); changed = true; }
    }
    if (!changed) return false;
    this.host.saveHistory();
    this.host.onChange();
    return true;
  }
}
