import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const parts = ['Third-party software and font notices', 'Generated from package-lock.json. Each component retains its own license.', ''];
for (const [path, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!path || entry.dev || entry.optional) continue;
  if (entry.optional && !existsSync(join(path, 'package.json'))) continue;
  const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
  const license = pkg.license ?? entry.license;
  if (!license) throw new Error(`Missing license declaration: ${pkg.name}`);
  const names = readdirSync(path).filter(n => /^(?:licen[sc]e|copying|copyright|notice|ofl)(?:[.-].*)?$/i.test(n));
  // Some font packages keep OFL in a dedicated directory.
  if (existsSync(join(path, 'LICENSES'))) {
    for (const name of readdirSync(join(path, 'LICENSES'))) names.push(`LICENSES/${name}`);
  }
  if (!names.length) throw new Error(`Missing license text: ${pkg.name}`);
  parts.push('='.repeat(72), `${pkg.name}@${pkg.version}`, `License: ${typeof license === 'string' ? license : JSON.stringify(license)}`, '');
  for (const name of names.sort()) parts.push(`--- ${name} ---`, readFileSync(join(path, name), 'utf8'), '');
}
writeFileSync('public/third-party-notices.txt', parts.join('\n'));
console.log('Generated notices for production JavaScript and font packages (native optional/build tools are not browser assets).');
