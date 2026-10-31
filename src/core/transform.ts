/**
 * Element transform helpers built on the SVG DOM's typed transform list
 * (SVGTransformList / SVGTransform) rather than regex on the `transform` string.
 *
 * The string approach only matched the exact `translate(x, y)` / `rotate(a, …)`
 * forms BuzzQuill itself wrote, and silently mishandled anything else — an
 * imported `matrix(...)`, scientific notation, or a second transform in the
 * list. The typed API composes correctly regardless of what's already there.
 *
 * Canonical form written here: `translate(tx ty) rotate(deg cx cy)` — the
 * translate is outermost (a parent-space move) and the rotate is about the
 * element's local bbox centre, so a translated shape rotates about its own
 * centre instead of orbiting the origin.
 */

export function nudgeTranslate(el: SVGElement, dx: number, dy: number): void {
  const owner = el.ownerSVGElement;
  if (!owner) return;
  const list = (el as SVGGraphicsElement).transform.baseVal;
  const first = list.numberOfItems > 0 ? list.getItem(0) : null;
  if (first && first.type === SVGTransform.SVG_TRANSFORM_TRANSLATE) {
    // Merge into the existing outermost translate so drags don't accumulate items.
    const m = first.matrix;
    first.setTranslate(m.e + dx, m.f + dy);
  } else {
    const t = owner.createSVGTransform();
    t.setTranslate(dx, dy);
    list.insertItemBefore(t, 0);
  }
}

/**
 * The element's own transform as a single matrix, WITHOUT touching the element.
 *
 * Deliberately not the SVGTransformList's own consolidate method: that MUTATES
 * the list, collapsing `translate(...) rotate(...)` into one `matrix(...)`.
 * getRotation runs on every panel refresh, so using it there would silently
 * rewrite the document's markup on read — losing the canonical form this module
 * documents and the merge-into-first-translate fast path nudgeTranslate needs.
 */
function listMatrix(list: SVGTransformList): DOMMatrix {
  let m = new DOMMatrix();
  for (let i = 0; i < list.numberOfItems; i++) {
    const k = list.getItem(i).matrix;
    m = m.multiply(new DOMMatrix([k.a, k.b, k.c, k.d, k.e, k.f]));
  }
  return m;
}

/** The rotation a matrix applies, in degrees. Pure scale/translate gives 0; a
 *  flip or skew still yields the standard rotation component (atan2 of the
 *  first column), which is what design tools report. */
function rotationOfMatrix(m: DOMMatrix): number {
  const deg = (Math.atan2(m.b, m.a) * 180) / Math.PI;
  if (!Number.isFinite(deg)) return 0;
  const r = Math.round(deg * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * The element's rotation in degrees.
 *
 * Read from the CONSOLIDATED matrix rather than by hunting for a `rotate()` item.
 * Every other SVG editor writes rotation baked into `matrix(...)` — Inkscape does
 * it for everything it touches — so scanning for the literal `rotate()` form we
 * happen to write reported 0 for visibly-rotated imported artwork, and the panel
 * showed R = 0 next to a plainly tilted selection box. It also under-reported a
 * shape carrying BOTH (multi-select rotate writes `rotate(delta) <original>`),
 * where only the delta came back rather than the total.
 */
export function getRotation(el: SVGElement): number {
  const list = (el as SVGGraphicsElement).transform?.baseVal;
  if (!list || list.numberOfItems === 0) return 0;
  return rotationOfMatrix(listMatrix(list));
}

/**
 * Set the element's rotation about (cx, cy), preserving any other transforms
 * (e.g. a translate). deg === 0 removes rotation (and the attribute if nothing
 * else remains).
 */
export function setRotation(el: SVGElement, deg: number, cx: number, cy: number): void {
  const owner = el.ownerSVGElement;
  if (!owner) return;
  const list = (el as SVGGraphicsElement).transform.baseVal;
  for (let i = list.numberOfItems - 1; i >= 0; i--) {
    if (list.getItem(i).type === SVGTransform.SVG_TRANSFORM_ROTATE) list.removeItem(i);
  }
  // `deg` is the ABSOLUTE angle the caller wants, and what remains may already
  // rotate the element (an imported matrix). Turn by the difference so the total
  // lands on `deg` and matches what getRotation reads back. With no residual —
  // every shape this app authored — this is exactly `rotate(deg cx cy)` as before.
  const residual = rotationOfMatrix(listMatrix(list));
  const turn = Math.round((deg - residual) * 1000) / 1000;
  if (turn !== 0) {
    const t = owner.createSVGTransform();
    t.setRotate(turn, cx, cy);
    list.appendItem(t); // after the translate, so the move stays in parent space
  }
  if (list.numberOfItems === 0) el.removeAttribute('transform');
}
