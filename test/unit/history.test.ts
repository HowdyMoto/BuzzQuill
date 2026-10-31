import { describe, it, expect } from 'vitest';
import { History } from '../../src/core/history';

// A test harness: `setNext` controls the entry the next save() will capture,
// `restored` records what restore() was handed.
function makeHistory(max?: number, maxBytes?: number) {
  let next = { svgContent: '', selectedId: null as string | null, artboardsJson: '[]' };
  const restored: { svgContent: string }[] = [];
  const h = new History(() => ({ ...next }), (e) => { restored.push(e); }, max, maxBytes);
  const save = (svgContent: string) => { next = { svgContent, selectedId: null, artboardsJson: '' }; h.save(); };
  return { h, save, restored };
}

describe('History entry-count cap', () => {
  it('keeps only the most recent `max` entries', () => {
    const { h, save } = makeHistory(3, Infinity);
    save('a'); save('b'); save('c'); save('d'); save('e');
    // 5 saved, cap 3 → can undo twice then stops (3 entries: c,d,e).
    expect(h.undo()).toBe(true);
    expect(h.undo()).toBe(true);
    expect(h.undo()).toBe(false); // only 3 entries remain
  });
});

describe('History byte cap', () => {
  it('evicts oldest entries over the memory budget, keeping at least two', () => {
    // Budget 100 chars; each entry is 40 chars → at most 2 fit.
    const { h, save } = makeHistory(100, 100);
    const big = 'x'.repeat(40);
    save(big); save(big); save(big); save(big);
    // Always trimmed back to the last two → exactly one undo available.
    expect(h.undo()).toBe(true);
    expect(h.undo()).toBe(false);
  });

  it('does not evict below two entries even if a single doc exceeds the budget', () => {
    const { h, save } = makeHistory(100, 10);
    save('x'.repeat(50)); // already over budget alone
    save('y'.repeat(50));
    expect(h.undo()).toBe(true);  // two kept → one undo works
    expect(h.undo()).toBe(false);
  });

  it('restores the correct entry after byte eviction', () => {
    const { h, save, restored } = makeHistory(100, 100);
    const big = (c: string) => c.repeat(40);
    save(big('a')); save(big('b')); save(big('c')); // → keeps [b, c]
    h.undo();
    expect(restored.at(-1)?.svgContent).toBe(big('b'));
  });
});

describe('History dirty tracking survives eviction', () => {
  it('keeps `dirty` correct as the saved baseline scrolls off', () => {
    const { h, save } = makeHistory(3, Infinity);
    save('a');
    h.markClean();            // baseline = current
    expect(h.dirty).toBe(false);
    save('b');
    expect(h.dirty).toBe(true);
    save('c'); save('d');     // 'a' (the baseline) is evicted by the count cap
    // Baseline scrolled off → never clean again without an explicit markClean.
    expect(h.dirty).toBe(true);
  });
});
