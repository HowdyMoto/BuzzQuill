import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// A fast repository guard, complemented by the independent Gitleaks CI job.
// Print locations/rule names only, never a matched credential.
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const rules = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ['Google OAuth secret', /GOCSPX-[A-Za-z0-9_-]{20,}/],
  ['provider token', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sb_secret_[A-Za-z0-9_-]{15,})/],
  ['Google bearer token', /ya29\.[A-Za-z0-9_-]{20,}/],
  ['AWS credential', /(?:AKIA|ASIA)[A-Z0-9]{16}/],
  ['webhook credential', /https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/],
  ['credential URL', /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/@:]+:[^\s/@]+@/],
];
let failed = false;
for (const file of new Set(files)) {
  if (/(?:^|\/)(?:\.env(?:\..+)?|credentials\.json|secrets\.json|service-account.*\.json)$/.test(file)
      && !/^\.env\.(?:example|sample|template)$/.test(file)) {
    console.error(`${file}: private configuration filename`); failed = true;
  }
  const text = readFileSync(file).toString('utf8');
  for (const [rule, pattern] of rules) {
    if (pattern.test(text)) { console.error(`${file}: ${rule}`); failed = true; }
  }
  for (const token of text.matchAll(/eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g)) {
    try {
      const claims = JSON.parse(Buffer.from(token[0].split('.')[1], 'base64url').toString());
      if (claims.role !== 'anon') { console.error(`${file}: non-public JWT`); failed = true; }
    } catch { console.error(`${file}: unclassified JWT`); failed = true; }
  }
}
if (failed) process.exitCode = 1;
else console.log(`Secret guard passed (${new Set(files).size} files; matched values are never printed).`);
