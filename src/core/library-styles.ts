/**
 * Style links — the model behind "this object uses that library style".
 *
 * Applying a library style stamps a `data-*-style` attribute on the object, so a
 * later redefine/edit can propagate to everything using it. That attribute is the
 * whole link model: it rides the innerHTML history snapshot for free, survives
 * save/load, and is carried onto appearance/width wrappers via CARRY_ATTRS.
 *
 * The policy that matters here is DETACH-BY-RECONCILIATION: a link is dropped when
 * the object stops MATCHING its definition, rather than when some setter decides
 * the user "touched something". That distinction is load-bearing — the earlier
 * touch-based version only fired from three selection setters, so editing a fill
 * through the Fills/Appearance panel (the primary editor) left objects linked but
 * visually diverged, and the next redefine destroyed the user's work. Comparing
 * against the definition means every mutation path detaches correctly, while the
 * style's own apply/propagate paths — which write exactly the style's values —
 * can never false-detach.
 *
 * Text styles are deliberately excluded from reconciliation: they track per-property
 * overrides (TextStyleRegistry.overriddenKeys) instead of detaching wholesale.
 *
 * Extracted from AppState; all document access goes through {@link StyleLinkHost}.
 */

import type { ShapeData, ObjectShadow, AppearanceLayer } from './types';
import type { AssetType, LibraryAsset, PaintStylePayload, EffectStylePayload } from './library';

/**
 * THE one place the link attributes are enumerated. Everything else — adapters,
 * panels, the invariant — derives from this, so a new linked style type can't be
 * half-registered (which is how the attr set previously drifted between AppState
 * literals and the adapters' own `linkAttr` fields).
 */
export const LINK_ATTR: Readonly<Partial<Record<AssetType, string>>> = {
  'text-style': 'data-text-style',
  'paint-style': 'data-paint-style',
  'effect-style': 'data-effect-style',
};

/** Every link attribute, for sweeps (prune / invariant / wrapper carry). */
export const LINK_ATTRS: readonly string[] = Object.values(LINK_ATTR) as string[];

/** The slice of the document the style-link model needs. */
export interface StyleLinkHost {
  getShapes(): ShapeData[];
  findShape(id: string): ShapeData | null;
  getDrawingLayer(): SVGGElement;
  /** An appearance-wrapped shape keeps its paint in a layer stack, not an attribute. */
  getAppearance(id: string): AppearanceLayer[];
  getObjectEffects(id: string): { blur: number; shadow: ObjectShadow | null };
  /** Resolve a generic library asset (paint/effect/palette) by id. */
  getAsset(id: string): LibraryAsset | undefined;
  /** Does this id name a live text style? (Text styles have their own registry.) */
  hasTextStyle(id: string): boolean;
}

export class StyleLinkManager {
  private readonly host: StyleLinkHost;

  constructor(host: StyleLinkHost) {
    this.host = host;
  }

  // ---- Queries -----------------------------------------------------------

  /** Every shape whose `attr` link equals `styleId`, anywhere in the tree. */
  shapesWith(attr: string, styleId: string): ShapeData[] {
    const out: ShapeData[] = [];
    const visit = (list: ShapeData[]): void => {
      for (const s of list) {
        if (s.element.getAttribute(attr) === styleId) out.push(s);
        if (s.children) visit(s.children);
      }
    };
    visit(this.host.getShapes());
    return out;
  }

  // ---- Mutations ---------------------------------------------------------

  /** Stamp a link on shapes (the apply path), so a later redefine reaches them. */
  link(attr: string, styleId: string, ids: string[]): void {
    for (const id of ids) this.host.findShape(id)?.element.setAttribute(attr, styleId);
  }

  /** Strip a link from every shape carrying it — used when the style is deleted, so
   *  nothing is left pointing at a dead id. Returns the affected shape ids. */
  detachAll(attr: string, styleId: string): string[] {
    const ids: string[] = [];
    for (const s of this.shapesWith(attr, styleId)) {
      s.element.removeAttribute(attr);
      ids.push(s.id);
    }
    return ids;
  }

  /** Drop links whose object no longer matches its style (see the file header).
   *  Returns the ids whose link was removed. */
  reconcile(ids: Iterable<string>): string[] {
    const detached: string[] = [];
    for (const id of ids) {
      const shape = this.host.findShape(id);
      if (!shape) continue;
      const el = shape.element;
      const paintAttr = LINK_ATTR['paint-style']!;
      const effectAttr = LINK_ATTR['effect-style']!;
      const pid = el.getAttribute(paintAttr);
      if (pid && !this.paintMatches(shape, pid)) { el.removeAttribute(paintAttr); detached.push(id); }
      const eid = el.getAttribute(effectAttr);
      if (eid && !this.effectMatches(id, eid)) { el.removeAttribute(effectAttr); detached.push(id); }
    }
    return detached;
  }

  /** Remove links naming an asset this document doesn't have — e.g. an object
   *  pasted or imported from another file. Returns how many were pruned. */
  pruneDangling(): number {
    let pruned = 0;
    for (const [attr, resolves] of this.resolvers()) {
      for (const el of this.linkedElements(attr)) {
        const id = el.getAttribute(attr);
        if (id && !resolves(id)) { el.removeAttribute(attr); pruned++; }
      }
    }
    return pruned;
  }

  /**
   * DEV-ONLY invariant: every style link in the layer must resolve to a live asset
   * of the matching type. Catches the whole class of link bugs — a deleted style
   * leaving orphans, an id recycled onto the wrong asset, a cross-document paste
   * importing a foreign link — the instant it happens. Wired into onStateChange
   * next to devCheckFramesInvariant.
   */
  devCheckInvariant(): void {
    for (const [attr, resolves] of this.resolvers()) {
      for (const el of this.linkedElements(attr)) {
        const id = el.getAttribute(attr) ?? '';
        if (!resolves(id)) {
          console.error(`[style-links] ${el.id || '(no id)'} has ${attr}="${id}" but no such asset exists`);
        }
      }
    }
  }

  // ---- Internals ---------------------------------------------------------

  private linkedElements(attr: string): SVGElement[] {
    return Array.from(this.host.getDrawingLayer().querySelectorAll<SVGElement>(`[${attr}]`));
  }

  /** attr → "does this id name a live asset of the matching type?" */
  private resolvers(): Array<[string, (id: string) => boolean]> {
    const assetOfType = (type: AssetType) => (id: string): boolean =>
      this.host.getAsset(id)?.type === type;
    return [
      [LINK_ATTR['text-style']!, (id) => this.host.hasTextStyle(id)],
      [LINK_ATTR['paint-style']!, assetOfType('paint-style')],
      [LINK_ATTR['effect-style']!, assetOfType('effect-style')],
    ];
  }

  /** The shape's current fill paint (appearance-wrapped shapes keep it in a layer). */
  private currentFillPaint(shape: ShapeData): string {
    if (shape.type === 'appearance') {
      const f = this.host.getAppearance(shape.id).find((l) => l.t === 'fill' && l.visible !== false);
      return f?.paint ?? 'none';
    }
    return shape.element.getAttribute('fill') ?? shape.style.fill ?? 'none';
  }

  private paintMatches(shape: ShapeData, styleId: string): boolean {
    const p = this.host.getAsset(styleId)?.payload as PaintStylePayload | undefined;
    if (!p) return false; // style is gone
    const fill = this.currentFillPaint(shape);
    if (p.kind !== 'solid') {
      // A gradient/pattern style is replanted under a FRESH def id on every apply,
      // so the reference never string-matches. Compare the referenced def to the
      // saved markup with the id normalized away — otherwise swapping in a totally
      // different gradient would count as "still matching" and never detach.
      const id = /^url\(#(.+?)\)$/.exec(fill)?.[1];
      if (!id) return false;
      const def = document.getElementById(id);
      if (!def || !p.defMarkup) return !!def;
      const norm = (m: string): string => m.replace(/\sid="[^"]*"/, '');
      return norm(def.outerHTML) === norm(p.defMarkup);
    }
    return fill.toLowerCase() === p.value.toLowerCase();
  }

  private effectMatches(shapeId: string, styleId: string): boolean {
    const e = this.host.getAsset(styleId)?.payload as EffectStylePayload | undefined;
    if (!e) return false;
    const fx = this.host.getObjectEffects(shapeId);
    if ((fx.blur || 0) !== (e.blur || 0)) return false;
    const a = fx.shadow, b = e.shadow;
    if (!a !== !b) return false;
    if (!a || !b) return true;
    return a.dx === b.dx && a.dy === b.dy && a.blur === b.blur
      && a.color.toLowerCase() === b.color.toLowerCase() && a.opacity === b.opacity;
  }
}
