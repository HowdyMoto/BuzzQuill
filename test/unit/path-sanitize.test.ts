import { describe, it, expect } from 'vitest';
import { sanitizePathData } from '../../src/core/path-sanitize';

describe('sanitizePathData', () => {
  it('leaves a clean polygon untouched (removed 0, original string returned)', () => {
    const d = 'M 0 0 L 10 0 L 10 10 Z';
    const out = sanitizePathData(d);
    expect(out.removed).toBe(0);
    expect(out.d).toBe(d); // when nothing is removed, the input is returned verbatim
  });

  it('drops a closed subpath collapsed to a point (control points flung out)', () => {
    // All on-curve anchors coincide at (5,5); the C control points shoot to ±100.
    const out = sanitizePathData('M 5 5 C 100 100 -100 -100 5 5 Z');
    expect(out.removed).toBe(1);
    expect(out.d).toBe('');
  });

  it('keeps the good subpath and removes only the degenerate one', () => {
    const out = sanitizePathData('M 0 0 L 10 0 L 10 10 Z M 5 5 C 100 100 -100 -100 5 5 Z');
    expect(out.removed).toBe(1);
    expect(out.d).toContain('L 10 10'); // the real triangle survives
    expect(out.d).not.toContain('C');   // the junk curve is gone
  });

  it('preserves an open line (real extent between anchors)', () => {
    const d = 'M 0 0 L 100 0';
    const out = sanitizePathData(d);
    expect(out.removed).toBe(0);
    expect(out.d).toBe(d);
  });

  it('is a no-op on empty / unparseable input', () => {
    expect(sanitizePathData('')).toEqual({ d: '', removed: 0 });
    expect(sanitizePathData('   ')).toEqual({ d: '   ', removed: 0 });
  });
});
