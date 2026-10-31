// ---------------------------------------------------------------------------
// Appearance stack — multiple fills / strokes on one object (Illustrator's
// Appearance panel).
//
// SVG paints a single element with one fill + one stroke, so a rich stack is
// stored as a `<g data-appearance="[layers]">` wrapper. Inside it:
//   • one hidden `[data-ap-src]` element → the canonical geometry (the object the
//     user actually drew), fill+stroke cleared;
//   • N `[data-ap]` render-clones of that geometry, one per visible layer, each
//     painted with a single fill or stroke, stacked bottom→top.
// The render-clones live in the drawing layer, so they round-trip through the
// history/innerHTML snapshot for free; rebuildShapesFromDOM models the wrapper as
// a LEAF (type 'appearance') and never walks into it. When a stack collapses to
// ≤1 fill and ≤1 stroke we UNWRAP back to a plain native element.
//
// Extracted from AppState as a collaborator (see EffectsManager / MarkersManager):
// it reaches AppState only through the AppearanceHost seam.
// ---------------------------------------------------------------------------

import type { ShapeData, AppearanceLayer } from './types';
import { carryObjectAttrs, moveObjectAttrs } from './wrapper-attrs';
import { applyStrokeAlignment, type StrokeAlign } from './stroke-align';
import { ensureOffsetEngine, offsetPathData, localPathData, type StrokeJoin } from './boolean';
import { reversePathData } from './path-model';

const SVG = 'http://www.w3.org/2000/svg';

// --- Per-stroke offset geometry (paperjs-offset) ---
// Offsetting a curve is real geometry (async engine), so results are memoized by
// (source d, delta, join). regenerate() runs synchronously off this cache; if the
// engine isn't loaded yet offsetPathData throws, so we render un-offset and
// self-heal on load. A '' result (offset failed) is cached to avoid retry loops.
let offsetEngineLoading = false;
const offsetCache = new Map<string, string>();

/** Cached offset `d`, or null if not yet computable (engine still loading). */
function cachedOffsetD(srcD: string, delta: number, join: StrokeJoin): string | null {
  if (!srcD.trim() || !delta) return srcD || null;
  const key = `${srcD}|${delta}|${join}`;
  const hit = offsetCache.get(key);
  if (hit !== undefined) return hit || null;
  try {
    const out = offsetPathData(srcD, delta, join); // throws if engine not loaded
    offsetCache.set(key, out);
    return out || null;
  } catch {
    return null; // engine not loaded yet → caller renders un-offset + schedules load
  }
}

/** Per-stroke presentation attributes (beyond paint/width/opacity) carried on
 *  each stroke render-clone and on an unwrapped native stroke. */
const STROKE_ATTRS = [
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'vector-effect',
];

export interface AppearanceHost {
  findShape(id: string): ShapeData | null;
  /** Rebuild/remove an element's effect <filter> from its data-fx-* attrs. */
  applyEffectFilter(el: SVGElement): void;
  rebuild(): void;
  setSelection(ids: string[]): void;
  saveHistory(): void;
  onChange(): void;
}

export class AppearanceManager {
  private host: AppearanceHost;
  constructor(host: AppearanceHost) { this.host = host; }

  /**
   * Sort a stack so every STROKE sits above every FILL (index 0 is the top layer),
   * preserving order within each kind. Applied on both the read and the write path,
   * so the model, the render and the panel can't disagree.
   *
   * The stack is one interleaved array, but nothing can *express* an interleaving:
   * the panel shows two separate lists and `reorderWithinType` only ever moves a row
   * among its own kind. So a fill above a stroke was never authored — it fell out of
   * `addFill` unshifting onto absolute index 0 — and it contradicted the rest of the
   * model: `get()` reports a plain element as `[stroke, fill]` (stroke on top, which
   * is also SVG's own fill-then-stroke painting order for one element), so adding a
   * second fill would silently move the object's stroke *under* it. Same object, same
   * stroke, different z just because a fill appeared.
   */
  private static strokesFirst(layers: AppearanceLayer[]): AppearanceLayer[] {
    const strokes = layers.filter(l => l.t === 'stroke');
    if (strokes.length === 0 || strokes.length === layers.length) return layers; // already sorted
    return [...strokes, ...layers.filter(l => l.t === 'fill')];
  }

  private parse(wrapperEl: SVGElement): AppearanceLayer[] {
    try {
      const raw = JSON.parse(wrapperEl.getAttribute('data-appearance') || '[]');
      if (!Array.isArray(raw)) return [];
      return AppearanceManager.strokesFirst(raw.filter((l): l is AppearanceLayer => l && (l.t === 'fill' || l.t === 'stroke')));
    } catch { return []; }
  }

  /** ≤1 visible/expressible fill and ≤1 stroke, no per-layer blend → expressible
   *  as a plain element (so we can unwrap and keep it fully editable). */
  private isTrivial(layers: AppearanceLayer[]): boolean {
    const fills = layers.filter(l => l.t === 'fill');
    const strokes = layers.filter(l => l.t === 'stroke');
    if (fills.length > 1 || strokes.length > 1) return false;
    // A non-zero offset or a cut (knockout) is emulated geometry a plain element
    // can't hold, so either forces the wrapper to persist.
    return layers.every(l => !l.blend && !l.offset && !l.cut);
  }

  /** Write a trivial (≤1 fill, ≤1 stroke) stack onto a plain element's native
   *  presentation attributes. A hidden or absent layer becomes paint 'none'. */
  private applyTrivialToNative(el: SVGElement, layers: AppearanceLayer[]): void {
    const fill = layers.find(l => l.t === 'fill');
    const stroke = layers.find(l => l.t === 'stroke');
    if (fill && fill.visible !== false && fill.paint !== 'none') {
      el.setAttribute('fill', fill.paint);
      if (fill.opacity < 1) el.setAttribute('fill-opacity', String(fill.opacity));
      else el.removeAttribute('fill-opacity');
    } else {
      el.setAttribute('fill', 'none');
      el.removeAttribute('fill-opacity');
    }
    if (stroke && stroke.visible !== false && stroke.paint !== 'none') {
      el.setAttribute('stroke', stroke.paint);
      el.setAttribute('stroke-width', String(stroke.width ?? 1));
      if (stroke.opacity < 1) el.setAttribute('stroke-opacity', String(stroke.opacity));
      else el.removeAttribute('stroke-opacity');
      this.applyStrokeAttrs(el, stroke);
      // An inside/outside-aligned stroke renders at DOUBLED width behind a clip
      // (stroke-align.ts) — writing the raw width above broke that invariant, so
      // re-run the alignment engine with the authored width.
      const align = el.getAttribute('data-stroke-align') as StrokeAlign | null;
      if (align === 'inside' || align === 'outside') {
        applyStrokeAlignment(el, el.tagName.toLowerCase() as ShapeData['type'], align, stroke.width ?? 1);
      }
    } else {
      el.removeAttribute('stroke');
      el.removeAttribute('stroke-width');
      el.removeAttribute('stroke-opacity');
      for (const a of STROKE_ATTRS) el.removeAttribute(a);
      // No stroke → no alignment emulation either; drop its marker + clip.
      if (el.hasAttribute('data-stroke-align')) {
        el.removeAttribute('data-stroke-align');
        if ((el.getAttribute('clip-path') ?? '').includes('sa-clip-')) el.removeAttribute('clip-path');
        el.style.removeProperty('paint-order');
      }
    }
  }

  /** Apply a stroke layer's per-stroke presentation attributes to an element
   *  (render-clone or unwrapped native), setting only non-defaults and removing
   *  the rest so the DOM stays minimal. */
  private applyStrokeAttrs(el: SVGElement, L: AppearanceLayer): void {
    const set = (name: string, on: boolean, val: string) =>
      on ? el.setAttribute(name, val) : el.removeAttribute(name);
    set('stroke-dasharray', !!(L.dash && L.dash.trim()), (L.dash ?? '').trim());
    set('stroke-dashoffset', !!L.dashOffset, String(L.dashOffset ?? 0));
    set('stroke-linecap', !!L.cap && L.cap !== 'butt', String(L.cap));
    set('stroke-linejoin', !!L.join && L.join !== 'miter', String(L.join));
    set('stroke-miterlimit', L.miter != null && L.miter !== 4, String(L.miter));
    set('vector-effect', !!L.nonScaling, 'non-scaling-stroke');
  }

  /** Re-run the render-clone generation after the source geometry was edited in place
   *  (e.g. by the node tool). */
  refresh(wrapperEl: SVGElement): void { this.regenerate(wrapperEl); }

  /** Rebuild a wrapper's `[data-ap]` render-clones from its geometry + stack, and
   *  seed representative paint on the wrapper. Called on every stack edit; idempotent. */
  private regenerate(wrapperEl: SVGElement): void {
    const src = wrapperEl.querySelector(':scope > [data-ap-src]') as SVGElement | null;
    if (!src) return;
    // Clear everything but the source (clones, plus masked groups + masks from any
    // prior cut render).
    wrapperEl.querySelectorAll(':scope > :not([data-ap-src])').forEach(n => n.remove());
    const layers = this.parse(wrapperEl);
    const wrapperId = wrapperEl.id || 'ap';

    // Paint bottom→top: later DOM siblings render on top, and layers[0] is the
    // TOP layer, so append in reverse. The src stays first (invisible baseline).
    let engineMiss = false; // an offset stroke wanted geometry the engine can't give yet
    let cutN = 0;
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      if (L.visible === false) continue;

      // Cut (knockout) stroke: punch its shape out of everything painted below it
      // by wrapping those clones in a group masked by (white field − black cut).
      if (L.t === 'stroke' && L.cut) {
        if ((L.width ?? 1) <= 0) continue;
        // Strokes now always sort above fills, which would put every cut above every
        // fill and start slicing the fill too. A cut is documented as punching a gap
        // through the STROKES below it — the fill showing through that gap is the
        // point — so fill clones are excluded from the knockout and simply stay as
        // earlier (lower) siblings.
        const below = [...wrapperEl.querySelectorAll(':scope > :not([data-ap-src]):not([data-ap-mask]):not([data-ap="fill"])')];
        if (!below.length) continue; // nothing beneath to cut
        const cut = this.geomClone(src, L); if (cut.miss) engineMiss = true;
        this.stripClone(cut.el);
        cut.el.setAttribute('fill', 'none');
        cut.el.setAttribute('stroke', '#000'); // black = knocked out in the mask
        cut.el.setAttribute('stroke-width', String(L.width ?? 1));
        this.applyStrokeAttrs(cut.el, L); // a dashed/round cut cuts dashed/round gaps
        const maskId = `${wrapperId}-cut-${cutN++}`;
        const mask = document.createElementNS(SVG, 'mask');
        mask.setAttribute('id', maskId);
        mask.setAttribute('data-ap-mask', '');
        mask.setAttribute('maskUnits', 'userSpaceOnUse');
        for (const [a, v] of [['x', '-100000'], ['y', '-100000'], ['width', '200000'], ['height', '200000']]) mask.setAttribute(a, v);
        const bg = document.createElementNS(SVG, 'rect');
        for (const [a, v] of [['x', '-100000'], ['y', '-100000'], ['width', '200000'], ['height', '200000']]) bg.setAttribute(a, v);
        bg.setAttribute('fill', '#fff');
        mask.append(bg, cut.el);
        wrapperEl.appendChild(mask);
        const group = document.createElementNS(SVG, 'g');
        group.setAttribute('data-ap-group', '');
        group.setAttribute('mask', `url(#${maskId})`);
        below.forEach(n => group.appendChild(n));
        wrapperEl.appendChild(group);
        continue;
      }

      if (L.paint === 'none') continue;
      // A stroke with a non-zero offset renders as a fresh <path> of the source
      // geometry shifted sideways (parallel line). Falls back to a plain clone
      // until the async offset engine has loaded.
      const g = this.geomClone(src, L); if (g.miss) engineMiss = true;
      const clone = g.el;
      this.stripClone(clone);
      clone.setAttribute('data-ap', L.t);
      if (L.t === 'fill') {
        clone.setAttribute('fill', L.paint);
        clone.setAttribute('fill-opacity', String(L.opacity));
        clone.setAttribute('stroke', 'none');
        clone.removeAttribute('stroke-width');
      } else {
        clone.setAttribute('fill', 'none');
        clone.setAttribute('stroke', L.paint);
        clone.setAttribute('stroke-width', String(L.width ?? 1));
        clone.setAttribute('stroke-opacity', String(L.opacity));
        this.applyStrokeAttrs(clone, L); // dash / cap / join / miter / fixed (removes any inherited)
      }
      if (L.blend) clone.style.setProperty('mix-blend-mode', L.blend);
      wrapperEl.appendChild(clone);
    }
    wrapperEl.insertBefore(src, wrapperEl.firstChild);

    // Representative single paint on the wrapper (inert — clones override — but
    // read by the Properties panel / export / eyedropper).
    const topFill = layers.find(l => l.t === 'fill' && l.visible !== false && l.paint !== 'none');
    const topStroke = layers.find(l => l.t === 'stroke' && !l.cut && l.visible !== false && l.paint !== 'none');
    wrapperEl.setAttribute('fill', topFill?.paint ?? 'none');
    if (topStroke) {
      wrapperEl.setAttribute('stroke', topStroke.paint);
      wrapperEl.setAttribute('stroke-width', String(topStroke.width ?? 1));
    } else {
      wrapperEl.setAttribute('stroke', 'none');
      wrapperEl.removeAttribute('stroke-width');
    }

    // An offset stroke rendered un-offset because the engine was still loading:
    // load it, then re-render this wrapper (and refresh panels) once ready.
    if (engineMiss) this.loadOffsetEngineThen(wrapperEl);
  }

  /** A render-clone of `src` for layer `L`: an offset `<path>` when the layer has
   *  a non-zero offset (falling back to a plain clone — `miss=true` — until the
   *  async engine loads), else a plain deep clone. */
  private geomClone(src: SVGElement, L: AppearanceLayer): { el: SVGElement; miss: boolean } {
    if (L.t === 'stroke' && L.offset) {
      const off = this.offsetClone(src, L.offset, (L.join ?? 'miter') as StrokeJoin, !!L.offsetReversed);
      if (off) return { el: off, miss: false };
      return { el: src.cloneNode(true) as SVGElement, miss: true };
    }
    return { el: src.cloneNode(true) as SVGElement, miss: false };
  }

  /** Strip identity/object-level attributes off a render-clone (shared by paint
   *  clones and cut-mask clones). */
  private stripClone(clone: SVGElement): void {
    clone.removeAttribute('id');
    clone.removeAttribute('data-ap-src');
    clone.removeAttribute('data-name');
    for (const a of ['clip-path', 'filter', 'data-fx-blur', 'data-fx-shadow', 'style']) clone.removeAttribute(a);
  }

  /** Build a `<path>` render-clone of `src` offset sideways by `delta`px, or null
   *  if the offset geometry isn't cached/available yet. */
  private offsetClone(src: SVGElement, delta: number, join: StrokeJoin, reversed: boolean): SVGElement | null {
    const srcD = localPathData(src);
    const d = cachedOffsetD(reversed ? reversePathData(srcD) : srcD, delta, join);
    if (d == null || !d.trim()) return null;
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    return p;
  }

  /** Kick off the async offset engine load once; on ready, re-regenerate the
   *  wrapper so its offset strokes appear (self-heal after a cache miss). */
  private loadOffsetEngineThen(wrapperEl: SVGElement): void {
    if (offsetEngineLoading) return;
    offsetEngineLoading = true;
    ensureOffsetEngine().then(() => {
      offsetEngineLoading = false;
      if (wrapperEl.isConnected) { this.regenerate(wrapperEl); this.host.onChange(); }
    }).catch(() => { offsetEngineLoading = false; });
  }

  /** Promote a plain element into a `<g data-appearance>` wrapper in place. */
  private wrap(shape: ShapeData, layers: AppearanceLayer[]): SVGElement {
    const el = shape.element;
    const g = document.createElementNS(SVG, 'g');
    g.id = el.id;
    g.setAttribute('data-appearance', JSON.stringify(layers));
    // Object-level attributes move to the wrapper (transform positions the whole
    // stack; effects/clip/name/lock/opacity apply to it as a unit).
    moveObjectAttrs(el, g);

    el.removeAttribute('id');
    el.setAttribute('data-ap-src', '');
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', 'none');

    // A pre-existing emulated stroke-align (doubled width + clip, see stroke-align.ts)
    // is superseded by the stack's own per-layer rendering — strip it so it can't
    // double-apply. get() already recovered the authored width into `layers`.
    if (el.hasAttribute('data-stroke-align')) {
      el.removeAttribute('data-stroke-align');
      el.style.removeProperty('paint-order');
      const cp = g.getAttribute('clip-path');
      if (cp && cp.includes('sa-clip-')) g.removeAttribute('clip-path');
    }

    el.replaceWith(g); // takes el's slot (preserves parent/position, incl. nested frames)
    g.appendChild(el);
    this.regenerate(g);
    if (g.hasAttribute('data-fx-blur') || g.hasAttribute('data-fx-shadow')) this.host.applyEffectFilter(g);
    return g;
  }

  /** Collapse a wrapper back to its plain source element (trivial stack). */
  private unwrap(wrapperEl: SVGElement, layers: AppearanceLayer[]): SVGElement | null {
    const src = wrapperEl.querySelector(':scope > [data-ap-src]') as SVGElement | null;
    if (!src) return null;
    wrapperEl.querySelectorAll(':scope > [data-ap]').forEach(n => n.remove());
    src.setAttribute('id', wrapperEl.id);
    src.removeAttribute('data-ap-src');
    carryObjectAttrs(wrapperEl, src);
    this.applyTrivialToNative(src, layers);
    wrapperEl.replaceWith(src);
    if (src.hasAttribute('data-fx-blur') || src.hasAttribute('data-fx-shadow')) this.host.applyEffectFilter(src);
    return src;
  }

  /**
   * The Appearance stack for an object (TOP layer first). For a plain element this
   * is synthesized from its native fill/stroke so the panel can display and extend
   * it; for a wrapped object it's the stored stack.
   */
  get(id: string): AppearanceLayer[] {
    const shape = this.host.findShape(id);
    if (!shape) return [];
    if (shape.type === 'appearance') return this.parse(shape.element);
    const el = shape.element;
    const layers: AppearanceLayer[] = [];
    const stroke = el.getAttribute('stroke');
    if (stroke && stroke !== 'none') {
      // Emulated inside/outside align renders at doubled width (see stroke-align.ts);
      // recover the authored width so the stack shows the real number.
      const aligned = el.hasAttribute('data-stroke-align');
      const rawW = parseFloat(el.getAttribute('stroke-width') ?? '1') || 1;
      const layer: AppearanceLayer = {
        t: 'stroke', paint: stroke,
        width: aligned ? rawW / 2 : rawW,
        opacity: parseFloat(el.getAttribute('stroke-opacity') ?? '1'),
      };
      const dash = el.getAttribute('stroke-dasharray'); if (dash) layer.dash = dash;
      const doff = parseFloat(el.getAttribute('stroke-dashoffset') ?? '0'); if (doff) layer.dashOffset = doff;
      const cap = el.getAttribute('stroke-linecap'); if (cap === 'round' || cap === 'square') layer.cap = cap;
      const join = el.getAttribute('stroke-linejoin'); if (join === 'round' || join === 'bevel') layer.join = join;
      const miter = parseFloat(el.getAttribute('stroke-miterlimit') ?? '4'); if (miter && miter !== 4) layer.miter = miter;
      if (el.getAttribute('vector-effect') === 'non-scaling-stroke') layer.nonScaling = true;
      layers.push(layer);
    }
    const fill = el.getAttribute('fill');
    if (fill && fill !== 'none') {
      layers.push({ t: 'fill', paint: fill, opacity: parseFloat(el.getAttribute('fill-opacity') ?? '1') });
    }
    return layers;
  }


  /**
   * DEV-only: record every write that ADDS a stroke layer, with the call stack that
   * did it.
   *
   * Reported symptom: "something keeps adding multiple strokes to a rectangle,
   * but I can't replicate it." Adding a stroke is often legitimate (the Strokes
   * panel's +, Offset Path, Cut), so this can't be an invariant that fails the
   * build — it's a trace. Every stack write funnels through setMulti, so the
   * culprit is whatever appears in the recorded stack, whether it's a deliberate
   * action or a path firing when it shouldn't.
   *
   * Read it in the console as `__bqStrokeAdds` (last 30 kept). Warns rather than
   * errors so it can't trip the smoke suite's console guard.
   */
  private devTraceStrokeGrowth(id: string, incoming: AppearanceLayer[]): void {
    let before: number;
    try { before = this.get(id).filter(l => l.t === 'stroke').length; } catch { return; }
    const after = (incoming ?? []).filter(l => l.t === 'stroke').length;
    if (after <= before) return;
    const stack = (new Error().stack ?? '').split(String.fromCharCode(10)).slice(3, 9)
      .map(l => l.trim().replace(/^at\s+/, '')).filter(Boolean);
    const w = window as unknown as { __bqStrokeAdds?: unknown[] };
    (w.__bqStrokeAdds ??= []).push({ at: new Date().toISOString(), id, before, after, stack });
    if (w.__bqStrokeAdds.length > 30) w.__bqStrokeAdds.shift();
    console.warn(`[stroke-trace] ${id}: strokes ${before} -> ${after} via ${stack[0] ?? '?'}`
      + ` — full trace in window.__bqStrokeAdds`);
  }

  /**
   * Replace an object's Appearance stack (TOP layer first). Collapses to a plain
   * native element when the stack is trivial (≤1 fill, ≤1 stroke, no blend),
   * otherwise wraps/updates a `<g data-appearance>`. One undo step.
   */
  set(id: string, layers: AppearanceLayer[], record = true): void {
    this.setMulti([{ id, layers }], [id], record);
  }

  /**
   * Apply appearance edits to multiple shapes in a single undo step. `selectionAfter`
   * is the selection to restore after the rebuild (pass the FULL selection — collapsing
   * it to one shape mid-edit breaks live color-picker scrubs over a multi-selection).
   * Each shape's stack is independently wrapped/unwrapped; all share one rebuild+history.
   */
  setMulti(edits: Array<{ id: string; layers: AppearanceLayer[] }>, selectionAfter: string[], record = true): void {
    if (import.meta.env?.DEV) for (const e of edits) this.devTraceStrokeGrowth(e.id, e.layers);
    for (const { id, layers: authored } of edits) {
      const shape = this.host.findShape(id);
      if (!shape) continue;
      // Normalize on the way in as well as on the way out, so the stored attribute
      // matches what renders and callers never have to think about absolute indices.
      const layers = AppearanceManager.strokesFirst(authored);
      const trivial = this.isTrivial(layers);
      if (shape.type === 'appearance') {
        if (trivial) this.unwrap(shape.element, layers);
        else { shape.element.setAttribute('data-appearance', JSON.stringify(layers)); this.regenerate(shape.element); }
      } else {
        if (trivial) this.applyTrivialToNative(shape.element, layers);
        else this.wrap(shape, layers);
      }
    }
    this.host.rebuild();
    this.host.setSelection(selectionAfter);
    if (record) this.host.saveHistory();
    this.host.onChange();
  }
}
