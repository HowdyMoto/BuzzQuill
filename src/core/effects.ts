// ---------------------------------------------------------------------------
// Object effects — non-destructive blur + drop shadow via SVG <filter>.
//
// The effect PARAMETERS are the source of truth and live as data-fx-* attributes
// on the element, so they round-trip through the history/innerHTML snapshot. The
// generated <filter> in <defs> is a regenerated CACHE (defs aren't snapshotted),
// so ensureFilters() rebuilds it after every rebuild/import/undo.
//
// Extracted from AppState as a collaborator (like History/PaintRegistry/
// ClipboardManager/SymbolRegistry): it reaches the few AppState primitives it
// needs through the EffectsHost seam rather than owning any document state.
// ---------------------------------------------------------------------------

import type { ObjectShadow } from './types';
import { ensureCropClip } from './crop-clip';
import { composeOpacity, getBlend, setBlend } from './wrapper-attrs';

const SVG = 'http://www.w3.org/2000/svg';

/** Serialize a shadow to its `data-fx-shadow` value. JSON (not comma-joined) so a
 *  colour that contains commas — `rgb(0,0,0)` / `rgba(...)` — can't shatter the
 *  encoding. Round-trips through the history/innerHTML snapshot as an escaped attr. */
function encodeShadow(s: ObjectShadow): string {
  return JSON.stringify({ dx: s.dx, dy: s.dy, blur: s.blur, color: s.color, opacity: s.opacity });
}

/** Parse `data-fx-shadow`. Accepts the current JSON form and the legacy comma form
 *  (`dx,dy,blur,color,opacity`, where old docs only ever stored a hex colour). */
function parseShadow(attr: string | null | undefined): ObjectShadow | null {
  if (!attr) return null;
  const t = attr.trim();
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t);
      return {
        dx: Number(o.dx) || 0, dy: Number(o.dy) || 0, blur: Number(o.blur) || 0,
        color: o.color || '#000000', opacity: o.opacity == null ? 1 : Number(o.opacity),
      };
    } catch { return null; }
  }
  const [dx, dy, b, color, op] = t.split(',');
  return { dx: parseFloat(dx) || 0, dy: parseFloat(dy) || 0, blur: parseFloat(b) || 0, color: color || '#000000', opacity: parseFloat(op) || 0 };
}

export interface EffectsHost {
  ensureDefs(): SVGDefsElement;
  getDrawingLayer(): SVGGElement;
  findShapeElement(id: string): SVGElement | null;
  /** Elements of the current selection, resolved anywhere in the tree. */
  selectionElements(): SVGElement[];
  nextId(): string;
  /** Re-derive the shape tree after a structural change. */
  rebuild(): void;
  /** Swap one id for another in the selection (the object it named was wrapped). */
  replaceInSelection(oldId: string, newId: string): void;
  saveHistory(): void;
  onChange(): void;
}

/** Groups that are more than a plain group — never reused as a mask's effect host. */
const SPECIAL_GROUP = ['data-frame', 'data-boolean', 'data-appearance', 'data-width', 'data-clip-group', 'data-repeat'];

export class EffectsManager {
  private host: EffectsHost;
  constructor(host: EffectsHost) { this.host = host; }

  getObjectEffects(id: string): { blur: number; shadow: ObjectShadow | null } {
    const el = this.host.findShapeElement(id);
    const blur = el ? (parseFloat(el.getAttribute('data-fx-blur') || '0') || 0) : 0;
    const shadow = parseShadow(el?.getAttribute('data-fx-shadow'));
    return { blur, shadow };
  }

  // `record` lets a slider apply live on `input` (record=false) and commit one
  // history entry on `change` (record=true), so a drag doesn't flood undo.
  private applyBlurTo(target: SVGElement, stdDev: number): void {
    const el = stdDev > 0 ? this.effectHost(target) : target;
    if (stdDev > 0) el.setAttribute('data-fx-blur', String(stdDev));
    else el.removeAttribute('data-fx-blur');
    this.applyFilter(el);
  }

  private applyShadowTo(target: SVGElement, shadow: ObjectShadow | null): void {
    const el = shadow ? this.effectHost(target) : target;
    if (shadow) el.setAttribute('data-fx-shadow', encodeShadow(shadow));
    else el.removeAttribute('data-fx-shadow');
    this.applyFilter(el);
  }

  /**
   * The element an effect on `el` belongs on. For everything but a mask, itself.
   *
   * A mask is one element carrying both `clip-path` and the effect's `filter`, and
   * SVG applies the filter FIRST — so a mask's own shadow was cut off at the mask's
   * outline and its blur ended in a hard edge. The effect has to sit outside the
   * clip, which takes a second element: a plain group around the mask. It takes
   * over the selection, and what must composite after the clip (the effects, the
   * opacity, the blend, a linked effect style) moves onto it. A mask already alone
   * in a plain group reuses that group.
   */
  private effectHost(el: SVGElement): SVGElement {
    if (!el.hasAttribute('data-clip-group')) return el;
    const parent = el.parentElement;
    const reusable = !!parent && parent.tagName.toLowerCase() === 'g' && /^shape-\d+$/.test(parent.id)
      && parent.children.length === 1 && !SPECIAL_GROUP.some((a) => parent.hasAttribute(a));
    const g = reusable ? (parent as unknown as SVGElement) : document.createElementNS(SVG, 'g');
    if (!reusable) {
      g.id = this.host.nextId();
      g.setAttribute('data-name', 'Group');
      el.replaceWith(g);
      g.appendChild(el);
    }
    this.host.ensureDefs().querySelector(`[id="fx-${el.id}"]`)?.remove();
    for (const a of ['data-fx-blur', 'data-fx-shadow', 'data-effect-style']) {
      const v = el.getAttribute(a);
      if (v != null && !g.hasAttribute(a)) g.setAttribute(a, v);
      el.removeAttribute(a);
    }
    el.removeAttribute('filter'); // applyFilter writes the group's own
    const op = composeOpacity(g.getAttribute('opacity'), el.getAttribute('opacity'));
    if (op) g.setAttribute('opacity', op); else g.removeAttribute('opacity');
    el.removeAttribute('opacity');
    const blend = getBlend(el);
    if (blend) {
      if (!getBlend(g)) setBlend(g, blend);
      setBlend(el, null);
    }
    this.host.rebuild();
    this.host.replaceInSelection(el.id, g.id);
    return g;
  }

  setObjectBlur(id: string, stdDev: number, record = true): void {
    const el = this.host.findShapeElement(id);
    if (!el) return;
    this.applyBlurTo(el, stdDev);
    if (record) this.host.saveHistory();
    this.host.onChange();
  }

  setObjectShadow(id: string, shadow: ObjectShadow | null, record = true): void {
    const el = this.host.findShapeElement(id);
    if (!el) return;
    this.applyShadowTo(el, shadow);
    if (record) this.host.saveHistory();
    this.host.onChange();
  }

  /** Apply blur to every selected object in a single undo step. */
  setSelectionBlur(stdDev: number, record = true): void {
    for (const el of this.host.selectionElements()) this.applyBlurTo(el, stdDev);
    if (record) this.host.saveHistory();
    this.host.onChange();
  }

  setSelectionShadow(shadow: ObjectShadow | null, record = true): void {
    for (const el of this.host.selectionElements()) this.applyShadowTo(el, shadow);
    if (record) this.host.saveHistory();
    this.host.onChange();
  }

  /** Set blur + shadow on specific elements (not the selection) — the linked
   *  effect-style propagation path. Both are set so the objects match the style. */
  setEffectsOnElements(els: SVGElement[], blur: number, shadow: ObjectShadow | null, record = true): void {
    for (const el of els) { this.applyBlurTo(el, blur); this.applyShadowTo(el, shadow); }
    if (record) this.host.saveHistory();
    this.host.onChange();
  }

  /** (Re)build or remove an element's `<filter>` from its data-fx-* attributes.
   *  Also called by the appearance/width wrappers when they move fx attrs. */
  applyFilter(el: SVGElement): void {
    const blur = parseFloat(el.getAttribute('data-fx-blur') || '0') || 0;
    const shadow = parseShadow(el.getAttribute('data-fx-shadow'));
    const fid = `fx-${el.id}`;
    const defs = this.host.ensureDefs();
    defs.querySelector(`[id="${fid}"]`)?.remove();

    if (blur <= 0 && !shadow) {
      if (el.getAttribute('filter') === `url(#${fid})`) el.removeAttribute('filter');
      return;
    }
    // Chrome ignores a crop's viewport clip once the crop itself is filtered; a crop
    // saved before crops clipped one level down is upgraded here (crop-clip.ts).
    ensureCropClip(el);
    const filter = document.createElementNS(SVG, 'filter');
    filter.setAttribute('id', fid);
    // A group's or instance's stroke lives on its children; measure it once here
    // (a regenerated cache, so it's rebuilt with the filter) for fitRegion to reuse.
    if (CONTAINERS.has(el.tagName.toLowerCase())) filter.setAttribute('data-stroke-half', String(strokeHalf(el)));
    if (!this.fitRegion(el, filter)) {
      // Not laid out — a generous %-region until the next render refits it.
      filter.setAttribute('x', '-80%'); filter.setAttribute('y', '-80%');
      filter.setAttribute('width', '260%'); filter.setAttribute('height', '260%');
    }
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    let input = 'SourceGraphic';
    if (blur > 0) {
      const fe = document.createElementNS(SVG, 'feGaussianBlur');
      fe.setAttribute('in', input); fe.setAttribute('stdDeviation', String(blur));
      fe.setAttribute('result', 'fxblur'); filter.appendChild(fe); input = 'fxblur';
    }
    if (shadow) {
      const fe = document.createElementNS(SVG, 'feDropShadow');
      fe.setAttribute('in', input);
      fe.setAttribute('dx', String(shadow.dx)); fe.setAttribute('dy', String(shadow.dy));
      fe.setAttribute('stdDeviation', String(shadow.blur));
      fe.setAttribute('flood-color', shadow.color);
      fe.setAttribute('flood-opacity', String(shadow.opacity));
      filter.appendChild(fe);
    }
    defs.appendChild(filter);
    el.setAttribute('filter', `url(#${fid})`);
  }

  /**
   * Fit a filter's region to the element's CURRENT box. The default
   * objectBoundingBox %-region COLLAPSES for a zero-area bbox (a perfectly
   * horizontal/vertical stroke-only line clipped away), so the region is ABSOLUTE
   * — userSpaceOnUse, padded for the stroke half-width, the blur, and the shadow's
   * offset + blur. False when the element isn't laid out.
   */
  private fitRegion(el: SVGElement, filter: Element): boolean {
    const blur = parseFloat(el.getAttribute('data-fx-blur') || '0') || 0;
    const shadow = parseShadow(el.getAttribute('data-fx-shadow'));
    let bb: DOMRect;
    try { bb = (el as unknown as SVGGraphicsElement).getBBox(); } catch { return false; }
    const sw = CONTAINERS.has(el.tagName.toLowerCase())
      ? parseFloat(filter.getAttribute('data-stroke-half') || '0') || 0
      : strokeHalf(el);
    const shadowPad = shadow ? shadow.blur * 3 + Math.max(Math.abs(shadow.dx), Math.abs(shadow.dy)) : 0;
    const pad = sw + blur * 3 + shadowPad + 4; // +4 = antialias slack
    // A <use>'s x/y are an extra translate INSIDE its user space: a userSpaceOnUse
    // region is read after it, but getBBox reports the box before it. Unshifted,
    // the region sat exactly (x, y) away from the instance and clipped every
    // pixel — a blurred or shadowed component instance simply vanished.
    let ox = 0, oy = 0;
    if (el.tagName.toLowerCase() === 'use') {
      ox = parseFloat(el.getAttribute('x') || '0') || 0;
      oy = parseFloat(el.getAttribute('y') || '0') || 0;
    }
    const set = (a: string, v: number): void => {
      const s = String(v);
      if (filter.getAttribute(a) !== s) filter.setAttribute(a, s);
    };
    if (filter.getAttribute('filterUnits') !== 'userSpaceOnUse') filter.setAttribute('filterUnits', 'userSpaceOnUse');
    set('x', bb.x - ox - pad);
    set('y', bb.y - oy - pad);
    set('width', bb.width + pad * 2);
    set('height', bb.height + pad * 2);
    return true;
  }

  /**
   * Re-fit every effect region to its element as it is NOW. A region is absolute,
   * so it went stale whenever geometry changed without a full rebuild — a nudge, a
   * Transform-panel X or W, a live drag — clipping the shape, or hiding it entirely
   * once it moved off its old region. Called every render frame; a getBBox per
   * effect, and nothing at all in a document without effects.
   */
  refreshRegions(): void {
    const layer = this.host.getDrawingLayer();
    const defs = layer.ownerSVGElement?.querySelector('defs');
    if (!defs) return;
    const unowned: Element[] = [];
    for (const f of Array.from(defs.querySelectorAll('filter[id^="fx-"]'))) {
      const el = layer.querySelector(`[id="${f.id.slice(3)}"]`) as SVGElement | null;
      if (el) this.fitRegion(el, f); else unowned.push(f);
    }
    // A filter whose object isn't in the drawing layer is either a component's (its
    // content lives in <defs>) or an orphan of a deleted shape. Telling them apart
    // means searching the canvas, so only do it when that set changes.
    const key = unowned.map((f) => f.id).join(' ');
    if (key !== this.unownedKey) this.unownedKey = this.pruneFilters(unowned).join(' ');
  }
  private unownedKey = '';

  /** Remove the given effect filters that nothing references; returns the ids kept. */
  private pruneFilters(filters: Element[]): string[] {
    const svg = this.host.getDrawingLayer().ownerSVGElement;
    if (!svg) return filters.map((f) => f.id);
    const kept: string[] = [];
    for (const f of filters) {
      if (svg.querySelector(`[filter="url(#${f.id})"]`)) kept.push(f.id); else f.remove();
    }
    return kept;
  }

  /** Regenerate every effect filter from its element's data-fx-* attrs (defs are
   *  not part of the history snapshot, so they must be rebuilt after restore). */
  ensureFilters(): void {
    this.host.getDrawingLayer().querySelectorAll('[data-fx-blur],[data-fx-shadow]')
      .forEach((el) => this.applyFilter(el as SVGElement));
    // Drop filters nothing uses any more. Every replace (detach, outline, ungroup,
    // wrapping a mask) gives the effect a new element id and so a new filter, and
    // the old one stayed behind in <defs> — and in every saved file.
    this.pruneFilters(Array.from(this.host.ensureDefs().querySelectorAll(':scope > filter[id^="fx-"]')));
  }
}

/**
 * Hand a dissolving container's effects to one of its children, re-expressed in
 * the child's own space (`childToParent` is the child's own transform): a shadow's
 * offset turns and scales with it, and a blur's radius scales. A blur adds to one
 * the child already has (two Gaussians compose as √(a²+b²)); a child that already
 * casts a shadow keeps its own, since one element has one shadow.
 */
export function inheritEffects(child: Element, from: Element, childToParent: DOMMatrix): void {
  const blur = parseFloat(from.getAttribute('data-fx-blur') || '0') || 0;
  const shadow = parseShadow(from.getAttribute('data-fx-shadow'));
  const m = childToParent;
  const det = m.a * m.d - m.b * m.c;
  if ((blur <= 0 && !shadow) || Math.abs(det) < 1e-12) return;
  const scale = Math.sqrt(Math.abs(det));
  const round = (v: number): number => Math.round(v * 1000) / 1000;
  if (blur > 0) {
    const own = parseFloat(child.getAttribute('data-fx-blur') || '0') || 0;
    child.setAttribute('data-fx-blur', String(round(Math.hypot(own, blur / scale))));
  }
  if (shadow && !child.hasAttribute('data-fx-shadow')) {
    child.setAttribute('data-fx-shadow', encodeShadow({
      ...shadow,
      dx: round((m.d * shadow.dx - m.c * shadow.dy) / det),
      dy: round((m.a * shadow.dy - m.b * shadow.dx) / det),
      blur: round(shadow.blur / scale),
    }));
  }
}

/** Elements whose strokes are drawn by their CHILDREN (or, for a `<use>`, by the
 *  element it instances), not by any stroke-width of their own. */
const CONTAINERS = new Set(['g', 'use', 'svg', 'a', 'switch']);

/**
 * Half the widest stroke the element draws, in its own units — getBBox leaves every
 * stroke out. A container's own stroke-width says nothing about its children's: a
 * blurred group or instance with a 40px stroke lost the outer half of it to the
 * region. Children's own transforms are ignored (an estimate, erring small).
 */
export function strokeHalf(el: Element): number {
  const own = (n: Element): number => {
    const cs = getComputedStyle(n);
    return cs.stroke && cs.stroke !== 'none' ? parseFloat(cs.strokeWidth) || 0 : 0;
  };
  const tag = el.tagName.toLowerCase();
  if (!CONTAINERS.has(tag)) return own(el) / 2;
  let root: Element = el, scale = 1;
  if (tag === 'use') {
    const ref = (el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? '').replace(/^#/, '');
    const target = ref ? el.ownerDocument.getElementById(ref) : null;
    if (!target) return 0;
    root = target;
    const vb = (target.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
    const w = parseFloat(el.getAttribute('width') ?? ''), h = parseFloat(el.getAttribute('height') ?? '');
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0 && w > 0 && h > 0) scale = Math.max(w / vb[2], h / vb[3]);
  }
  let max = 0;
  for (const n of Array.from(root.querySelectorAll('*'))) max = Math.max(max, own(n));
  return (max / 2) * scale;
}
