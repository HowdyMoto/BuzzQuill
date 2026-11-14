import { describe, it, expect } from 'vitest';
import { PathEditSession } from '../../src/core/path-edit';

const loop = 'M0 0 C10 20 20 30 30 30 C40 30 50 0 60 0 C70 0 80 20 90 30 C80 60 -10 20 0 0 Z';
describe('break and extract a closed segment', () => {
  for (const picks of [[1, 2], [2, 1], [3, 0], [0, 3]]) {
    it(`preserves the other curves and selected endpoints for ${picks}`, () => {
      const s = new PathEditSession(loop + ' M200 200 L250 250');
      const before = structuredClone(s.model);
      s.selectOnly(0, picks[0]); s.addSelect(0, picks[1]);
      const extracted = s.extractSelectedSegment()!;
      const start = picks.includes(3) ? 3 : 1;
      const end = (start + 1) % 4;
      expect(extracted.subpaths[0].anchors[0].outX).toBe(before.subpaths[0].anchors[start].outX);
      expect(extracted.subpaths[0].anchors[1].inX).toBe(before.subpaths[0].anchors[end].inX);
      expect(s.model.subpaths[0].closed).toBe(false);
      expect(s.model.subpaths[0].anchors).toHaveLength(4);
      expect(s.model.subpaths[1]).toEqual(before.subpaths[1]);
      const a = s.model.subpaths[0].anchors;
      expect(a[0].x).toBe(before.subpaths[0].anchors[end].x);
      expect(a[3].x).toBe(before.subpaths[0].anchors[start].x);
      expect(a[0].inX).toBeUndefined(); expect(a[3].outX).toBeUndefined();
      for (let i = 0; i < 3; i++) {
        expect(a[i].outX).toBe(before.subpaths[0].anchors[(end + i) % 4].outX);
        expect(a[i + 1].inX).toBe(before.subpaths[0].anchors[(end + i + 1) % 4].inX);
      }
      expect([...s.selected]).toEqual(['0:0', '0:3']);
    });
  }
  it('rejects ambiguous or invalid selections without mutation', () => {
    for (const [d, picks] of [[loop, ['0:0', '0:2']], [loop, ['0:1']],
      ['M0 0 L30 30', ['0:0', '0:1']], ['M0 0 L30 30 Z', ['0:0', '0:1']],
      [loop + ' M100 100 L120 120', ['0:0', '1:0']]] as const) {
      const s = new PathEditSession(d); const before = s.commit();
      s.selected = new Set(picks);
      expect(s.breakSelectedSegment()).toBe(false);
      expect(s.extractSelectedSegment()).toBeNull();
      expect(s.commit()).toBe(before);
    }
  });
});
