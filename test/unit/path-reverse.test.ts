import { describe, it, expect } from 'vitest';
import {
  parsePath, serializePath, reversePathData, reverseSubPath, type SubPath,
} from '../../src/core/path-model';

/** A cubic-or-line segment list, each as [p0, c1, c2, p3], for comparing geometry
 *  without caring how it was written. */
type Seg = number[];
function segsOf(sp: SubPath): Seg[] {
  const n = sp.anchors.length;
  const out: Seg[] = [];
  for (let i = 0; i < (sp.closed ? n : n - 1); i++) {
    const a = sp.anchors[i], b = sp.anchors[(i + 1) % n];
    out.push([a.x, a.y, a.outX ?? a.x, a.outY ?? a.y, b.inX ?? b.x, b.inY ?? b.y, b.x, b.y]);
  }
  return out;
}
/** The same segment walked the other way. */
const flipSeg = ([a, b, c, d, e, f, g, h]: Seg): Seg => [g, h, e, f, c, d, a, b];

describe('reversePathData', () => {
  it('runs an open path backwards: first point last, last point first', () => {
    expect(reversePathData('M 0 0 L 10 0 L 10 10')).toBe('M 10 10 L 10 0 L 0 0');
  });

  it('keeps a closed loop on its start point, walked the other way', () => {
    // The start matters: it is a circuit's start line, and a text baseline's origin.
    expect(reversePathData('M 0 0 L 10 0 L 10 10 L 0 10 Z')).toBe('M 0 0 L 0 10 L 10 10 L 10 0 Z');
  });

  it('swaps each anchor\'s handles, so every curve is the same curve', () => {
    const d = 'M 0 0 C 0 5 5 10 10 10 C 15 10 20 5 20 0';
    const before = segsOf(parsePath(d).subpaths[0]);
    const after = segsOf(parsePath(reversePathData(d)).subpaths[0]);
    expect(after).toEqual([...before].reverse().map(flipSeg));
  });

  it('keeps the curved closing segment of a closed loop', () => {
    const d = 'M 0 0 C 10 0 10 10 0 10 C -10 10 -10 0 0 0 Z';
    const before = segsOf(parsePath(d).subpaths[0]);
    const after = segsOf(parsePath(reversePathData(d)).subpaths[0]);
    expect(after).toEqual([...before].reverse().map(flipSeg));
    expect(after[0].slice(0, 2)).toEqual([0, 0]); // same start
  });

  it('reversing twice gives the path back', () => {
    for (const d of [
      'M 0 0 L 10 0 L 10 10',
      'M 0 0 L 10 0 L 10 10 L 0 10 Z',
      'M 0 0 C 0 5 5 10 10 10 C 15 10 20 5 20 0',
      'M 0 0 C 10 0 10 10 0 10 C -10 10 -10 0 0 0 Z',
      'M 0 0 L 10 0 Z M 20 20 L 30 20 L 30 30',
    ]) {
      expect(reversePathData(reversePathData(d))).toBe(serializePath(parsePath(d, 1e-6)));
    }
  });

  it('keeps a compound path\'s runs in order, each one reversed', () => {
    expect(reversePathData('M 0 0 L 10 0 M 20 0 L 30 0'))
      .toBe('M 10 0 L 0 0 M 30 0 L 20 0');
  });

  it('keeps holes as holes: every run of a compound path flips together', () => {
    // Under fill-rule nonzero a hole is a run wound against its outline. Reversing
    // both keeps them opposed; reversing one alone would fill the hole in.
    const d = 'M 0 0 L 100 0 L 100 100 L 0 100 Z M 25 25 L 25 75 L 75 75 L 75 25 Z';
    const area = (sp: SubPath) => sp.anchors.reduce((sum, a, i) => {
      const b = sp.anchors[(i + 1) % sp.anchors.length];
      return sum + a.x * b.y - b.x * a.y;
    }, 0);
    const [outer, hole] = parsePath(reversePathData(d)).subpaths;
    expect(Math.sign(area(outer))).toBe(-Math.sign(area(hole)));
  });

  it('does not lose a small closed loop to the node editor\'s merge tolerance', () => {
    // Artwork in tiny units: the last point is within 0.5 of the first, and is still
    // a real point. MERGE_EPS would have swallowed it.
    expect(reversePathData('M 0 0 L .3 0 L .3 .3 Z')).toBe('M 0 0 L 0.3 0.3 L 0.3 0 Z');
  });

  it('merges an end point that exactly repeats the start of a closed loop', () => {
    expect(reversePathData('M 0 0 L 10 0 L 10 10 L 0 0 Z')).toBe('M 0 0 L 10 10 L 10 0 Z');
  });

  it('leaves a lone point alone', () => {
    expect(reversePathData('M 5 5')).toBe('M 5 5');
  });

  it('never mutates the subpath it is given', () => {
    const sp = parsePath('M 0 0 C 1 1 2 2 3 3').subpaths[0];
    const copy = JSON.parse(JSON.stringify(sp));
    reverseSubPath(sp);
    expect(sp).toEqual(copy);
  });
});

describe('what reversing depends on: reading any path someone else wrote', () => {
  it('reads minified arc flags, which have no separators', () => {
    // SVGO writes "0 015 5" for flags 0,1 and the end point 5,5.
    const spaced = serializePath(parsePath('M0 0 a5 5 0 0 1 5 5'));
    expect(serializePath(parsePath('M0 0a5 5 0 015 5'))).toBe(spaced);
    expect(serializePath(parsePath('M0 0a5 5 0 01.5.5')))
      .toBe(serializePath(parsePath('M0 0 a5 5 0 0 1 .5 .5')));
    expect(serializePath(parsePath('M0 0a5 5 0 1 1 5 5a5 5 0 11-5-5')))
      .toBe(serializePath(parsePath('M0 0 a5 5 0 1 1 5 5 a5 5 0 1 1 -5 -5')));
  });

  it('starts a new run when drawing continues after Z without a moveto', () => {
    // SVG: after Z the next segment starts at the loop's start point.
    const m = parsePath('M 0 0 L 10 0 L 10 10 Z L -5 -5');
    expect(m.subpaths.length).toBe(2);
    expect(m.subpaths[0].closed).toBe(true);
    expect(m.subpaths[0].anchors.length).toBe(3);
    expect(m.subpaths[1].closed).toBe(false);
    expect(m.subpaths[1].anchors.map(a => [a.x, a.y])).toEqual([[0, 0], [-5, -5]]);
  });
});
