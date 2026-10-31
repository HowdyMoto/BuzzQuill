import { tokens } from '../ui/tokens';
import { BaseTool } from './base';
import type { Point } from '../core/types';
import { worldToLocal, matrixBetween, matrixAttr } from '../core/coords';
import { ensureCropClip } from '../core/crop-clip';
import { showGestureHud, hideGestureHud } from '../ui/gesture-hud';
import { resizeCursorFor } from '../ui/selection-overlay';

/**
 * Crop tool — Figma-style raster cropping. Double-clicking a raster image (or an
 * already-cropped one) enters a crop session: the whole image shows, the area
 * outside the crop dims, and eight handles + a move region let you frame it.
 * Enter / double-click / clicking away / switching tools commits; Escape cancels.
 *
 * The committed crop is a self-contained nested `<svg data-crop viewBox>` holding
 * the `<image>` — a viewport that clips to the crop with NO defs, so it round-trips
 * through history's innerHTML snapshot for free, resizes by scaling its content
 * (viewBox fixed, width/height change), and reads back as a single `image` leaf.
 * Expanding the crop back to the full image commits a bare `<image>` (uncrop).
 *
 * Everything is computed in the target's PARENT user space (where the image's
 * x/y/w/h live), so a plain image and a resized/moved cropped image are handled by
 * the same CTM-based geometry.
 */

type Box = { x: number; y: number; w: number; h: number };
type Mode = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move';

const NS = 'http://www.w3.org/2000/svg';

/** True for a committed crop (a nested <svg data-crop> wrapping one image). */
export function isCropped(el: SVGElement): boolean {
  return el.tagName.toLowerCase() === 'svg' && el.hasAttribute('data-crop');
}

/** Geometry attributes the rebuilt element sets itself; everything else on the old
 *  element (transform, opacity, filter, clip-path, blend/effect data-*, style
 *  links, …) is carried across verbatim. Dropping `transform` is how a crop used
 *  to flatten a rotated image onto its bounding box. */
const GEOMETRY_ATTRS = new Set([
  'x', 'y', 'width', 'height', 'viewBox', 'data-crop', 'overflow',
  'preserveAspectRatio', 'href', 'xlink:href',
]);

/** Copy every non-geometry attribute from `from` to `to` (id included). */
function carryAttrs(from: Element, to: Element): void {
  for (const a of Array.from(from.attributes)) {
    if (GEOMETRY_ATTRS.has(a.name)) continue;
    to.setAttribute(a.name, a.value);
  }
}

/**
 * Unwrap a cropped image back to a plain full <image> (a one-click "reset crop").
 *
 * The inner image's box is already in the wrapper's own pre-transform space, so it
 * transfers as-is and the wrapper's `transform` comes with it — a rotated crop
 * resets to a rotated full image, not to its bounding box. Returns the new element
 * (not yet inserted) or null if `el` isn't a crop.
 */
export function uncropToImage(el: SVGElement): SVGImageElement | null {
  if (!isCropped(el)) return null;
  const inner = el.querySelector('image');
  if (!inner) return null;
  const box = mapBox(matrixBetween(el as unknown as SVGGraphicsElement, inner), {
    x: parseFloat(inner.getAttribute('x') ?? '0'),
    y: parseFloat(inner.getAttribute('y') ?? '0'),
    w: parseFloat(inner.getAttribute('width') ?? '0'),
    h: parseFloat(inner.getAttribute('height') ?? '0'),
  });
  const im = document.createElementNS(NS, 'image') as SVGImageElement;
  carryAttrs(el, im);
  im.setAttribute('x', String(box.x)); im.setAttribute('y', String(box.y));
  im.setAttribute('width', String(box.w)); im.setAttribute('height', String(box.h));
  im.setAttribute('href', inner.getAttribute('href') ?? inner.getAttribute('xlink:href') ?? '');
  im.setAttribute('preserveAspectRatio', inner.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet');
  return im;
}

/** A box through a matrix, as the axis-aligned box of its four mapped corners.
 *  Null matrix (or none needed) passes the box straight through. */
function mapBox(m: DOMMatrix | null, b: Box): Box {
  if (!m) return { ...b };
  const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]
    .map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

const HANDLE = 14;  // on-screen corner arm / edge half-length, kept constant via ÷zoom
const GRAB = 16;     // on-screen grab tolerance (px)
const MIN = 8;      // smallest crop edge in world units (÷ the image's own scale)

export class CropTool extends BaseTool {
  name = 'crop';

  private overlay: SVGGElement | null = null;
  /** The stylesheet rule hiding the real element while the session previews it. */
  private hideStyle: SVGStyleElement | null = null;
  private parentEl: SVGElement | null = null;
  private origEl: SVGElement | null = null;  // the image/svg being cropped (hidden during the session)
  private href = '';
  private preserve = 'xMidYMid meet';
  // Everything is measured in the IMAGE'S OWN space — the one its x/y/w/h are
  // written in, before its own `transform`. That keeps a rotated image rotated
  // (the crop frame turns with it, Figma-style) instead of flattening it onto its
  // bounding box, and lets the commit hand the transform straight back.
  private imgBox: Box = { x: 0, y: 0, w: 0, h: 0 };  // full image, image space
  private crop: Box = { x: 0, y: 0, w: 0, h: 0 };    // current crop, image space
  private startCrop: Box | null = null;              // the crop this session opened with
  /** image space → the target's parent space, captured before the element hides
   *  (a display:none element has no CTM to ask). */
  private localToParent: DOMMatrix | null = null;
  /** image space → guides-layer space, for the overlay. */
  private localToGuides: DOMMatrix | null = null;
  /** On-screen size of one image-space unit at zoom 1 (the element's own scale). */
  private localScale = 1;

  private mode: Mode | null = null;
  private dragStartCrop: Box | null = null;
  private dragStartPt: Point = { x: 0, y: 0 };
  private done = false;

  activate(): void {
    this.done = false;
    const shape = this.state.getSelectedShape();
    if (!shape || shape.type !== 'image') { this.bail(); return; }

    const el = shape.element;
    const img = el.tagName.toLowerCase() === 'image'
      ? (el as SVGImageElement)
      : el.querySelector('image');
    if (!img || !el.id) { this.bail(); return; }

    this.origEl = el;
    this.parentEl = el.parentNode as SVGElement;
    this.href = img.getAttribute('href') ?? img.getAttribute('xlink:href') ?? '';
    this.preserve = img.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet';
    // The <image>'s own numbers ARE the working space — no mapping, so nothing
    // about the element's transform leaks into the geometry.
    this.imgBox = this.numBox(img);

    if (el.tagName.toLowerCase() === 'svg' && el.hasAttribute('data-crop')) {
      // Re-cropping: the current crop is the wrapper's viewBox, which is written in
      // the same space as the inner image (mapped, for an imported crop that isn't).
      const vb = (el.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
      const local = vb.length === 4 ? { x: vb[0], y: vb[1], w: vb[2], h: vb[3] } : this.numBox(el);
      this.crop = mapBox(matrixBetween(img, el as unknown as SVGGraphicsElement), local);
    } else {
      this.crop = { ...this.imgBox }; // fresh crop starts as the whole image
    }
    this.startCrop = { ...this.crop };

    // Capture both mappings while the element is still rendered.
    const guides = this.svgCanvas.querySelector('#guides-layer') as SVGGElement | null;
    this.localToParent = matrixBetween(this.parentEl as unknown as SVGGraphicsElement, img);
    this.localToGuides = guides ? matrixBetween(guides as unknown as SVGGraphicsElement, img) : null;
    const m = this.localToGuides;
    this.localScale = m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1 : 1;

    // The session preview stands in for the element, which is hidden by a rule in
    // the overlay layer rather than by an attribute ON it: its markup never changes,
    // so history, autosave and a tab switch can't capture a half-open crop (a reload
    // mid-session restored the picture hidden), and backing out leaves no residue.
    if (guides) {
      const style = document.createElementNS(this.NS, 'style') as SVGStyleElement;
      style.textContent = `#drawing-layer [id="${el.id.replace(/["\\]/g, '\\$&')}"]{display:none!important}`;
      guides.appendChild(style);
      this.hideStyle = style;
    }
    this.buildOverlay();
    this.render();
  }

  deactivate(): void {
    // Switching tools mid-crop keeps the crop (like finishing a shape); Escape,
    // which explicitly cancels, sets done first so this is a no-op.
    if (!this.done) this.commit();
    this.cleanup();
  }

  onMouseDown(pt: Point, e: MouseEvent): void {
    if (!this.origEl) return;
    const p = this.toLocal(pt);
    const m = this.hitTest(p);
    if (!m) { this.commitAndReturn(); return; } // clicked away → commit
    this.mode = m;
    this.dragStartCrop = { ...this.crop };
    this.dragStartPt = p;
    showGestureHud('crop', e);
  }

  onMouseMove(pt: Point, e: MouseEvent): void {
    if (!this.mode || !this.dragStartCrop) {
      // Idle hover: reflect the grab affordance in the cursor.
      const c = this.hitTest(this.toLocal(pt));
      this.svgCanvas.style.cursor = c ? this.cursorFor(c) : 'default';
      return;
    }
    showGestureHud('crop', e);
    const p = this.toLocal(pt);
    const dx = p.x - this.dragStartPt.x;
    const dy = p.y - this.dragStartPt.y;
    this.crop = this.applyDrag(this.dragStartCrop, this.mode, dx, dy);
    this.render();
  }

  onMouseUp(): void {
    this.mode = null;
    this.dragStartCrop = null;
    hideGestureHud();
  }

  onDoubleClick(): void { this.commitAndReturn(); }

  onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter') { e.preventDefault(); this.commitAndReturn(); }
    else if (e.key === 'Escape') { e.preventDefault(); this.cancel(); }
  }

  /** The resize cursor for a handle by where it points ON SCREEN. The handles turn
   *  with a rotated image, so the by-name `n-resize` pointed across the drag — the
   *  same fix the selection overlay's handles got (ui/selection-overlay.ts). */
  private cursorFor(m: Mode): string {
    if (m === 'move') return 'move';
    const t = this.localToGuides;
    if (!t) return `${m}-resize`;
    const lx = m.includes('e') ? 1 : m.includes('w') ? -1 : 0;
    const ly = m.includes('s') ? 1 : m.includes('n') ? -1 : 0;
    const ul = Math.hypot(t.a, t.b) || 1, vl = Math.hypot(t.c, t.d) || 1; // unit image axes
    const dx = (lx * t.a) / ul + (ly * t.c) / vl, dy = (lx * t.b) / ul + (ly * t.d) / vl;
    return dx === 0 && dy === 0 ? `${m}-resize` : resizeCursorFor(dx, dy);
  }

  // ---- geometry ----

  private numBox(el: SVGElement): Box {
    return {
      x: parseFloat(el.getAttribute('x') ?? '0'),
      y: parseFloat(el.getAttribute('y') ?? '0'),
      w: parseFloat(el.getAttribute('width') ?? '0'),
      h: parseFloat(el.getAttribute('height') ?? '0'),
    };
  }

  /** A world (canvas) point in the image's own space. Goes via the parent, which
   *  is still rendered — the image itself is hidden for the session, so its live
   *  CTM is unavailable and the captured matrix does the last step. */
  private toLocal(pt: Point): Point {
    const inParent = worldToLocal(this.svgCanvas, this.parentEl, pt);
    const m = this.localToParent;
    if (!m) return inParent;
    const p = new DOMPoint(inParent.x, inParent.y).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }

  /** Clamp the crop so it stays inside the image and never smaller than MIN. */
  private applyDrag(start: Box, mode: Mode, dx: number, dy: number): Box {
    const img = this.imgBox;
    const MIN_L = MIN / this.localScale; // a world-unit minimum, in image space
    let { x, y, w, h } = start;
    if (mode === 'move') {
      x = Math.max(img.x, Math.min(x + dx, img.x + img.w - w));
      y = Math.max(img.y, Math.min(y + dy, img.y + img.h - h));
      return { x, y, w, h };
    }
    let l = x, t = y, r = x + w, b = y + h;
    if (mode.includes('w')) l = Math.max(img.x, Math.min(x + dx, r - MIN_L));
    if (mode.includes('e')) r = Math.min(img.x + img.w, Math.max(x + w + dx, l + MIN_L));
    if (mode.includes('n')) t = Math.max(img.y, Math.min(y + dy, b - MIN_L));
    if (mode.includes('s')) b = Math.min(img.y + img.h, Math.max(y + h + dy, t + MIN_L));
    return { x: l, y: t, w: r - l, h: b - t };
  }

  private handleCenters(): Record<Mode, Point> {
    const { x, y, w, h } = this.crop;
    const mx = x + w / 2, my = y + h / 2;
    return {
      nw: { x, y }, n: { x: mx, y }, ne: { x: x + w, y },
      e: { x: x + w, y: my }, se: { x: x + w, y: y + h }, s: { x: mx, y: y + h },
      sw: { x, y: y + h }, w: { x, y: my }, move: { x: mx, y: my },
    };
  }

  private hitTest(p: Point): Mode | null {
    const tol = GRAB / (this.canvas.getZoom() * this.localScale);
    const centers = this.handleCenters();
    for (const m of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as Mode[]) {
      const c = centers[m];
      if (Math.abs(p.x - c.x) <= tol && Math.abs(p.y - c.y) <= tol) return m;
    }
    const { x, y, w, h } = this.crop;
    if (p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h) return 'move';
    return null;
  }

  // ---- overlay ----

  private buildOverlay(): void {
    const guides = this.svgCanvas.querySelector('#guides-layer') as SVGGElement;
    const g = document.createElementNS(this.NS, 'g') as SVGGElement;
    // Draw in IMAGE space: the captured matrix carries the image's own transform,
    // so the preview, the dimmed bands and the handles all turn with a rotated
    // image and the crop frame stays square to the picture.
    if (this.localToGuides) g.setAttribute('transform', matrixAttr(this.localToGuides));
    guides.appendChild(g);
    this.overlay = g;
  }

  onViewChange(): void { this.render(); }

  private render(): void {
    const g = this.overlay;
    if (!g) return;
    g.innerHTML = '';
    // Screen px per image-space unit: the canvas zoom AND the image's own scale,
    // since the overlay is drawn through the image's transform.
    const z = this.canvas.getZoom() * this.localScale;
    const img = this.imgBox, c = this.crop;

    // Full image preview (so the parts outside the crop are visible to reposition).
    const im = document.createElementNS(this.NS, 'image');
    im.setAttribute('x', String(img.x)); im.setAttribute('y', String(img.y));
    im.setAttribute('width', String(img.w)); im.setAttribute('height', String(img.h));
    im.setAttribute('href', this.href);
    im.setAttribute('preserveAspectRatio', this.preserve);
    g.appendChild(im);

    // Dim everything outside the crop (four bands within the image bounds).
    const bands: Box[] = [
      { x: img.x, y: img.y, w: img.w, h: c.y - img.y },                       // top
      { x: img.x, y: c.y + c.h, w: img.w, h: img.y + img.h - (c.y + c.h) },   // bottom
      { x: img.x, y: c.y, w: c.x - img.x, h: c.h },                           // left
      { x: c.x + c.w, y: c.y, w: img.x + img.w - (c.x + c.w), h: c.h },       // right
    ];
    for (const b of bands) {
      if (b.w <= 0 || b.h <= 0) continue;
      this.rect(g, b, { fill: 'rgba(0,0,0,0.5)' });
    }

    // Rule-of-thirds guides inside the crop.
    for (let i = 1; i <= 2; i++) {
      this.line(g, c.x + (c.w * i) / 3, c.y, c.x + (c.w * i) / 3, c.y + c.h);
      this.line(g, c.x, c.y + (c.h * i) / 3, c.x + c.w, c.y + (c.h * i) / 3);
    }

    // Crop outline.
    this.rect(g, c, { fill: 'none', stroke: tokens.selectionAccent, sw: 1 });

    // Familiar crop brackets: inward-facing L corners and straight edge bars.
    // A dark keyline keeps the white handles legible over light and dark images.
    const rx = Math.min(HANDLE / z, c.w / 4);
    const ry = Math.min(HANDLE / z, c.h / 4);
    const centers = this.handleCenters();
    for (const m of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as Mode[]) {
      const p = centers[m];
      const horizontal = m === 'n' || m === 's';
      const vertical = m === 'e' || m === 'w';
      const dx = m.includes('w') ? rx : -rx;
      const dy = m.includes('n') ? ry : -ry;
      const d = horizontal ? `M ${p.x - rx} ${p.y} H ${p.x + rx}`
        : vertical ? `M ${p.x} ${p.y - ry} V ${p.y + ry}`
        : `M ${p.x + dx} ${p.y} H ${p.x} V ${p.y + dy}`;
      const handle = document.createElementNS(this.NS, 'g');
      handle.setAttribute('data-crop-handle', m);
      handle.setAttribute('pointer-events', 'none');
      for (const [color, width] of [['#111', '5'], ['#fff', '3']]) {
        const path = document.createElementNS(this.NS, 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', color);
        path.setAttribute('stroke-width', width);
        path.setAttribute('stroke-linejoin', 'miter');
        path.setAttribute('stroke-linecap', 'square');
        path.setAttribute('vector-effect', 'non-scaling-stroke');
        handle.appendChild(path);
      }
      g.appendChild(handle);
    }
  }

  private rect(g: SVGGElement, b: Box, o: { fill: string; stroke?: string; sw?: number }): void {
    const r = document.createElementNS(this.NS, 'rect');
    r.setAttribute('x', String(b.x)); r.setAttribute('y', String(b.y));
    r.setAttribute('width', String(Math.max(0, b.w))); r.setAttribute('height', String(Math.max(0, b.h)));
    r.setAttribute('fill', o.fill);
    if (o.stroke) { r.setAttribute('stroke', o.stroke); r.setAttribute('stroke-width', String(o.sw ?? 1)); r.setAttribute('vector-effect', 'non-scaling-stroke'); }
    r.setAttribute('pointer-events', 'none');
    g.appendChild(r);
  }

  private line(g: SVGGElement, x1: number, y1: number, x2: number, y2: number): void {
    const l = document.createElementNS(this.NS, 'line');
    l.setAttribute('x1', String(x1)); l.setAttribute('y1', String(y1));
    l.setAttribute('x2', String(x2)); l.setAttribute('y2', String(y2));
    l.setAttribute('stroke', '#fff'); l.setAttribute('stroke-opacity', '0.4');
    l.setAttribute('stroke-width', '1'); l.setAttribute('vector-effect', 'non-scaling-stroke');
    l.setAttribute('pointer-events', 'none');
    g.appendChild(l);
  }

  // ---- commit / cancel ----

  private commitAndReturn(): void {
    this.commit();
    this.cleanup();
    this.state.requestTool?.(this.state.cropReturnTool ?? 'select');
  }

  private cancel(): void {
    this.done = true;
    this.cleanup();
    this.state.requestTool?.(this.state.cropReturnTool ?? 'select');
  }

  private commit(): void {
    if (this.done || !this.origEl || !this.parentEl) return;
    this.done = true;
    const el = this.origEl;
    const img = this.imgBox, c = this.crop;
    const eps = 0.5 / this.localScale; // half a world unit, in image space
    const same = (a: Box, b: Box): boolean =>
      Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps &&
      Math.abs(a.w - b.w) < eps && Math.abs(a.h - b.h) < eps;

    // Opening a crop and leaving it alone must not touch the document: a
    // double-click you back out of otherwise rewrote the element and spent an
    // undo step, which is how a careful rotation went missing.
    if (this.startCrop && same(c, this.startCrop)) { this.state.onChange_public(); return; }

    const next = same(c, img) ? this.buildBareImage(el) : this.buildCropSvg(el);
    el.parentNode!.replaceChild(next, el);

    this.state.rebuildShapesFromDOM();
    this.state.selectShape(next.id);
    this.state.saveHistory();
    this.state.onChange_public();
  }

  /** The uncropped form: the full image, with everything the old element carried
   *  (its transform above all) handed across. */
  private buildBareImage(from: SVGElement): SVGImageElement {
    const im = document.createElementNS(this.NS, 'image') as SVGImageElement;
    carryAttrs(from, im);
    const b = this.imgBox;
    im.setAttribute('x', String(b.x)); im.setAttribute('y', String(b.y));
    im.setAttribute('width', String(b.w)); im.setAttribute('height', String(b.h));
    im.setAttribute('href', this.href);
    im.setAttribute('preserveAspectRatio', this.preserve);
    return im;
  }

  /** The cropped form: a nested viewport at the crop, wrapping the full image —
   *  again carrying the old element's own attributes (transform included), so the
   *  crop lands rotated exactly where the picture was. */
  private buildCropSvg(from: SVGElement): SVGSVGElement {
    const c = this.crop, img = this.imgBox;
    const svg = document.createElementNS(this.NS, 'svg') as SVGSVGElement;
    carryAttrs(from, svg);
    svg.setAttribute('data-crop', '');
    svg.setAttribute('x', String(c.x)); svg.setAttribute('y', String(c.y));
    svg.setAttribute('width', String(c.w)); svg.setAttribute('height', String(c.h));
    svg.setAttribute('viewBox', `${c.x} ${c.y} ${c.w} ${c.h}`); // 1:1 — content at native scale
    svg.setAttribute('preserveAspectRatio', 'none');

    const im = document.createElementNS(this.NS, 'image');
    im.setAttribute('x', String(img.x)); im.setAttribute('y', String(img.y));
    im.setAttribute('width', String(img.w)); im.setAttribute('height', String(img.h));
    im.setAttribute('href', this.href);
    im.setAttribute('preserveAspectRatio', this.preserve);
    svg.appendChild(im);
    ensureCropClip(svg); // clip one level down, so a blur/shadow can't undo the crop
    return svg;
  }

  private cleanup(): void {
    this.hideStyle?.remove();
    this.hideStyle = null;
    this.overlay?.remove();
    this.overlay = null;
    this.svgCanvas.style.cursor = 'default';
    hideGestureHud();
  }

  private bail(): void {
    this.done = true;
    this.state.requestTool?.(this.state.cropReturnTool ?? 'select');
  }
}
