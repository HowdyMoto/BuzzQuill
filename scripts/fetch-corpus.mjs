#!/usr/bin/env node
/**
 * Download the SVG test corpus from Wikimedia Commons.
 *
 * The corpus is a set of large, real-world SVGs (maps, coats of arms, matplotlib
 * figures) used to stress the importer. They are NOT committed to git — only
 * `test/corpus/corpus.json` (the manifest) is. Run this once (and in CI) to
 * populate `test/corpus/svg/` before running `npm test`.
 *
 *   node scripts/fetch-corpus.mjs           # fetch any missing/changed files
 *   node scripts/fetch-corpus.mjs --force   # re-download everything
 *
 * Files are pulled via Special:FilePath (stable, filename-only) and verified
 * against the sha256 pinned in the manifest. A checksum mismatch means Commons
 * has a newer revision than the tests were written against — it's reported, not
 * silently accepted, so corpus drift is visible.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'test/corpus/corpus.json');
// Wikimedia asks bots/scripts to send a descriptive UA with contact info.
const UA = 'BuzzQuill-corpus-fetcher/1.0 (https://github.com/HowdyMoto/SVGMaker; test corpus)';
const force = process.argv.includes('--force');

const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const destDir = join(ROOT, manifest.destDir);
mkdirSync(destDir, { recursive: true });

let fetched = 0, skipped = 0, failed = 0, drifted = 0;

for (const entry of manifest.files) {
  const dest = join(destDir, entry.file);

  if (!force && existsSync(dest) && statSync(dest).size === entry.bytes) {
    if (sha256(readFileSync(dest)) === entry.sha256) { skipped++; console.log(`✓ ${entry.file} (present)`); continue; }
  }

  process.stdout.write(`↓ ${entry.file} … `);
  try {
    // Polite pacing so we don't trip Commons rate limits (HTTP 429).
    await sleep(1200);
    const res = await fetch(entry.url, { headers: { 'User-Agent': UA, 'Accept': 'image/svg+xml,*/*' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = sha256(buf);
    writeFileSync(dest, buf);
    if (got === entry.sha256) {
      console.log(`ok (${(buf.length / 1e6).toFixed(1)}MB)`);
      fetched++;
    } else {
      console.log(`ok but CHECKSUM DRIFT (${(buf.length / 1e6).toFixed(1)}MB)`);
      console.log(`    manifest sha256: ${entry.sha256}`);
      console.log(`    downloaded     : ${got}`);
      console.log(`    → Commons has a newer revision. Review, then update corpus.json if intended.`);
      fetched++; drifted++;
    }
  } catch (err) {
    console.log(`FAILED — ${err.message}`);
    console.log(`    try manually: ${entry.url}`);
    failed++;
  }
}

console.log(`\nCorpus: ${fetched} fetched, ${skipped} present, ${failed} failed${drifted ? `, ${drifted} drifted` : ''}.`);
console.log(`Location: ${manifest.destDir}/`);
if (failed) process.exitCode = 1;
