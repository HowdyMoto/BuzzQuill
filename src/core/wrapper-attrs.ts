import { LINK_ATTRS } from './library-styles';

/**
 * Object-level attributes: what an object IS beyond its geometry and paint — where
 * it sits, how it composites, its effects, its name, lock and library links. They
 * belong to the object, so they travel whenever its element is wrapped, unwrapped,
 * replaced or dissolved: onto an appearance / variable-width wrapper `<g>` and
 * back, onto a flattened or outlined result, onto detached content.
 *
 * Every one is an attribute, so one list covers them all. (Blend mode used to be
 * the exception — it lived only in inline style — and every site below needed a
 * special case for it. `data-blend` is now the source of truth; see {@link setBlend}.)
 */
export const CARRY_ATTRS = [
  'transform', 'clip-path', 'filter', 'data-fx-blur', 'data-fx-shadow',
  'data-locked', 'data-name', 'opacity', 'data-blend',
  // Library style links, derived from the single table in core/library-styles.ts so
  // a newly registered linked type is carried automatically. Without these, wrapping
  // a shape (adding a 2nd fill, a variable-width stroke) silently orphaned it from
  // its style: the link stayed on the inner element, which the model treats as a
  // leaf, so the style stopped propagating and the attr was cloned onto the id-less
  // render children.
  ...LINK_ATTRS,
];

/** An object's blend mode, or '' for normal. Reads `data-blend`, falling back to
 *  an inline `mix-blend-mode` the document hasn't been adopted from yet. */
export function getBlend(el: Element): string {
  const mode = el.getAttribute('data-blend') || (el as SVGElement).style?.mixBlendMode || '';
  return mode === 'normal' ? '' : mode;
}

/**
 * Set (or, with '' / null / 'normal', clear) an object's blend mode. `data-blend`
 * is the state; the inline `mix-blend-mode` is written from it here and nowhere
 * else, because it is what actually renders — in the editor and in any other
 * viewer of a saved or exported file.
 */
export function setBlend(el: Element, mode: string | null): void {
  const style = (el as SVGElement).style;
  if (mode && mode !== 'normal') {
    el.setAttribute('data-blend', mode);
    if (style) style.mixBlendMode = mode;
    return;
  }
  el.removeAttribute('data-blend');
  style?.removeProperty('mix-blend-mode');
  if (el.getAttribute('style') !== null && !el.getAttribute('style')?.trim()) el.removeAttribute('style');
}

/**
 * Copy the object-level attributes ({@link CARRY_ATTRS}) and a hidden layer's
 * `display:none` from `from` onto `to`. For any code that REPLACES an element with
 * a rebuilt one: copying a hand-picked list instead is how flatten / outline /
 * detach / crop each silently dropped a rotation, an opacity or an effect (and how
 * a hidden layer reappeared). `except` names attributes the caller composes or
 * writes itself.
 */
export function carryObjectAttrs(from: Element, to: Element, except: readonly string[] = []): void {
  for (const a of CARRY_ATTRS) {
    if (except.includes(a)) continue;
    const v = from.getAttribute(a);
    if (v != null) to.setAttribute(a, v);
  }
  if (!except.includes('data-blend')) { const blend = getBlend(from); if (blend) setBlend(to, blend); }
  if ((from as SVGElement).style?.display === 'none') (to as SVGElement).style.display = 'none';
}

/**
 * MOVE the object-level attributes from `from` onto `to`: {@link carryObjectAttrs},
 * then strip them from `from`, which stays in the document as part of `to` (the
 * source inside an appearance wrapper, the fill body inside an outlined group).
 * Left on both, an opacity or an effect would apply twice. Attributes in `except`
 * are neither copied nor removed.
 */
export function moveObjectAttrs(from: Element, to: Element, except: readonly string[] = []): void {
  carryObjectAttrs(from, to, except);
  for (const a of CARRY_ATTRS) if (!except.includes(a)) from.removeAttribute(a);
  if (!except.includes('data-blend')) setBlend(from, null);
  const style = (from as SVGElement).style;
  style?.removeProperty('display'); // hidden-ness moved with the rest
  if (from.getAttribute('style') !== null && !from.getAttribute('style')?.trim()) from.removeAttribute('style');
}

/** An `opacity` value as the renderer reads it: a number or a percentage, clamped
 *  to 0–1 (so "50%" is a half, not fifty, and "2" is fully opaque). Absent = 1. */
function opacityValue(v: string | null): number {
  if (v == null) return 1;
  const t = v.trim();
  const n = t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

/** Multiply two `opacity` attribute values (either may be absent = 1). Opacity
 *  composites per element, so folding an ancestor's onto a child is a product. */
export function composeOpacity(a: string | null, b: string | null): string | null {
  const v = opacityValue(a) * opacityValue(b);
  if (v >= 0.9995) return null;
  return String(Math.round(v * 1000) / 1000);
}

/** Object attributes defined in the element's OWN coordinate space: a clip's
 *  geometry, an effect's blur radius and shadow offset. They can't simply be
 *  copied onto an element whose space is different. */
export const SPACE_BOUND_ATTRS = ['clip-path', 'filter', 'data-fx-blur', 'data-fx-shadow'];

/** `outer`'s own transform, then any step between the two, then `inner`'s. */
function composedTransform(outer: Element | null, inner: Element, via: string): string {
  return [outer?.getAttribute('transform'), via, inner.getAttribute('transform')].filter(Boolean).join(' ');
}

/**
 * Can `outer` — a container about to be replaced by its content — be folded onto
 * `inner` without changing what renders? Not when it carries a clip or an effect
 * and `inner` lives in a different space (it has a transform of its own, or `via`
 * adds one) or already has a clip or effect of its own.
 */
export function foldsCleanly(outer: Element, inner: Element, via = ''): boolean {
  if (!SPACE_BOUND_ATTRS.some((a) => outer.hasAttribute(a))) return true;
  return !composedTransform(null, inner, via) && !SPACE_BOUND_ATTRS.some((a) => inner.hasAttribute(a));
}

/**
 * Fold `outer` onto `inner`: transforms compose (outer · via · inner), opacities
 * multiply, and everything else `outer` carried — lock, links, blend, hidden,
 * and a clip or effect when {@link foldsCleanly} — comes across. `via` is a
 * transform that sat between the two (a symbol instance's viewport step).
 */
export function foldOnto(outer: Element, inner: Element, via = ''): void {
  const all = composedTransform(outer, inner, via);
  if (all) inner.setAttribute('transform', all); else inner.removeAttribute('transform');
  const op = composeOpacity(outer.getAttribute('opacity'), inner.getAttribute('opacity'));
  if (op) inner.setAttribute('opacity', op); else inner.removeAttribute('opacity');
  carryObjectAttrs(outer, inner, ['transform', 'opacity', 'data-name']);
}

/**
 * Dissolve `outer` onto `inner` and return the element that takes its place:
 * `inner` itself when it folds cleanly, otherwise a new plain `<g>` that stays in
 * `outer`'s space, carries what `outer` carried, and holds `inner`. The shared
 * answer to "a container is going away — what happens to what it carried?",
 * which detach, repeat release and the rest each used to answer by hand. The
 * caller gives a new wrapper its id and name.
 */
export function dissolveOnto(outer: Element, inner: SVGElement, via = ''): SVGElement {
  if (foldsCleanly(outer, inner, via)) { foldOnto(outer, inner, via); return inner; }
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  carryObjectAttrs(outer, g, ['data-name']);
  const own = composedTransform(null, inner, via);
  if (own) inner.setAttribute('transform', own); else inner.removeAttribute('transform');
  g.appendChild(inner);
  return g;
}
