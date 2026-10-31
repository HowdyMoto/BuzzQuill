import { describe, expect, it } from 'vitest';
import { buildIdentity } from '../../scripts/build-version';

describe('release identity', () => {
  const sha = 'a'.repeat(40);
  it('advances when the same commit is rebuilt, including across a day boundary', () => {
    const first = buildIdentity(new Date('2026-10-31T23:59:59.999Z'), sha);
    const next = buildIdentity(new Date('2026-11-01T00:00:00.000Z'), sha);
    expect(first.version).toBe('2026.10.31.235959999');
    expect(next.version).toBe('2026.11.01.000000000');
    expect(next.version > first.version).toBe(true);
    expect(next.sha).toBe(sha);
  });
  it('labels development and rejects non-commit metadata', () => {
    expect(buildIdentity(new Date('2026-10-31T07:00:00.001Z'), '<invalid>', true))
      .toEqual({ version: '2026.10.31.070000001-dev', builtAt: '2026-10-31T07:00:00.001Z', sha: 'unknown' });
  });
});
