/**
 * Asset-type adapters — the extension seam that plugs each asset type into the
 * unified Library panel. The panel is type-agnostic: it iterates ASSET_ADAPTERS
 * and calls these methods. Adding a new asset type is
 * one new adapter + one registerAdapter() call — no panel changes.
 *
 * Each adapter bridges the uniform LibraryAsset envelope to whatever backing store
 * that type already uses at document scope (text styles → TextStyleRegistry;
 * palettes/effects/paints → the generic LibraryRegistry; components → SymbolRegistry).
 */

import type { AppState } from '../core/state';
import type { AssetType, LibraryAsset, PaintStylePayload, EffectStylePayload, PalettePayload } from '../core/library';
import type { TextStyleProps } from '../core/text-styles';
import { hasFill } from '../core/shape-props';
import { LINK_ATTR } from '../core/library-styles';
import { sanitizeSvgElement } from '../core/svg-sanitize';
import { addSwatches } from './swatches';
import type { EditField, EditValues } from './dialogs';

// The link attributes come from ONE table (core/library-styles.ts); these used to be
// re-typed as literals in a dozen places, which is how the declared `linkAttr` and
// the constants actually used drifted apart.
const TEXT_LINK = LINK_ATTR['text-style']!;
const PAINT_LINK = LINK_ATTR['paint-style']!;
const EFFECT_LINK = LINK_ATTR['effect-style']!;

const SVG_NS = 'http://www.w3.org/2000/svg';
let previewSeq = 0; // unique ids for gradient/pattern preview swatches

export interface CaptureResult { name: string; payload: unknown; }

export interface AssetAdapter {
  type: AssetType;
  label: string;        // singular, e.g. 'Text style'
  labelPlural: string;  // e.g. 'Text styles'

  /** Can the current selection produce an asset of this type? A default name +
   *  payload to seed the save dialog, or null when the selection can't. */
  capture(state: AppState): CaptureResult | null;

  /** This document's assets of this type, as uniform envelopes (id = the backing
   *  store's native id). */
  listDocument(state: AppState): LibraryAsset[];

  /** Create a document asset from the current selection (linked where that makes
   *  sense). Returns the new doc-asset id, or null. One undo step. */
  createFromSelection(state: AppState, name: string): string | null;

  /** Apply / insert a document asset (by doc id) onto the selection or canvas.
   *  Returns how many objects were affected. */
  applyDocument(state: AppState, docId: string): number;

  renameDocument(state: AppState, docId: string, name: string): void;
  removeDocument(state: AppState, docId: string): void;

  /** A compact preview node for a library row, built from a name + payload. */
  renderPreview(asset: { name: string; payload: unknown }): HTMLElement;

  /** The doc-asset id currently linked to the selection (drives the active check). */
  linkedDocId?(state: AppState): string | null;

  /** Override the "Applied to N objects" toast for types that don't paint objects
   *  (e.g. a palette loads swatches). `n` is applyDocument's return. */
  successMessage?(n: number): string;

  /** Does applyDocument act ON the selection? False for types whose apply is
   *  selection-independent — a palette loads swatches, a component places an
   *  instance — which otherwise had their only action disabled whenever nothing
   *  happened to be selected. Defaults to true. */
  needsSelection?: boolean;

  /** Verb for the apply control, when "Apply to selection" would be wrong. */
  applyLabel?: string;

  /** A short human summary of what the style CONTAINS, for the row's meta line
   *  ("Inter 24 · Bold", "#3399ff", "Blur 3 · Shadow"). Falls back to `label`. */
  describe?(payload: unknown): string;

  /** The `data-*` attribute this type stamps on objects it's applied to, linking
   *  them to the style. Present ⇒ the type supports "select objects using this
   *  style" and redefine-propagation. */
  linkAttr?: string;

  /** Redefine the style from the current selection: capture new values, persist
   *  them, and re-apply to EVERY linked object. Returns how many objects updated
   *  (0 if nothing to capture). Present ⇒ the row offers "Update style from selection". */
  redefineFromSelection?(state: AppState, docId: string): number;

  /** The style's contents as editable fields. Present ⇒ the row offers "Edit style…". */
  editFields?(payload: unknown): EditField[];

  /** Persist edited field values into the style and re-apply to every linked
   *  object. Returns how many objects updated. `record: false` skips the history
   *  entry — live panel editing mutates freely, then commits one entry on release. */
  applyEdits?(state: AppState, docId: string, values: EditValues, record?: boolean): number;
}

const REGISTRY: AssetAdapter[] = [];

export function registerAdapter(a: AssetAdapter): void {
  if (!REGISTRY.some((x) => x.type === a.type)) REGISTRY.push(a);
}
export function assetAdapters(): AssetAdapter[] { return REGISTRY.slice(); }
export function adapterFor(type: AssetType): AssetAdapter | undefined {
  return REGISTRY.find((a) => a.type === type);
}

// ---------------------------------------------------------------------------
// Text-style adapter (Phase 1) — backed by TextStyleRegistry via AppState.
// ---------------------------------------------------------------------------

function selectedTextIds(state: AppState): string[] {
  return state.getSelectedShapes().filter((s) => state.canStyleText(s)).map((s) => s.id);
}

const textStyleAdapter: AssetAdapter = {
  type: 'text-style',
  label: 'Text style',
  labelPlural: 'Text styles',
  linkAttr: TEXT_LINK,

  capture(state) {
    const first = state.getSelectedShapes().find((s) => state.canStyleText(s));
    if (!first) return null;
    const props = state.readTextProps(first);
    if (!props) return null;
    return { name: `Text ${state.textStyles.length + 1}`, payload: props };
  },

  listDocument(state) {
    return state.textStyles.map((s) => ({
      id: s.id, type: 'text-style', name: s.name, payload: s.props,
      origin: s.origin, rev: s.cloudRev,
    }));
  },

  createFromSelection(state, name) {
    const ids = selectedTextIds(state);
    if (!ids.length) return null;
    return state.createTextStyleFromShapes(name, ids)?.id ?? null;
  },

  applyDocument(state, docId) {
    const ids = selectedTextIds(state);
    if (!ids.length) return 0;
    return state.applyTextStyle(docId, ids).length; // stamps data-text-style (links)
  },

  redefineFromSelection(state, docId) {
    const first = state.getSelectedShapes().find((s) => state.canStyleText(s));
    if (!first) return 0;
    const props = state.readTextProps(first);
    if (!props) return 0;
    return state.redefineTextStyle(docId, props).length; // updates def + re-applies to linked
  },

  renameDocument(state, docId, name) { state.renameTextStyle(docId, name); },
  removeDocument(state, docId) { state.removeTextStyle(docId); },

  editFields(payload) {
    const p = payload as TextStyleProps;
    return [
      { key: 'fontFamily', label: 'Font', type: 'text', value: p.fontFamily ?? '' },
      { key: 'fontSize', label: 'Size', type: 'number', value: p.fontSize ?? 16, min: 1, step: 1 },
      { key: 'fontWeight', label: 'Weight', type: 'select', value: String(p.fontWeight ?? 'normal'),
        options: ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'] },
      { key: 'italic', label: 'Italic', type: 'checkbox', value: p.fontStyle === 'italic' },
    ];
  },

  applyEdits(state, docId, v, record = true) {
    const cur = state.textStyles.find((s) => s.id === docId);
    if (!cur) return 0;
    const props: TextStyleProps = {
      ...cur.props,
      fontFamily: String(v.fontFamily),
      fontSize: Number(v.fontSize) || cur.props.fontSize,
      fontWeight: String(v.fontWeight),
      fontStyle: v.italic ? 'italic' : 'normal',
    };
    return state.redefineTextStyle(docId, props, record).length; // persists + re-applies to linked
  },

  describe(payload) {
    const p = payload as TextStyleProps;
    const bits: string[] = [p.fontFamily || 'sans-serif', `${Math.round(p.fontSize || 0)}`];
    const w = String(p.fontWeight ?? '');
    if (w && w !== 'normal' && w !== '400') bits.push(w);
    if (p.fontStyle === 'italic') bits.push('italic');
    return bits.join(' · ');
  },

  renderPreview(asset) {
    const p = asset.payload as TextStyleProps;
    const el = document.createElement('span');
    el.className = 'lib-preview lib-preview-text';
    el.textContent = 'Ag';
    // Set the face via the CSSOM (never an innerHTML style string): these props can
    // come from a shared/public document's markup, and the setters drop bad values.
    el.style.fontFamily = p.fontFamily || 'sans-serif';
    el.style.fontWeight = String(p.fontWeight || 400);
    el.style.fontStyle = p.fontStyle === 'italic' ? 'italic' : 'normal';
    return el;
  },

  linkedDocId(state) {
    const first = state.getSelectedShapes().find((s) => state.canStyleText(s));
    return (first && state.linkedStyleOf(first)?.id) ?? null;
  },
};

// ---------------------------------------------------------------------------
// Paint-style adapter — a reusable fill (solid colour, gradient, or pattern),
// backed by the generic LibraryRegistry.
// Solid paints store just the colour; gradient/pattern paints ALSO capture the
// def's markup so the paint round-trips into ANY document — on apply the def is
// replanted under a fresh id (state.adoptPaintDef) so it never collides with the
// target document's own defs.
// ---------------------------------------------------------------------------

/** The selection's fill as a savable paint: a solid colour, or a gradient/pattern
 *  (with its def markup captured). null for no selection, an unfillable shape,
 *  no-fill, or a `url(...)` whose def can't be found. */
function selectedFillPaint(state: AppState): PaintStylePayload | null {
  const shape = state.getSelectedShapes().find((s) => hasFill(s.type));
  if (!shape) return null;
  const fill = shape.style.fill;
  if (!fill || fill === 'none') return null;
  const idm = /^url\(#(.+?)\)$/.exec(fill);
  if (!idm) return { kind: 'solid', value: fill };
  const def = document.getElementById(idm[1]);
  if (!def) return null; // dangling paint reference — nothing to save
  const kind: PaintStylePayload['kind'] = def.tagName.toLowerCase() === 'pattern' ? 'pattern' : 'gradient';
  return { kind, value: fill, defMarkup: def.outerHTML };
}

const paintStyleAdapter: AssetAdapter = {
  type: 'paint-style',
  label: 'Colour style',
  labelPlural: 'Colour styles',
  linkAttr: PAINT_LINK,

  capture(state) {
    const payload = selectedFillPaint(state);
    if (!payload) return null;
    const label = payload.kind === 'solid' ? 'Colour' : payload.kind === 'gradient' ? 'Gradient' : 'Pattern';
    return { name: `${label} ${state.listLibraryAssets('paint-style').length + 1}`, payload };
  },

  listDocument(state) {
    return state.listLibraryAssets('paint-style'); // already LibraryAsset envelopes (origin/rev carried)
  },

  createFromSelection(state, name) {
    const cap = this.capture(state);
    if (!cap) return null;
    return state.createLibraryAsset('paint-style', name, cap.payload).id;
  },

  applyDocument(state, docId) {
    const p = state.getLibraryAsset(docId)?.payload as PaintStylePayload | undefined;
    if (!p) return 0;
    const targets = state.selectedShapeIds.filter((id) => {
      const s = state.findShapeById(id);
      return !!s && hasFill(s.type);
    });
    if (!targets.length) return 0;
    let paint = p.value;
    if (p.kind !== 'solid') {
      // One canonical def per style per document: every object using this style
      // shares it, so editing the style updates them all live, and re-applying
      // doesn't mint a new def each time. Adopted (fresh id) on first use here, so
      // a style from another document still can't collide.
      if (!p.defMarkup) return 0;
      const adopted = state.canonicalPaintDef(docId, p.kind, p.defMarkup);
      if (!adopted) return 0;
      paint = adopted;
    }
    // Paint FIRST (setSelectionFill detaches any previous style link as a manual
    // edit), then stamp this style's link and fold it into the same undo entry.
    state.setSelectionFill(paint); // handles plain + appearance-wrapped
    state.linkShapesToStyle(PAINT_LINK, docId, targets);
    state.amendHistory();
    return targets.length;
  },

  redefineFromSelection(state, docId) {
    const payload = selectedFillPaint(state);
    if (!payload) return 0;
    state.updateLibraryAsset(docId, payload, undefined, false);
    // Re-link what we redefined FROM: editing it manually had detached it, and
    // "make the style look like this" implies the object still uses the style.
    const fillable = state.selectedShapeIds.filter((id) => {
      const s = state.findShapeById(id);
      return !!s && hasFill(s.type);
    });
    state.linkShapesToStyle(PAINT_LINK, docId, fillable);
    const linked = state.shapesWithStyleLink(PAINT_LINK, docId).map((s) => s.id);
    // Record even with nothing linked: the definition DID change, and returning
    // early left that mutation outside history (and the toast claiming nothing happened).
    if (!linked.length) { state.saveHistory(); return 0; }
    let paint = payload.value;
    if (payload.kind !== 'solid' && payload.defMarkup) {
      // The definition changed wholesale — drop the old canonical def and re-adopt.
      state.clearStyleDef(docId);
      const adopted = state.canonicalPaintDef(docId, payload.kind, payload.defMarkup);
      if (adopted) paint = adopted;
    }
    state.applyFillToShapes(linked, paint, false);
    state.saveHistory(); // one undo step for the whole redefine
    return linked.length;
  },

  renameDocument(state, docId, name) { state.renameLibraryAsset(docId, name); },
  removeDocument(state, docId) { state.removeLibraryAsset(docId); },

  /** Highlights the row for the style the primary selection is using. */
  linkedDocId(state) {
    return state.getSelectedShape()?.element.getAttribute(PAINT_LINK) ?? null;
  },

  editFields(payload) {
    const p = payload as PaintStylePayload;
    // Only solid paints are editable as a field; gradients/patterns are edited on
    // the canvas (fills panel) and captured back with "Update style from selection".
    if (p.kind !== 'solid') return [];
    // Always a colour field: the panel uses the app's own picker, which handles
    // rgb()/named values (a native <input type=color> only accepts #rrggbb, which
    // is why this used to degrade to a raw text box).
    return [{ key: 'value', label: 'Colour', type: 'color', value: p.value }];
  },

  applyEdits(state, docId, v, record = true) {
    const cur = state.getLibraryAsset(docId)?.payload as PaintStylePayload | undefined;
    if (!cur || cur.kind !== 'solid') return 0;
    const next: PaintStylePayload = { kind: 'solid', value: String(v.value) };
    // Mutate silently and record at most ONE entry — updateLibraryAsset and the
    // shape apply each save history on their own, which would cost two undos.
    state.updateLibraryAsset(docId, next, undefined, false);
    const linked = state.shapesWithStyleLink(PAINT_LINK, docId).map((s) => s.id);
    if (linked.length) state.applyFillToShapes(linked, next.value, false);
    if (record) state.saveHistory();
    return linked.length;
  },

  describe(payload) {
    const p = payload as PaintStylePayload;
    if (p.kind === 'solid') return p.value;
    if (p.kind === 'gradient') {
      const stops = (p.defMarkup?.match(/<stop\b/g) || []).length;
      return stops ? `Gradient · ${stops} stops` : 'Gradient';
    }
    return 'Pattern';
  },

  renderPreview(asset) {
    const p = asset.payload as PaintStylePayload;
    const el = document.createElement('span');
    el.className = 'lib-preview lib-preview-paint';
    if (p.kind === 'solid') {
      // CSSOM (not innerHTML) so a hostile value from a shared doc is dropped by
      // the setter rather than injected.
      el.style.background = p.value;
      return el;
    }
    // Gradient/pattern: render the REAL def in a tiny inline SVG swatch, under a
    // preview-local id so it can't clash with the live document's defs.
    if (p.defMarkup) {
      const src = new DOMParser().parseFromString(
        `<svg xmlns="${SVG_NS}">${p.defMarkup}</svg>`, 'image/svg+xml');
      const def = src.documentElement.querySelector('linearGradient, radialGradient, pattern');
      if (def) {
        const pid = `libprev-${++previewSeq}`;
        def.setAttribute('id', pid);
        const isPattern = p.kind === 'pattern';
        // Size the viewport to the TILE. A fixed box showed an arbitrary corner crop
        // of a userSpaceOnUse tile, which for most artwork is empty — the preview
        // just looked like a dark rectangle. Gradients are 0..1 objectBoundingBox.
        const vw = isPattern ? Math.max(1, parseFloat(def.getAttribute('width') ?? '24') || 24) : 1;
        const vh = isPattern ? Math.max(1, parseFloat(def.getAttribute('height') ?? '24') || 24) : 1;
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
        svg.setAttribute('preserveAspectRatio', isPattern ? 'xMidYMid slice' : 'none');
        const defs = document.createElementNS(SVG_NS, 'defs');
        const node = document.importNode(def, true) as SVGElement;
        if (!sanitizeSvgElement(node)) return el;
        defs.appendChild(node);
        svg.appendChild(defs);
        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('width', String(vw));
        rect.setAttribute('height', String(vh));
        rect.setAttribute('fill', `url(#${pid})`);
        svg.appendChild(rect);
        el.appendChild(svg);
      }
    }
    return el;
  },
};

// ---------------------------------------------------------------------------
// Effect-style adapter — a reusable blur + drop-shadow, backed by the generic
// LibraryRegistry. Captured from an object's
// effects and applied to the selection. Effects are object-level, so ANY shape
// can carry and receive one.
// ---------------------------------------------------------------------------

/** hex (#rrggbb) + alpha → rgba() for a CSS filter; passes non-hex through. */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const effectStyleAdapter: AssetAdapter = {
  type: 'effect-style',
  label: 'Effect style',
  labelPlural: 'Effect styles',
  linkAttr: EFFECT_LINK,

  capture(state) {
    const shape = state.getSelectedShape(); // the primary object the Effects panel reflects
    if (!shape) return null;
    const fx = state.getObjectEffects(shape.id);
    if (!fx.blur && !fx.shadow) return null; // no effect worth saving
    const payload: EffectStylePayload = {};
    if (fx.blur) payload.blur = fx.blur;
    if (fx.shadow) payload.shadow = fx.shadow;
    return { name: `Effect ${state.listLibraryAssets('effect-style').length + 1}`, payload };
  },

  listDocument(state) {
    return state.listLibraryAssets('effect-style');
  },

  createFromSelection(state, name) {
    const cap = this.capture(state);
    if (!cap) return null;
    return state.createLibraryAsset('effect-style', name, cap.payload).id;
  },

  applyDocument(state, docId) {
    const p = state.getLibraryAsset(docId)?.payload as EffectStylePayload | undefined;
    if (!p) return 0;
    if (!state.selectedShapeIds.length) return 0;
    // Blur first without recording, shadow last WITH recording → one undo step
    // for the whole effect (both are set to the style's values, clearing either
    // when the style doesn't define it). The setters detach any previous link, so
    // stamp this style's link after them and fold it into the same undo entry.
    state.setSelectionBlur(p.blur ?? 0, false);
    state.setSelectionShadow(p.shadow ?? null, true);
    // Read the targets AFTER the setters: an effect on a mask lands on a group
    // around it, which takes over the selection — the link belongs there too.
    const targets = state.selectedShapeIds.slice();
    state.linkShapesToStyle(EFFECT_LINK, docId, targets);
    state.amendHistory();
    return targets.length;
  },

  redefineFromSelection(state, docId) {
    const first = state.getSelectedShape();
    if (!first) return 0;
    const fx = state.getObjectEffects(first.id);
    const payload: EffectStylePayload = {};
    if (fx.blur) payload.blur = fx.blur;
    if (fx.shadow) payload.shadow = fx.shadow;
    state.updateLibraryAsset(docId, payload, undefined, false);
    // Re-link what we redefined FROM (the manual edit had detached it).
    state.linkShapesToStyle(EFFECT_LINK, docId, state.selectedShapeIds.slice());
    const linked = state.shapesWithStyleLink(EFFECT_LINK, docId).map((s) => s.id);
    if (!linked.length) { state.saveHistory(); return 0; }
    state.applyEffectToShapes(linked, payload.blur ?? 0, payload.shadow ?? null, false);
    state.saveHistory(); // one undo step for the whole redefine
    return linked.length;
  },

  renameDocument(state, docId, name) { state.renameLibraryAsset(docId, name); },
  removeDocument(state, docId) { state.removeLibraryAsset(docId); },

  linkedDocId(state) {
    return state.getSelectedShape()?.element.getAttribute(EFFECT_LINK) ?? null;
  },

  editFields(payload) {
    const p = payload as EffectStylePayload;
    const sh = p.shadow;
    const onShadow = { key: 'shadow', equals: true } as const;
    return [
      { key: 'blur', label: 'Blur', type: 'number', value: p.blur ?? 0, min: 0, step: 0.5 },
      { key: 'shadow', label: 'Drop shadow', type: 'checkbox', value: !!sh },
      // The shadow parameters are dead controls while the shadow is off, so they
      // only show when it's ticked (they used to sit there, editable, doing nothing).
      { key: 'dx', label: 'X', type: 'number', value: sh?.dx ?? 4, step: 1, showWhen: onShadow },
      { key: 'dy', label: 'Y', type: 'number', value: sh?.dy ?? 4, step: 1, showWhen: onShadow },
      { key: 'sblur', label: 'Shadow blur', type: 'number', value: sh?.blur ?? 3, min: 0, step: 0.5, showWhen: onShadow },
      { key: 'scolor', label: 'Shadow colour', type: 'color', value: sh?.color ?? '#000000', showWhen: onShadow },
      { key: 'sopacity', label: 'Shadow opacity', type: 'number', value: sh?.opacity ?? 0.5, min: 0, max: 1, step: 0.05, showWhen: onShadow },
    ];
  },

  applyEdits(state, docId, v, record = true) {
    const payload: EffectStylePayload = {};
    const blur = Math.max(0, Number(v.blur) || 0);
    if (blur > 0) payload.blur = blur;
    if (v.shadow) {
      payload.shadow = {
        dx: Number(v.dx) || 0,
        dy: Number(v.dy) || 0,
        blur: Math.max(0, Number(v.sblur) || 0),
        color: String(v.scolor),
        opacity: Math.min(1, Math.max(0, Number(v.sopacity))),
      };
    }
    state.updateLibraryAsset(docId, payload, undefined, false); // one entry, see paint
    const linked = state.shapesWithStyleLink(EFFECT_LINK, docId).map((s) => s.id);
    if (linked.length) state.applyEffectToShapes(linked, payload.blur ?? 0, payload.shadow ?? null, false);
    if (record) state.saveHistory();
    return linked.length;
  },

  describe(payload) {
    const p = payload as EffectStylePayload;
    const bits: string[] = [];
    if (p.blur) bits.push(`Blur ${p.blur}`);
    if (p.shadow) bits.push('Shadow');
    return bits.join(' · ') || 'No effect';
  },

  renderPreview(asset) {
    const p = asset.payload as EffectStylePayload;
    const el = document.createElement('span');
    el.className = 'lib-preview lib-preview-effect';
    const chip = document.createElement('span');
    chip.className = 'lib-preview-effect-chip';
    // Show the actual effect on a chip, offsets/blur clamped so it stays in the tile.
    const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
    const filters: string[] = [];
    if (p.shadow) {
      filters.push(`drop-shadow(${clamp(p.shadow.dx, -3, 3)}px ${clamp(p.shadow.dy, -3, 3)}px ` +
        `${clamp(Math.max(0, p.shadow.blur), 0, 3)}px ${hexToRgba(p.shadow.color, p.shadow.opacity)})`);
    }
    if (p.blur) filters.push(`blur(${clamp(p.blur, 0, 3)}px)`);
    if (filters.length) chip.style.filter = filters.join(' ');
    el.appendChild(chip);
    return el;
  },
};

// ---------------------------------------------------------------------------
// Palette adapter — a named set of colours, backed by the generic LibraryRegistry
// Unlike the other types it doesn't paint the
// selection: capturing collects the distinct colours USED by the selected shapes,
// and applying LOADS them into the swatches panel (a "swatch set you load").
// ---------------------------------------------------------------------------

/**
 * Every distinct solid colour used by the selection, in first-seen order.
 *
 * Reads the APPEARANCE STACK, not just shape.style.fill/stroke: those are the
 * flattened top paint, so an object with two strokes and a fill contributed only
 * two of its three colours to a palette. Anything with a multi-paint stack keeps
 * its real paints in the layer list.
 */
function selectionColors(state: AppState): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (c: string | undefined): void => {
    if (!c || c === 'none' || c.startsWith('url(')) return;   // skip gradients/patterns
    const k = c.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(c); }
  };
  for (const s of state.getSelectedShapes()) {
    const layers = s.type === 'appearance' ? state.getAppearance(s.id) : [];
    if (layers.length) {
      for (const l of layers) { if (l.visible !== false) add(l.paint); }
    } else {
      add(s.style.fill);
      add(s.style.stroke);
    }
  }
  return out;
}

const paletteAdapter: AssetAdapter = {
  type: 'palette',
  label: 'Palette',
  labelPlural: 'Palettes',
  needsSelection: false,          // loads swatches; nothing needs to be selected
  applyLabel: 'Load into swatches',

  capture(state) {
    const colors = selectionColors(state);
    if (!colors.length) return null;
    const payload: PalettePayload = { colors };
    return { name: `Palette ${state.listLibraryAssets('palette').length + 1}`, payload };
  },

  listDocument(state) {
    return state.listLibraryAssets('palette');
  },

  createFromSelection(state, name) {
    const cap = this.capture(state);
    if (!cap) return null;
    return state.createLibraryAsset('palette', name, cap.payload).id;
  },

  applyDocument(state, docId) {
    const p = state.getLibraryAsset(docId)?.payload as PalettePayload | undefined;
    if (!p || !p.colors.length) return 0;
    // Report what was actually ADDED: addSwatches dedupes, so claiming the palette's
    // full size told you "Loaded 4 colours" when it had added none.
    const added = addSwatches(p.colors);
    return added || p.colors.length;
  },

  successMessage(n) { return `Loaded ${n} colour${n === 1 ? '' : 's'} into swatches`; },

  renameDocument(state, docId, name) { state.renameLibraryAsset(docId, name); },
  removeDocument(state, docId) { state.removeLibraryAsset(docId); },

  // Declaring editFields marks the type as editable in the Style panel; a palette
  // has no flat fields — it mounts a swatch-grid editor there instead.
  editFields() { return []; },

  describe(payload) {
    const n = (payload as PalettePayload).colors?.length ?? 0;
    return `${n} colour${n === 1 ? '' : 's'}`;
  },

  renderPreview(asset) {
    const p = asset.payload as PalettePayload;
    const el = document.createElement('span');
    // The panel adds .lib-preview (a centred box); fill it with a flex swatch row
    // using the panel's own .lib-preview-swatches/.lib-preview-swatch classes.
    const row = document.createElement('span');
    row.className = 'lib-preview-swatches';
    for (const c of (p.colors || []).slice(0, 8)) {
      const chip = document.createElement('span');
      chip.className = 'lib-preview-swatch';
      chip.style.background = c;
      row.appendChild(chip);
    }
    el.appendChild(row);
    return el;
  },
};

// ---------------------------------------------------------------------------
// Component adapter — a reusable object (a `<symbol>`), backed by SymbolRegistry
// (NOT the generic LibraryRegistry). Creating turns the selected object into a
// symbol + instance; applying places another instance.
// ---------------------------------------------------------------------------

interface ComponentPayload { markup: string }

const componentAdapter: AssetAdapter = {
  type: 'component',
  label: 'Component',
  labelPlural: 'Components',
  needsSelection: false,          // places an instance; nothing needs to be selected
  applyLabel: 'Place instance',

  capture(state) {
    const shapes = state.getSelectedShapes();
    if (shapes.length !== 1) return null; // one object → one component (group first for many)
    const s = shapes[0];
    if (s.type === 'frame' || s.type === 'use') return null; // not a frame or an existing instance
    return { name: s.name || 'Component', payload: {} };
  },

  listDocument(state) {
    return state.symbols.map((sym) => ({
      id: sym.id,
      type: 'component' as const,
      name: sym.name,
      payload: { markup: sym.element.outerHTML } as ComponentPayload,
      origin: sym.element.getAttribute('data-origin') || undefined,
      rev: sym.element.hasAttribute('data-rev') ? Number(sym.element.getAttribute('data-rev')) : undefined,
    }));
  },

  createFromSelection(state, name) {
    const shapes = state.getSelectedShapes();
    if (shapes.length !== 1) return null;
    const sym = state.createSymbolFromShape(shapes[0].id, name);
    return sym?.id ?? null;
  },

  applyDocument(state, docId) {
    if (!state.symbols.some((s) => s.id === docId)) return 0;
    state.placeSymbolInstance(docId); // places one instance at the active frame, selects it
    return 1;
  },

  successMessage(n) { return `Placed ${n} instance${n === 1 ? '' : 's'}`; },

  renameDocument(state, docId, name) { state.renameSymbol(docId, name); },
  removeDocument(state, docId) { state.removeSymbol(docId); },

  describe(payload) {
    const vb = (payload as ComponentPayload).markup?.match(/viewBox="([^"]+)"/)?.[1]?.split(/\s+/).map(Number);
    if (vb && vb.length === 4) return `${Math.round(vb[2])} × ${Math.round(vb[3])}`;
    return 'Component';
  },

  renderPreview(asset) {
    const p = asset.payload as ComponentPayload;
    const el = document.createElement('span');
    el.className = 'lib-preview lib-preview-component';
    if (p.markup) {
      const src = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}">${p.markup}</svg>`, 'image/svg+xml');
      const sym = src.documentElement.querySelector('symbol');
      if (sym) {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', sym.getAttribute('viewBox') || '0 0 100 100');
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet'); // contain, centred
        const g = document.createElementNS(SVG_NS, 'g');
        const imported = document.importNode(sym, true) as SVGElement;
        if (!sanitizeSvgElement(imported)) return el;
        g.append(...Array.from(imported.childNodes)); // <symbol> can't render directly; move its content into a <g>
        svg.appendChild(g);
        el.appendChild(svg);
      }
    }
    return el;
  },

  linkedDocId(state) {
    const s = state.getSelectedShape();
    return s?.type === 'use' && s.symbolId ? s.symbolId : null;
  },
};

// ---------------------------------------------------------------------------
// Pattern adapter — a tiling fill made from your own artwork (or an image).
// Its own type, not a "colour style": a user who just drew a tile looks for
// "Patterns", and a repeat is a different kind of thing from a flat colour even
// though both are paints under the hood. Payload reuses PaintStylePayload so the
// apply path (canonical def + fill) is shared with paint styles.
// ---------------------------------------------------------------------------

const patternAdapter: AssetAdapter = {
  type: 'pattern',
  label: 'Pattern',
  labelPlural: 'Patterns',

  capture(state) {
    const ids = state.selectedShapeIds.filter((id) => state.findShapeById(id)?.type !== 'frame');
    if (!ids.length) return null;
    return { name: `Pattern ${state.listLibraryAssets('pattern').length + 1}`, payload: {} };
  },

  listDocument(state) {
    return state.listLibraryAssets('pattern');
  },

  createFromSelection(state, name) {
    const ids = state.selectedShapeIds.filter((id) => state.findShapeById(id)?.type !== 'frame');
    if (!ids.length) return null;
    const pat = state.createPatternFromShapes(ids);
    if (!pat) return null;
    const el = document.getElementById(pat.id);
    return state.createLibraryAsset('pattern', name, {
      kind: 'pattern', value: `url(#${pat.id})`, defMarkup: el?.outerHTML, defId: pat.id,
    } as PaintStylePayload).id;
  },

  applyDocument(state, docId) {
    const p = state.getLibraryAsset(docId)?.payload as PaintStylePayload | undefined;
    if (!p?.defMarkup) return 0;
    const targets = state.selectedShapeIds.filter((id) => {
      const sh = state.findShapeById(id);
      return !!sh && hasFill(sh.type);
    });
    if (!targets.length) return 0;
    const paint = state.canonicalPaintDef(docId, 'pattern', p.defMarkup);
    if (!paint) return 0;
    state.setSelectionFill(paint);
    return targets.length;
  },

  renameDocument(state, docId, name) { state.renameLibraryAsset(docId, name); },
  removeDocument(state, docId) { state.removeLibraryAsset(docId); },

  describe(payload) {
    const p = payload as PaintStylePayload;
    const m = /<pattern[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"/.exec(p.defMarkup ?? '');
    const size = m ? `${Math.round(+m[1])} × ${Math.round(+m[2])}` : '';
    const linked = /data-pat-source="/.test(p.defMarkup ?? '');
    const kind = /data-pat-type="object"/.test(p.defMarkup ?? '') ? 'Artwork'
      : /data-pat-type="image"/.test(p.defMarkup ?? '') ? 'Image' : 'Preset';
    return [kind, size, linked ? 'linked' : ''].filter(Boolean).join(' · ');
  },

  // A pattern is edited through its own tiled editor in the Style panel.
  editFields() { return []; },

  renderPreview(asset) {
    const p = asset.payload as PaintStylePayload;
    const el = document.createElement('span');
    el.className = 'lib-preview lib-preview-paint';
    if (!p.defMarkup) return el;
    const src = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}">${p.defMarkup}</svg>`, 'image/svg+xml');
    const def = src.documentElement.querySelector('pattern');
    if (!def) return el;
    const pid = `libprev-${++previewSeq}`;
    def.setAttribute('id', pid);
    // Show a whole tile, sized from the def — a fixed box would crop an arbitrary
    // corner, which for most artwork is empty and reads as a blank swatch.
    const vw = Math.max(1, parseFloat(def.getAttribute('width') ?? '24') || 24);
    const vh = Math.max(1, parseFloat(def.getAttribute('height') ?? '24') || 24);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    const defs = document.createElementNS(SVG_NS, 'defs');
    const node = document.importNode(def, true) as SVGElement;
    if (!sanitizeSvgElement(node)) return el;
    defs.appendChild(node);
    svg.appendChild(defs);
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('width', String(vw));
    rect.setAttribute('height', String(vh));
    rect.setAttribute('fill', `url(#${pid})`);
    svg.appendChild(rect);
    el.appendChild(svg);
    return el;
  },
};

/** Register the built-in adapters. Call once at boot, before the panel renders. */
export function registerBuiltinAdapters(): void {
  registerAdapter(textStyleAdapter);
  registerAdapter(paintStyleAdapter);
  registerAdapter(effectStyleAdapter);
  registerAdapter(paletteAdapter);
  registerAdapter(patternAdapter);
  registerAdapter(componentAdapter);
}
