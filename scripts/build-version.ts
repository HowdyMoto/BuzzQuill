/** Calendar version: UTC date + time to the millisecond, increasing per build.
 * Unlike a commit count, rebuilding the same commit also gets a new identity.
 */
export function buildIdentity(now: Date, sha: string, development = false) {
  const builtAt = now.toISOString();
  const [date, time] = builtAt.split('T');
  const version = `${date.replaceAll('-', '.')}.${time.replace(/[:.Z]/g, '')}${development ? '-dev' : ''}`;
  return { version, builtAt, sha: /^[a-f0-9]{7,40}$/i.test(sha) ? sha : 'unknown' };
}
