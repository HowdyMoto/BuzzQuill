import { describe, it, expect } from 'vitest';
import { detailEvictions } from '../../src/core/raster-detail-budget';

describe('resident and pending image detail budget', () => {
  it('reserves before replacing uneven crops and remains safe if decoding is cancelled', () => {
    const resident = [{ key: 'a', pixels: 1, stale: true }, { key: 'b', pixels: 31, stale: true }];
    const evicted = detailEvictions(resident, 31, 32)!;
    expect(evicted).toEqual(['b']);
    const remaining = resident.filter(r => !evicted.includes(r.key)).reduce((n, r) => n+r.pixels, 0);
    expect(remaining + 31).toBeLessThanOrEqual(32);
    expect(remaining).toBeLessThanOrEqual(32); // a cancelled decode cannot strand excess resident pixels
    expect(detailEvictions([{ key: 'a', pixels: 31, stale: false }], 1, 32)).toEqual([]);
  });
  it('keeps reusable detail when obsolete detail can provide the reservation', () => {
    expect(detailEvictions([{ key: 'keep', pixels: 20, stale: false }, { key: 'old', pixels: 10, stale: true }], 10, 32)).toEqual(['old']);
  });
  it('rejects a crop larger than the entire budget and needs no reservation for cache hits', () => {
    expect(detailEvictions([], 33, 32)).toBeNull();
    expect(detailEvictions([{ key: 'keep', pixels: 32, stale: false }], 0, 32)).toEqual([]);
  });
});
