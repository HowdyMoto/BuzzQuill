#!/usr/bin/env node
/**
 * Download the W3C SVG 1.1 (Second Edition) conformance test suite for the broad
 * "smoke" tier — hundreds of real spec-conformance files we run generic
 * load/round-trip assertions over (test/smoke.spec.ts).
 *
 * Authoritative (the spec owner's own fixtures) and broad. Files are NOT committed
 * (gitignored); run once: `npm run smoke:fetch`. License: W3C Test Suite License
 * (BSD-3-Clause-style) — see https://www.w3.org/Graphics/SVG/Test/.
 *
 * Requires `tar` on PATH (present on macOS/Linux/Windows 10+).
 */
import { mkdirSync, existsSync, readdirSync, copyFileSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'test/smoke/svg');
const URL = 'https://www.w3.org/Graphics/SVG/Test/20110816/archives/W3C_SVG_11_TestSuite.tar.gz';
const UA = 'BuzzQuill-smoke-fetcher/1.0 (https://github.com/HowdyMoto/SVGMaker; test suite)';
const force = process.argv.includes('--force');

if (!force && existsSync(DEST) && readdirSync(DEST).some(f => f.endsWith('.svg'))) {
  console.log(`✓ smoke suite already present (${readdirSync(DEST).filter(f => f.endsWith('.svg')).length} files). Use --force to refresh.`);
  process.exit(0);
}

const tmp = join(ROOT, 'test/smoke/.cache');
mkdirSync(tmp, { recursive: true });
const tarball = join(tmp, 'w3c-svg11.tar.gz');

console.log('↓ downloading W3C SVG 1.1 test suite (~14MB) …');
const res = await fetch(URL, { headers: { 'User-Agent': UA }, redirect: 'follow' });
if (!res.ok) { console.error(`Download failed: HTTP ${res.status}`); process.exit(1); }
await pipeline(Readable.fromWeb(res.body), createWriteStream(tarball));

console.log('extracting …');
const extracted = join(tmp, 'extracted');
mkdirSync(extracted, { recursive: true });
// Only the canonical top-level svg/ test files (skip harness/svgweb duplicates).
execFileSync('tar', ['-xzf', tarball, '-C', extracted, 'svg'], { stdio: 'ignore' });

mkdirSync(DEST, { recursive: true });
const srcDir = join(extracted, 'svg');
let n = 0;
for (const f of readdirSync(srcDir)) {
  if (f.endsWith('.svg')) { copyFileSync(join(srcDir, f), join(DEST, f)); n++; }
}

writeFileSync(join(ROOT, 'test/smoke/smoke.json'), JSON.stringify({
  $comment: 'Broad SVG smoke tier — generic load/round-trip assertions over the W3C suite. Files gitignored; fetch with `npm run smoke:fetch`.',
  source: URL,
  license: 'W3C Test Suite License (BSD-3-Clause-style) — https://www.w3.org/Graphics/SVG/Test/',
  files: n,
}, null, 2) + '\n');

rmSync(tmp, { recursive: true, force: true });
console.log(`✓ ${n} SVG files → test/smoke/svg/`);
