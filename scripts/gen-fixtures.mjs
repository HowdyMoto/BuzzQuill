#!/usr/bin/env node
/**
 * Generates the curated SVG feature/edge-case fixtures under test/fixtures/svg/
 * plus test/fixtures/fixtures.json (per-file focus + expectations).
 *
 * Unlike the large downloaded corpus, these are small, committed, deterministic
 * files that each isolate ONE behaviour so a failure points straight at a cause.
 * Run: node scripts/gen-fixtures.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'test/fixtures/svg');
mkdirSync(DIR, { recursive: true });

const svg = (body, attrs = 'viewBox="0 0 100 100"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>\n${body}\n</svg>\n`;

// Each fixture: { name, focus, svg, expect }
// expect fields (all optional): rendersBlank, strippedTags[], noScript, noOnHandlers,
// noJavascriptHrefs, maxElements, effectiveFill{id,value}, refsAllResolve, knownIssue
const F = [];
const add = (name, focus, body, expect = {}, attrs) => F.push({ name, focus, svg: svg(body, attrs), expect });

// ---- Paint ----
add('gradient-linear-transform', 'linearGradient + gradientTransform',
  `<defs><linearGradient id="g" gradientTransform="rotate(45)"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>
  <rect width="100" height="100" fill="url(#g)"/>`);
add('gradient-radial-focal', 'radialGradient with focal point (fx/fy/fr)',
  `<defs><radialGradient id="g" cx="0.5" cy="0.5" r="0.5" fx="0.25" fy="0.25"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient></defs>
  <circle cx="50" cy="50" r="50" fill="url(#g)"/>`);
add('pattern-nested-transform', 'pattern referencing pattern + patternTransform',
  `<defs><pattern id="base" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#333"/></pattern>
  <pattern id="p" width="20" height="20" patternUnits="userSpaceOnUse" patternTransform="rotate(20)"><rect width="20" height="20" fill="url(#base)"/></pattern></defs>
  <rect width="100" height="100" fill="url(#p)"/>`);
add('mesh-gradient', 'SVG2 meshgradient (Inkscape) — round-trip of an unusual def',
  `<defs><meshgradient id="m" x="0" y="0" gradientUnits="userSpaceOnUse">
    <meshrow><meshpatch>
      <stop path="C 25,0 75,0 100,0" stop-color="#f00"/>
      <stop path="C 100,25 100,75 100,100" stop-color="#0f0"/>
      <stop path="C 75,100 25,100 0,100" stop-color="#00f"/>
      <stop path="C 0,75 0,25 0,0" stop-color="#ff0"/>
    </meshpatch></meshrow>
  </meshgradient></defs>
  <rect width="100" height="100" fill="url(#m)"/><rect width="100" height="100" fill="#eee" opacity="0"/>`);
add('paint-currentcolor', 'currentColor inheritance',
  `<g color="#c33"><rect width="100" height="100" fill="currentColor"/></g>`);
add('paint-order', 'paint-order: stroke fill',
  `<text x="10" y="60" font-size="40" stroke="#000" stroke-width="4" fill="#fc0" paint-order="stroke" style="paint-order:stroke">A</text>`);

// ---- Text ----
add('text-on-path', 'textPath referencing a path',
  `<defs><path id="curve" d="M10,80 Q50,10 90,80"/></defs>
  <text font-size="14"><textPath xlink:href="#curve">Hello on a path</textPath></text>`,
  { refsAllResolve: true });
add('text-tspan-positioning', 'tspan dx/dy/rotate per-glyph',
  `<text x="10" y="50" font-size="20"><tspan dx="0 2 4 6" dy="0 -2 2 -2" rotate="0 10 -10 0">Wavy</tspan></text>`);
add('text-rtl-bidi', 'RTL / bidi text round-trip',
  `<text x="90" y="50" font-size="18" direction="rtl" text-anchor="end">שלום עולם مرحبا</text>`);
// U+00A0 must serialize as &#160;, not the HTML-only &nbsp; (invalid XML on reload).
add('text-nbsp', 'non-breaking space (U+00A0) round-trips as valid XML',
  `<text x="10" y="50" font-size="16">a b c</text>`);
add('text-vertical-cjk', 'vertical writing-mode + CJK',
  `<text x="50" y="10" font-size="18" style="writing-mode:vertical-rl">日本語のテキスト</text>`);

// ---- Filters ----
add('filter-primitives', 'feColorMatrix/feOffset/feFlood/feMerge/feComposite',
  `<defs><filter id="f" x="-20%" y="-20%" width="140%" height="140%">
    <feFlood flood-color="#0008" result="a"/>
    <feOffset in="SourceAlpha" dx="3" dy="3" result="o"/>
    <feColorMatrix in="o" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.5 0" result="s"/>
    <feMerge><feMergeNode in="s"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter></defs>
  <rect x="20" y="20" width="60" height="60" fill="#39f" filter="url(#f)"/>`);
add('filter-turbulence-displace', 'feTurbulence + feDisplacementMap',
  `<defs><filter id="f"><feTurbulence type="turbulence" baseFrequency="0.05" numOctaves="2" result="t"/><feDisplacementMap in="SourceGraphic" in2="t" scale="10"/></filter></defs>
  <rect x="10" y="10" width="80" height="80" fill="#3a3" filter="url(#f)"/>`);
add('filter-dropshadow', 'feDropShadow shorthand primitive',
  `<defs><filter id="f"><feDropShadow dx="3" dy="3" stdDeviation="2" flood-color="#000a"/></filter></defs>
  <circle cx="50" cy="50" r="35" fill="#fa0" filter="url(#f)"/>`);

// ---- Markers ----
add('markers-arrowheads', 'marker-start/mid/end',
  `<defs><marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#222"/></marker></defs>
  <polyline points="10,80 40,20 70,80 90,30" fill="none" stroke="#222" stroke-width="3" marker-start="url(#arrow)" marker-mid="url(#arrow)" marker-end="url(#arrow)"/>`);

// ---- Structure / references ----
add('use-chain', 'use -> use -> shape reference chain',
  `<defs><circle id="c" cx="0" cy="0" r="8" fill="#e44"/><use id="u1" xlink:href="#c"/></defs>
  <use xlink:href="#u1" x="30" y="30"/><use xlink:href="#u1" x="70" y="70"/>`,
  { refsAllResolve: true });
add('use-symbol-viewbox', 'symbol with viewBox + use sizing',
  `<defs><symbol id="star" viewBox="0 0 10 10"><path d="M5,0 6,4 10,4 7,6 8,10 5,7 2,10 3,6 0,4 4,4z" fill="#fb0"/></symbol></defs>
  <use xlink:href="#star" x="10" y="10" width="40" height="40"/><use xlink:href="#star" x="50" y="50" width="40" height="40"/>`,
  { refsAllResolve: true });
add('nested-svg-viewbox', 'inner <svg> with its own viewBox',
  `<rect width="100" height="100" fill="#eef"/><svg x="20" y="20" width="60" height="60" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#48c"/></svg>`);
add('image-svg-datauri', '<image> of an SVG data URI',
  `<image x="10" y="10" width="80" height="80" xlink:href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCI+PHJlY3Qgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjM2E5Ii8+PC9zdmc+"/>`);
add('clippath-mask-combo', 'clipPath + mask on the same element',
  `<defs><clipPath id="cp"><circle cx="50" cy="50" r="45"/></clipPath><mask id="mk"><rect width="100" height="100" fill="#fff"/><rect x="40" width="20" height="100" fill="#000"/></mask></defs>
  <rect width="100" height="100" fill="#c39" clip-path="url(#cp)" mask="url(#mk)"/>`);

// ---- CSS cascade (our known weak spot) ----
add('css-stylesheet-only', 'styling only via <style> classes (no inline)',
  `<style>.box{fill:#06c} .ring{stroke:#063;stroke-width:4}</style>
  <rect id="r" class="box ring" x="10" y="10" width="80" height="80"/>`,
  { effectiveFill: { id: 'r', value: 'rgb(0, 102, 204)' } });
// The correct render is GREEN: inline style outranks a class rule. The cascade-
// preserving flattenInlineStyle must keep it green (it used to invert this to red
// by demoting the inline style to a presentation attribute).
add('css-class-vs-inline', 'inline style must beat a competing class rule',
  `<style>.c{fill:red}</style>
  <rect id="r" class="c" style="fill:green" x="10" y="10" width="80" height="80"/>`,
  { effectiveFill: { id: 'r', value: 'rgb(0, 128, 0)' } });

// ---- Robustness / adversarial ----
add('entity-expansion-bounded', 'nested DTD entity expansion stays bounded',
  `<text x="5" y="50" font-size="4">&d;</text>`,
  { maxElements: 50, parserMayReject: true },
  `viewBox="0 0 100 100"`);
F[F.length - 1].svg = `<?xml version="1.0"?>
<!DOCTYPE svg [
  <!ENTITY a "AAAAAAAAAA">
  <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
  <!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
  <!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">
]>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="5" y="50" font-size="4">&d;</text></svg>
`;
add('use-self-reference', 'self-referential <use> must not hang',
  `<defs><g id="a"><rect width="10" height="10" fill="#999"/><use xlink:href="#a"/></g></defs><use xlink:href="#a" x="20" y="20"/>`);
add('broken-references', 'dangling url(#…) / href refs do not crash',
  `<rect width="100" height="100" fill="url(#missing)" stroke="#000"/>
  <rect x="20" y="20" width="60" height="60" fill="#7a7" clip-path="url(#nope)" filter="url(#gone)"/>
  <use xlink:href="#ghost"/>`);
add('duplicate-ids', 'duplicate element ids do not crash import',
  `<rect id="dup" width="40" height="40" fill="#a33"/><rect id="dup" x="50" y="50" width="40" height="40" fill="#33a"/>`);

// deep nesting (built programmatically)
{
  let body = '<rect width="100" height="100" fill="#efe"/>';
  let open = '', close = '';
  for (let i = 0; i < 400; i++) { open += `<g transform="translate(0,0)">`; close = `</g>` + close; }
  add('deep-nesting', '400-deep nested groups (recursion safety)', open + '<circle cx="50" cy="50" r="20" fill="#494"/>' + close + body);
}
// one huge path
{
  let d = 'M0,50';
  for (let i = 1; i <= 8000; i++) d += ` L${(i * 0.0125).toFixed(3)},${(50 + 40 * Math.sin(i / 50)).toFixed(2)}`;
  add('huge-single-path', 'one path with ~8k vertices', `<path d="${d}" fill="none" stroke="#225" stroke-width="0.3"/>`);
}

// ---- Degradation / security (sanitizer) ----
add('smil-animation', 'SMIL animation is stripped, static art survives',
  `<rect width="100" height="100" fill="#69c"><animate attributeName="fill" values="#69c;#c96;#69c" dur="2s" repeatCount="indefinite"/></rect>
  <circle cx="50" cy="50" r="20" fill="#fff"><animateTransform attributeName="transform" type="rotate" from="0 50 50" to="360 50 50" dur="3s" repeatCount="indefinite"/></circle>`,
  { strippedTags: ['animate', 'animatetransform'] });
add('foreignobject-content', 'foreignObject visible content is stripped (known limitation)',
  `<foreignObject x="5" y="5" width="90" height="90"><div xmlns="http://www.w3.org/1999/xhtml" style="background:#9c6;height:100%">HTML content</div></foreignObject>`,
  { strippedTags: ['foreignobject'], rendersBlank: true, knownIssue: 'foreignObject is the only content; stripped for security → renders blank' });
add('security-injection', 'scripts, event handlers, javascript: hrefs are stripped',
  `<script>window.__pwned=1</script>
  <rect width="100" height="100" fill="#ccc" onload="window.__pwned=1" onclick="window.__pwned=1"/>
  <a xlink:href="javascript:window.__pwned=1"><circle cx="50" cy="50" r="20" fill="#e55"/></a>
  <image x="0" y="0" width="10" height="10" xlink:href="javascript:1"/>`,
  { noScript: true, noOnHandlers: true, noJavascriptHrefs: true });

// Write files + manifest
const manifest = { destDir: 'test/fixtures/svg', files: [] };
for (const f of F) {
  writeFileSync(join(DIR, `${f.name}.svg`), f.svg);
  manifest.files.push({ file: `${f.name}.svg`, focus: f.focus, expect: f.expect });
}
writeFileSync(join(ROOT, 'test/fixtures/fixtures.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote ${F.length} fixtures + manifest to test/fixtures/`);
