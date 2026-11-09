import { describe, it, expect } from 'vitest';
import { PathEditSession } from '../../src/core/path-edit';

const curve = 'M0 0 C10 20 20 30 30 30 C40 30 50 0 60 0 C70 0 80 20 90 30';
describe('straighten one segment', () => {
  it('preserves neighboring handles and anchors, regardless of selection order', () => {
    const s = new PathEditSession(curve);
    const before = structuredClone(s.model.subpaths[0].anchors);
    s.selectOnly(0, 2); s.addSelect(0, 1);
    expect(s.straightenSelectedSegment()).toBe(true);
    const a = s.model.subpaths[0].anchors;
    expect(a[0]).toEqual(before[0]); expect(a[3]).toEqual(before[3]);
    const { outX: _x, outY: _y, ...left } = before[1];
    const { inX: _i, inY: _j, ...right } = before[2];
    expect(a[1]).toEqual({ ...left, type: 'broken' });
    expect(a[2]).toEqual({ ...right, type: 'broken' });
    expect(s.commit()).toContain('L 60 0');
    expect(s.straightenSelectedSegment()).toBe(false);
    s.moveHandle(0, 1, 'in', 15, 25);
    expect(a[1].outX).toBeUndefined();
  });
  it('handles the closing segment without changing either adjacent curve', () => {
    const s = new PathEditSession(curve + ' C80 60 -10 20 0 0 Z');
    const before = structuredClone(s.model.subpaths[0].anchors);
    s.selectOnly(0, 0); s.addSelect(0, 3);
    expect(s.straightenSelectedSegment()).toBe(true);
    const a = s.model.subpaths[0].anchors;
    expect(a[0].outX).toBe(before[0].outX); expect(a[3].inX).toBe(before[3].inX);
    expect(a[0].inX).toBeUndefined(); expect(a[3].outX).toBeUndefined();
    expect(a.slice(1, 3)).toEqual(before.slice(1, 3));
  });
  it('rejects nonadjacent, cross-subpath, and ambiguous closed pairs without changes', () => {
    for (const [d, picks] of [[curve, ['0:0', '0:2']], [curve, ['0:1']],
      [curve + ' M100 100 L120 100', ['0:1', '1:0']],
      ['M0 0 C10 20 20 20 30 0 C20 -20 10 -20 0 0 Z', ['0:0', '0:1']]] as const) {
      const s = new PathEditSession(d); const before = s.commit();
      s.selected = new Set(picks);
      expect(s.straightenSelectedSegment()).toBe(false); expect(s.commit()).toBe(before);
    }
  });
});
