import { describe, it, expect } from 'vitest';
import { clearRetiredCredentials } from '../../src/core/legacy-session-cleanup';

describe('retired browser credentials', () => {
  it('removes only retired auth keys, preserving documents and current Drive credentials', () => {
    const data = new Map([
      ['sb-abcdefghijklmnopqrst-auth-token', 'dummy old session'],
      ['sb-abcdefghijklmnopqrst-auth-token-code-verifier', 'dummy verifier'],
      ['bq-drive-token', 'dummy current token'], ['preferences', '{}'], ['document', '<svg/>'],
    ]);
    const storage = { get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null, removeItem: (key: string) => { data.delete(key); } } as Storage;
    clearRetiredCredentials(storage);
    expect([...data.keys()]).toEqual(['bq-drive-token', 'preferences', 'document']);
    clearRetiredCredentials(storage);
    expect(data.size).toBe(3);
  });
});
