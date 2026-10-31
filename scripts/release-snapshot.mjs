import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

const git = (...args) => execFileSync('git', args, { maxBuffer: 32 * 1024 * 1024 });
const destination = process.argv[2];
if (!destination) throw new Error('Usage: npm run release:snapshot -- <new-directory>');
if (git('status', '--porcelain').length) throw new Error('Commit the reviewed changes first; release snapshots require a clean checkout.');
const root = resolve(destination);
if (existsSync(root)) throw new Error('Destination must not exist; no existing files will be overwritten.');
const entries = git('ls-tree', '-r', '-z', '--full-tree', 'HEAD').toString('utf8').split('\0').filter(Boolean).map(row => {
  const [meta, file] = row.split('\t');
  const [mode, type, object] = meta.split(' ');
  const rel = relative(root, resolve(root, file));
  if (type !== 'blob' || !['100644', '100755'].includes(mode) || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Unsupported release entry: ${file}`);
  }
  if (/(?:^|\/)(?:\.git|\.env(?:\..+)?|node_modules|dist|tmp)(?:\/|$)/.test(file) && file !== '.env.example') {
    throw new Error(`Unexpected release input: ${file}`);
  }
  return { file, object };
});
mkdirSync(root, { recursive: true });
const manifest = [];
for (const { file, object } of entries) {
  const bytes = git('cat-file', 'blob', object);
  const target = resolve(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, { flag: 'wx' });
  manifest.push({ file, sha256: createHash('sha256').update(bytes).digest('hex') });
}
writeFileSync(resolve(root, 'RELEASE-MANIFEST.json'), JSON.stringify({ files: manifest }, null, 2) + '\n', { flag: 'wx' });
console.log(`Exported ${manifest.length} committed files without Git history. Scan the snapshot before publishing.`);
