/** Retire browser credentials from the removed account integration, without
 * touching artwork, preferences, file handles or the current Drive token. */
export function clearRetiredCredentials(storage: Storage): void {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && /^sb-[a-z0-9]{20}-auth-token(?:-code-verifier)?$/.test(key)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

export function retireBrowserCredentials(): void {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    try { clearRetiredCredentials(window[name]); }
    catch { /* Storage can be blocked; local editing must still start. */ }
  }
}
