import { describe, expect, it } from 'vitest';
import { migrateTab, type SessionTab } from '../../src/core/session-store';

// A stand-in for a FileSystemFileHandle: migrateTab only carries it, never calls it.
const handle = { kind: 'file', name: 'poster.svg' } as unknown as FileSystemFileHandle;
const base = { title: 'T', svg: null, view: null, selection: [] };

describe('migrateTab (pre-DocSource session records)', () => {
  it('turns a bare fileHandle into a local source', () => {
    const out = migrateTab({ ...base, fileHandle: handle } as SessionTab);
    expect(out.source).toEqual({ kind: 'local', handle });
    expect('fileHandle' in out).toBe(false);
  });

  it('drops a cloud tether: no source, title kept', () => {
    const out = migrateTab({
      ...base, fileHandle: null,
      cloudDoc: { id: 'x', name: 'Board', updatedAt: '2026-01-01', category: null },
    } as SessionTab);
    expect(out.source).toBeNull();
    expect(out.title).toBe('T');
    expect('cloudDoc' in out).toBe(false);
  });

  it('passes a current-shape record through, including an explicit null source', () => {
    expect(migrateTab({ ...base, source: null }).source).toBeNull();
    const local = { kind: 'local' as const, handle };
    expect(migrateTab({ ...base, source: local }).source).toBe(local);
  });

  it('a legacy record with a handle AND a cloud tether keeps the file', () => {
    const out = migrateTab({ ...base, fileHandle: handle, cloudDoc: { id: 'x' } } as SessionTab);
    expect(out.source).toEqual({ kind: 'local', handle });
  });
});
