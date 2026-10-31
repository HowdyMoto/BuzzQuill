// Property capability map + multi-selection value reducers.
//
// The properties panel is selection-driven: a control is shown only when EVERY
// selected object supports its property (the intersection), and a field shows the
// shared value or a MIXED marker when they differ. This module is the single source
// for "which types have which property" and the common-value reduction, so the panel
// (single- or multi-select) and any future callers agree.

import type { ShapeData } from './types';

export type ShapeType = ShapeData['type'];

// ---- Capability predicates (who has each property) ----
// Kept deliberately generous for container-ish types (group/use inherit fill/stroke
// to their content), and narrow only where the attribute is meaningless (a line has
// no area to fill; an image/frame takes neither paint here).

// A repeat grid's clones carry the source's explicit paints, so painting the
// wrapper does nothing visible — style the ORIGINAL inside it instead.
export const hasFill = (t: ShapeType): boolean =>
  t !== 'line' && t !== 'image' && t !== 'frame' && t !== 'repeat';

export const hasStroke = (t: ShapeType): boolean =>
  t !== 'image' && t !== 'frame' && t !== 'repeat';

export const hasCornerRadius = (t: ShapeType): boolean => t === 'rect';

export const hasMarkers = (t: ShapeType): boolean =>
  t === 'line' || t === 'polyline' || t === 'path';

export const isText = (t: ShapeType): boolean => t === 'text';

/** Does this id name a shape in the model? */
export type ShapeIdLookup = (id: string) => boolean;

/**
 * A DOM element counts as a modeled shape (a selectable layer) iff the MODEL
 * knows its id. Chrome — frame clipPath / .frame-bg, metadata carriers, and
 * regenerated caches like bool results and repeat clones — is never modeled, so
 * it is skipped either way.
 *
 * Deliberately asks the model rather than matching a `shape-N` id: rebuild keys
 * a shape by whatever id its element already has, so an IMPORTED document's
 * shapes are called `c1` / `track` / `marker1`. Testing the name instead made
 * every such shape invisible to click selection, the eyedropper, node editing,
 * measuring and z-order — clicking anything in an imported file selected its
 * frame instead. Lookups are Map-cached, so this is O(1).
 */
export const isModeledShapeEl = (el: Element | null, isShape: ShapeIdLookup): el is SVGElement =>
  !!el && !!el.id && isShape(el.id);

/**
 * Containers are transparent to click-selection: clicking their contents selects
 * the CONTENTS, not the container. Frames (artboards) and imported editor layers
 * (`data-layer` — an Inkscape `groupmode="layer"` wrapper, which organises a whole
 * file rather than being artwork someone grouped) both qualify.
 */
export const isContainerEl = (el: Element): boolean =>
  el.hasAttribute('data-frame') || el.hasAttribute('data-layer');

export const canRotate = (t: ShapeType): boolean => t !== 'frame';

/** True only when EVERY shape passes the predicate (empty selection → false). */
export const all = (shapes: ShapeData[], pred: (t: ShapeType) => boolean): boolean =>
  shapes.length > 0 && shapes.every(s => pred(s.type));

// ---- Common-value reduction ----

/** Sentinel meaning "the selected objects disagree on this value". */
export const MIXED = Symbol('mixed');
export type Maybe<T> = T | typeof MIXED | undefined;

/** Reduce a per-shape getter to a single value: the shared value if all equal,
 *  MIXED if they differ, or undefined if nothing supplied a value. Values are
 *  compared with a stringified key so numbers/strings/booleans all work. */
export function common<S, T>(
  items: S[],
  get: (s: S) => T,
  key: (v: T) => string = (v) => String(v),
): Maybe<T> {
  let first: T | undefined;
  let has = false;
  for (const s of items) {
    const v = get(s);
    if (!has) { first = v; has = true; }
    else if (key(v) !== key(first as T)) return MIXED;
  }
  return has ? (first as T) : undefined;
}
