import type { AnchorType, PathModel } from './path-model';

/** SVG geometry cannot distinguish aligned independent handles from linked ones.
 * Keep editing intent on the geometry source so history, saves and clones carry it.
 * Coordinate transforms preserve indices; topology edits must rewrite this value. */
export const POINT_MODES_ATTR = 'data-point-modes';
const modes: Record<string, AnchorType> = { c: 'corner', s: 'smooth', b: 'broken' };

export function restorePointModes(model: PathModel, value: string | null | undefined): void {
  if (!value) return;
  const runs = value.split('|');
  if (runs.length !== model.subpaths.length || runs.some((run, i) =>
    run[0] !== (model.subpaths[i].closed ? 'z' : 'o') ||
    run.length !== model.subpaths[i].anchors.length + 1 || !/^[oz][csb]*$/.test(run))) return;
  model.subpaths.forEach((sp, i) => sp.anchors.forEach((a, j) => {
    a.type = modes[runs[i][j + 1]];
    // Cubic serialization may spell a missing handle as the anchor itself.
    if (a.type === 'corner') {
      if (a.inX === a.x && a.inY === a.y) { delete a.inX; delete a.inY; }
      if (a.outX === a.x && a.outY === a.y) { delete a.outX; delete a.outY; }
    }
  }));
}

export function writePointModes(el: Element, model: PathModel): void {
  el.setAttribute(POINT_MODES_ATTR, model.subpaths.map(sp =>
    (sp.closed ? 'z' : 'o') + sp.anchors.map(a => a.type[0]).join('')).join('|'));
}
