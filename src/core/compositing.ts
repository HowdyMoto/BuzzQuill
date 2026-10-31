// ---------------------------------------------------------------------------
// Compositing — object-level blend mode + opacity, and the document backdrop.
//
//   • Blend mode — the `data-blend` attribute, with the inline mix-blend-mode that
//     renders it written from there (wrapper-attrs.ts setBlend). Round-trips the snapshot.
//   • Object opacity — the SVG `opacity` attribute (omitted at 1).
//   • Canvas background — paints the #pasteboard rect (chrome, not artwork);
//     the value itself lives on AppState (external save/load writes it), so the
//     host supplies it and this just applies it.
//
// Extracted from AppState as a collaborator behind a CompositingHost seam.
// ---------------------------------------------------------------------------

import type { ShapeData } from './types';
import { getBlend, setBlend } from './wrapper-attrs';

export interface CompositingHost {
  findShape(id: string): ShapeData | null;
  /** Elements of the current selection (resolved anywhere in the tree). */
  selectionElements(): SVGElement[];
  /** The drawing layer, used to reach the #pasteboard rect. */
  getDrawingLayer(): SVGGElement;
  /** The document's backdrop colour, or null for the theme default. */
  canvasBackground(): string | null;
  saveHistory(): void;
  onChange(): void;
}

export class CompositingManager {
  private host: CompositingHost;
  constructor(host: CompositingHost) { this.host = host; }

  // ---- Blend mode ----

  /** Blend mode (mix-blend-mode) of an object; 'normal' = none. */
  getBlendMode(id: string): string {
    const el = this.host.findShape(id)?.element as SVGElement | undefined;
    return (el && getBlend(el)) || 'normal';
  }

  private applyBlendTo(el: SVGElement, mode: string): void {
    setBlend(el, mode);
  }

  /**
   * Bring the drawing layer's blend modes into line after a rebuild. An object that
   * only has the inline style — an older document, imported or pasted SVG — is
   * ADOPTED (given its `data-blend`); then every `data-blend` rewrites its style,
   * so the two can't disagree. Appearance render clones (`data-ap`) blend per fill
   * layer and aren't objects, so they are left alone.
   */
  ensureBlend(): void {
    const layer = this.host.getDrawingLayer();
    for (const el of Array.from(layer.querySelectorAll<SVGElement>('[style*="mix-blend-mode"]:not([data-blend]):not([data-ap])'))) {
      const mode = el.style.mixBlendMode;
      if (mode && mode !== 'normal') el.setAttribute('data-blend', mode);
    }
    for (const el of Array.from(layer.querySelectorAll<SVGElement>('[data-blend]'))) {
      const mode = el.getAttribute('data-blend') ?? '';
      if (el.style.mixBlendMode !== mode) setBlend(el, mode);
    }
  }

  setBlendMode(id: string, mode: string): void {
    const el = this.host.findShape(id)?.element as SVGElement | undefined;
    if (!el) return;
    this.applyBlendTo(el, mode);
    this.host.saveHistory();
    this.host.onChange();
  }

  /** Apply a blend mode to every selected object in a single undo step. */
  setSelectionBlendMode(mode: string): void {
    for (const el of this.host.selectionElements()) this.applyBlendTo(el, mode);
    this.host.saveHistory();
    this.host.onChange();
  }

  // ---- Object opacity ----

  /** Object-level opacity (0..1) of a shape; 1 = fully opaque (attribute omitted). */
  getObjectOpacity(id: string): number {
    const v = this.host.findShape(id)?.element.getAttribute('opacity');
    return v == null ? 1 : (parseFloat(v) || 0);
  }

  private applyOpacityTo(el: SVGElement, value: number): void {
    const v = Math.max(0, Math.min(1, value));
    if (v >= 1) el.removeAttribute('opacity');
    else el.setAttribute('opacity', String(v));
  }

  /** Set object opacity on every selected object. `record` lets a slider apply live
   *  on `input` (record=false) and commit one history entry on `change` (record=true). */
  setSelectionOpacity(value: number, record = true): void {
    for (const el of this.host.selectionElements()) this.applyOpacityTo(el, value);
    if (record) this.host.saveHistory();
    this.host.onChange();
  }

  // ---- Canvas backdrop ----

  /** Paint the #pasteboard rect from the host's canvasBackground (inline style beats
   *  the CSS theme rule); clearing it reverts to the theme. Called on set, load, and
   *  tab switch so the backdrop always matches the active document. */
  applyCanvasBackground(): void {
    const svg = this.host.getDrawingLayer().ownerSVGElement;
    const pasteboard = svg?.querySelector('#pasteboard') as SVGRectElement | null;
    if (!pasteboard) return;
    const bg = this.host.canvasBackground();
    if (bg) pasteboard.style.fill = bg;
    else pasteboard.style.removeProperty('fill');
  }
}
