import { afterEach, expect, it } from 'vitest';
import {
  adoptSource, getDocumentIdentity, getDocSource, getProjectName, hasDiskCopy,
  onDocumentIdentityChange, setProjectName,
} from '../../src/core/document-identity';

afterEach(() => adoptSource(null, null));

it('publishes a complete identity while preserving previously captured identities', () => {
  const source = { kind: 'drive' as const, fileId: 'one', name: 'one.svg', modifiedTime: null };
  adoptSource(source, 'one.svg');
  const captured = getDocumentIdentity();
  const seen: unknown[] = [];
  const unsubscribe = onDocumentIdentityChange(identity => {
    seen.push({ identity, source: getDocSource(), name: getProjectName(), diskCopy: hasDiskCopy() });
  });
  try {
    adoptSource(null, 'download.svg', true);
    expect(seen).toEqual([{
      identity: { source: null, name: 'download.svg', diskCopy: true },
      source: null, name: 'download.svg', diskCopy: true,
    }]);
    expect(captured).toEqual({ source, name: 'one.svg', diskCopy: false });
    expect(Object.isFrozen(getDocumentIdentity())).toBe(true);
  } finally { unsubscribe(); }
  setProjectName('renamed.svg');
  expect(seen).toHaveLength(1);
  expect(getDocumentIdentity()).toEqual({ source: null, name: 'renamed.svg', diskCopy: true });
});
