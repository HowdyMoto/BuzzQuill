// ---------------------------------------------------------------------------
// Effective paint resolution — "what does this element actually paint?"
//
// SVG paint cascades: an element with no `fill` of its own inherits one from an
// ancestor `<g>`, and only falls back to SVG's initial black when nothing up the
// chain supplies it. Reading `el.getAttribute('fill')` therefore answers the
// wrong question for anything DERIVED from an element's appearance (seeding a
// boolean result, an outline, a variable-width stroke, the eyedropper), which is
// why those paths used to lose an inheriting shape's colour and fall back to
// black / grey / none.
//
// The editor used to sidestep this by BAKING the inherited value onto every leaf
// during rebuild (issue #139). That made the model accurate but flattened the
// document: a group's fill became permanently inert (#206/#208) and imported
// artwork that legitimately paints by inheritance was silently rewritten. This
// module is the replacement — resolve on read, leave the markup as authored.
// ---------------------------------------------------------------------------

/** Paint properties that CSS inherits (so an ancestor `<g>` can supply them).
 *  `opacity` is deliberately absent: it composites per element, never inherits. */
export const INHERITABLE_PAINT = [
  'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
] as const;

/** The value an element OWNS for `prop` — its presentation attribute or inline
 *  style — or null when it owns none and would inherit. */
export function ownedPaint(el: Element, prop: string): string | null {
  const attr = el.getAttribute(prop);
  if (attr !== null && attr.trim() !== '') return attr.trim();
  const inline = (el as unknown as ElementCSSInlineStyle).style?.getPropertyValue(prop);
  return inline && inline.trim() !== '' ? inline.trim() : null;
}

/**
 * The value that actually paints `el`: its own, else the nearest ancestor's,
 * stopping at `boundary` (the drawing layer — never inherit editor chrome).
 * Returns null when nothing in the chain supplies one, so the caller can apply
 * the right default for its context (black for fill, none for stroke).
 *
 * Walks attributes rather than calling getComputedStyle: this runs per element
 * during rebuild, and forcing style resolution there was measurably the wrong
 * trade. A stylesheet-driven paint is still handled, because rebuild flattens
 * author `<style>` rules onto elements before this is consulted.
 */
export function effectivePaint(el: Element, prop: string, boundary?: Element | null): string | null {
  const own = ownedPaint(el, prop);
  if (own !== null) return own;
  if (!(INHERITABLE_PAINT as readonly string[]).includes(prop)) return null;
  for (let a = el.parentElement; a && a !== boundary; a = a.parentElement) {
    const v = ownedPaint(a, prop);
    if (v !== null) return v;
    if (a.tagName.toLowerCase() === 'svg') break; // don't escape a nested document
  }
  return null;
}

/** True when some ANCESTOR (not the element itself) supplies `prop` — i.e. the
 *  element paints by inheritance and must not be flattened. */
export function inheritsPaint(el: Element, prop: string, boundary?: Element | null): boolean {
  if (ownedPaint(el, prop) !== null) return false;
  for (let a = el.parentElement; a && a !== boundary; a = a.parentElement) {
    if (ownedPaint(a, prop) !== null) return true;
    if (a.tagName.toLowerCase() === 'svg') break;
  }
  return false;
}

/** Effective fill for a shape that paints an area, with SVG's initial black as
 *  the final fallback — the distinction #139 was about. */
export function effectiveFill(el: Element, boundary?: Element | null): string {
  return effectivePaint(el, 'fill', boundary) ?? '#000000';
}

// ---------------------------------------------------------------------------
// Container paint — "what colour IS this group?"
//
// A `<g>` usually owns no fill of its own: imported artwork (Google/Material
// icons, most exporters) paints each leaf. Reading only the group's attribute
// therefore reported `none` for an icon that is plainly grey on screen, and a
// fill set on the group did nothing, because every leaf's own fill wins. So
// containers answer from their CONTENTS instead.
// ---------------------------------------------------------------------------

/** `<g>`s that are a generated wrapper CACHE, not authored structure. Their
 *  children are regenerated render output and must never be walked or rewritten. */
const WRAPPER_ATTRS = ['data-frame', 'data-boolean', 'data-appearance', 'data-width', 'data-clip-group', 'data-repeat'];

/** Elements that never paint, so they can't contribute a colour. */
const NON_PAINTING = new Set(['clippath', 'defs', 'mask', 'title', 'desc', 'metadata', 'style', 'lineargradient', 'radialgradient', 'pattern', 'filter']);

/** True for a plain authored `<g>` — safe to walk into. */
export function isPlainGroup(el: Element): boolean {
  return el.tagName.toLowerCase() === 'g' && !WRAPPER_ATTRS.some((a) => el.hasAttribute(a));
}

/**
 * The elements inside `root` that actually paint. Recurses through plain groups
 * and stops AT wrapper caches (they own their paint as a unit — the appearance /
 * width / boolean managers write it), never inside them.
 */
export function paintableLeaves(root: Element): Element[] {
  const out: Element[] = [];
  for (const child of Array.from(root.children)) {
    const tag = child.tagName.toLowerCase();
    if (NON_PAINTING.has(tag)) continue;
    if (isPlainGroup(child)) { out.push(...paintableLeaves(child)); continue; }
    out.push(child);
  }
  return out;
}

/**
 * What a container paints, read from its contents: the single distinct colour its
 * leaves use, or `mixed` when they disagree.
 *
 * An explicit `none` leaf is IGNORED rather than counted as a colour — icon sets
 * ship an invisible `<path fill="none">` spacer to pin the viewBox, and letting
 * that outvote the real artwork would report a grey icon as having no fill.
 * `value` is null only when nothing inside paints at all.
 */
export function containerPaint(root: Element, prop: string, boundary?: Element | null):
  { value: string | null; mixed: boolean } {
  const seen = new Set<string>();
  for (const leaf of paintableLeaves(root)) {
    const v = effectivePaint(leaf, prop, boundary);
    if (v === null || v === 'none') continue;
    seen.add(v);
    if (seen.size > 2) break; // "several" is all the caller needs to know
  }
  const first = seen.values().next();
  return { value: first.done ? null : first.value, mixed: seen.size > 1 };
}
