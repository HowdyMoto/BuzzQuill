// ---------------------------------------------------------------------------
// Variable-width strokes (the Width tool) — a stroke whose thickness varies along
// its length.
//
// SVG can't paint that, so a width object is a `<g data-width>` wrapper (leaf, type
// 'width') holding:
//   • `[data-width-src]`    — the centerline geometry (keeps the object's fill,
//     stroke cleared) — the editable source, and
//   • `[data-width-render]` — a generated closed outline `<path>` filled with the
//     stroke colour, whose shape comes from the centerline + width profile.
// The outline lives in the drawing layer, so it round-trips through the history
// snapshot for free; rebuildShapesFromDOM treats the wrapper as a leaf. The profile
// + base width + stroke colour live on the wrapper; regeneration only runs when the
// profile changes (a preset or a Width-tool drag).
//
// Extracted from AppState as a collaborator (twin of AppearanceManager): it reaches
// AppState only through the WidthStrokeHost seam and shares the object-attribute carry.
// ---------------------------------------------------------------------------

import { effectivePaint } from './effective-paint';
import type { ShapeData } from './types';
import { variableWidthOutline, type WidthPoint } from './variable-width';
import { localPathData } from './boolean';
import { carryObjectAttrs } from './wrapper-attrs';

const SVG = 'http://www.w3.org/2000/svg';
const WIDTH_MIN = 0.01;

export interface WidthStrokeHost {
  findShape(id: string): ShapeData | null;
  applyEffectFilter(el: SVGElement): void;
  rebuild(): void;
  setSelection(ids: string[]): void;
  saveHistory(): void;
  onChange(): void;
}

export class WidthStrokeManager {
  private host: WidthStrokeHost;
  constructor(host: WidthStrokeHost) { this.host = host; }

  /** The width model for an object, or null if it isn't a width object. */
  get(id: string): { centerline: string; base: number; stroke: string; points: WidthPoint[] } | null {
    const shape = this.host.findShape(id);
    if (!shape || shape.type !== 'width') return null;
    const g = shape.element;
    const src = g.querySelector(':scope > [data-width-src]') as SVGElement | null;
    let points: WidthPoint[] = [];
    try { const raw = JSON.parse(g.getAttribute('data-width-profile') || '[]'); if (Array.isArray(raw)) points = raw; } catch { /* keep [] */ }
    return {
      centerline: src?.getAttribute('d') ?? '',
      base: parseFloat(g.getAttribute('data-width-base') || '1') || 1,
      stroke: g.getAttribute('data-width-stroke') || '#000000',
      points,
    };
  }

  /** True when a shape can take a width profile (has a strokeable centerline). */
  canApply(id: string): boolean {
    const shape = this.host.findShape(id);
    if (!shape) return false;
    if (shape.type === 'width') return true;
    return ['path', 'line', 'polyline', 'polygon'].includes(shape.type);
  }

  /** Re-run the outline generation after the source centerline was edited in place
   *  (e.g. by the node tool). */
  refresh(g: SVGElement): void { this.regenerate(g); }

  private regenerate(g: SVGElement): void {
    const src = g.querySelector(':scope > [data-width-src]') as SVGElement | null;
    if (!src) return;
    const centerline = src.getAttribute('d') ?? '';
    const base = parseFloat(g.getAttribute('data-width-base') || '1') || 1;
    let points: WidthPoint[] = [];
    try { const raw = JSON.parse(g.getAttribute('data-width-profile') || '[]'); if (Array.isArray(raw)) points = raw; } catch { /* [] */ }
    const outlineD = variableWidthOutline(centerline, points, base);
    let render = g.querySelector(':scope > [data-width-render]') as SVGElement | null;
    if (!render) {
      render = document.createElementNS(SVG, 'path');
      render.setAttribute('data-width-render', '');
      g.appendChild(render);
    }
    render.setAttribute('d', outlineD);
    render.setAttribute('fill', g.getAttribute('data-width-stroke') || '#000000');
    render.setAttribute('fill-rule', 'nonzero');
    render.setAttribute('stroke', 'none');
    // Keep the render on top of the (filled) centerline, matching stroke-over-fill.
    g.appendChild(render);
    // Seed representative paint so the panel / export see the stroke colour.
    g.setAttribute('fill', g.getAttribute('data-width-stroke') || '#000000');
    g.setAttribute('stroke', 'none');
  }

  /** Wrap a plain strokeable shape into a `<g data-width>` in place. */
  private wrap(shape: ShapeData, base: number): SVGElement {
    const el = shape.element;
    const centerline = shape.type === 'path' ? (el.getAttribute('d') ?? '') : localPathData(el);
    const stroke = effectivePaint(el, 'stroke');
    const strokeColor = (stroke && stroke !== 'none') ? stroke : (effectivePaint(el, 'fill') || '#000000');

    const g = document.createElementNS(SVG, 'g');
    g.id = el.id;
    g.setAttribute('data-width', '');
    g.setAttribute('data-width-base', String(base));
    g.setAttribute('data-width-stroke', strokeColor);
    carryObjectAttrs(el, g); // el is replaced outright, so nothing to strip from it

    // The centerline keeps the object's fill (rendered under the stroke outline),
    // becomes a plain <path> of the centerline geometry, and loses its own stroke.
    const srcPath = document.createElementNS(SVG, 'path');
    srcPath.setAttribute('data-width-src', '');
    srcPath.setAttribute('d', centerline);
    srcPath.setAttribute('fill', effectivePaint(el, 'fill') || 'none');
    const fo = el.getAttribute('fill-opacity'); if (fo) srcPath.setAttribute('fill-opacity', fo);
    srcPath.setAttribute('stroke', 'none');

    el.replaceWith(g);
    g.appendChild(srcPath);
    if (g.hasAttribute('data-fx-blur') || g.hasAttribute('data-fx-shadow')) this.host.applyEffectFilter(g);
    return g;
  }

  /** Collapse a width object back to a plain `<path>` centerline (release). */
  clear(id: string): void {
    const shape = this.host.findShape(id);
    if (!shape || shape.type !== 'width') return;
    const g = shape.element;
    const model = this.get(id)!;
    const path = document.createElementNS(SVG, 'path');
    path.id = id;
    path.setAttribute('d', model.centerline);
    const src = g.querySelector(':scope > [data-width-src]') as SVGElement | null;
    path.setAttribute('fill', src?.getAttribute('fill') || 'none');
    const fo = src?.getAttribute('fill-opacity'); if (fo) path.setAttribute('fill-opacity', fo);
    path.setAttribute('stroke', model.stroke);
    path.setAttribute('stroke-width', String(model.base));
    carryObjectAttrs(g, path);
    g.replaceWith(path);
    if (path.hasAttribute('data-fx-blur') || path.hasAttribute('data-fx-shadow')) this.host.applyEffectFilter(path);
    this.host.rebuild();
    this.host.setSelection([id]);
    this.host.saveHistory();
    this.host.onChange();
  }

  /**
   * Apply / update a width profile on an object. Wraps a plain shape into a
   * `<g data-width>` on first use, stores the profile, and regenerates the outline.
   * `points` are {t (0–1), w (full width)}; pass [] with a base to reset to uniform.
   * One undo step when `record`.
   */
  set(id: string, points: WidthPoint[], base: number, record = true): void {
    const shape = this.host.findShape(id);
    if (!shape || !this.canApply(id)) return;
    const clean = points
      .filter(p => isFinite(p.t) && isFinite(p.w))
      .map(p => ({ t: Math.min(1, Math.max(0, p.t)), w: Math.max(WIDTH_MIN, p.w) }))
      .sort((a, b) => a.t - b.t);
    const g = shape.type === 'width' ? shape.element : this.wrap(shape, base);
    g.setAttribute('data-width-base', String(base));
    g.setAttribute('data-width-profile', JSON.stringify(clean));
    this.regenerate(g);
    this.host.rebuild();
    this.host.setSelection([id]);
    if (record) this.host.saveHistory();
    this.host.onChange();
  }
}
