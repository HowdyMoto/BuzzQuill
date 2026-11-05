import { describe, it, expect } from 'vitest';
import { PathEditSession } from '../../src/core/path-edit';
import { restorePointModes } from '../../src/core/path-point-modes';

const d = 'M0 0 C20 0 40 0 100 0 C190 0 200 0 250 0';
describe('point mode intent', () => {
  it('keeps Broken independent even after the handles line up', () => {
    const s = new PathEditSession(d); s.selectOnly(0, 1); s.setSelectedType('broken');
    s.moveHandle(0, 1, 'out', 180, 0);
    s.moveHandle(0, 1, 'out', 180, 40);
    const a = s.anchor({ sp: 0, i: 1 })!;
    expect(a.type).toBe('broken'); expect(a.inX).toBe(40); expect(a.inY).toBe(0);
  });
  it('Smooth preserves each existing handle length', () => {
    const s = new PathEditSession(d); s.selectOnly(0, 1); s.setSelectedType('smooth');
    expect(s.anchor({ sp: 0, i: 1 })).toMatchObject({ inX: 40, outX: 190 });
  });
  it('open endpoints only create handles on the side with a segment', () => {
    for (const type of ['smooth', 'broken'] as const) {
      const s = new PathEditSession('M0 0 L100 0'); s.selectOnly(0, 0); s.setSelectedType(type);
      expect(s.anchor({ sp: 0, i: 0 })!.inX).toBeUndefined();
      expect(s.anchor({ sp: 0, i: 0 })!.outX).toBeDefined();
    }
  });
  it('ignores malformed or outdated topology metadata', () => {
    for (const value of ['xbbb', 'ob', 'obbbb', 'obxb', 'zbbb', 'obbb|ob']) {
      const s = new PathEditSession(d, value);
      expect(s.anchor({ sp: 0, i: 1 })!.type).toBe('smooth');
    }
  });
  it('keeps modes attached to points when reversing, inserting and deleting', () => {
    const s = new PathEditSession(d, 'osbb');
    s.reverse(); expect(s.model.subpaths[0].anchors.map(a => a.type)).toEqual(['broken', 'broken', 'smooth']);
    const added = s.insertAt({ sp: 0, seg: 0, t: 0.5 });
    expect(s.model.subpaths[0].anchors[2].type).toBe('broken');
    s.selectOnly(added.sp, added.i); s.deleteSelected();
    expect(s.model.subpaths[0].anchors.map(a => a.type)).toEqual(['broken', 'broken', 'smooth']);
  });
  it('restores a smooth endpoint even though SVG geometry alone cannot infer it', () => {
    const s = new PathEditSession(d); restorePointModes(s.model, 'ossb');
    expect(s.model.subpaths[0].anchors[0].type).toBe('smooth');
  });
});
