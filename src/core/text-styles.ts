/**
 * Reusable text styles (Phase 5). A text style is a named bundle of the Text
 * panel's own controls, applied to many text objects at once and re-applied when
 * the style is redefined ("change Heading once, every heading follows").
 *
 * STORAGE — the two persistence layers this app has, both satisfied:
 *  - The LINK from a text object to its style is a plain `data-text-style="ts-N"`
 *    attribute on the object's outer element, so it rides the history snapshot
 *    (#drawing-layer.innerHTML) and the save file for free, like any other attr.
 *  - The LIBRARY of definitions is a hidden `<metadata class="bq-text-styles">`
 *    carrier inside #drawing-layer whose `data-styles` attribute holds the JSON.
 *    It is the one home that survives BOTH undo (it's in the innerHTML snapshot)
 *    AND save/load (getDrawingLayerSVG includes it; the sanitizer keeps
 *    <metadata>), so create/rename/redefine/delete are atomic and undoable.
 *    `detectType` returns null for <metadata>, so it is never modelled as a
 *    phantom layer. The model list re-derives from the carrier after every
 *    rebuildShapesFromDOM (see AppState) — mirroring how effects/markers re-ensure.
 *
 * The apply/read helpers below are the single source of truth for HOW each prop
 * maps to the DOM; they mirror ui/properties.ts's per-property text appliers
 * exactly (attribute-based props on the <text>; case / OpenType / variable-axis
 * props as inline style on the OUTER element so they CSS-inherit into a
 * multi-stroke wrapper's render-clones).
 */

import type { ShapeData } from './types';

const NS = 'http://www.w3.org/2000/svg';

/** 6 random base36 chars — keeps style ids unique across documents. */
function randomToken(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 6);
}

/** The styleable text properties a style captures — exactly the Text panel's controls. */
export interface TextStyleProps {
  fontFamily: string;
  fontWeight: string;            // '100'..'900'
  fontStyle: string;             // 'normal' | 'italic'
  fontSize: number;
  lineHeight: number;            // multiple (data-line-height)
  letterSpacing: number;         // px, 0 = none
  textAnchor: string;            // 'start' | 'middle' | 'end'
  textTransform: string;         // 'none' | 'uppercase' | 'lowercase' | 'capitalize'
  textDecoration: string;        // '' | 'underline' | 'line-through' | 'underline line-through'
  baselineShift: number;         // px, 0 = none
  fill: string;                  // solid colour ('' = leave alone / wrapped fill lives in the stack)
  fontFeatureSettings: string;   // OpenType, e.g. '"frac" 1'
  fontVariationSettings: string; // variable axes, e.g. '"wdth" 75'
}

export interface TextStyle {
  id: string;                    // 'ts-N' — document-local
  name: string;                  // 'Heading / H1'
  /** Cloud style uuid this doc-style was instantiated from (Phase 5b); absent for pure document styles. */
  origin?: string;
  /** Cloud revision this copy was pulled at (Phase 5b) — drives "update available". */
  cloudRev?: number;
  props: TextStyleProps;
}

/** The property keys a style covers, in a stable order (for equality / diffing). */
const PROP_KEYS: (keyof TextStyleProps)[] = [
  'fontFamily', 'fontWeight', 'fontStyle', 'fontSize', 'lineHeight', 'letterSpacing',
  'textAnchor', 'textTransform', 'textDecoration', 'baselineShift', 'fill',
  'fontFeatureSettings', 'fontVariationSettings',
];

/** The <text> a style edits: the shape itself for plain text, or the hidden
 *  [data-ap-src] source <text> inside a multi-stroke (appearance) wrapper.
 *  Mirrors ui/properties.ts:textTarget (kept here so core has no ui/ dependency). */
function textElementOf(shape: ShapeData): SVGTextElement | null {
  if (shape.type === 'text') return shape.element as unknown as SVGTextElement;
  if (shape.type === 'appearance') {
    const src = shape.element.querySelector(':scope > [data-ap-src]');
    if (src && src.tagName.toLowerCase() === 'text') return src as unknown as SVGTextElement;
  }
  return null;
}

/** True when a style can be created from / applied to this shape (text-backed). */
export function isTextStyleTarget(shape: ShapeData): boolean { return !!textElementOf(shape); }

/** Re-space a multi-line text's tspans after a size/line-height change (mirrors
 *  properties.ts:relayoutTspans). Single-line text has no tspans → no-op. */
function relayoutTspans(el: SVGTextElement): void {
  const tspans = el.querySelectorAll('tspan');
  if (!tspans.length) return;
  const fs = parseFloat(el.getAttribute('font-size') ?? '24') || 24;
  const lh = parseFloat(el.getAttribute('data-line-height') ?? '') || 1.2;
  tspans.forEach((t, i) => t.setAttribute('dy', i === 0 ? '0' : String(fs * lh)));
}

function num(v: string | null, d: number): number {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : d;
}

/** Read the styleable text props off a shape (plain text or multi-stroke wrapper). */
export function readTextStyleProps(shape: ShapeData): TextStyleProps | null {
  const te = textElementOf(shape);
  if (!te) return null;
  const outer = shape.element as unknown as SVGElement;
  const lhRaw = parseFloat(te.getAttribute('data-line-height') ?? '');
  return {
    fontFamily: te.getAttribute('font-family') ?? 'Arial',
    fontWeight: te.getAttribute('font-weight') ?? '400',
    fontStyle: te.getAttribute('font-style') === 'italic' ? 'italic' : 'normal',
    fontSize: num(te.getAttribute('font-size'), 24),
    lineHeight: Number.isFinite(lhRaw) && lhRaw > 0 ? lhRaw : 1.2,
    letterSpacing: num(te.getAttribute('letter-spacing'), 0),
    textAnchor: te.getAttribute('text-anchor') || 'start',
    textTransform: outer.style.textTransform || 'none',
    textDecoration: te.getAttribute('text-decoration') || '',
    baselineShift: num(te.getAttribute('baseline-shift'), 0),
    // A wrapped text's fill lives in its appearance stack, not the source <text>;
    // only plain text carries a meaningful fill in a style.
    fill: shape.type === 'text' ? (te.getAttribute('fill') || '') : '',
    fontFeatureSettings: outer.style.fontFeatureSettings || '',
    fontVariationSettings: outer.style.fontVariationSettings || '',
  };
}

/**
 * Write style props to a shape's text element (+ its outer element for the
 * inline-style props). Pure DOM write — the caller refreshes appearance wrappers
 * (state.refreshAppearance) and records one history step. Mirrors the exact
 * per-property logic in ui/properties.ts.
 */
export function applyTextStyleProps(shape: ShapeData, props: TextStyleProps): void {
  const te = textElementOf(shape);
  if (!te) return;
  const outer = shape.element as unknown as SVGElement;

  te.setAttribute('font-family', props.fontFamily);
  te.setAttribute('font-weight', props.fontWeight);
  te.setAttribute('font-style', props.fontStyle);
  te.setAttribute('font-size', String(props.fontSize));
  te.setAttribute('data-line-height', String(props.lineHeight));
  if (props.letterSpacing) te.setAttribute('letter-spacing', String(props.letterSpacing));
  else te.removeAttribute('letter-spacing');
  if (props.textAnchor === 'start') te.removeAttribute('text-anchor');
  else te.setAttribute('text-anchor', props.textAnchor);
  if (props.textDecoration) te.setAttribute('text-decoration', props.textDecoration);
  else te.removeAttribute('text-decoration');
  if (props.baselineShift) te.setAttribute('baseline-shift', String(props.baselineShift));
  else te.removeAttribute('baseline-shift');
  if (shape.type === 'text' && props.fill) {
    te.setAttribute('fill', props.fill);
    shape.style.fill = props.fill;
  }
  // Keep the model style in sync for plain text (readback / save metadata read it).
  if (shape.type === 'text') {
    shape.style.fontFamily = props.fontFamily;
    shape.style.fontWeight = props.fontWeight;
    shape.style.fontStyle = props.fontStyle;
    shape.style.fontSize = props.fontSize;
  }

  // Inline style on the OUTER element (CSS-inherits into a wrapper's render-clones).
  if (props.textTransform && props.textTransform !== 'none') outer.style.textTransform = props.textTransform;
  else outer.style.removeProperty('text-transform');
  if (props.fontFeatureSettings) outer.style.fontFeatureSettings = props.fontFeatureSettings;
  else outer.style.removeProperty('font-feature-settings');
  if (props.fontVariationSettings) outer.style.fontVariationSettings = props.fontVariationSettings;
  else outer.style.removeProperty('font-variation-settings');

  relayoutTspans(te);
}

/** The keys where a linked shape currently diverges from its style (its overrides). */
export function overriddenKeys(current: TextStyleProps, style: TextStyleProps): (keyof TextStyleProps)[] {
  // fill '' means "unset in the style" — never counts as an override.
  return PROP_KEYS.filter((k) => k !== 'fill' || style.fill !== '').filter((k) => current[k] !== style[k]);
}

/** The document's live library of text styles, persisted in the carrier element.
 *  Pure model + persistence: history recording, propagation to linked text, and
 *  onChange are orchestrated by AppState. */
export interface TextStyleHost {
  getDrawingLayer: () => SVGGElement;
}

export class TextStyleRegistry {
  private host: TextStyleHost;
  private styles: TextStyle[] = [];
  private counter = 0;

  constructor(host: TextStyleHost) { this.host = host; }

  /** Re-read the model from the carrier (the source of truth). Called after every
   *  rebuildShapesFromDOM so undo/redo/load re-sync the library from the markup. */
  syncFromDOM(): void {
    this.styles = [];
    const carrier = this.carrier();
    if (carrier) {
      try {
        const parsed = JSON.parse(carrier.getAttribute('data-styles') || '[]');
        if (Array.isArray(parsed)) this.styles = parsed as TextStyle[];
      } catch { /* corrupt carrier — start empty rather than throw */ }
    }
    // The sequence is PERSISTED, never re-derived from the survivors: deriving it
    // reissued a deleted style's id (see core/library.ts for the same fix).
    const stored = parseInt(carrier?.getAttribute('data-seq') ?? '', 10);
    this.counter = Number.isFinite(stored) && stored > 0 ? stored : 0;
    for (const s of this.styles) {
      const m = /^ts-(\d+)/.exec(s.id); // legacy 'ts-N' and 'ts-N-token'
      if (m) this.counter = Math.max(this.counter, parseInt(m[1], 10));
    }
  }

  private carrier(): Element | null {
    return this.host.getDrawingLayer().querySelector(':scope > metadata.bq-text-styles');
  }

  private ensureCarrier(): Element {
    let c = this.carrier();
    if (!c) {
      c = document.createElementNS(NS, 'metadata');
      c.setAttribute('class', 'bq-text-styles');
      this.host.getDrawingLayer().prepend(c); // first child: stable, out of the z-order
    }
    return c;
  }

  /** Persist the model into the carrier. Removes the carrier entirely when empty
   *  so untouched documents stay pristine. Call before AppState.saveHistory. */
  private flush(): void {
    // Keep the carrier once anything has been created so data-seq survives.
    if (this.styles.length === 0 && this.counter === 0) { this.carrier()?.remove(); return; }
    const c = this.ensureCarrier();
    c.setAttribute('data-styles', JSON.stringify(this.styles));
    c.setAttribute('data-seq', String(this.counter));
  }

  list(): TextStyle[] { return this.styles; }
  get(id: string): TextStyle | undefined { return this.styles.find((s) => s.id === id); }

  create(name: string, props: TextStyleProps, extra?: Pick<TextStyle, 'origin' | 'cloudRev'>): TextStyle {
    // The random token also makes the id unique across DOCUMENTS, so text pasted
    // from another file can't be adopted by an unrelated local style of the same
    // number (pruneDanglingStyleLinks only drops links that DON'T resolve).
    const style: TextStyle = { id: `ts-${++this.counter}-${randomToken()}`, name, props, ...(extra ?? {}) };
    this.styles.push(style);
    this.flush();
    return style;
  }

  rename(id: string, name: string): void {
    const s = this.get(id);
    if (s) { s.name = name; this.flush(); }
  }

  redefine(id: string, props: TextStyleProps, extra?: Pick<TextStyle, 'origin' | 'cloudRev'>): void {
    const s = this.get(id);
    if (s) {
      s.props = props;
      if (extra?.origin !== undefined) s.origin = extra.origin;
      if (extra?.cloudRev !== undefined) s.cloudRev = extra.cloudRev;
      this.flush();
    }
  }

  /** Set/refresh a style's cloud provenance (origin uuid + rev) without touching
   *  its props — used when promoting a document style to the account library. */
  retag(id: string, extra: Pick<TextStyle, 'origin' | 'cloudRev'>): void {
    const s = this.get(id);
    if (s) {
      if (extra.origin !== undefined) s.origin = extra.origin;
      if (extra.cloudRev !== undefined) s.cloudRev = extra.cloudRev;
      this.flush();
    }
  }

  remove(id: string): void {
    const i = this.styles.findIndex((s) => s.id === id);
    if (i >= 0) { this.styles.splice(i, 1); this.flush(); }
  }
}
