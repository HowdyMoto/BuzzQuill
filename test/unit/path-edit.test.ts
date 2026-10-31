import { describe, it, expect } from 'vitest';
import { PathEditSession } from '../../src/core/path-edit';

// hitSegment used to sample every segment at 24 fixed points, so on a long
// segment a click between two samples found nothing — a double-click on a big
// path inserted no point until you happened to land on a sample.
describe('PathEditSession.hitSegment', () => {
  it('hits a long straight segment anywhere along it', () => {
    const s = new PathEditSession('M 0 0 L 5000 0');
    for (let x = 1; x < 5000; x += 7) {
      const hit = s.hitSegment(x, 3, 7);
      expect(hit, `x=${x}`).not.toBeNull();
      expect(hit!.t * 5000).toBeCloseTo(x, 0);
    }
    expect(s.hitSegment(2500, 20, 7)).toBeNull();
  });

  it('hits a long curve anywhere along it, with t where the click was', () => {
    const s = new PathEditSession('M 0 0 C 1500 -800 3500 800 5000 0');
    const at = (t: number) => { const u = 1 - t; return { x: 3 * u * u * t * 1500 + 3 * u * t * t * 3500 + t * t * t * 5000, y: 3 * u * u * t * -800 + 3 * u * t * t * 800 }; };
    for (let t = 0.01; t < 1; t += 0.013) {
      const p = at(t);
      const hit = s.hitSegment(p.x + 2, p.y + 2, 7);
      expect(hit, `t=${t}`).not.toBeNull();
      expect(Math.abs(hit!.t - t)).toBeLessThan(0.005);
    }
    expect(s.hitSegment(2500, 900, 7)).toBeNull();
  });

  it('picks the nearest of several segments', () => {
    const s = new PathEditSession('M 0 0 L 1000 0 L 1000 1000');
    expect(s.hitSegment(999, 400, 7)!.seg).toBe(1);
    expect(s.hitSegment(400, 1, 7)!.seg).toBe(0);
  });
});
