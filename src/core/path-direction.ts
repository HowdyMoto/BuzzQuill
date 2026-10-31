// ---------------------------------------------------------------------------
// Path direction — which way a path runs, and turning it around.
//
// The order points are WRITTEN in is invisible on the canvas but is all another
// program has to go on: TraceCraft reads a pit lane's first point as the pit entry,
// a plotter cuts in that order, a stroke animation draws in it. Reversing rewrites
// that order and nothing a person can see, with these exceptions, all on purpose:
// an arrowhead stays on `marker-end`, so it moves to the new end and keeps pointing
// the way the path travels; text on the path flips to its other side, since a
// baseline's direction is what decides that side.
//
// What each kind of shape needs so its picture survives:
//   - line / polyline / polygon stay what they are, their coordinates reordered;
//   - path / variable-width / multi-stroke rewrite the (source) `d`, a width profile
//     mirrors along with it, and a sideways stroke remembers the way it was computed;
//   - rect / ellipse have no written order at all, so they become paths — that's
//     the only way a file can say which way one runs;
//   - a live boolean, or a wrapper around a primitive, has no geometry of its own to
//     rewrite; it is reported rather than silently converted.
//
// Collaborator of AppState (see the host seam); chrome and animation live in
// ui/direction-overlay.ts.
// ---------------------------------------------------------------------------

import type { AppearanceLayer, ShapeData } from './types';
import type { PathEditSession } from './path-edit';
import { isLockedEl } from './locks';
import { parsePath, reversePathData } from './path-model';
import { dropParametricAttrs, shapeToPathData } from './shape-adapters';

export interface PathDirectionHost {
  getSelectedIds(): string[];
  findShape(id: string): ShapeData | null;
  /** Replace a primitive with an equivalent <path> in place; false if it can't. */
  convertShapeToPath(shape: ShapeData): boolean;
  /** The live node-editing session and the shape it edits, or nulls outside it. */
  getEditSession(): PathEditSession | null;
  getEditingId(): string | null;
  /** Write the edit session back to the element (no undo step: the caller records). */
  commitPathEdit(): void;
  refreshWidth(el: SVGElement): void;
  refreshAppearance(el: SVGElement): void;
  rebuild(): void;
  saveHistory(): void;
  onChange(): void;
}

export interface ReverseResult {
  /** Top-level shape ids whose direction changed. */
  ids: string[];
  /** How many rect/ellipse shapes had to become paths to have a direction at all. */
  converted: number;
  /** Shapes in the request with no direction to reverse (a live boolean, a symbol…). */
  skipped: ShapeData[];
}

const WIDTH_SRC = ':scope > [data-width-src]';
const AP_SRC = ':scope > [data-ap-src]';

/** Types that have a direction once you ask for one. */
const DIRECTED: ReadonlyArray<ShapeData['type']> =
  ['path', 'rect', 'ellipse', 'line', 'polyline', 'polygon', 'width', 'appearance'];

/** The element holding a shape's geometry — the source inside a wrapper, the shape
 *  itself otherwise — or null when it has none to reverse. */
export function directionSourceEl(shape: ShapeData): SVGElement | null {
  const el = shape.element as unknown as SVGElement;
  if (shape.type === 'width' || shape.type === 'appearance') {
    const src = el.querySelector(shape.type === 'width' ? WIDTH_SRC : AP_SRC) as SVGElement | null;
    return src?.tagName.toLowerCase() === 'path' && src.getAttribute('d') ? src : null;
  }
  return DIRECTED.includes(shape.type) ? el : null;
}

/** A shape's path data in its written order (rect/ellipse: as it'd convert). */
export function directionPathData(shape: ShapeData): string {
  const src = directionSourceEl(shape);
  return src ? shapeToPathData(src) : '';
}

/** Whether this one shape (not its children) can be reversed. */
export function hasDirection(shape: ShapeData): boolean {
  if (!directionSourceEl(shape) || isLockedEl(shape.element)) return false;
  return parsePath(directionPathData(shape)).subpaths.some(sp => sp.anchors.length > 1);
}

/** Every leaf under `shape` with a direction: a group or frame stands for what's in
 *  it, except hidden layers, which nobody would know they had just changed. */
export function directedLeaves(shape: ShapeData, out: ShapeData[] = []): ShapeData[] {
  if ((shape.type === 'group' || shape.type === 'frame') && shape.children) {
    for (const c of shape.children) if (c.visible) directedLeaves(c, out);
  } else if (hasDirection(shape)) out.push(shape);
  return out;
}

/**
 * Keep text on a baseline in place across a reversal: position s along the old path
 * is L − s along the new one, so the text's span maps to 100 − offset − length%.
 * Tracks the flip on `data-flip`, which is what the Text panel's toggle reads.
 */
export function flipTextSpan(tp: Element, baseline: SVGGeometryElement): void {
  const total = baseline.getTotalLength();
  let textPct = 0;
  try {
    const tl = (tp.closest('text') as unknown as SVGTextContentElement).getComputedTextLength();
    if (total > 0) textPct = (tl / total) * 100;
  } catch { /* hidden source (wrapped) → skip span remap */ }
  const o = parseFloat(tp.getAttribute('startOffset') ?? '0') || 0;
  const next = Math.max(0, Math.min(100, 100 - o - textPct));
  if (next) tp.setAttribute('startOffset', `${Math.round(next * 10) / 10}%`); else tp.removeAttribute('startOffset');
  if (tp.getAttribute('data-flip') === '1') tp.removeAttribute('data-flip'); else tp.setAttribute('data-flip', '1');
}

/** The <textPath>s flowing along a path: the real ones, not a wrapper's render clones. */
function textPathsOn(id: string): Element[] {
  return Array.from(document.querySelectorAll('#drawing-layer textPath')).filter((tp) => {
    if ((tp.getAttribute('href') || tp.getAttribute('xlink:href')) !== `#${id}`) return false;
    return !tp.closest('[data-appearance]') || !!tp.closest('[data-ap-src]');
  });
}

export class PathDirectionManager {
  private host: PathDirectionHost;
  constructor(host: PathDirectionHost) { this.host = host; }

  /** True when the selection holds at least one path to reverse. */
  canReverse(): boolean {
    return this.host.getSelectedIds().some((id) => {
      const s = this.host.findShape(id);
      return !!s && directedLeaves(s).length > 0;
    });
  }

  /** Reverse everything selected — one undo step. */
  reverseSelected(): ReverseResult { return this.reverse(this.host.getSelectedIds()); }

  /** Reverse these shapes (and whatever's in any group among them) — one undo step. */
  reverse(ids: string[]): ReverseResult {
    const result: ReverseResult = { ids: [], converted: 0, skipped: [] };
    const seen = new Set<string>();
    for (const id of ids) {
      const shape = this.host.findShape(id);
      if (!shape) continue;
      const leaves = directedLeaves(shape);
      if (leaves.length === 0) {
        if (shape.type !== 'frame' && shape.type !== 'group') result.skipped.push(shape);
        continue;
      }
      for (const leaf of leaves) {
        if (seen.has(leaf.id)) continue; // a shape and the group it's in, both selected
        seen.add(leaf.id);
        const primitive = leaf.type === 'rect' || leaf.type === 'ellipse';
        if (this.reverseLeaf(leaf)) {
          result.ids.push(leaf.id);
          if (primitive) result.converted++;
        }
      }
    }
    if (result.ids.length === 0) return result;
    // A rect/ellipse came back as a new <path>; the model has to catch up. Selection
    // is by id, and the id carried over.
    if (result.converted) this.host.rebuild();
    this.host.saveHistory();
    this.host.onChange();
    return result;
  }

  private reverseLeaf(shape: ShapeData): boolean {
    const session = this.host.getEditSession();
    if (session && this.host.getEditingId() === shape.id) {
      this.mirrorDependents(shape);
      const edited = directionSourceEl(shape);
      if (edited) for (const tp of textPathsOn(edited.id)) flipTextSpan(tp, edited as unknown as SVGGeometryElement);
      session.reverse();
      this.host.commitPathEdit();
      return true;
    }
    if (shape.type === 'rect' || shape.type === 'ellipse') {
      if (!this.host.convertShapeToPath(shape)) return false;
    }
    const src = directionSourceEl(shape);
    if (!src || !this.rewrite(src)) return false;
    this.mirrorDependents(shape);
    dropParametricAttrs(src); // an arc's data-shape would regenerate the old order on resize
    if (shape.type === 'width') this.host.refreshWidth(shape.element as unknown as SVGElement);
    if (shape.type === 'appearance') this.host.refreshAppearance(shape.element as unknown as SVGElement);
    return true;
  }

  /** Reorder an element's own geometry; false if the result would be the same. */
  private rewrite(el: SVGElement): boolean {
    const tag = el.tagName.toLowerCase();
    if (tag === 'line') {
      const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map(a => el.getAttribute(a) ?? '0');
      if (x1 === x2 && y1 === y2) return false;
      el.setAttribute('x1', x2); el.setAttribute('y1', y2);
      el.setAttribute('x2', x1); el.setAttribute('y2', y1);
      return true;
    }
    if (tag === 'polyline' || tag === 'polygon') {
      const nums = (el.getAttribute('points') ?? '').match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
      const pts: string[] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push(`${nums[i]},${nums[i + 1]}`);
      if (pts.length < 2) return false;
      pts.reverse();
      if (tag === 'polygon') pts.unshift(pts.pop() as string); // a loop keeps its start
      el.setAttribute('points', pts.join(' '));
      return true;
    }
    const d = el.getAttribute('d') ?? '';
    const out = reversePathData(d);
    if (!out || out === d) return false;
    for (const tp of textPathsOn(el.id)) flipTextSpan(tp, el as unknown as SVGGeometryElement);
    el.setAttribute('d', out);
    return true;
  }

  /** What's measured along the path and so has to turn around with it. */
  private mirrorDependents(shape: ShapeData): void {
    const g = shape.element as unknown as SVGElement;
    if (shape.type === 'width') {
      try {
        const pts = JSON.parse(g.getAttribute('data-width-profile') || '[]') as { t: number; w: number }[];
        if (Array.isArray(pts) && pts.length) {
          const mirrored = pts.map(p => ({ ...p, t: 1 - p.t })).sort((a, b) => a.t - b.t);
          g.setAttribute('data-width-profile', JSON.stringify(mirrored));
        }
      } catch { /* an unreadable profile stays as it is */ }
    }
    if (shape.type === 'appearance') {
      // A sideways stroke would otherwise jump sides. See AppearanceLayer.offsetReversed.
      try {
        const layers = JSON.parse(g.getAttribute('data-appearance') || '[]') as AppearanceLayer[];
        if (Array.isArray(layers) && layers.some(l => l.offset || l.offsetReversed)) {
          for (const l of layers) {
            if (!l.offset && !l.offsetReversed) continue;
            if (l.offsetReversed) delete l.offsetReversed; else l.offsetReversed = true;
          }
          g.setAttribute('data-appearance', JSON.stringify(layers));
        }
      } catch { /* as above */ }
    }
  }
}
