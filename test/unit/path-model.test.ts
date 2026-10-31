import { describe, it, expect } from 'vitest';
import { tokenizePath, parsePath, serializePath, scalePathData } from '../../src/core/path-model';

describe('tokenizePath', () => {
  it('splits commands and numeric args', () => {
    expect(tokenizePath('M0 0L10 10')).toEqual([
      { cmd: 'M', args: [0, 0] },
      { cmd: 'L', args: [10, 10] },
    ]);
  });

  it('treats extra coordinate pairs after M as implicit lineto (SVG spec)', () => {
    // "M 0 0 10 10" == moveto (0,0) then lineto (10,10)
    expect(tokenizePath('M0 0 10 10')).toEqual([
      { cmd: 'M', args: [0, 0] },
      { cmd: 'L', args: [10, 10] },
    ]);
  });

  it('handles negative and decimal args without separators', () => {
    expect(tokenizePath('L-1.5-2.5')).toEqual([{ cmd: 'L', args: [-1.5, -2.5] }]);
  });
});

describe('parsePath / serializePath round-trip', () => {
  // Re-serializing an already-normalized path must be a fixed point.
  for (const d of [
    'M 0 0 L 10 0 L 10 10 Z',
    'M 0 0 C 10 0 10 10 0 10 Z',
    'M 5 5 Q 10 0 15 5 T 25 5',
  ]) {
    it(`is idempotent for "${d}"`, () => {
      const once = serializePath(parsePath(d));
      const twice = serializePath(parsePath(once));
      expect(twice).toBe(once);
    });
  }
});

describe('scalePathData', () => {
  const anchorsOf = (d: string) =>
    parsePath(d).subpaths.flatMap((sp) => sp.anchors.map((a) => [a.x, a.y]));

  it('scales anchors about the origin', () => {
    const out = scalePathData('M 0 0 L 10 0 L 10 10', 0, 0, 2, 2);
    expect(anchorsOf(out)).toEqual([[0, 0], [20, 0], [20, 20]]);
  });

  it('scales about an arbitrary fixed point, which stays put', () => {
    const out = scalePathData('M 10 10 L 20 10', 10, 10, 2, 1);
    expect(anchorsOf(out)).toEqual([[10, 10], [30, 10]]);
  });

  it('supports negative (mirroring) scale factors', () => {
    const out = scalePathData('M 0 0 L 10 0', 0, 0, -1, 1);
    expect(anchorsOf(out)).toEqual([[0, 0], [-10, 0]]);
  });

  it('scales cubic control handles along with anchors', () => {
    // Control handles must scale too, or curves distort on resize.
    const out = scalePathData('M 0 0 C 10 0 10 10 0 10', 0, 0, 2, 2);
    const sp = parsePath(out).subpaths[0];
    const end = sp.anchors[sp.anchors.length - 1];
    expect([end.x, end.y]).toEqual([0, 20]);
    // The incoming handle on the end anchor was (10,10) → (20,20).
    expect([end.inX, end.inY]).toEqual([20, 20]);
  });
});
