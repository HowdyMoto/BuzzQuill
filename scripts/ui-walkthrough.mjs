/**
 * UI walkthrough — drives the app the way a PERSON does.
 *
 * scripts/smoke.mjs asserts against the model; this drives the actual interface:
 * toolbar clicks, mouse drags to draw, marquee select, context menus, real typing.
 * The only page.evaluate calls READ state to assert — never to set anything up.
 *
 * That distinction matters. This harness has caught bugs the model-level checks
 * structurally cannot, because they are about what the screen SHOWS: a CSS escape
 * that rendered as "□ 92" instead of an arrow, a panel frozen by a pointerdown
 * guard so it displayed stale state, and success toasts wearing a warning triangle.
 *
 * Usage:
 *   npm run dev -- --port 5300 --strictPort
 *   node scripts/ui-walkthrough.mjs 5300 ./out          # headed (watch it)
 *   node scripts/ui-walkthrough.mjs 5300 ./out headless # CI
 *
 * Screenshots land in the output directory, numbered per step. Exit 0 = clean.
 */
// Resolve Playwright from the project's own node_modules (portable across machines).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); }
catch { pw = (await import('playwright')).default; }
const { chromium } = pw;

const PORT = process.argv[2] ?? '5390';
const DIR = process.argv[3] ?? '.';
const HEADED = process.argv[4] !== 'headless';

const errors = [];
let step = 0;
const fails = [];
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { console.error(`  FAIL ${m}`); fails.push(m); };

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: !HEADED, slowMo: HEADED ? 120 : 0 });
  console.log('Using installed Google Chrome\n');
} catch {
  browser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 120 : 0 });
  console.log('Google Chrome not found — using bundled Chromium\n');
}
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

const shot = async (name) => { await page.screenshot({ path: `${DIR}/chrome-${String(++step).padStart(2, '0')}-${name}.png` }); };

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.state);
await page.waitForTimeout(400);

// Where is the canvas? Draw inside the default frame so shapes land somewhere sane.
const box = await page.locator('#svg-canvas').boundingBox();
const at = (dx, dy) => ({ x: box.x + dx, y: box.y + dy });

const drag = async (from, to) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(180);
};

console.log('STEP 1 — draw the tile artwork with the real tools');
await page.click('[data-tool="rect"]');
await drag(at(420, 300), at(470, 350));
await page.click('[data-tool="ellipse"]');
await drag(at(480, 360), at(520, 400));
await shot('artwork-drawn');
const drawn = await page.evaluate(() => window.state.shapes.length);
drawn >= 1 ? ok(`drew artwork with the toolbar (${drawn} top-level layer(s))`) : bad('drawing produced nothing');

console.log('STEP 2 — select both with the select tool (marquee)');
await page.click('[data-tool="select"]');
await drag(at(390, 270), at(560, 430));
const selCount = await page.evaluate(() => window.state.selectedShapeIds.length);
selCount === 2 ? ok('marquee selected both shapes') : bad(`marquee selected ${selCount}, expected 2`);
await shot('selected');

console.log('STEP 3 — right-click → Make Pattern from Selection');
await page.mouse.click(box.x + 445, box.y + 325, { button: 'right' });
await page.waitForTimeout(300);
const menuItems = await page.evaluate(() =>
  [...document.querySelectorAll('.context-menu-item')].map((i) => i.textContent.trim()));
menuItems.some((t) => /Make Pattern from Selection/i.test(t))
  ? ok('context menu offers "Make Pattern from Selection"')
  : bad(`context menu missing the item: ${JSON.stringify(menuItems)}`);
await shot('context-menu');
await page.evaluate(() => [...document.querySelectorAll('.context-menu-item')]
  .find((i) => /Make Pattern from Selection/i.test(i.textContent))?.click());
await page.waitForTimeout(700);
await shot('after-make-pattern');

console.log('STEP 4 — the Library surfaces it, ready to name');
const reveal = await page.evaluate(() => ({
  libOpen: !document.getElementById('panel-library')?.classList.contains('collapsed'),
  renameOpen: !!document.querySelector('#lib-sections .lib-row input'),
  section: [...document.querySelectorAll('.lib-section-head')]
    .find((h) => h.getAttribute('aria-expanded') === 'true')?.querySelectorAll('span')[1]?.textContent,
}));
reveal.libOpen ? ok('the Library panel came forward on its own') : bad('the Library panel did not open');
reveal.section === 'Patterns' ? ok('the Patterns section is the one opened') : bad(`opened section was ${reveal.section}`);
reveal.renameOpen ? ok('the new row is already in rename — you can just type') : bad('rename did not open');
if (reveal.renameOpen) {
  await page.keyboard.type('Polka');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const named = await page.evaluate(() => window.state.listLibraryAssets('pattern')[0]?.name);
  named === 'Polka' ? ok(`typed a name and it stuck ("${named}")`) : bad(`name did not stick: ${named}`);
}
await shot('named');

console.log('STEP 5 — the row preview shows the tile (not a black chip)');
const preview = await page.evaluate(() => {
  const svg = document.querySelector('#lib-sections .lib-preview-paint svg');
  return { present: !!svg, viewBox: svg?.getAttribute('viewBox') };
});
preview.present && preview.viewBox !== '0 0 24 24'
  ? ok(`preview renders a whole tile (viewBox ${preview.viewBox})`)
  : bad(`preview looks wrong: ${JSON.stringify(preview)}`);
const swatch = await page.locator('#lib-sections .lib-preview-paint').first().boundingBox();
if (swatch) await page.screenshot({ path: `${DIR}/chrome-${String(++step).padStart(2,'0')}-preview-zoom.png`,
  clip: { x: swatch.x - 6, y: swatch.y - 6, width: swatch.width + 12, height: swatch.height + 12 } });

console.log('STEP 6 — draw a big rect and apply the pattern by clicking the row');
await page.click('[data-tool="rect"]');
await drag(at(650, 280), at(880, 460));
await page.click('[data-tool="select"]');
await page.mouse.click(box.x + 760, box.y + 370);
await page.waitForTimeout(200);
await page.click('#lib-sections .lib-row');
await page.waitForTimeout(500);
const applied = await page.evaluate(() => {
  const s = window.state.getSelectedShapes()[0];
  return s ? (s.element.getAttribute('fill') ?? '') : '';
});
/^url\(#/.test(applied) ? ok(`clicking the Library row filled the shape (${applied})`) : bad(`fill is ${applied || '(none)'}`);
await shot('applied');

console.log('STEP 7 — open the editor from the row menu, change Repeat');
await page.hover('#lib-sections .lib-row');
await page.click('#lib-sections .lib-row .lib-row-more');
await page.waitForTimeout(300);
await page.evaluate(() => [...document.querySelectorAll('.context-menu-item')]
  .find((i) => /Edit style/i.test(i.textContent))?.click());
await page.waitForTimeout(500);
const editorUp = await page.evaluate(() => ({
  panel: document.getElementById('panel-style')?.style.display !== 'none',
  controls: [...document.querySelectorAll('#style-panel-body label')].map((l) => l.textContent),
  noDupPicker: document.querySelectorAll('#style-panel-body .pat-picker-chip').length === 0,
  libLink: !!document.querySelector('#style-panel-body .pat-lib-link-btn'),
}));
editorUp.panel ? ok(`the Style panel opened: ${JSON.stringify(editorUp.controls)}`) : bad('Style panel did not open');
editorUp.noDupPicker ? ok('no duplicate pattern picker in the editor') : bad('the duplicate picker is back');
await shot('editor-open');

const sel = page.locator('#style-panel-body select').first();
if (await sel.count()) {
  await sel.selectOption('brick-row');
  await page.waitForTimeout(500);
  const brick = await page.evaluate(() => {
    const pat = window.state.patterns.find((p) => p.type === 'object');
    return { tileType: pat?.tileType, defH: document.getElementById(pat.id)?.getAttribute('height') };
  });
  brick.tileType === 'brick-row' ? ok(`Repeat changed to ${brick.tileType} (tile now ${brick.defH}px tall)`)
    : bad(`Repeat did not change: ${JSON.stringify(brick)}`);
  const stillThere = await page.evaluate(() => !!document.querySelector('#style-panel-body select'));
  stillThere ? ok('the dropdown survived being used (no one-frame vanish)') : bad('the dropdown was destroyed');
} else bad('no Repeat dropdown found');
await shot('brick');

console.log('STEP 8 — Edit artwork, then move it and watch the fill follow');
const editBtn = page.locator('#style-panel-body .pat-edit-art');
if (await editBtn.count()) {
  const before = await page.evaluate(() =>
    window.state.patterns.find((p) => p.type === 'object')?.sourceMarkup);
  await editBtn.click();
  await page.waitForTimeout(600);
  const placed = await page.evaluate(() => {
    const id = window.state.selectedShapeIds[0];
    const s = window.state.findShapeById(id);
    const r = s?.element.getBoundingClientRect();
    return { name: s?.name, x: r ? r.x + r.width / 2 : 0, y: r ? r.y + r.height / 2 : 0 };
  });
  placed.name === 'Pattern artwork' ? ok('"Edit artwork" put the tile on the canvas') : bad(`placed ${placed.name}`);
  await shot('edit-artwork');
  // Drag it with the mouse — the thing the user asked "how do I move the shapes?"
  await drag({ x: placed.x, y: placed.y }, { x: placed.x + 60, y: placed.y + 30 });
  await page.waitForTimeout(500);
  const after = await page.evaluate(() =>
    window.state.patterns.find((p) => p.type === 'object')?.sourceMarkup);
  after !== before ? ok('dragging that artwork updated the pattern (linked)') : bad('moving the artwork did not update the pattern');
  await shot('artwork-moved');
} else bad('no "Edit artwork" button');

console.log('STEP 9 — collapse a Library section');
const head = page.locator('.lib-section-head[aria-expanded="true"]').first();
if (await head.count()) {
  const label = (await head.locator('span').nth(1).textContent())?.trim();
  await head.click();
  await page.waitForTimeout(300);
  const closed = await page.evaluate((l) => {
    const h = [...document.querySelectorAll('.lib-section-head')]
      .find((x) => x.querySelectorAll('span')[1]?.textContent?.trim() === l);
    return h?.getAttribute('aria-expanded') === 'false';
  }, label);
  closed ? ok(`clicking the "${label}" header folded it`) : bad(`"${label}" did not fold`);
} else bad('no open section to collapse');
await shot('folded');

console.log('STEP 10 — collapse each dock panel and look at the seam');
// Two defects shipped here, both invisible to any model-level check: the divider
// was the ONLY gap between Layers and Library (display:none fused them into one
// slab), and a collapsed panel kept its flex-grow so it never shrank to its
// header. Measured, because "looks fused" is a pixel fact, not a state fact.
const dockGeom = () => page.evaluate(() => {
  const a = document.getElementById('panel-layers');
  const b = document.getElementById('panel-library');
  const d = document.getElementById('left-dock-divider');
  if (!a || !b) return null;
  const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
  const hdr = (el) => Math.round(el.querySelector('.panel-header').getBoundingClientRect().height);
  return {
    gap: Math.round((rb.top - ra.bottom) * 10) / 10,
    layersH: Math.round(ra.height), libraryH: Math.round(rb.height),
    layersHdr: hdr(a), libraryHdr: hdr(b),
    layersCollapsed: a.classList.contains('collapsed'),
    libraryCollapsed: b.classList.contains('collapsed'),
    // "is there a visible grab affordance" — the divider itself must be laid out,
    // not just its ::before, which still computes as block inside a display:none parent.
    handle: d ? getComputedStyle(d).display !== 'none'
             && getComputedStyle(d, '::before').display !== 'none' : false,
  };
});
const toggle = async (id) => {
  await page.evaluate((i) => document.querySelector(`#${i} .panel-collapse`).click(), id);
  await page.waitForTimeout(450);
};

await page.evaluate(() => {
  for (const i of ['panel-layers', 'panel-library']) document.getElementById(i)?.classList.remove('collapsed');
});
await page.waitForTimeout(300);

const g0 = await dockGeom();
if (!g0) bad('the left dock is missing a panel');
else {
  g0.gap > 0 ? ok(`both expanded: ${g0.gap}px between Layers and Library`) : bad('no gap between the dock panels');
  g0.handle ? ok('the resize handle shows while it can be dragged') : bad('no resize handle when both are expanded');

  for (const [id, label] of [['panel-library', 'Library'], ['panel-layers', 'Layers']]) {
    await toggle(id);
    const g = await dockGeom();
    const isLib = id === 'panel-library';
    const h = isLib ? g.libraryH : g.layersH;
    const hdr = isLib ? g.libraryHdr : g.layersHdr;
    const other = isLib ? g.layersH : g.libraryH;
    const otherWas = isLib ? g0.layersH : g0.libraryH;
    g.gap > 0
      ? ok(`${label} collapsed: still ${g.gap}px of seam`)
      : bad(`${label} collapsed and fused with its neighbour (gap ${g.gap}px)`);
    h <= hdr + 4
      ? ok(`${label} collapsed to its header (${h}px)`)
      : bad(`${label} collapsed but kept ${h}px — a ${h - hdr}px dead slab under the header`);
    other > otherWas
      ? ok(`the other panel reclaimed the space (${otherWas} -> ${other}px)`)
      : bad(`collapsing ${label} freed no space for its neighbour (${otherWas} -> ${other}px)`);
    !g.handle
      ? ok('the resize handle is gone while dragging is meaningless')
      : bad(`${label} is collapsed but the drag handle still shows`);
    await shot(`dock-${label.toLowerCase()}-collapsed`);
    await toggle(id);
  }

  await toggle('panel-library');
  await toggle('panel-layers');
  const gBoth = await dockGeom();
  gBoth.gap > 0
    ? ok(`both collapsed: ${gBoth.gap}px of seam holds`)
    : bad(`both collapsed and fused (gap ${gBoth.gap}px)`);
  await shot('dock-both-collapsed');
  await toggle('panel-library');
  await toggle('panel-layers');
}

console.log('\n— console —');
errors.length ? console.error('  ERRORS:\n   ' + errors.join('\n   ')) : ok('zero console errors for the whole flow');

console.log(`\nRESULT: ${fails.length || errors.length ? 'FAIL' : 'PASS'} — ${step} screenshots in ${DIR}`);
if (fails.length) { console.error('Failures:'); fails.forEach((f) => console.error('  - ' + f)); }
if (HEADED) await page.waitForTimeout(1500);
await browser.close();
process.exit(fails.length || errors.length ? 1 : 0);
