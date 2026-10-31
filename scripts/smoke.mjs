/**
 * QA smoke test — the {operation × shape-type} matrix.
 *
 * Most bugs this catches were "works for a rect, breaks for a path/polygon/frame" or
 * "a mutation path forgot to re-sync a derived cache". This drives the REAL app
 * (not model methods) across every shape type and the common operations, and fails
 * on ANY console error — including the dev frames-invariant (see
 * AppState.devCheckFramesInvariant), which fires when the artboards cache drifts.
 *
 * Usage:
 *   npm run dev -- --port 5300 --strictPort   # in one terminal
 *   node scripts/smoke.mjs 5300               # in another (defaults to 5300)
 *
 * Exit code 0 = clean, 1 = at least one failure. Add operations/types as the app grows.
 */
// Resolve Playwright from the project's own node_modules (portable across
// machines); fall back to a bare specifier if it's installed elsewhere.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); }
catch { pw = (await import('playwright')).default; }

const PORT = process.argv[2] || '5300';
const URL = `http://localhost:${PORT}/`;

// Each shape type + how to create one (world coords on the pasteboard, below Frame 1).
const TYPES = [
  { type: 'rect',     make: (id, x) => mkEl('rect', id, { x, y: 700, width: 80, height: 60 }) },
  { type: 'ellipse',  make: (id, x) => mkEl('ellipse', id, { cx: x + 40, cy: 730, rx: 40, ry: 30 }) },
  { type: 'polygon',  make: (id, x) => mkEl('polygon', id, { points: `${x},700 ${x + 80},700 ${x + 40},760` }) },
  { type: 'path',     make: (id, x) => mkEl('path', id, { d: `M ${x} 700 L ${x + 80} 700 L ${x + 80} 760 Z` }) },
  { type: 'line',     make: (id, x) => mkEl('line', id, { x1: x, y1: 700, x2: x + 80, y2: 760 }) },
];

// Serialized element factory, run inside the page.
function mkEl(tag, id, attrs) { return { tag, id, attrs }; }

const results = [];
const fail = (name, detail) => { results.push({ name, ok: false, detail }); };
const pass = (name) => { results.push({ name, ok: true }); };

// System Chrome when Playwright's own browser isn't downloaded (as ui-walkthrough.mjs does).
let browser;
try { browser = await pw.chromium.launch({ channel: 'chrome' }); }
catch { browser = await pw.chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const consoleErrors = [];
// Messages a guard provoked ON PURPOSE (the [style-links] prune fixture plants a
// dangling link to prove paste removes it). The per-test tally already excludes
// these from its verdict; recording them keeps them out of the end-of-run dump too,
// so a clean run prints nothing and a genuinely unexpected error can't hide inside a
// list readers have learned to skim past.
const expectedConsoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

// Every <input type="range"> that appears at any point in the run — built by a
// dialog, a popover, a panel re-render — is recorded, so the slider guards can check
// the ones a load-time look at the page never sees. (Reported near the end.)
await page.addInitScript(() => {
  window.__ranges = [];
  const note = (n) => {
    if (!(n instanceof Element)) return;
    const found = n.matches('input[type=range]') ? [n] : [...n.querySelectorAll('input[type=range]')];
    for (const r of found) if (!window.__ranges.includes(r)) window.__ranges.push(r);
  };
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') note(m.target);
      else m.addedNodes.forEach(note);
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['type'] });
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.state && !!window.docs, null, { timeout: 8000 });

// Helper: run an op inside the page, return the model x-position of a shape.
const addShape = (t, id, x) => page.evaluate(({ t, id, x }) => {
  const s = window.state, NS = 'http://www.w3.org/2000/svg';
  const el = document.createElementNS(NS, t.tag);
  for (const [k, v] of Object.entries(t.attrs)) el.setAttribute(k, String(v));
  el.id = id; el.setAttribute('fill', '#39f');
  s.addShape({ id, type: t.type, element: el, name: id, style: { fill: '#39f', stroke: '#000', strokeWidth: 1, opacity: 1 }, visible: true, locked: false });
  return true;
}, { t: { tag: t.type === 'polygon' ? 'polygon' : t.type, attrs: t.make(id, x).attrs }, id, x }).catch(() => false);

// Run a page-side thunk. Playwright's page.evaluate does NOT auto-invoke an
// arrow-function *string* (it evaluates it as an expression and throws the value
// away), so wrap string thunks in an IIFE — otherwise the call is a silent no-op.
const boolOf = (fn) => page.evaluate(typeof fn === 'string' ? `(${fn})()` : fn);

for (const t of TYPES) {
  const id = `s_${t.type}`;
  const before = consoleErrors.length;
  // create
  await addShape(t, id, 200);
  await page.waitForTimeout(60);
  // select + move via Transform panel
  await boolOf(`() => window.state.selectShape('${id}')`);
  const moved = await page.evaluate((id) => {
    const el = document.getElementById(id); if (!el) return false;
    const x0 = el.getBoundingClientRect().x;
    const i = document.getElementById('prop-x'); if (!i) return false;
    i.value = String(parseFloat(i.value) + 120);
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
    return Math.abs(document.getElementById(id).getBoundingClientRect().x - x0) > 15;
  }, id);
  moved ? pass(`move:${t.type}`) : fail(`move:${t.type}`, 'Transform panel X did not move it');
  // copy + paste
  await boolOf(`() => { window.state.copySelected(); window.state.pasteClipboard(); }`);
  await page.waitForTimeout(80);
  // delete everything selected
  await boolOf(`() => window.state.removeSelected()`);
  await page.waitForTimeout(60);
  // cleanup the original too
  await boolOf(`(id) => window.state.findShapeById('${id}') && window.state.removeShape('${id}')`).catch(() => {});
  if (consoleErrors.length > before) fail(`console:${t.type}`, consoleErrors.slice(before).join(' | '));
  else pass(`console:${t.type}`);
}

// Frame lifecycle (the special "<g> that pretends to be a shape" — the invariant guards this).
{
  const before = consoleErrors.length;
  const fid = await boolOf(`() => window.state.addFrame(400, 120, 300, 200, 'QA Frame')`);
  await page.waitForTimeout(80);
  // move the frame by its transform, then confirm the invariant stays quiet
  await boolOf(`(id) => { const g = window.state.findShapeById('${fid}').element; g.setAttribute('transform', 'translate(600 260)'); window.state.syncFrames(); window.state.onChange_public(); }`);
  await page.waitForTimeout(80);
  // paste a copy, then delete via removeSelected
  await boolOf(`() => { window.state.selectShape('${fid}'); window.state.copySelected(); window.state.pasteClipboard(); }`);
  await page.waitForTimeout(120);
  await boolOf(`() => window.state.removeSelected()`);
  await page.waitForTimeout(120);
  (consoleErrors.length > before) ? fail('frame-lifecycle', consoleErrors.slice(before).join(' | ')) : pass('frame-lifecycle');
}

// Tab document-name follows the active tab. Regression guard: loadTabIntoState
// used to fire a render mid-load that read the OUTGOING tab's name back onto the
// incoming tab, so closing/switching tabs left a stale name in the title bar.
{
  const before = consoleErrors.length;
  // The current document name lives on the active tab (the menu-bar #project-name
  // label was removed — the tab row is the single place it shows). Read it there.
  const nameNow = () => page.evaluate(() => window.docs?.active?.title);
  // Collapse to one tab, name it Alpha.svg.
  await boolOf(`() => { const d = window.docs; while (d.tabs.length > 1) d.closeTab(d.tabs[d.tabs.length - 1].id); d.renameTab(d.activeId, 'Alpha.svg'); }`);
  await page.waitForTimeout(60);
  // New tab: the name must move OFF Alpha (not stay stuck on the previous tab).
  await boolOf(`() => window.docs.newTab()`);
  await page.waitForTimeout(60);
  const afterNew = await nameNow();
  (afterNew && afterNew !== 'Alpha.svg') ? pass('tab-name:new') : fail('tab-name:new', `stuck on '${afterNew}'`);
  // Name the 2nd tab, switch back to the 1st: name follows the active tab.
  await boolOf(`() => window.docs.renameTab(window.docs.activeId, 'Beta.svg')`);
  await page.waitForTimeout(40);
  await boolOf(`() => window.docs.switchTo(window.docs.tabs[0].id)`);
  await page.waitForTimeout(60);
  const afterSwitch = await nameNow();
  (afterSwitch === 'Alpha.svg') ? pass('tab-name:switch') : fail('tab-name:switch', `got '${afterSwitch}'`);
  // Close the active named tab → switches to Beta, name updates (the reported bug).
  await boolOf(`() => window.docs.closeTab(window.docs.activeId)`);
  await page.waitForTimeout(60);
  const afterCloseActive = await nameNow();
  (afterCloseActive === 'Beta.svg') ? pass('tab-name:close-active') : fail('tab-name:close-active', `got '${afterCloseActive}'`);
  // Close the last named tab → blank doc, name clears to Untitled.
  await boolOf(`() => window.docs.closeTab(window.docs.activeId)`);
  await page.waitForTimeout(60);
  const afterCloseLast = await nameNow();
  (afterCloseLast === 'Untitled') ? pass('tab-name:close-last') : fail('tab-name:close-last', `got '${afterCloseLast}'`);
  (consoleErrors.length > before) ? fail('tab-name:console', consoleErrors.slice(before).join(' | ')) : pass('tab-name:console');
}

// --- Library styles: link lifecycle -----------------------------------------
// Guards the bug classes an adversarial review found shipped: a deleted style
// leaving orphaned links (and its id being recycled onto the next style), a manual
// edit through the Fills/Appearance seam NOT detaching, a component delete losing
// artwork, and links leaking across documents. The dev [style-links] invariant
// fires as a console error, which this harness already fails on.
{
  const before = consoleErrors.length;
  await boolOf(`() => { const d = window.docs; while (d.tabs.length > 1) d.closeTab(d.tabs[d.tabs.length - 1].id); }`);
  const setup = `() => {
    const s = window.state, NS = 'http://www.w3.org/2000/svg';
    for (const id of ['sty-a','sty-b']) { const e = window.state.findShapeById(id); if (e) s.removeShape(id); }
    const mk = (id, x) => { const el = document.createElementNS(NS,'rect'); el.id = id;
      el.setAttribute('x', String(x)); el.setAttribute('y','700'); el.setAttribute('width','60'); el.setAttribute('height','40');
      el.setAttribute('fill','#ff0000'); el.setAttribute('stroke','none');
      s.addShape({ id, type:'rect', element: el, name: id, style:{fill:'#ff0000',stroke:'none',strokeWidth:0,opacity:1}, visible:true, locked:false }); };
    mk('sty-a', 60); mk('sty-b', 140);
  }`;
  await boolOf(setup);
  const run = (body) => page.evaluate(`(async () => {
    const mod = await import('/src/ui/library-adapters.ts');
    const s = window.state;
    ${body}
  })()`);

  // apply links both; a Fills/Appearance edit detaches (the primary fill editor).
  const detach = await run(`
    const ad = mod.adapterFor('paint-style');
    s.selectShape('sty-a'); const id = ad.createFromSelection(s, 'Smoke Paint');
    s.selectMultiple(['sty-a','sty-b']); ad.applyDocument(s, id);
    const linked = ['sty-a','sty-b'].every(x => document.getElementById(x).getAttribute('data-paint-style') === id);
    const layers = s.getAppearance('sty-b'); const f = layers.find(l => l.t === 'fill');
    if (f) f.paint = '#123456'; else layers.push({ t:'fill', paint:'#123456', opacity:1 });
    s.setAppearance('sty-b', layers);
    return { id, linked, bDetached: !document.getElementById('sty-b').getAttribute('data-paint-style') };
  `);
  detach.linked ? pass('style-link:apply') : fail('style-link:apply', 'apply did not link both objects');
  detach.bDetached ? pass('style-link:detach-on-manual-edit')
    : fail('style-link:detach-on-manual-edit', 'a Fills/Appearance edit left the object linked');
  // The OTHER seam: a plain (non-appearance) shape recoloured via setSelectionFill,
  // which is what the colour picker and swatches use.
  const plain = await run(`
    const ad = mod.adapterFor('paint-style');
    s.selectShape('sty-a'); const id = ad.createFromSelection(s, 'Smoke Plain');
    s.selectShape('sty-a'); ad.applyDocument(s, id);
    const linked = document.getElementById('sty-a').getAttribute('data-paint-style') === id;
    s.selectShape('sty-a'); s.setSelectionFill('#0a0b0c');
    return { linked, detached: !document.getElementById('sty-a').getAttribute('data-paint-style') };
  `);
  plain.linked ? pass('style-link:apply-plain') : fail('style-link:apply-plain', 'apply did not link a plain shape');
  plain.detached ? pass('style-link:detach-plain-shape')
    : fail('style-link:detach-plain-shape', 'recolouring a plain shape left it linked (colour-picker path)');

  // delete detaches survivors; the next style must NOT inherit them (no id reuse).
  const del = await run(`
    const ad = mod.adapterFor('paint-style');
    const id = s.listLibraryAssets('paint-style').find(a => a.name === 'Smoke Paint').id;
    // Re-link a shape RIGHT HERE. This assertion used to depend on state left by
    // earlier blocks, which had already unlinked sty-a — so it passed whether or
    // not delete detached anything. Mutation testing caught that it was vacuous.
    s.selectShape('sty-b'); ad.applyDocument(s, id);
    const linkedBefore = document.getElementById('sty-b').getAttribute('data-paint-style') === id;
    s.removeLibraryAsset(id);
    const orphan = !!document.getElementById('sty-b').getAttribute('data-paint-style');
    s.rebuildShapesFromDOM();
    s.selectShape('sty-a'); const id2 = ad.createFromSelection(s, 'Smoke Paint 2');
    // Compare the SEQUENCE, not the whole id: the random token alone would make the
    // ids differ even if data-seq persistence regressed entirely.
    // NB: this body is embedded in a template literal, where a regex '\d' would be
    // eaten as an escape. Split instead of matching.
    const seqOf = (x) => parseInt(String(x).split('-')[1] || '0', 10);
    return { orphan, id, id2, linkedBefore, reused: seqOf(id2) <= seqOf(id), adopted: s.shapesWithStyleLink('data-paint-style', id2).length };
  `);
  del.linkedBefore ? pass('style-link:delete-fixture') : fail('style-link:delete-fixture', 'the delete test never linked anything — assertion would be vacuous');
  !del.orphan ? pass('style-link:delete-detaches') : fail('style-link:delete-detaches', 'link survived the delete');
  !del.reused ? pass('style-link:no-id-reuse')
    : fail('style-link:no-id-reuse', `deleted ${del.id} then minted ${del.id2} — sequence went backwards`);
  del.adopted === 0 ? pass('style-link:no-orphan-adoption')
    : fail('style-link:no-orphan-adoption', `${del.adopted} orphan(s) joined the new style`);

  // component delete keeps the artwork and is undoable.
  const comp = await run(`
    const ad = mod.adapterFor('component');
    s.selectShape('sty-a'); const symId = ad.createFromSelection(s, 'Smoke Component');
    if (!symId) return { made: false };
    const rectsBefore = document.querySelectorAll('#drawing-layer rect').length;
    s.removeSymbol(symId);
    await new Promise(r => setTimeout(r, 80));
    // Not just "the <use> is gone" — that would also pass if delete simply destroyed
    // the instances. Real geometry must have REPLACED it.
    const kept = document.querySelectorAll('#drawing-layer use[href="#' + symId + '"]').length === 0
      && s.symbols.length === 0
      && document.querySelectorAll('#drawing-layer rect').length > rectsBefore;
    s.undo();
    await new Promise(r => setTimeout(r, 150));
    return { made: true, kept, restored: s.symbols.length === 1 };
  `);
  comp.made ? pass('component:create') : fail('component:create', 'could not create a component from the selection');
  comp.kept ? pass('component:delete-keeps-artwork') : fail('component:delete-keeps-artwork', 'instances were not detached');
  comp.restored ? pass('component:delete-undoable') : fail('component:delete-undoable', 'undo did not restore the component');

  (consoleErrors.length > before) ? fail('style-link:console', consoleErrors.slice(before).join(' | ')) : pass('style-link:console');
}

// --- Object patterns: artwork as a tiling fill --------------------------------
// Guards the copy-model contract: the tile is snapshotted from the artwork (editing
// the originals must NOT change it), sized from the union bbox in LAYER coords, and
// brick tiling is baked into an oversized tile because <pattern> can't stagger.
{
  const before = consoleErrors.length;
  await boolOf(`() => {
    const s = window.state, NS = 'http://www.w3.org/2000/svg';
    const mk = (id, tag, a) => { const el = document.createElementNS(NS, tag); el.id = id;
      for (const k in a) el.setAttribute(k, String(a[k]));
      s.addShape({ id, type: tag === 'circle' ? 'ellipse' : 'rect', element: el, name: id,
        style: { fill: a.fill, stroke: 'none', strokeWidth: 0, opacity: 1 }, visible: true, locked: false }); };
    mk('pat_a', 'rect', { x: 100, y: 620, width: 20, height: 20, fill: '#e23b3b', stroke: 'none' });
    mk('pat_b', 'circle', { cx: 140, cy: 660, r: 10, fill: '#2f6fe0', stroke: 'none' });
    return true;
  }`);
  const made = await boolOf(`() => {
    const s = window.state;
    const pat = s.createPatternFromShapes(['pat_a', 'pat_b']);
    if (!pat) return null;
    const el = document.getElementById(pat.id);
    return { id: pat.id, type: pat.type, tw: pat.tileWidth, th: pat.tileHeight,
      cells: el.querySelectorAll('[data-pat-src]').length, w: el.getAttribute('width') };
  }`);
  made ? pass('pattern:make') : fail('pattern:make', 'createPatternFromShapes returned null');
  if (made) {
    (made.type === 'object' && made.cells === 1)
      ? pass('pattern:artwork-is-the-tile')
      : fail('pattern:artwork-is-the-tile', JSON.stringify(made));
    // Union bbox of the two marks is 50x50 in layer coords; getBBox alone would differ.
    (made.tw === 50 && made.th === 50 && made.w === '50')
      ? pass('pattern:tile-size') : fail('pattern:tile-size', `${made.tw}x${made.th} w=${made.w}`);

    const brick = await boolOf(`() => {
      const s = window.state, pat = s.getPatternById('${made.id}');
      pat.tileType = 'brick-row'; pat.tileOffset = 0.5; s.updatePattern(pat);
      const el = document.getElementById('${made.id}');
      return { h: el.getAttribute('height'), cells: el.querySelectorAll(':scope > g').length };
    }`);
    (brick && brick.h === '100' && brick.cells === 3)
      ? pass('pattern:brick-baked') : fail('pattern:brick-baked', JSON.stringify(brick));

    const rt = await boolOf(`() => {
      window.docs.restoreSession(window.docs.serializeSession());
      const pat = window.state.patterns.find(p => p.type === 'object');
      return pat ? { hasArt: !!pat.sourceMarkup, tileType: pat.tileType, tw: pat.tileWidth } : null;
    }`);
    (rt && rt.hasArt && rt.tileType === 'brick-row' && rt.tw === 50)
      ? pass('pattern:round-trip') : fail('pattern:round-trip', JSON.stringify(rt));

    const copy = await boolOf(`() => {
      const s = window.state;
      const bef = s.patterns.find(p => p.type === 'object').sourceMarkup;
      const a = document.getElementById('pat_a');
      if (a) { a.setAttribute('fill', '#00ff00'); s.rebuildShapesFromDOM(); }
      const aft = s.patterns.find(p => p.type === 'object').sourceMarkup;
      return { same: bef === aft, captured: bef.indexOf('e23b3b') >= 0 };
    }`);
    (copy && copy.captured && copy.same)
      ? pass('pattern:copy-semantics')
      : fail('pattern:copy-semantics', 'editing the source artwork changed the pattern');
  }
  (consoleErrors.length > before) ? fail('pattern:console', consoleErrors.slice(before).join(' | ')) : pass('pattern:console');
}

// --- Linked patterns ----------------------------------------------------------
// The link/copy distinction has to be REAL (a copy must not track), and a missing
// source must freeze the pattern rather than break the fill.
{
  const before = consoleErrors.length;
  await boolOf(`() => {
    const s = window.state, NS = 'http://www.w3.org/2000/svg';
    const el = document.createElementNS(NS, 'rect'); el.id = 'lp_src';
    el.setAttribute('x', '120'); el.setAttribute('y', '640'); el.setAttribute('width', '30');
    el.setAttribute('height', '30'); el.setAttribute('fill', '#c33'); el.setAttribute('stroke', 'none');
    s.addShape({ id: 'lp_src', type: 'rect', element: el, name: 'lp_src',
      style: { fill: '#c33', stroke: 'none', strokeWidth: 0, opacity: 1 }, visible: true, locked: false });
    return true;
  }`);
  const track = await boolOf(`() => {
    const s = window.state;
    const pat = s.createPatternFromShapes(['lp_src'], { link: true });
    const before = s.getPatternById(pat.id).sourceMarkup;
    document.getElementById('lp_src').setAttribute('fill', '#00cc44');
    s.rebuildShapesFromDOM();
    return { id: pat.id, changed: before !== s.getPatternById(pat.id).sourceMarkup };
  }`);
  (track && track.changed) ? pass('linked-pattern:tracks-source')
    : fail('linked-pattern:tracks-source', 'editing the source did not re-capture the tile');

  const copyMode = await boolOf(`() => {
    const s = window.state;
    const pat = s.createPatternFromShapes(['lp_src']);
    const before = s.getPatternById(pat.id).sourceMarkup;
    document.getElementById('lp_src').setAttribute('fill', '#0000ff');
    s.rebuildShapesFromDOM();
    return before === s.getPatternById(pat.id).sourceMarkup;
  }`);
  copyMode ? pass('linked-pattern:copy-does-not-track')
    : fail('linked-pattern:copy-does-not-track', 'a copy pattern followed its origin');

  const frozen = await boolOf(`() => {
    const s = window.state;
    const pat = s.patterns.find(p => p.sourceId === 'lp_src');
    if (!pat) return null;
    const art = pat.sourceMarkup;
    s.removeShape('lp_src');
    s.rebuildShapesFromDOM();
    const after = s.getPatternById(pat.id);
    return { alive: !!after, unlinked: !after.sourceId, keptArt: after.sourceMarkup === art };
  }`);
  (frozen && frozen.alive && frozen.unlinked && frozen.keptArt)
    ? pass('linked-pattern:freeze-on-missing')
    : fail('linked-pattern:freeze-on-missing', JSON.stringify(frozen));
  (consoleErrors.length > before) ? fail('linked-pattern:console', consoleErrors.slice(before).join(' | ')) : pass('linked-pattern:console');
}

// --- Linked files -------------------------------------------------------------
// The contract: a linked file MATERIALIZES its content, so the artwork renders even
// when the source is unreachable; it is ONE leaf layer (its generated children must
// never become phantom layers); and status is derived, never stored.
{
  const before = consoleErrors.length;
  const SRC = '<svg xmlns="http://www.w3.org/2000/svg"><g id="drawing-layer">'
    + '<rect id="shape-9" x="0" y="0" width="60" height="40" fill="#c33"/></g></svg>';
  const placed = await boolOf(`() => {
    const id = window.state.placeLinkedFile({ src: 'proj-sync', name: 'Linked.svg',
      rev: 'r1', content: ${JSON.stringify(SRC)}, x: 300, y: 640 });
    const sh = window.state.findShapeById(id);
    const el = document.getElementById(id);
    return id ? { id, type: sh && sh.type, kids: sh && sh.children ? sh.children.length : 0,
      ids: el.querySelectorAll('[id]').length, w: Math.round(el.getBoundingClientRect().width) } : null;
  }`);
  placed ? pass('linked:place') : fail('linked:place', 'placeLinkedFile returned null');
  if (placed) {
    (placed.type === 'linked' && placed.kids === 0 && placed.ids === 0)
      ? pass('linked:one-leaf-layer') : fail('linked:one-leaf-layer', JSON.stringify(placed));
    (placed.w > 10) ? pass('linked:renders') : fail('linked:renders', `width ${placed.w}`);

    const status = await boolOf(`() => {
      const s = window.state;
      s.noteLinkedSourceRevisions(new Map([['proj-sync', 'r1']]));
      const same = s.listLinkedFiles()[0].stale;
      s.noteLinkedSourceRevisions(new Map([['proj-sync', 'r2']]));
      const newer = s.listLinkedFiles()[0].stale;
      s.noteLinkedSourceRevisions(new Map(), ['proj-sync']);
      return { same, newer, gone: s.listLinkedFiles()[0].missing };
    }`);
    (status && !status.same && status.newer && status.gone)
      ? pass('linked:status-derived') : fail('linked:status-derived', JSON.stringify(status));

    const rt = await boolOf(`() => {
      window.docs.restoreSession(window.docs.serializeSession());
      const l = window.state.listLinkedFiles()[0];
      return l ? { src: l.src, type: window.state.findShapeById(l.shapeId).type } : null;
    }`);
    (rt && rt.type === 'linked' && rt.src === 'proj-sync')
      ? pass('linked:round-trip') : fail('linked:round-trip', JSON.stringify(rt));

    const emb = await boolOf(`() => {
      const s = window.state, l = s.listLinkedFiles()[0];
      const n = document.getElementById(l.shapeId).querySelectorAll('*').length;
      s.embedLinkedFile(l.shapeId);
      return { left: s.listLinkedFiles().length,
        same: document.getElementById(l.shapeId).querySelectorAll('*').length === n };
    }`);
    (emb && emb.left === 0 && emb.same)
      ? pass('linked:embed-keeps-artwork') : fail('linked:embed-keeps-artwork', JSON.stringify(emb));
  }
  (consoleErrors.length > before) ? fail('linked:console', consoleErrors.slice(before).join(' | ')) : pass('linked:console');
}

// --- Guards added after mutation testing --------------------------------------
// Each of these exists because re-introducing a real, previously-shipped bug left
// the suite GREEN. Every one builds its own fixture: the first vacuous check this
// exercise exposed was vacuous precisely because it leaned on earlier state.
{
  const before = consoleErrors.length;
  const mk = (id, x) => `
    (() => { const s = window.state, NS = 'http://www.w3.org/2000/svg';
      const el = document.createElementNS(NS, 'rect'); el.id = '${id}';
      el.setAttribute('x', '${x}'); el.setAttribute('y', '760');
      el.setAttribute('width', '40'); el.setAttribute('height', '30');
      el.setAttribute('fill', '#c33'); el.setAttribute('stroke', 'none');
      s.addShape({ id: '${id}', type: 'rect', element: el, name: '${id}',
        style: { fill: '#c33', stroke: 'none', strokeWidth: 0, opacity: 1 },
        visible: true, locked: false }); })();`;

  // (a) The asset-id sequence must be PERSISTED, not re-derived from survivors.
  const seq = await boolOf(`async () => {
    const mod = await import('/src/ui/library-adapters.ts');
    const s = window.state, ad = mod.adapterFor('paint-style');
    ${mk('mt_a', 60)}
    s.selectShape('mt_a'); const a = ad.createFromSelection(s, 'MT One');
    s.removeLibraryAsset(a);
    s.rebuildShapesFromDOM();
    s.selectShape('mt_a'); const b = ad.createFromSelection(s, 'MT Two');
    const seqOf = (x) => parseInt(String(x).split('-')[1] || '0', 10);
    const carrier = document.querySelector('#drawing-layer > metadata.bq-library');
    return { advanced: seqOf(b) > seqOf(a), hasSeq: !!(carrier && carrier.getAttribute('data-seq')) };
  }`);
  (seq && seq.advanced && seq.hasSeq)
    ? pass('guard:asset-seq-persisted') : fail('guard:asset-seq-persisted', JSON.stringify(seq));

  // (b) Wrapping a shape must carry its style link onto the wrapper.
  const wrapped = await boolOf(`async () => {
    const mod = await import('/src/ui/library-adapters.ts');
    const s = window.state, ad = mod.adapterFor('paint-style');
    ${mk('mt_w', 120)}
    s.selectShape('mt_w'); const id = ad.createFromSelection(s, 'MT Wrap');
    s.selectShape('mt_w'); ad.applyDocument(s, id);
    const n0 = s.shapesWithStyleLink('data-paint-style', id).length;
    const layers = s.getAppearance('mt_w');
    layers.push({ t: 'fill', paint: '#ffffff', opacity: 0.5 });
    s.setAppearance('mt_w', layers);
    s.rebuildShapesFromDOM();
    return { n0, n1: s.shapesWithStyleLink('data-paint-style', id).length };
  }`);
  (wrapped && wrapped.n0 === 1 && wrapped.n1 === 1)
    ? pass('guard:wrapper-carries-link') : fail('guard:wrapper-carries-link', JSON.stringify(wrapped));

  // (c) A component must be creatable from a FRAME-PARENTED shape — the default
  //     case, since auto-parenting puts freshly drawn shapes inside a frame.
  const inFrame = await boolOf(`() => {
    const s = window.state, NS = 'http://www.w3.org/2000/svg';
    const frame = document.querySelector('#drawing-layer g[data-frame]');
    if (!frame) return { skip: true };
    const el = document.createElementNS(NS, 'rect'); el.id = 'mt_if';
    el.setAttribute('x', '30'); el.setAttribute('y', '30');
    el.setAttribute('width', '40'); el.setAttribute('height', '30');
    el.setAttribute('fill', '#28a'); el.setAttribute('stroke', 'none');
    frame.appendChild(el);
    s.rebuildShapesFromDOM();
    const nested = !!s.findShapeById('mt_if') && !s.shapes.some(x => x.id === 'mt_if');
    const sym = s.createSymbolFromShape('mt_if', 'MT Component');
    return { nested, made: !!sym };
  }`);
  (inFrame && (inFrame.skip || (inFrame.nested && inFrame.made)))
    ? pass('guard:component-from-frame-child') : fail('guard:component-from-frame-child', JSON.stringify(inFrame));

  // (d) The symbol library must not grow on repeated rebuilds.
  const dbl = await boolOf(`() => {
    const s = window.state;
    const n0 = s.symbols.length;
    s.rebuildShapesFromDOM(); s.rebuildShapesFromDOM(); s.rebuildShapesFromDOM();
    return { n0, n1: s.symbols.length };
  }`);
  (dbl && dbl.n1 === dbl.n0) ? pass('guard:symbols-stable-across-rebuilds')
    : fail('guard:symbols-stable-across-rebuilds', `symbols ${dbl && dbl.n0} -> ${dbl && dbl.n1}`);

  // (d2) Detach Instance must still work after a rebuild. symbolId used to be set
  //      only on the object placeSymbolInstance pushed, so the first rebuild —
  //      i.e. any structural edit, undo, or load — dropped it and Detach became a
  //      silent no-op for EVERY instance (#234). The paint-style guard above
  //      covers a different feature entirely, which is why this went unnoticed.
  const inst = await boolOf(`() => {
    const s = window.state;
    const NS = 'http://www.w3.org/2000/svg';
    const el = document.createElementNS(NS, 'rect'); el.id = 'inst-src';
    el.setAttribute('x','40'); el.setAttribute('y','760');
    el.setAttribute('width','60'); el.setAttribute('height','40');
    el.setAttribute('fill','#0a0'); el.setAttribute('stroke','none');
    s.addShape({ id:'inst-src', type:'rect', element: el, name:'inst-src',
      style:{fill:'#0a0',stroke:'none',strokeWidth:0,opacity:1}, visible:true, locked:false });
    s.selectShape('inst-src');
    if (!s.createSymbolFromShape) return { skip: true };
    s.createSymbolFromShape('inst-src');
    const useId = [...s.selectedShapeIds][0];
    if (s.findShapeById(useId)?.type !== 'use') return { skip: true };
    // The rebuild that used to wipe the link.
    s.rebuildShapesFromDOM();
    const linkSurvives = !!s.findShapeById(useId)?.symbolId;
    const ok = s.detachSymbolInstance(useId);
    const nowId = [...s.selectedShapeIds][0];
    const nowType = s.findShapeById(nowId)?.type ?? null;
    return { linkSurvives, ok, detachedTo: nowType, stillUse: nowType === 'use' };
  }`);
  (inst && (inst.skip || (inst.linkSurvives && inst.ok && !inst.stillUse)))
    ? pass('guard:instance-detach-after-rebuild')
    : fail('guard:instance-detach-after-rebuild', JSON.stringify(inst));

  // (d3) A group's fill must stay LIVE, and inherited paint must not be baked onto
  //      children. rebuildShapesFromDOM used to copy an ancestor's fill onto every
  //      paintable leaf (for #139), which made the group's own fill permanently
  //      inert and silently rewrote imported artwork that paints by inheritance
  //      (#206/#208). The model must still REPORT the inherited colour, and a leaf
  //      with no fill source anywhere must still report black, not "no fill" (#139).
  const inh = await boolOf(`() => {
    const s = window.state;
    const NS = 'http://www.w3.org/2000/svg';
    const frame = document.querySelector('[data-frame]') || s.getDrawingLayer?.() || document.getElementById('drawing-layer');
    const g = document.createElementNS(NS,'g'); g.id = s.nextId(); g.setAttribute('fill','#c8a');
    const r = document.createElementNS(NS,'rect'); r.id = s.nextId();
    r.setAttribute('x','900'); r.setAttribute('y','900');
    r.setAttribute('width','20'); r.setAttribute('height','20');
    g.appendChild(r); frame.appendChild(g);
    s.rebuildShapesFromDOM();
    const notBaked = r.getAttribute('fill') === null;
    const modelReports = s.findShapeById(r.id)?.style.fill;
    g.setAttribute('fill','#1188ff');
    s.rebuildShapesFromDOM();
    const live = getComputedStyle(r).fill === 'rgb(17, 136, 255)';
    // #139: a leaf with NO fill source anywhere still reports its rendered black.
    const bare = document.createElementNS(NS,'rect'); bare.id = s.nextId();
    bare.setAttribute('x','940'); bare.setAttribute('y','900');
    bare.setAttribute('width','20'); bare.setAttribute('height','20');
    frame.appendChild(bare);
    s.rebuildShapesFromDOM();
    const bareFill = s.findShapeById(bare.id)?.style.fill ?? 'none';
    g.remove(); bare.remove(); s.rebuildShapesFromDOM();
    return { notBaked, modelReports, live, bareFill };
  }`);
  (inh && inh.notBaked && inh.modelReports === '#c8a' && inh.live && inh.bareFill !== 'none')
    ? pass('guard:group-fill-stays-live')
    : fail('guard:group-fill-stays-live', JSON.stringify(inh));

  // (d4) An Inkscape LAYER must be transparent to click-selection WITHOUT being
  //      restructured. Every tool following Inkscape's convention wraps a whole
  //      drawing in <g inkscape:groupmode="layer">; modelled as an ordinary group
  //      that made the file one object, so clicking any shape selected the lot.
  //      The first fix UNWRAPPED the layer, folding its transform onto each child
  //      — which doubled that transform for every <use> pointing at a sibling,
  //      because a <use> composes its TARGET's own transform on top of its own
  //      CTM. Inkscape files lean on exactly that (an invisible template path
  //      drawn by several <use>s), so a track map imported a page-width off
  //      canvas. Geometry must now be byte-identical to the source.
  const ink = await boolOf(`async () => {
    const s = window.state;
    const saved = document.getElementById('drawing-layer').innerHTML;
    const pf = await import('/src/ui/project-file.ts');
    const doc = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"'
      + ' xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="600" height="400">'
      + '<g inkscape:groupmode="layer" id="lyr" transform="translate(300,0)">'
      + '<path id="lr_tpl" style="fill:none" d="M 10 100 L 110 100 L 110 200 Z"/>'
      + '<use x="0" y="0" xlink:href="#lr_tpl" id="lr_use" style="stroke:black;stroke-width:6"/>'
      + '<rect id="lr_a" x="10" y="20" width="50" height="40" fill="#c33"/></g></svg>';
    pf.loadDocumentSVG(s, doc);
    const layer = document.getElementById('drawing-layer');
    const at = (id) => { const e = document.getElementById(id); if (!e) return null;
      const b = e.getBBox(); const rel = layer.getCTM().inverse().multiply(e.getCTM());
      const p = layer.ownerSVGElement.createSVGPoint(); p.x = b.x; p.y = b.y;
      const q = p.matrixTransform(rel); return Math.round(q.x); };
    // translate(300) must apply ONCE to both the plain rect and the <use>.
    const useX = at('lr_use'), rectX = at('lr_a');
    const layerKept = !!document.querySelector('#drawing-layer [data-layer]');
    // and the layer must be transparent: a click resolves to the shape itself
    s.selectShape(null);
    const el = document.getElementById('lr_a');
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    const opts = { clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window, button: 0 };
    hit.dispatchEvent(new MouseEvent('mousedown', opts));
    hit.dispatchEvent(new MouseEvent('mouseup', opts));
    const picked = [...s.selectedShapeIds][0] ?? null;
    document.getElementById('drawing-layer').innerHTML = saved;
    s.rebuildShapesFromDOM();
    return { useX, rectX, layerKept, picked, hitWasShape: hit === el };
  }`);
  (ink && ink.useX === 310 && ink.rectX === 310 && ink.layerKept && ink.hitWasShape && ink.picked === 'lr_a')
    ? pass('guard:inkscape-layer-transparent')
    : fail('guard:inkscape-layer-transparent', JSON.stringify(ink));

  // (d4b) Rotation must be READ from the composed matrix. Every other SVG editor
  //       bakes rotation into matrix(...) — Inkscape does it for everything — so
  //       scanning for the literal rotate() form this app writes reported R = 0
  //       next to a plainly tilted selection box on imported artwork. Reading must
  //       also leave markup ALONE (the transform list's consolidate() mutates it,
  //       which would rewrite the document on every panel refresh), and setting an
  //       absolute angle must land there even when a matrix already rotates it.
  const rot = await boolOf(`async () => {
    const s = window.state;
    const saved = document.getElementById('drawing-layer').innerHTML;
    const pf = await import('/src/ui/project-file.ts');
    const tr = await import('/src/core/transform.ts');
    pf.loadDocumentSVG(s, '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400">'
      + '<rect id="rt_m" x="200" y="200" width="80" height="40" fill="#3c3" transform="matrix(0.866,0.5,-0.5,0.866,0,0)"/>'
      + '<rect id="rt_r" x="50" y="50" width="80" height="40" fill="#c33" transform="rotate(25 90 70)"/></svg>');
    const m = document.getElementById('rt_m'), r = document.getElementById('rt_r');
    const beforeAttr = m.getAttribute('transform');
    const readMatrix = Math.round(tr.getRotation(m));
    const readRotate = Math.round(tr.getRotation(r));
    const nonDestructive = m.getAttribute('transform') === beforeAttr;
    const bb = m.getBBox();
    tr.setRotation(m, 45, bb.x + bb.width / 2, bb.y + bb.height / 2);
    const setAbsolute = Math.round(tr.getRotation(m));
    tr.setRotation(m, 0, bb.x + bb.width / 2, bb.y + bb.height / 2);
    const unrotates = Math.round(tr.getRotation(m));
    document.getElementById('drawing-layer').innerHTML = saved;
    s.rebuildShapesFromDOM();
    return { readMatrix, readRotate, nonDestructive, setAbsolute, unrotates };
  }`);
  (rot && rot.readMatrix === 30 && rot.readRotate === 25 && rot.nonDestructive
     && rot.setAbsolute === 45 && rot.unrotates === 0)
    ? pass('guard:rotation-reads-matrix')
    : fail('guard:rotation-reads-matrix', JSON.stringify(rot));

  // (d4c) A corner radius is a PROPERTY, not geometry: 8px stays 8px however far
  //       the box is dragged. Two separate paths got this wrong. A multi-select or
  //       group resize works by baking a residual scale into geometry, and the bake
  //       scaled rx with the box (8 -> 20.5). And a per-corner rect — which is a
  //       <path data-rect> — was caught by the generic path branch of applyResize,
  //       which scaled its baked `d`: that stretched the corner arcs, dropped them
  //       entirely, and left data-rect-* stale so a later radius edit snapped the
  //       shape back to its old size. Export baking must still scale the radius,
  //       or flattened output stops matching the canvas.
  const rad = await boolOf(`async () => {
    const s = window.state;
    const saved = document.getElementById('drawing-layer').innerHTML;
    const NS = 'http://www.w3.org/2000/svg';
    const frame = document.querySelector('[data-frame]') || document.getElementById('drawing-layer');
    const bake = await import('/src/core/bake.ts');
    const rs = await import('/src/core/rect-shape.ts');

    // uniform radius + a residual 3x scale, baked the way a group resize does
    const r = document.createElementNS(NS, 'rect');
    r.id = 'rad_u'; r.setAttribute('x','40'); r.setAttribute('y','40');
    r.setAttribute('width','80'); r.setAttribute('height','60');
    r.setAttribute('rx','8'); r.setAttribute('fill','#4a8cff');
    r.setAttribute('transform','scale(3)');
    frame.appendChild(r); s.rebuildShapesFromDOM();
    bake.bakeOwnTransform(r, { preserveCornerRadius: true });
    const uniformRx = r.getAttribute('rx');
    const uniformW = r.getAttribute('width');

    // export baking must STILL scale it, so the flattened file matches the canvas
    const e = document.createElementNS(NS, 'rect');
    e.id = 'rad_e'; e.setAttribute('x','40'); e.setAttribute('y','40');
    e.setAttribute('width','80'); e.setAttribute('height','60');
    e.setAttribute('rx','8'); e.setAttribute('fill','#4a8cff');
    e.setAttribute('transform','scale(2)');
    frame.appendChild(e); s.rebuildShapesFromDOM();
    const out = bake.bakeLayerContent(document.getElementById('drawing-layer')).content;
    // Parse rather than regex: escaping a pattern through this template layer is
    // its own bug source, and the DOM gives the attribute directly.
    const doc = new DOMParser().parseFromString(
      '<svg xmlns="http://www.w3.org/2000/svg">' + out + '</svg>', 'image/svg+xml');
    const exportRx = doc.getElementById('rad_e')?.getAttribute('rx') ?? null;

    // per-corner rect keeps its ARCS and its params stay in step with the render
    const pr = document.createElementNS(NS, 'rect');
    pr.setAttribute('x','300'); pr.setAttribute('y','40');
    pr.setAttribute('width','140'); pr.setAttribute('height','100'); pr.setAttribute('fill','#e0574a');
    frame.appendChild(pr); s.rebuildShapesFromDOM();
    const pa = rs.setRectRadii(pr, [8, 0, 16, 0]); s.rebuildShapesFromDOM();
    rs.applyRectBox(pa, 300, 40, 420, 100);
    const arcCount = (pa.getAttribute('d') || '').split('A ').length - 1;
    const paramsInStep = Math.abs(parseFloat(pa.getAttribute('data-rect-w')) - pa.getBBox().width) < 1.5;

    document.getElementById('drawing-layer').innerHTML = saved;
    s.rebuildShapesFromDOM();
    return { uniformRx, uniformW, exportRx, arcCount, paramsInStep };
  }`);
  (rad && rad.uniformRx === '8' && rad.uniformW === '240' && rad.exportRx === '16'
     && rad.arcCount === 2 && rad.paramsInStep)
    ? pass('guard:corner-radius-survives-resize')
    : fail('guard:corner-radius-survives-resize', JSON.stringify(rad));

  // (d4f) Resizing CLIPPED artwork must not bake its transform away. A clipPath's
  //       contents are in USER SPACE by default, so folding the geometry moves the
  //       artwork out from under a clip that stays put: an imported icon vanished
  //       entirely on resize (geometry rewritten, clip left at its old coordinates)
  //       while its selection outline and layer rows remained. The bake must refuse
  //       and leave the transform live — but must still bake an UNclipped sibling,
  //       or this trades one bug for a blanket opt-out.
  const clip = await boolOf(`async () => {
    const s = window.state;
    const saved = document.getElementById('drawing-layer').innerHTML;
    const NS = 'http://www.w3.org/2000/svg';
    const layer = document.getElementById('drawing-layer');
    const bake = await import('/src/core/bake.ts');
    const defs = s.ensureDefs ? s.ensureDefs() : document.querySelector('defs');
    const cp = document.createElementNS(NS, 'clipPath');
    cp.id = 'cb_clip';
    const cpp = document.createElementNS(NS, 'path');
    cpp.setAttribute('d', 'M600 400h40v40h-40z');
    cp.appendChild(cpp); defs.appendChild(cp);

    const g = document.createElementNS(NS, 'g');
    g.id = 'cb_g'; g.setAttribute('transform', 'scale(4)');
    const inner = document.createElementNS(NS, 'g');
    inner.setAttribute('clip-path', 'url(#cb_clip)');
    const p1 = document.createElementNS(NS, 'rect');
    p1.setAttribute('x','605'); p1.setAttribute('y','405');
    p1.setAttribute('width','20'); p1.setAttribute('height','20'); p1.setAttribute('fill','#f50');
    inner.appendChild(p1); g.appendChild(inner); layer.appendChild(g);

    const g2 = document.createElementNS(NS, 'g');
    g2.id = 'cb_g2'; g2.setAttribute('transform', 'scale(4)');
    const p2 = document.createElementNS(NS, 'rect');
    p2.setAttribute('x','10'); p2.setAttribute('y','10');
    p2.setAttribute('width','20'); p2.setAttribute('height','20'); p2.setAttribute('fill','#08f');
    g2.appendChild(p2); layer.appendChild(g2);
    s.rebuildShapesFromDOM();

    const clippedBaked = bake.bakeOwnTransform(g);
    const controlBaked = bake.bakeOwnTransform(g2);
    const out = {
      clippedRefused: clippedBaked === false,
      clippedKeptTransform: g.getAttribute('transform') !== null,
      clippedGeometryIntact: p1.getAttribute('x') === '605',
      controlBaked: controlBaked === true && g2.getAttribute('transform') === null,
      controlGeometryFolded: p2.getAttribute('x') === '40',
    };
    document.getElementById('drawing-layer').innerHTML = saved;
    document.getElementById('cb_clip')?.remove();
    s.rebuildShapesFromDOM();
    return out;
  }`);
  (clip && clip.clippedRefused && clip.clippedKeptTransform && clip.clippedGeometryIntact
     && clip.controlBaked && clip.controlGeometryFolded)
    ? pass('guard:clipped-artwork-survives-resize')
    : fail('guard:clipped-artwork-survives-resize', JSON.stringify(clip));

  // (d4g) Resize must track the pointer 1:1 for EVERY shape kind, whatever transform
  //       an ancestor carries. getBBox() is LOCAL (pre-transform) while the drag
  //       delta is WORLD, and the two were reconciled by a translate only — so any
  //       ancestor scale multiplied the resize by exactly that scale: a rect inside
  //       scale(2) grew 80 units for a 40-unit drag, inside scale(0.5) only 20.
  //       Rotation survived (it preserves lengths), which is why this hid for so
  //       long. The matrix is the point: a new shape type that resizes in the wrong
  //       space fails here rather than shipping.
  const spaces = await boolOf(`async () => {
    const s = window.state;
    const saved = document.getElementById('drawing-layer').innerHTML;
    const NS = 'http://www.w3.org/2000/svg';
    const layer = document.getElementById('drawing-layer');
    const frame = document.querySelector('[data-frame]') || layer;
    const worldW = (el) => {
      const b = el.getBBox();
      const m = layer.getCTM().inverse().multiply(el.getCTM());
      const p = layer.ownerSVGElement.createSVGPoint();
      p.x = b.x; p.y = b.y; const a = p.matrixTransform(m);
      p.x = b.x + b.width; p.y = b.y; const d = p.matrixTransform(m);
      return Math.round(Math.hypot(d.x - a.x, d.y - a.y) * 100) / 100;
    };
    const centre = (n) => { const r = n.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
    const drag = async (px) => {
      const he = document.querySelector('[data-handle="e"]');
      const hw = document.querySelector('[data-handle="w"]');
      if (!he) return false;
      const p = centre(he);
      // Drag along the BOX'S OWN east axis (W->E), which is where the handle sits.
      // A world-horizontal drag only grows a rotated box by its projection, so
      // expecting the full gain from one would bake cos(theta) into the guard and
      // let a real space bug hide behind it (#273).
      let ux = 1, uy = 0;
      if (hw) { const q = centre(hw);
        const vx = p.x - q.x, vy = p.y - q.y, L = Math.hypot(vx, vy) || 1;
        ux = vx / L; uy = vy / L; }
      const x = p.x, y = p.y;
      const o = (cx, cy) => ({ clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window, button: 0 });
      he.dispatchEvent(new MouseEvent('mousedown', o(Math.round(x), Math.round(y))));  // target must BE the handle
      const canvas = document.getElementById('svg-canvas');
      for (let i = 1; i <= 4; i++) {
        canvas.dispatchEvent(new MouseEvent('mousemove', o(x + ux * px * i / 4, y + uy * px * i / 4)));
        await new Promise(r => setTimeout(r, 20));
      }
      window.dispatchEvent(new MouseEvent('mouseup', o(x + ux * px, y + uy * px)));
      await new Promise(r => setTimeout(r, 220));
      return true;
    };
    const mk = (kind, tf, i) => {
      const g = document.createElementNS(NS, 'g');
      if (tf) g.setAttribute('transform', tf);
      let el;
      if (kind === 'rect') { el = document.createElementNS(NS, 'rect');
        el.setAttribute('x','60'); el.setAttribute('y','60');
        el.setAttribute('width','80'); el.setAttribute('height','60'); }
      else if (kind === 'ellipse') { el = document.createElementNS(NS, 'ellipse');
        el.setAttribute('cx','100'); el.setAttribute('cy','90');
        el.setAttribute('rx','40'); el.setAttribute('ry','30'); }
      else if (kind === 'group') {
        // A CONTAINER takes the other branch entirely — it writes a transform in its
        // PARENT's space instead of geometry in its own, so it needs its own row.
        el = document.createElementNS(NS, 'g');
        for (const [x0, w0] of [[60, 30], [110, 30]]) {
          const r2 = document.createElementNS(NS, 'rect');
          r2.setAttribute('x', String(x0)); r2.setAttribute('y','60');
          r2.setAttribute('width', String(w0)); r2.setAttribute('height','60');
          r2.setAttribute('fill','#4a8cff');
          el.appendChild(r2);
        }
      }
      else { el = document.createElementNS(NS, 'path');
        el.setAttribute('d','M 60 60 L 140 60 L 140 120 Z'); }
      el.id = 'sp_' + i; el.setAttribute('fill', '#4a8cff');
      g.appendChild(el); frame.appendChild(g);
      s.rebuildShapesFromDOM(); s.selectShape(el.id);
      return el;
    };
    const cases = [
      ['rect', null], ['rect', 'translate(700,700) scale(2)'], ['rect', 'translate(700,900) scale(0.5)'],
      ['ellipse', 'translate(900,700) scale(2)'], ['path', 'translate(1100,700) scale(2)'],
      ['rect', 'translate(900,900) rotate(30)'],
      // An ancestor that rotates AND scales: the rotation used to survive into the
      // delta and cost the drag cos(theta), for leaves and containers alike (#273).
      ['rect', 'translate(1300,700) scale(1.6) rotate(20)'],
      ['ellipse', 'translate(1300,900) scale(1.6) rotate(45)'],
      ['group', 'translate(1500,700) scale(1.6) rotate(20)'],
      ['group', 'translate(1500,900) scale(2)'],
    ];
    const out = [];
    for (let i = 0; i < cases.length; i++) {
      const el = mk(cases[i][0], cases[i][1], i);
      await new Promise(r => setTimeout(r, 250));
      const before = worldW(el);
      const ok = await drag(40);
      const gained = Math.round((worldW(el) - before) * 100) / 100;
      out.push({ kind: cases[i][0], tf: cases[i][1] || 'none', gained, ok });
    }
    // 40 SCREEN px is however many WORLD units the current zoom says — compare
    // against that, not a hard-coded 40, so the guard survives a zoom change.
    const m = layer.getScreenCTM();
    const pxPerUnit = Math.hypot(m.a, m.b) || 1;
    const expected = Math.round((40 / pxPerUnit) * 100) / 100;
    document.getElementById('drawing-layer').innerHTML = saved;
    s.rebuildShapesFromDOM();
    return { expected, cases: out };
  }`);
  (spaces && Array.isArray(spaces.cases) && spaces.cases.length === 10
     && spaces.cases.every(c => c.ok && Math.abs(c.gained - spaces.expected) <= 2))
    ? pass('guard:resize-tracks-pointer-in-any-space')
    : fail('guard:resize-tracks-pointer-in-any-space', JSON.stringify(spaces));

  // (d4e) A radius wider than half the box must draw as a PILL, not an ellipse.
  //       SVG clamps rx and ry INDEPENDENTLY (rx to w/2, ry to h/2), so a 20x39
  //       rect with r=16 rendered as a full oval — rx became 10 while ry stayed 16.
  //       Both are now clamped to the same min(w,h)/2, and the AUTHORED radius is
  //       remembered in data-radius so growing the box brings it back, the way
  //       Figma keeps what you typed.
  const clamp = await boolOf(`async () => {
    const s = window.state;
    const saved = document.getElementById('drawing-layer').innerHTML;
    const NS = 'http://www.w3.org/2000/svg';
    const frame = document.querySelector('[data-frame]') || document.getElementById('drawing-layer');
    const rs = await import('/src/core/rect-shape.ts');
    const el = document.createElementNS(NS, 'rect');
    el.id = 'cl_r'; el.setAttribute('x','700'); el.setAttribute('y','700');
    el.setAttribute('width','200'); el.setAttribute('height','140'); el.setAttribute('fill','#e8892b');
    frame.appendChild(el); s.rebuildShapesFromDOM();
    rs.setRectRadii(el, [16, 16, 16, 16]);
    const big = { rx: el.getAttribute('rx'), ry: el.getAttribute('ry') };
    rs.applyRectBox(el, 700, 700, 20, 39);
    const small = { rx: el.getAttribute('rx'), ry: el.getAttribute('ry'),
                    authored: rs.readRectBox(el).radii[0] };
    rs.applyRectBox(el, 700, 700, 200, 140);
    const back = { rx: el.getAttribute('rx'), ry: el.getAttribute('ry'),
                   dataRadius: el.getAttribute('data-radius') };
    document.getElementById('drawing-layer').innerHTML = saved;
    s.rebuildShapesFromDOM();
    return { big, small, back };
  }`);
  (clamp && clamp.big.rx === '16' && clamp.big.ry === '16'
     && clamp.small.rx === '10' && clamp.small.ry === '10'
     && clamp.small.authored === 16
     && clamp.back.rx === '16' && clamp.back.ry === '16' && clamp.back.dataRadius === null)
    ? pass('guard:radius-clamps-to-pill')
    : fail('guard:radius-clamps-to-pill', JSON.stringify(clamp));

  // (d4d) Dragging a MULTI-selection onto another layer must group ALL of it. The
  //       panel tracked a single draggedId, so dropping five selected labels onto a
  //       rectangle grouped only the grabbed row plus the rectangle and silently
  //       abandoned the rest. Dragging an UNSELECTED row must still carry just that
  //       row, and nothing may shift on screen.
  const grp = await boolOf(`async () => {
    const s = window.state;
    const saved = document.getElementById('drawing-layer').innerHTML;
    const NS = 'http://www.w3.org/2000/svg';
    const frame = document.querySelector('[data-frame]') || document.getElementById('drawing-layer');
    const rect = document.createElementNS(NS, 'rect');
    rect.id = 'gm_bg'; rect.setAttribute('x','600'); rect.setAttribute('y','600');
    rect.setAttribute('width','300'); rect.setAttribute('height','180');
    rect.setAttribute('fill','#2b3a55'); frame.appendChild(rect);
    const labels = [];
    for (let i = 0; i < 4; i++) {
      const t = document.createElementNS(NS, 'text'); t.id = 'gm_l' + i;
      t.setAttribute('x','620'); t.setAttribute('y', String(630 + i * 34));
      t.setAttribute('font-size','16'); t.setAttribute('fill','#fff');
      t.textContent = 'Label ' + i; frame.appendChild(t); labels.push(t.id);
    }
    s.rebuildShapesFromDOM();
    s.selectedShapeIds = [...labels]; s.onChange_public();
    await new Promise(r => setTimeout(r, 350));

    const pos = (id) => { const e = document.getElementById(id); const r = e.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y) }; };
    const before = Object.fromEntries([...labels, 'gm_bg'].map(id => [id, pos(id)]));

    // Drive the REAL panel drag — asserting the model call alone would pass even
    // with the single-id wiring the panel actually used.
    const row = (id) => document.querySelector('.layer-item[data-id="' + id + '"]');
    const src = row('gm_l1'), dst = row('gm_bg');
    if (!src || !dst) { document.getElementById('drawing-layer').innerHTML = saved;
      s.rebuildShapesFromDOM(); return { noRows: true }; }
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const r = dst.getBoundingClientRect();
    const at = { clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2) };
    dst.dispatchEvent(new DragEvent('dragover', Object.assign({ dataTransfer: dt, bubbles: true, cancelable: true }, at)));
    dst.dispatchEvent(new DragEvent('drop', Object.assign({ dataTransfer: dt, bubbles: true, cancelable: true }, at)));
    src.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 400));

    const walk = (l) => l.flatMap(x => [x, ...walk(x.children || [])]);
    const g = walk(s.shapes).find(x => x.type === 'group');
    const kids = g ? (g.children || []).map(c => c.id) : [];
    const after = Object.fromEntries([...labels, 'gm_bg'].map(id => [id, pos(id)]));
    const moved = Object.keys(before).filter(id =>
      Math.abs(before[id].x - after[id].x) > 1 || Math.abs(before[id].y - after[id].y) > 1);

    document.getElementById('drawing-layer').innerHTML = saved;
    s.rebuildShapesFromDOM();
    return { count: kids.length, bottomIsRect: kids[0] === 'gm_bg', movedCount: moved.length };
  }`);
  (grp && grp.count === 5 && grp.bottomIsRect && grp.movedCount === 0)
    ? pass('guard:drag-multi-selection-groups-all')
    : fail('guard:drag-multi-selection-groups-all', JSON.stringify(grp));

  // (d5) An IMPORTED shape must be selectable. rebuild keys a shape by whatever id
  //      its element already carries, so a foreign file's shapes are named 'c1' /
  //      'track', not 'shape-N'. Click resolution (and the eyedropper, node edit,
  //      measure, z-order) used to identify shapes by that NAME, so every imported
  //      shape was invisible to them and a click fell through to the frame the
  //      import wraps content in — "clicking any object selects the whole frame".
  const impSel = await boolOf(`async () => {
    const s = window.state;
    const saved = document.getElementById('drawing-layer').innerHTML;
    const pf = await import('/src/ui/project-file.ts');
    pf.loadDocumentSVG(s, '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">'
      + '<rect id="foreign_a" x="10" y="10" width="60" height="60" fill="#c33"/>'
      + '<g id="foreign_g"><rect id="foreign_b" x="100" y="10" width="60" height="60" fill="#3c3"/></g></svg>');
    const el = document.getElementById('foreign_a');
    const modelled = !!s.findShapeById('foreign_a');
    const frameWraps = s.shapes.length === 1 && s.shapes[0].type === 'frame';
    // Drive the REAL click path, not the model: dispatch mousedown/up at the
    // shape's centre and see what the Select tool resolves it to. Asserting only
    // the model would pass against the broken build too.
    s.selectShape(null);
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    const opts = { clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window, button: 0 };
    hit.dispatchEvent(new MouseEvent('mousedown', opts));
    hit.dispatchEvent(new MouseEvent('mouseup', opts));
    const picked = [...s.selectedShapeIds][0] ?? null;
    const pickedType = s.getSelectedShape()?.type ?? null;
    const out = { modelled, frameWraps, hitIsShape: hit === el, picked, pickedType };
    document.getElementById('drawing-layer').innerHTML = saved;
    s.rebuildShapesFromDOM();
    return out;
  }`);
  (impSel && impSel.modelled && impSel.hitIsShape && impSel.frameWraps
    && impSel.picked === 'foreign_a' && impSel.pickedType === 'rect')
    ? pass('guard:imported-shapes-are-modelled')
    : fail('guard:imported-shapes-are-modelled', JSON.stringify(impSel));

  // (e) A manual edit must stay detached through undo AND redo — reconciling after
  //     saveHistory left the link inside the snapshot, so redo re-attached it.
  const redo = await boolOf(`async () => {
    const mod = await import('/src/ui/library-adapters.ts');
    const s = window.state, ad = mod.adapterFor('paint-style');
    ${mk('mt_r', 180)}
    s.selectShape('mt_r'); const id = ad.createFromSelection(s, 'MT Redo');
    s.selectShape('mt_r'); ad.applyDocument(s, id);
    const layers = s.getAppearance('mt_r');
    const f = layers.find(l => l.t === 'fill');
    if (f) f.paint = '#123456'; else layers.push({ t: 'fill', paint: '#123456', opacity: 1 });
    s.setAppearance('mt_r', layers);
    const detached = !document.getElementById('mt_r').getAttribute('data-paint-style');
    s.undo(); s.redo();
    return { detached, afterRedo: !document.getElementById('mt_r').getAttribute('data-paint-style') };
  }`);
  (redo && redo.detached && redo.afterRedo)
    ? pass('guard:detach-survives-redo') : fail('guard:detach-survives-redo', JSON.stringify(redo));

  // (f) Paste must drop links naming assets this document lacks. Driven through
  //     copySelected/pasteClipboard: calling pruneDanglingStyleLinks() directly
  //     tested the function while leaving the WIRING unguarded (CLAUDE.md: drive
  //     the real gesture, not the model method).
  const pruned = await boolOf(`() => {
    const s = window.state;
    const el = document.getElementById('mt_a');
    if (!el) return { skip: true };
    el.setAttribute('data-paint-style', 'asset-999-bogus');
    s.selectShape('mt_a');
    s.copySelected();
    const before = new Set(s.shapes.map(x => x.id));
    if (!s.pasteClipboard()) return { skip: true };
    const fresh = s.shapes.filter(x => !before.has(x.id));
    const stillLinked = fresh.filter(x => x.element.getAttribute('data-paint-style') === 'asset-999-bogus');
    const out = { pasted: fresh.length, stillLinked: stillLinked.length };
    // Tidy the fixture: the dev [style-links] invariant correctly flags a dangling
    // link, and leaving one poisons every later console assertion.
    for (const el of document.querySelectorAll('[data-paint-style="asset-999-bogus"]')) {
      el.removeAttribute('data-paint-style');
    }
    s.rebuildShapesFromDOM();
    return out;
  }`);
  (pruned && (pruned.skip || (pruned.pasted >= 1 && pruned.stillLinked === 0)))
    ? pass('guard:prunes-foreign-links') : fail('guard:prunes-foreign-links', JSON.stringify(pruned));

  // (g) A palette must capture every paint in a multi-paint stack, not just the top.
  const pal = await boolOf(`async () => {
    const mod = await import('/src/ui/library-adapters.ts');
    const s = window.state;
    ${mk('mt_p', 240)}
    s.setAppearance('mt_p', [
      { t: 'stroke', paint: '#2f6fe0', width: 6, opacity: 1 },
      { t: 'stroke', paint: '#16a085', width: 3, opacity: 1 },
      { t: 'fill', paint: '#e23b3b', opacity: 1 } ]);
    s.selectShape('mt_p');
    const cap = mod.adapterFor('palette').capture(s);
    return cap ? cap.payload.colors.length : 0;
  }`);
  (pal >= 3) ? pass('guard:palette-reads-whole-stack')
    : fail('guard:palette-reads-whole-stack', `captured ${pal} of 3 paints`);

  // (h) Re-applying a non-solid paint style must reuse ONE canonical def per
  //     document, not mint a new one per apply (unbounded <defs> growth).
  const leak = await boolOf(`async () => {
    const mod = await import('/src/ui/library-adapters.ts');
    const s = window.state, ad = mod.adapterFor('paint-style');
    ${mk('mt_src', 300)}
    ${mk('mt_t1', 360)}
    ${mk('mt_t2', 420)}
    const g = s.createGradient('linear');
    s.selectShape('mt_src'); s.setSelectionFill('url(#' + g.id + ')');
    s.selectShape('mt_src'); const id = ad.createFromSelection(s, 'MT Canon');
    if (!id) return { skip: true };
    const svg = document.getElementById('drawing-layer').closest('svg');
    const count = () => svg.querySelectorAll('defs > linearGradient').length;
    s.selectShape('mt_t1'); ad.applyDocument(s, id);
    const n0 = count();
    for (let i = 0; i < 4; i++) {
      s.selectShape(i % 2 ? 'mt_t1' : 'mt_t2');
      ad.applyDocument(s, id);
    }
    return { n0, n1: count() };
  }`);
  (leak && (leak.skip || leak.n1 === leak.n0))
    ? pass('guard:paint-def-no-leak')
    : fail('guard:paint-def-no-leak', `gradient defs grew ${leak && leak.n0} -> ${leak && leak.n1} across 5 applies`);

  // (i) Swapping to a DIFFERENT gradient must detach — "any url() counts as a
  //     match" meant a gradient style silently owned unrelated gradients.
  const grad = await boolOf(`async () => {
    const mod = await import('/src/ui/library-adapters.ts');
    const s = window.state, ad = mod.adapterFor('paint-style');
    ${mk('mt_g', 420)}
    const g1 = s.createGradient('linear');
    s.selectShape('mt_g'); s.setSelectionFill('url(#' + g1.id + ')');
    s.selectShape('mt_g'); const id = ad.createFromSelection(s, 'MT Grad');
    s.selectShape('mt_g'); ad.applyDocument(s, id);
    const linked = !!document.getElementById('mt_g').getAttribute('data-paint-style');
    const g2 = s.createGradient('radial');
    s.selectShape('mt_g'); s.setSelectionFill('url(#' + g2.id + ')');
    return { linked, detached: !document.getElementById('mt_g').getAttribute('data-paint-style') };
  }`);
  (grad && grad.linked && grad.detached)
    ? pass('guard:different-gradient-detaches') : fail('guard:different-gradient-detaches', JSON.stringify(grad));

  // (j) Delete on a focused Library row must not delete the selected ARTWORK.
  //     Two ways this guard can go vacuous, both hit for real while writing it:
  //     the panel ships collapsed (no rows to focus), and focus() re-renders the
  //     list, so a row captured beforehand is DETACHED and its event never reaches
  //     the window handler. So: open the panel, re-query after focus, and assert
  //     the event actually propagated before trusting the artwork check.
  const delKey = await boolOf(`async () => {
    const lib = await import('/src/ui/library-panel.ts');
    const s = window.state;
    document.getElementById('panel-library')?.classList.remove('collapsed');
    lib.updateLibrary(s);
    lib.revealLibrarySection('paint-style');
    lib.updateLibrary(s);
    await new Promise(r => setTimeout(r, 350));
    // Enter hermetically: a modal left open by an earlier guard traps focus (the
    // #198 focus trap) and would make this one's focus/dispatch behave differently.
    const dismissModals = () => document.querySelectorAll('.modal-dialog').forEach((d) => {
      const cancel = [...d.querySelectorAll('button')].find((b) => /cancel/i.test(b.textContent || ''));
      if (cancel) cancel.click(); else d.remove();
    });
    dismissModals();
    if (!document.querySelector('#lib-sections .lib-row')) return { noRow: true };
    if (!document.getElementById('mt_p')) return { noArt: true };
    // Record WHO removes the artwork, if anyone does. A 1-in-13 flake that has
    // resisted reproduction (25 isolated runs in #205, 80 more in a focused stress
    // harness) is not worth chasing blind — but the next occurrence should name its
    // culprit instead of costing another investigation.
    // Patch the removal primitives rather than using a MutationObserver: observer
    // callbacks run as microtasks, so their stack names the observer, not the code
    // that did the removing — which is the entire question.
    let killer = null;
    const hit = (n) => n && (n.id === 'mt_p' || (n.querySelector && n.querySelector('#mt_p')));
    const snap = () => { if (!killer) killer = (new Error('removed by').stack || '').split(String.fromCharCode(10)).slice(1, 9).map(l => l.trim()).join(' <- '); };
    const origRemove = Element.prototype.remove;
    const origRemoveChild = Node.prototype.removeChild;
    const origReplaceWith = Element.prototype.replaceWith;
    Element.prototype.remove = function () { if (hit(this)) snap(); return origRemove.apply(this, arguments); };
    Node.prototype.removeChild = function (c) { if (hit(c)) snap(); return origRemoveChild.apply(this, arguments); };
    Element.prototype.replaceWith = function () { if (hit(this)) snap(); return origReplaceWith.apply(this, arguments); };
    const restorePatches = () => {
      Element.prototype.remove = origRemove;
      Node.prototype.removeChild = origRemoveChild;
      Element.prototype.replaceWith = origReplaceWith;
    };
    s.selectShape('mt_p');
    document.querySelector('#lib-sections .lib-row').focus();
    await new Promise(r => setTimeout(r, 120));
    const row = document.querySelector('#lib-sections .lib-row'); // re-query: focus re-renders
    if (!row || !row.isConnected) { restorePatches(); return { detached: true }; }
    let reachedWindow = false;
    const spy = () => { reachedWindow = true; };
    window.addEventListener('keydown', spy);
    const ev = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
    row.dispatchEvent(ev);
    window.removeEventListener('keydown', spy);
    // Did the ROW itself handle it? If the row was swapped by a re-render between the
    // re-query and this dispatch, the listener isn't there and nothing is proven —
    // the artwork would survive only because the event went nowhere.
    const rowHandled = ev.defaultPrevented;
    await new Promise(r => setTimeout(r, 400));
    const artworkAlive = !!document.getElementById('mt_p');
    restorePatches();
    // Leave hermetically too: the Delete opened deleteDoc's confirm dialog, and
    // this guard used to walk away leaving it on screen for every later guard.
    dismissModals();
    return { reachedWindow, rowHandled, stillConnected: row.isConnected, artworkAlive, killer };
  }`);
  // Two things have to hold, and they fail for different reasons:
  //   rowHandled   — the row's own keydown ran (preventDefault). Without it the event
  //                  went nowhere and a surviving shape proves nothing, so a vacuous
  //                  pass is reported as a failure rather than a green tick.
  //   artworkAlive — the actual guarantee.
  // reachedWindow stays diagnostic: correct code stops the event at the row.
  //
  // Flakiness history (#205): seen ~1 run in 13, and NOT reproduced in isolation —
  // 25 direct attempts there, plus 80 more in a focused stress harness (40 with a
  // plain shape, 40 with the appearance-wrapped fixture this guard actually uses).
  // It needs whole-suite context, so it was not chased further by brute force.
  // Instead this guard was made hermetic (it dismisses a modal left open by an
  // earlier guard on the way in, and the confirm dialog its own Delete opens on the
  // way out — it used to leave that dialog on screen for every later guard) and
  // self-diagnosing: the removal primitives are patched for its duration so a
  // failure names the exact call chain that removed the artwork, rather than
  // costing another blind investigation. Verified by removing BOTH protections in
  // the row handler: the guard fails and reports
  //   detachShape <- removeSelected <- edit.delete <- the global keydown handler.
  // Note preventDefault alone is what protects (main.ts skips defaultPrevented
  // events); stopPropagation is defence in depth, so removing only one still passes.
  (delKey && delKey.artworkAlive && delKey.rowHandled)
    ? pass('guard:row-delete-spares-artwork')
    : fail('guard:row-delete-spares-artwork',
        !delKey ? 'no result'
        : (delKey.noRow || delKey.noArt || delKey.detached)
          ? `fixture missing (${JSON.stringify(delKey)}) — guard would be vacuous`
          : !delKey.rowHandled
            ? `the row never handled the key (row swapped by a re-render?) — nothing proven: ${JSON.stringify(delKey)}`
            : `artwork mt_p was gone after Delete on a Library row; event ${delKey.reachedWindow ? 'DID reach window (global shortcut fired)' : 'was stopped at the row (something else removed it)'}${delKey.killer ? `; REMOVED BY: ${delKey.killer}` : '; no DOM removal was observed — mt_p was never removed, so it was never re-added after an appearance/wrapper rebuild'} — ${JSON.stringify(delKey)}`);

  // (k) Ids must carry a random token, not a bare counter. Two documents each
  //     mint "asset-3"/"ts-2" independently; without the token, copying between
  //     them silently rebinds objects to the WRONG style.
  const tokens = await boolOf(`async () => {
    const mod = await import('/src/ui/library-adapters.ts');
    const s = window.state;
    ${mk('mt_tok', 480)}
    s.selectShape('mt_tok');
    const assetId = mod.adapterFor('paint-style').createFromSelection(s, 'MT Token');
    const ts = s.createTextStyle('MT Text Token', { fontFamily: 'Inter', fontSize: 16 });
    // asset-<n>-<token> / ts-<n>-<token>: a bare counter has no third segment.
    return { asset: /^asset-[0-9]+-[a-z0-9]+$/.test(String(assetId)),
             text: /^ts-[0-9]+-[a-z0-9]+$/.test(String(ts && ts.id)) };
  }`);
  (tokens && tokens.asset && tokens.text)
    ? pass('guard:ids-carry-token')
    : fail('guard:ids-carry-token', `bare counters collide across documents: ${JSON.stringify(tokens)}`);

  // (l) A carrier holding the same symbol twice must not double the library.
  //     Seeded deliberately: the dedupe is unreachable on well-formed input, so a
  //     plain "rebuild 3x" check can never see it.
  const dedupe = await boolOf(`() => {
    const s = window.state;
    const c = document.querySelector('#drawing-layer > metadata.bq-symbols');
    if (!c) return { skip: true };
    let markups;
    try { markups = JSON.parse(c.getAttribute('data-symbols') || '[]'); } catch { return { skip: true }; }
    if (!markups.length) return { skip: true };
    const n0 = s.symbols.length;
    c.setAttribute('data-symbols', JSON.stringify(markups.concat(markups)));
    s.rebuildShapesFromDOM();
    return { n0, n1: s.symbols.length };
  }`);
  (dedupe && (dedupe.skip || dedupe.n1 === dedupe.n0))
    ? pass('guard:symbol-carrier-dedupe')
    : fail('guard:symbol-carrier-dedupe', `duplicate carrier entries doubled the library ${dedupe && dedupe.n0} -> ${dedupe && dedupe.n1}`);

  // (m) An open <select> in the style editor must survive its own pointerup —
  //     committing there tore the editor down, so the dropdown flashed for one
  //     frame and vanished (user-reported).
  const dd = await boolOf(`async () => {
    const sp = await import('/src/ui/style-panel.ts');
    const mod = await import('/src/ui/library-adapters.ts');
    const s = window.state;
    ${mk('mt_dd', 540)}
    s.selectShape('mt_dd');
    const pid = mod.adapterFor('pattern').createFromSelection(s, 'MT Dropdown');
    if (!pid) return { skip: true };
    sp.setFocusedStyle('pattern', pid);
    sp.updateStylePanel(s);
    await new Promise(r => setTimeout(r, 200));
    const body = document.getElementById('style-panel-body');
    const sel = body && body.querySelector('select');
    // NOT a skip: the editor must expose its dropdown, else this guard is vacuous.
    if (!sel) return { noSelect: true };
    sel.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    sel.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    return { alive: sel.isConnected };
  }`);
  (dd && (dd.skip || dd.alive))
    ? pass('guard:editor-dropdown-survives-pointerup')
    : fail('guard:editor-dropdown-survives-pointerup', dd && dd.noSelect
        ? 'the pattern editor rendered no <select> — guard would be vacuous'
        : 'pointerup rebuilt the editor and destroyed the open <select>');

  // (z) Image Trace: holes must be punched, and the art must land ON the image.
  // Two failure modes this engine has, and neither shows up as a console error:
  // a ring traced as a solid disc (the hole sub-path wound the wrong way, so the
  // nonzero rule fills it), and art placed at the wrong spot (buildTracedGroup
  // dropping the image's OWN transform instead of composing with it).
  const trace = await boolOf(`async () => {
    const mod = await import('/src/core/image-trace.ts');
    const NS = 'http://www.w3.org/2000/svg';
    const c = document.createElement('canvas'); c.width = 200; c.height = 200;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 200, 200);
    g.fillStyle = '#e8892b'; g.beginPath(); g.arc(100, 100, 80, 0, 7); g.fill();
    g.fillStyle = '#ffffff'; g.beginPath(); g.arc(100, 100, 36, 0, 7); g.fill();

    const img = document.createElementNS(NS, 'image'); img.id = 'tr_img';
    img.setAttribute('x', '0'); img.setAttribute('y', '0');
    img.setAttribute('width', '120'); img.setAttribute('height', '120');
    img.setAttribute('transform', 'translate(420 700)');  // own transform must survive
    img.setAttribute('href', c.toDataURL('image/png'));
    document.getElementById('drawing-layer').appendChild(img);

    if (!mod.isTraceable(img)) return { notTraceable: true };
    const box = img.getBoundingClientRect();
    const r = await mod.traceShape(img, { mode: 'color', colors: 4, detail: 40, despeckle: 10 }, 200);
    const grp = mod.buildTracedGroup(img, r, 'traced');
    img.parentNode.insertBefore(grp, img.nextSibling);
    const got = grp.getBoundingClientRect();

    // The traced ring, found by its fill rather than by index.
    const svg = grp.ownerSVGElement;
    const at = (x, y) => { const p = svg.createSVGPoint(); p.x = x; p.y = y; return p; };
    const cx = r.pixelW / 2, cy = r.pixelH / 2;
    // Identify the band by what it COVERS, not by index or colour: quantisation
    // leaves thin anti-alias rings in the same orange family, and those are not
    // the shape whose hole we care about.
    let ring = null;
    for (const path of grp.querySelectorAll('path')) {
      const m = /^#([0-9a-f]{6})$/i.exec(path.getAttribute('fill') || '');
      if (!m) continue;
      const R = parseInt(m[1].slice(0, 2), 16);
      const G = parseInt(m[1].slice(2, 4), 16);
      const B = parseInt(m[1].slice(4, 6), 16);
      if (!(R > 180 && G > 80 && G < 200 && B < 120)) continue;
      if (path.isPointInFill(at(cx, cy - 58))) { ring = path; break; }  // r=58 is mid-band
    }
    const out = {
      paths: grp.querySelectorAll('path').length,
      foundRing: !!ring,
      holePunched: ring ? !ring.isPointInFill(at(cx, cy)) : false,  // the white middle
      dx: Math.abs(got.x - box.x), dy: Math.abs(got.y - box.y),
      dw: Math.abs(got.width - box.width), dh: Math.abs(got.height - box.height),
    };
    grp.remove(); img.remove();
    window.state.rebuildShapesFromDOM();
    return out;
  }`);
  const placed = trace && trace.dx < 2 && trace.dy < 2 && trace.dw < 2 && trace.dh < 2;
  (trace && trace.paths > 1 && trace.foundRing && trace.holePunched && placed)
    ? pass('guard:image-trace-holes-and-placement')
    : fail('guard:image-trace-holes-and-placement', JSON.stringify(trace));

  // The prune fixture deliberately plants a dangling link, so the dev [style-links]
  // invariant SHOULD fire while it is in flight. Assert it did (that invariant is
  // itself a guard worth guarding), then exclude it from the error tally.
  const raised = consoleErrors.slice(before);
  const expected = raised.filter((m) => m.includes('asset-999-bogus'));
  expectedConsoleErrors.push(...expected);
  const unexpected = raised.filter((m) => !m.includes('asset-999-bogus'));
  expected.length ? pass('guard:dangling-link-invariant-fires')
    : fail('guard:dangling-link-invariant-fires', 'the dev [style-links] invariant stayed silent on a dangling link');
  (unexpected.length) ? fail('guard:console', unexpected.join(' | ')) : pass('guard:console');
}

// --- The toolbar swatches read real state (#202) ---------------------------------
// A hidden #legacy-stroke block used to shadow the stroke controls, and was believed
// to carry the toolbar swatch + new-shape defaults. It carried neither: the swatches
// read state.defaultStyle directly. With the block gone, prove that link still holds
// through the real keys — Swap (Shift+X) moves the colours, Default (D) restores them.
{
  await page.evaluate(() => { window.state.selectShape(null); window.state.onChange_public(); });
  await page.waitForTimeout(150);
  const read = () => page.evaluate(() => {
    const f = document.querySelector('#tb-fill-swatch .swatch-inner');
    const k = document.querySelector('#tb-stroke-swatch .swatch-inner');
    const s = window.state.defaultStyle;
    return { fillBg: f && getComputedStyle(f).backgroundColor, strokeBorder: k && getComputedStyle(k).borderColor,
      fill: s.fill, stroke: s.stroke, legacyGone: !document.getElementById('legacy-stroke') };
  });
  const toRgb = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return null;
    const n = parseInt(m[1], 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };
  await page.keyboard.press('d'); await page.waitForTimeout(150);
  const base = await read();
  await page.keyboard.press('Shift+X'); await page.waitForTimeout(150);
  const swapped = await read();
  await page.keyboard.press('d'); await page.waitForTimeout(150);
  const restored = await read();
  const tracks = (r) => r.strokeBorder === toRgb(r.stroke) && r.fillBg === toRgb(r.fill);
  (base.legacyGone && tracks(base) && tracks(swapped) && swapped.stroke === base.fill && swapped.fill === base.stroke
     && restored.stroke === base.stroke && restored.fill === base.fill)
    ? pass('guard:toolbar-swatches-read-state')
    : fail('guard:toolbar-swatches-read-state', JSON.stringify({ base, swapped, restored }));
}

// --- One escaper, safe in any position (#190) -----------------------------------
// Five helpers used to exist and three escaped only & < >, which is safe in element
// content but lets a value break out once it lands in an attribute. The survivor
// must survive a hostile string in content AND in both attribute quote styles —
// checked by the real HTML parser — and a document whose metadata carries those
// characters (shape names are in it) must still save and reopen intact.
{
  const r = await page.evaluate(async () => {
    const { escapeHtml } = await import('/src/ui/dom.ts');
    const pf = await import('/src/ui/project-file.ts');
    const hostile = `"><img src=x onerror=alert(1)> it's & <b>done</b>`;
    const div = document.createElement('div');
    div.innerHTML = `<span title="${escapeHtml(hostile)}" data-s='${escapeHtml(hostile)}'>${escapeHtml(hostile)}</span>`;
    const span = div.querySelector('span');
    const parsed = { noInjection: !div.querySelector('img, b'),
      title: span.getAttribute('title') === hostile, single: span.getAttribute('data-s') === hostile,
      text: span.textContent === hostile };

    // Save/reopen round-trip with the hostile string as a shape name (it lands in the
    // JSON metadata, whose quotes are now escaped too).
    const s = window.state;
    const saved = document.getElementById('drawing-layer').innerHTML;
    const NS = 'http://www.w3.org/2000/svg';
    const el = document.createElementNS(NS, 'rect');
    el.id = 'esc_r'; el.setAttribute('x', '40'); el.setAttribute('y', '40');
    el.setAttribute('width', '30'); el.setAttribute('height', '20');
    (document.querySelector('[data-frame]') || document.getElementById('drawing-layer')).appendChild(el);
    s.rebuildShapesFromDOM();
    const shape = s.findShapeById('esc_r');
    shape.name = hostile; el.setAttribute('data-name', hostile);
    const svg = pf.serializeDocumentSVG(s);
    pf.loadDocumentSVG(s, svg);
    const back = s.findShapeById('esc_r');
    const roundTrip = !!back && back.name === hostile;
    document.getElementById('drawing-layer').innerHTML = saved;
    s.rebuildShapesFromDOM();
    return { ...parsed, roundTrip };
  });
  (r && r.noInjection && r.title && r.single && r.text && r.roundTrip)
    ? pass('guard:escape-html-any-position') : fail('guard:escape-html-any-position', JSON.stringify(r));
}

// --- A transform gesture owns its targets (#258) ----------------------------------
// Resize and rotate re-read the LIVE selection on every mousemove, so a selection
// change mid-drag retargeted the gesture. The keyboard makes that easy with the
// mouse still down: Select All (which, with everything inside a frame, selects the
// FRAME) made a two-shape resize stop resizing the shapes and resize the frame
// instead; Escape froze it half-done and skipped the stroke bake. A drag-move
// already kept its own target list. Real mouse + real keys.
{
  const saved = await page.evaluate(() => document.getElementById('drawing-layer').innerHTML);
  const out = [];
  for (const key of ['Control+a', 'Escape']) {
    await page.evaluate(() => {
      const s = window.state, NS = 'http://www.w3.org/2000/svg';
      const frame = document.querySelector('[data-frame]');
      for (const [id, x] of [['own_a', 460], ['own_b', 620]]) {
        const r = document.createElementNS(NS, 'rect');
        r.id = id; r.setAttribute('x', String(x)); r.setAttribute('y', '300');
        r.setAttribute('width', '100'); r.setAttribute('height', '80'); r.setAttribute('fill', '#4a8cff');
        frame.appendChild(r);
      }
      s.rebuildShapesFromDOM();
      s.selectMultiple(['own_a', 'own_b']);
    });
    await page.waitForTimeout(250);
    const snap = () => page.evaluate(() => {
      const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, w: r.width }; };
      const f = document.querySelector('[data-frame]');
      return { a: box('own_a'), b: box('own_b'), frame: [f.getAttribute('transform'), f.getAttribute('data-frame-w'), f.getAttribute('data-frame-h')].join('|') };
    });
    const before = await snap();
    const h = await page.evaluate(() => { const n = document.querySelector('[data-handle="se"]'); if (!n) return null;
      const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    if (!h) { out.push({ key, noHandle: true }); continue; }
    await page.mouse.move(h.x, h.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(h.x + 6 * i, h.y + 4 * i);
      if (i === 5) await page.keyboard.press(key);          // selection changes, mouse still down
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await page.waitForTimeout(250);
    const after = await snap();
    // Both shapes must finish the WHOLE resize (the combined box grows by the full
    // 60px, shared between them), anchored at the far corner, and the frame untouched.
    const grewA = after.a.w - before.a.w, grewB = after.b.w - before.b.w;
    out.push({ key, grewA: Math.round(grewA), grewB: Math.round(grewB),
      anchorHeld: Math.abs(after.a.x - before.a.x) <= 1,
      frameUntouched: after.frame === before.frame,
      fullGrowth: Math.abs((after.b.x + after.b.w) - (before.b.x + before.b.w) - 60) <= 2 });
    await page.evaluate((html) => { document.getElementById('drawing-layer').innerHTML = html; window.state.rebuildShapesFromDOM(); window.state.selectShape(null); }, saved);
  }
  (out.length === 2 && out.every((c) => !c.noHandle && c.grewA > 10 && c.grewB > 10 && c.anchorHeld && c.frameUntouched && c.fullGrowth))
    ? pass('guard:transform-gesture-owns-targets')
    : fail('guard:transform-gesture-owns-targets', JSON.stringify(out));
}

// --- Hollow outlines are selectable by their inside (#260) ------------------------
// The browser's own hit-test misses the interior of a fill:none shape, so outlined
// artwork looked selectable but behaved like empty canvas. The fallback must use the
// SHAPE's area, not its bounding box: a box test selected a U-shape from inside its
// notch. Real mouse clicks, one fresh fixture per case.
{
  const saved = await page.evaluate(() => document.getElementById('drawing-layer').innerHTML);
  const cases = [
    ['hollow-rect-centre', '<rect x="20" y="20" width="160" height="160"/>', 100, 100, true],
    ['u-shape-arm', '<path d="M20 20 H60 V140 H140 V20 H180 V180 H20 Z"/>', 40, 100, true],
    ['u-shape-notch', '<path d="M20 20 H60 V140 H140 V20 H180 V180 H20 Z"/>', 100, 60, false],
    ['open-path-inside-box', '<path d="M20 180 L100 20 L180 180"/>', 100, 150, false],
  ];
  const out = [];
  for (const [name, shape, fx, fy, shouldSelect] of cases) {
    const at = await page.evaluate(({ shape, fx, fy }) => {
      const s = window.state, NS = 'http://www.w3.org/2000/svg';
      const frame = document.querySelector('[data-frame]') || document.getElementById('drawing-layer');
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('transform', 'translate(420 260)');
      g.innerHTML = shape;
      const el = g.firstElementChild;
      el.id = 'hol_t';
      el.setAttribute('fill', 'none'); el.setAttribute('stroke', '#000'); el.setAttribute('stroke-width', '2');
      frame.appendChild(g);
      s.rebuildShapesFromDOM();
      s.selectedShapeIds = []; s.onChange_public();
      const p = new DOMPoint(fx, fy).matrixTransform(el.getScreenCTM());
      return { x: p.x, y: p.y, native: document.elementFromPoint(p.x, p.y)?.id || '' };
    }, { shape, fx, fy });
    await page.waitForTimeout(150);
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(200);
    const sel = await page.evaluate(() => {
      const ids = window.state.selectedShapeIds.slice();
      const t = document.getElementById('hol_t');
      // The click resolves to the outermost group, so "selected" means the fixture or its wrapper.
      return ids.some((id) => { const e = document.getElementById(id); return !!e && !!t && (e === t || e.contains(t)); });
    });
    out.push({ name, shouldSelect, selected: sel, nativeMissed: at.native !== 'hol_t' });
    await page.evaluate((html) => { document.getElementById('drawing-layer').innerHTML = html; window.state.rebuildShapesFromDOM(); }, saved);
  }
  // The native hit-test must genuinely miss, or the guard would be vacuous.
  (out.every((c) => c.selected === c.shouldSelect && c.nativeMissed))
    ? pass('guard:hollow-outline-select-by-area')
    : fail('guard:hollow-outline-select-by-area', JSON.stringify(out));
}

// --- Every slider takes a typed value --------------------------------------------
// A slider alone can't land on an exact number, so each <input type="range"> gets an
// editable field (ui/slider-field.ts) instead of a read-only readout. Most sliders
// are built at runtime inside popovers and dialogs, so a DOM check alone can't see
// them — the source scan is what catches a new slider shipped without its field.
{
  const { readFileSync, readdirSync } = await import('node:fs');
  const srcDir = new globalThis.URL('../src/', import.meta.url);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(new globalThis.URL(`${e.name}/`, dir)) : [new globalThis.URL(e.name, dir)]);
  // Counted, not just present: one paired slider in a file used to whitelist any
  // number of bare ones beside it.
  const count = (code, re) => (code.match(re) || []).length;
  const bare = walk(srcDir)
    .filter((u) => u.pathname.endsWith('.ts'))
    .map((u) => {
      const code = readFileSync(u, 'utf8');
      return { file: u.pathname.split('/src/')[1], ranges: count(code, /type\s*=\s*['"]range['"]/g), fields: count(code, /\bsliderField\(/g) - count(code, /export function sliderField\(/g) };
    })
    .filter((f) => f.fields < f.ranges)
    .map((f) => `${f.file}: ${f.ranges} sliders, ${f.fields} fields`);

  await addShape(TYPES[0], 'sf_rect', 300);
  await page.evaluate(() => { window.state.saveHistory(); window.state.selectShape('sf_rect'); });
  await page.waitForTimeout(100);
  const unpaired = await page.evaluate(() => [...document.querySelectorAll('input[type=range]')]
    .filter((r) => !r.nextElementSibling?.classList.contains('slider-field')).map((r) => r.id || r.className));
  const field = page.locator('#obj-opacity + .slider-field .slider-field-input');
  await field.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('37');
  const beforeEnter = await page.evaluate(() => window.state.getObjectOpacity('sf_rect'));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  const typed = await page.evaluate(() => window.state.getObjectOpacity('sf_rect'));
  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(100);
  const undone = await page.evaluate(() => window.state.getObjectOpacity('sf_rect'));
  const shown = await field.inputValue();
  await boolOf(`() => window.state.findShapeById('sf_rect') && window.state.removeShape('sf_rect')`);
  (bare.length === 0 && unpaired.length === 0 && beforeEnter === 1 && typed === 0.37 && undone === 1 && shown === '100')
    ? pass('guard:slider-value-fields')
    : fail('guard:slider-value-fields', JSON.stringify({ bare, unpaired, beforeEnter, typed, undone, shown }));
}

// --- Escape reverts a half-typed field before a dialog hears it (#301) --------------
// A dialog closes on Escape from a document capture listener, which runs before any
// listener on the field: typing a radius in Round Corners and pressing Escape threw
// the whole dialog away. The first Escape puts the field back; the second closes.
{
  await page.evaluate(() => {
    const s = window.state, NS = 'http://www.w3.org/2000/svg';
    const el = document.createElementNS(NS, 'rect');
    el.id = 'esc_rect';
    for (const [k, v] of Object.entries({ x: 200, y: 640, width: 160, height: 120, fill: '#39f' })) el.setAttribute(k, String(v));
    (document.querySelector('[data-frame]') || document.getElementById('drawing-layer')).appendChild(el);
    s.rebuildShapesFromDOM(); s.saveHistory();
    s.selectShape('esc_rect'); s.onChange_public();
  });
  await page.waitForTimeout(150);
  await page.locator('button.menu-trigger', { hasText: /^Path$/ }).click();
  await page.waitForTimeout(120);
  await page.locator('.menu-panel[aria-label="Path"] [role=menuitem]', { hasText: 'Round Corners' }).click();
  await page.waitForTimeout(250);
  const field = page.locator('.dlg-corners .slider-field-input');
  const hasField = await field.count() === 1; // (a dialog without its field fails below, not by timing out)
  const start = hasField ? await field.inputValue() : null;
  if (hasField) {
    await field.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('33');
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const afterFirst = { open: await page.locator('.dlg-corners').count(), value: hasField ? await field.inputValue().catch(() => null) : null };
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const afterSecond = { open: await page.locator('.dlg-corners').count(),
    tag: await page.evaluate(() => window.state.findShapeById('esc_rect')?.element.tagName.toLowerCase()) };
  await page.evaluate(() => { if (window.state.findShapeById('esc_rect')) window.state.removeShape('esc_rect'); });
  (hasField && afterFirst.open === 1 && afterFirst.value === start && afterSecond.open === 0 && afterSecond.tag === 'rect')
    ? pass('guard:escape-reverts-the-field-first')
    : fail('guard:escape-reverts-the-field-first', JSON.stringify({ start, afterFirst, afterSecond }));
}

// --- Round Corners / Smooth ------------------------------------------------------
// The fillet is measured, not assumed: a 90° corner rounded at r must leave the path
// exactly r·(√2−1) from the old corner, so a wrong handle constant (the 0.5523
// quarter-circle number generalised to any angle) fails here instead of looking
// "roughly rounded". The other half is the dialog's contract: a cancelled preview
// restores the ORIGINAL element — including the <rect> that the preview converted to
// a <path> — and costs no undo step.
{
  const geom = await page.evaluate(async () => {
    const s = window.state, NS = 'http://www.w3.org/2000/svg';
    const el = document.createElementNS(NS, 'rect');
    el.id = 'rc_rect';
    el.setAttribute('x', '200'); el.setAttribute('y', '620');
    el.setAttribute('width', '160'); el.setAttribute('height', '120');
    el.setAttribute('fill', '#39f');
    s.addShape({ id: 'rc_rect', type: 'rect', element: el, name: 'rc_rect',
      style: { fill: '#39f', stroke: 'none', strokeWidth: 0, opacity: 1 }, visible: true, locked: false });
    s.saveHistory();
    s.selectShape('rc_rect');

    // 1. preview → cancel: the rect comes back, untouched.
    const began = s.beginCornerPreview();
    const previewTag = s.findShapeById('rc_rect').element.tagName;
    s.previewCornerRadius(24);
    s.cancelCornerPreview();
    const afterCancel = s.findShapeById('rc_rect').element;
    const restored = afterCancel.tagName.toLowerCase() === 'rect'
      && afterCancel.getAttribute('width') === '160' && !afterCancel.getAttribute('d');

    // 2. round for real, and measure how close the result comes to the old corner.
    s.selectShape('rc_rect');
    const rounded = s.roundSelectedCorners(24);
    const path = s.findShapeById('rc_rect').element;
    let gap = Infinity;
    if (path.getTotalLength) {
      const L = path.getTotalLength();
      for (let i = 0; i <= 800; i++) {
        const p = path.getPointAtLength((i / 800) * L);
        gap = Math.min(gap, Math.hypot(p.x - 200, p.y - 620));
      }
    }
    const expected = 24 * (Math.SQRT2 - 1);

    // 3. one undo puts the rect back (conversion + rounding = a single step).
    s.undo();
    const undoneTag = s.findShapeById('rc_rect')?.element.tagName.toLowerCase();

    // 4. smoothing a cornered path gives every interior corner handles.
    const p2 = document.createElementNS(NS, 'path');
    p2.id = 'rc_path';
    p2.setAttribute('d', 'M 420 620 L 520 700 L 620 620 L 720 700');
    p2.setAttribute('fill', 'none'); p2.setAttribute('stroke', '#39f');
    s.addShape({ id: 'rc_path', type: 'path', element: p2, name: 'rc_path',
      style: { fill: 'none', stroke: '#39f', strokeWidth: 1, opacity: 1 }, visible: true, locked: false });
    s.saveHistory();
    s.selectShape('rc_path');
    const smoothed = s.smoothSelectedPaths();
    const smoothD = s.findShapeById('rc_path').element.getAttribute('d');
    s.undo();
    const backToCorners = s.findShapeById('rc_path')?.element.getAttribute('d');

    for (const id of ['rc_rect', 'rc_path']) if (s.findShapeById(id)) s.removeShape(id);
    return { began, previewTag, restored, rounded, gap, expected, undoneTag, smoothed, smoothD, backToCorners };
  });
  const ok = geom.began && geom.previewTag.toLowerCase() === 'path' && geom.restored && geom.rounded
    && Math.abs(geom.gap - geom.expected) < 0.3 && geom.undoneTag === 'rect'
    && geom.smoothed && /C/.test(geom.smoothD) && !/C/.test(geom.backToCorners);
  ok ? pass('guard:round-corners-and-smooth')
    : fail('guard:round-corners-and-smooth', JSON.stringify(geom).slice(0, 400));
}

// --- The click that ends an inline rename still reaches its target ----------------
// Committing a rename re-renders the panels. That rebuild used to run from the blur
// — i.e. between the click's mousedown and mouseup — so the element under the
// pointer was replaced and the browser dispatched NO click: clicking a fill swatch
// while a layer was mid-rename silently did nothing. Real mouse only; a synthetic
// .click() passes against the broken build (it needs no surviving mouseup target).
{
  const r = await page.evaluate(() => {
    const s = window.state, NS = 'http://www.w3.org/2000/svg';
    const el = document.createElementNS(NS, 'rect');
    el.id = 'rn_rect';
    el.setAttribute('x', '120'); el.setAttribute('y', '820');
    el.setAttribute('width', '90'); el.setAttribute('height', '70'); el.setAttribute('fill', '#39f');
    s.addShape({ id: 'rn_rect', type: 'rect', element: el, name: 'rn_rect',
      style: { fill: '#39f', stroke: 'none', strokeWidth: 0, opacity: 1 }, visible: true, locked: false });
    s.saveHistory(); s.selectShape('rn_rect');
    return true;
  });
  await page.waitForTimeout(200);
  // Click the name of the already-selected row: that starts the inline rename.
  const nameSel = '#layers-list li[data-id="rn_rect"] .layer-name';
  let renaming = 0, opened = 0, named = '';
  if (await page.locator(nameSel).count()) {
    await page.locator(nameSel).click();
    await page.waitForTimeout(250);
    renaming = await page.locator('#layers-list input.layer-rename').count();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Renamed Layer');
    // …then a REAL click on a control in a panel that the commit re-renders.
    if (await page.locator('#fills-list .ap-color').count()) {
      await page.locator('#fills-list .ap-color').first().click();
      await page.waitForTimeout(600);
    }
    opened = await page.locator('.cpicker-panel').count();
    named = await page.evaluate(() => window.state.findShapeById('rn_rect')?.name ?? '');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await page.evaluate(() => document.querySelectorAll('.cpicker-overlay').forEach(o => o.remove()));
  }
  await boolOf(`() => window.state.findShapeById('rn_rect') && window.state.removeShape('rn_rect')`);
  (r && renaming === 1 && opened === 1 && named === 'Renamed Layer')
    ? pass('guard:rename-commit-keeps-the-click')
    : fail('guard:rename-commit-keeps-the-click', JSON.stringify({ renaming, opened, named }));
}

// --- Resize cursors follow the object's rotation ---------------------------------
// The cursor is picked from the box's RENDERED corners, not the handle's name, so
// it points along the direction that handle actually drags. A by-name cursor is up
// to 90° wrong on a rotated shape — at 90° the "N" handle drags horizontally, so it
// must read ew-resize, and the corner cursors swap diagonals.
{
  const r = await page.evaluate(async () => {
    const s = window.state, NS = 'http://www.w3.org/2000/svg';
    const { setRotation } = await import('/src/core/transform.ts');
    const el = document.createElementNS(NS, 'rect');
    el.id = 'cur_rect';
    el.setAttribute('x', '300'); el.setAttribute('y', '820');
    el.setAttribute('width', '160'); el.setAttribute('height', '100'); el.setAttribute('fill', '#39f');
    s.addShape({ id: 'cur_rect', type: 'rect', element: el, name: 'cur_rect',
      style: { fill: '#39f', stroke: 'none', strokeWidth: 0, opacity: 1 }, visible: true, locked: false });
    s.selectShape('cur_rect');
    s.onChange_public();
    const read = () => {
      const out = {};
      for (const h of document.querySelectorAll('#selection-layer [data-handle]')) {
        const id = h.getAttribute('data-handle');
        if (id !== 'rotate') out[id] = getComputedStyle(h).cursor;
      }
      return out;
    };
    const flat = read();
    setRotation(el, 90, 380, 870);
    s.selectShape('cur_rect');
    s.onChange_public();
    const turned = read();
    s.removeShape('cur_rect');
    return { flat, turned };
  });
  const FLAT = { nw: 'nwse-resize', n: 'ns-resize', ne: 'nesw-resize', e: 'ew-resize', se: 'nwse-resize', s: 'ns-resize', sw: 'nesw-resize', w: 'ew-resize' };
  // Every handle's cursor rotates by 90°: axes swap, diagonals swap.
  const TURNED = { nw: 'nesw-resize', n: 'ew-resize', ne: 'nwse-resize', e: 'ns-resize', se: 'nesw-resize', s: 'ew-resize', sw: 'nwse-resize', w: 'ns-resize' };
  const same = (got, want) => Object.keys(want).length > 0
    && Object.keys(want).every(k => got[k] === want[k]);
  (r && same(r.flat, FLAT) && same(r.turned, TURNED))
    ? pass('guard:resize-cursors-follow-rotation')
    : fail('guard:resize-cursors-follow-rotation', JSON.stringify(r));
}

// --- Cropping never eats a rotation ----------------------------------------------
// Double-clicking an image opens a crop session. Three contracts, all of which used
// to lose work: opening one and backing out must leave the markup byte for byte as
// it was (it rebuilt the element and spent an undo step); a real crop must hand back
// everything the old element carried — above all its transform, which was dropped,
// flattening a carefully rotated image onto its bounding box; and "reset crop" must
// restore a rotated FULL image, not its bounding box.
{
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const build = await page.evaluate(async (PNG) => {
    const s = window.state, NS = 'http://www.w3.org/2000/svg';
    const el = document.createElementNS(NS, 'image');
    el.id = 'crop_img';
    el.setAttribute('x', '200'); el.setAttribute('y', '150');
    el.setAttribute('width', '160'); el.setAttribute('height', '120');
    el.setAttribute('href', PNG);
    el.setAttribute('preserveAspectRatio', 'none');
    el.setAttribute('transform', 'rotate(24 280 210)');
    el.setAttribute('opacity', '0.8');
    (document.querySelector('[data-frame]') || document.getElementById('drawing-layer')).appendChild(el);
    s.rebuildShapesFromDOM();
    s.saveHistory();
    s.selectShape('crop_img');
    s.onChange_public();
    return s.findShapeById('crop_img')?.element.outerHTML ?? null;
  }, PNG);

  // 1. open a crop session and leave it untouched
  await page.evaluate(() => window.state.requestTool?.('crop'));
  await page.waitForTimeout(150);
  const entered = await page.evaluate(() => window.state.currentTool);
  await page.evaluate(() => window.state.requestTool?.('select'));
  await page.waitForTimeout(250);
  const afterNoop = await page.evaluate(() => window.state.findShapeById('crop_img')?.element.outerHTML ?? null);

  // 2. a REAL crop, dragged along the image's own axes, then committed
  await page.evaluate(() => { window.state.selectShape('crop_img'); window.state.requestTool?.('crop'); });
  await page.waitForTimeout(250);
  const frame = await page.evaluate(() => {
    const g = document.querySelector('#guides-layer g[transform]');
    const outline = [...document.querySelectorAll('#guides-layer rect')].pop();
    if (!g || !outline) return null;
    const m = new DOMMatrix(g.getAttribute('transform'));
    const o = new DOMPoint(0, 0).matrixTransform(m);
    const ax = new DOMPoint(1, 0).matrixTransform(m), ay = new DOMPoint(0, 1).matrixTransform(m);
    const se = new DOMPoint(
      +outline.getAttribute('x') + +outline.getAttribute('width'),
      +outline.getAttribute('y') + +outline.getAttribute('height'),
    ).matrixTransform(g.getScreenCTM());
    return { se: { x: se.x, y: se.y }, ax: { x: ax.x - o.x, y: ax.y - o.y }, ay: { x: ay.x - o.x, y: ay.y - o.y } };
  });
  let cropped = null, undone = null;
  if (frame) {
    const to = { x: frame.se.x - (frame.ax.x + frame.ay.x) * 30, y: frame.se.y - (frame.ax.y + frame.ay.y) * 30 };
    await page.mouse.move(frame.se.x, frame.se.y);
    await page.mouse.down();
    await page.mouse.move((frame.se.x + to.x) / 2, (frame.se.y + to.y) / 2, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(350);
    cropped = await page.evaluate(() => {
      const el = window.state.findShapeById('crop_img')?.element;
      if (!el) return null;
      const vb = (el.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
      return { tag: el.tagName.toLowerCase(), transform: el.getAttribute('transform'),
        opacity: el.getAttribute('opacity'), type: window.state.findShapeById('crop_img').type, vb };
    });
    await page.keyboard.press('Control+Z');
    await page.waitForTimeout(350);
    undone = await page.evaluate(() => window.state.findShapeById('crop_img')?.element.outerHTML ?? null);
  }

  // 3. reset crop (uncrop) keeps the rotation and restores the full image
  const uncropped = await page.evaluate(async (PNG) => {
    const NS = 'http://www.w3.org/2000/svg';
    const { uncropToImage } = await import('/src/tools/crop.ts');
    const wrap = document.createElementNS(NS, 'svg');
    wrap.id = 'crop_wrap';
    wrap.setAttribute('data-crop', '');
    wrap.setAttribute('x', '20'); wrap.setAttribute('y', '20');
    wrap.setAttribute('width', '60'); wrap.setAttribute('height', '40');
    wrap.setAttribute('viewBox', '20 20 60 40');
    wrap.setAttribute('transform', 'rotate(24 50 40)');
    wrap.setAttribute('opacity', '0.8');
    const inner = document.createElementNS(NS, 'image');
    inner.setAttribute('x', '0'); inner.setAttribute('y', '0');
    inner.setAttribute('width', '120'); inner.setAttribute('height', '90');
    inner.setAttribute('href', PNG);
    wrap.appendChild(inner);
    const bare = uncropToImage(wrap);
    return bare && { tag: bare.tagName.toLowerCase(), transform: bare.getAttribute('transform'),
      opacity: bare.getAttribute('opacity'), id: bare.id,
      box: ['x', 'y', 'width', 'height'].map(a => bare.getAttribute(a)).join(',') };
  }, PNG);
  await boolOf(`() => window.state.findShapeById('crop_img') && window.state.removeShape('crop_img')`);

  const u = uncropped;
  const ok = !!build && entered === 'crop' && afterNoop === build
    && !!cropped && cropped.tag === 'svg' && cropped.transform === 'rotate(24 280 210)'
    && cropped.opacity === '0.8' && cropped.type === 'image'
    && cropped.vb.length === 4 && Math.abs(cropped.vb[2] - 130) < 3 && Math.abs(cropped.vb[3] - 90) < 3
    && undone === build
    && !!u && u.tag === 'image' && u.transform === 'rotate(24 50 40)' && u.opacity === '0.8'
    && u.id === 'crop_wrap' && u.box === '0,0,120,90';
  ok ? pass('guard:crop-keeps-the-transform')
    : fail('guard:crop-keeps-the-transform', JSON.stringify({ entered, noopSame: afterNoop === build, cropped, undoSame: undone === build, u }).slice(0, 420));
}

// --- Pixel oracle for rebuild paths ---------------------------------------------------
// Shared by every guard below that asks "did this operation change what's on screen?".
// A case builds a shape (setup), runs the operation (act), and must leave the pixels
// as they were, with one undo restoring them. Ink is measured against a blank shot of
// the same region, so nothing else on the canvas dilutes it.
await page.evaluate(async () => {
  const { setRotation } = await import('/src/core/transform.ts');
  const NS = 'http://www.w3.org/2000/svg', s = window.state;
  const home = () => document.querySelector('[data-frame]') || document.getElementById('drawing-layer');
  const walk = () => { const all = []; const w = (x) => { all.push(x); (x.children ?? []).forEach(w); }; s.shapes.forEach(w); return all; };
  window.__rb = {
    ids: () => walk().map(x => x.id),
    add(tag, attrs, text) {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      if (text) el.textContent = text;
      home().appendChild(el);
      s.rebuildShapesFromDOM();
      return walk().find(x => x.element === el)?.id;
    },
    turn(id, deg, opacity) {
      const el = s.findShapeById(id).element, b = el.getBBox();
      setRotation(el, deg, b.x + b.width / 2, b.y + b.height / 2);
      if (opacity != null) el.setAttribute('opacity', String(opacity));
      s.rebuildShapesFromDOM(); s.saveHistory(); s.onChange_public();
    },
    clearAllBut(keep) { for (const x of walk()) if (!keep.includes(x.id) && s.findShapeById(x.id)) s.removeShape(x.id); },
  };
});
const CHROME = ['#selection-layer', '#guides-layer', '#path-actions-popover', '#pathfinder-popover', '#image-actions-popover', '.selection-popover'];
const rbShot = async (clip) => {
  await page.evaluate((CHROME) => {
    window.state.selectShape(null); window.state.onChange_public();
    for (const sel of CHROME) document.querySelectorAll(sel).forEach(e => { e.setAttribute('data-rb-hidden', ''); e.style.visibility = 'hidden'; });
  }, CHROME);
  await page.waitForTimeout(120);
  const buf = await page.screenshot({ clip });
  await page.evaluate(() => document.querySelectorAll('[data-rb-hidden]').forEach(e => { e.removeAttribute('data-rb-hidden'); e.style.visibility = ''; }));
  return buf.toString('base64');
};
const rbDiff = (imgs) => page.evaluate(async (imgs) => {
  const load = (src) => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + src; });
  const [z, b, a, u] = await Promise.all(imgs.map(load)).then((ims) => {
    const c = document.createElement('canvas'); c.width = ims[0].width; c.height = ims[0].height;
    const g = c.getContext('2d');
    return ims.map((im) => { g.clearRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; });
  });
  const delta = (p, q, i) => Math.max(Math.abs(p[i] - q[i]), Math.abs(p[i + 1] - q[i + 1]), Math.abs(p[i + 2] - q[i + 2]));
  const far = (p, q, i) => delta(p, q, i) > 40;
  let ink = 0, inkBefore = 0, changed = 0, notUndone = 0, sum = 0;
  for (let i = 0; i < z.length; i += 4) {
    const ib = far(b, z, i), ia = far(a, z, i);
    if (ib) inkBefore++;
    if (ib || ia) { ink++; sum += delta(a, b, i); }
    if (far(a, b, i)) changed++;
    if (far(u, b, i)) notUndone++;
  }
  const pct = (n) => Math.round((ink ? n / ink : 1) * 1000) / 10;
  // The mean difference over the ink catches what the >40 count can't: a lost
  // 0.6→0.5 opacity or a dropped blend mode moves every pixel a little, none a lot.
  return { inkBefore, changedPct: pct(changed), notUndonePct: pct(notUndone), meanDiff: Math.round((ink ? sum / ink : 255) * 10) / 10 };
}, imgs);
const rbCase = async (name, setup, act, tol = {}) => {
  const keep = await page.evaluate(() => window.__rb.ids());
  const errs = consoleErrors.length;
  const ctx = await page.evaluate(setup);
  await page.waitForTimeout(200);
  const tagOf = (id) => page.evaluate((id) => window.state.findShapeById(id)?.element.tagName.toLowerCase() ?? null, id ?? null);
  const clip = await page.evaluate((id) => {
    const r = window.state.findShapeById(id)?.element.getBoundingClientRect();
    return r && { x: Math.max(0, r.left - 30), y: Math.max(0, r.top - 30), width: r.width + 60, height: r.height + 60 };
  }, ctx?.measure ?? null);
  if (!clip) return `${name}: setup produced nothing`;
  const tagBefore = await tagOf(ctx.measure);
  const before = await rbShot(clip);
  await page.evaluate((id) => window.state.selectShape(id), ctx.measure);
  const out = await page.evaluate(act, ctx);
  await page.waitForTimeout(300);
  const tagAfter = await tagOf(out);
  const happened = tol.happened ? await page.evaluate(tol.happened, { ...ctx, out }) : true;
  const after = await rbShot(clip);
  await page.evaluate(() => window.state.undo());
  await page.waitForTimeout(250);
  const undone = await rbShot(clip);
  await page.evaluate((keep) => window.__rb.clearAllBut(keep), keep);
  await page.waitForTimeout(150);
  const blank = await rbShot(clip);
  const d = await rbDiff([blank, before, after, undone]);
  if (process.env.RB_DEBUG) console.log(`  ${name}: ${JSON.stringify(d)}`);
  // "It happened": the element changed kind — or, where the operation keeps the tag
  // (a mask committed to a plain group), whatever the case says proves it.
  const ok = d.inkBefore > 50 && !!tagAfter && (tol.happened ? happened : tagAfter !== tagBefore)
    && d.changedPct < (tol.changed ?? 6) && d.meanDiff < (tol.mean ?? 5) && d.notUndonePct < 2 && consoleErrors.length === errs;
  return ok ? null : `${name}: ${JSON.stringify({ tagBefore, tagAfter, happened, ...d, errors: consoleErrors.slice(errs) })}`;
};
/** Run pixel cases under one guard name: `run` is handed the case runner. */
const rbGuard = async (guard, run) => {
  const failures = [];
  await run(async (...a) => { const r = await rbCase(...a); if (r) failures.push(r); });
  failures.length ? fail(guard, failures.join(' || ').slice(0, 900)) : pass(guard);
};

// --- Rebuild paths keep what's rendered -------------------------------------------
// Flatten / outline / detach each REPLACE an element with a rebuilt one, and each
// used to copy a hand-picked attribute list, so a rotation, an opacity or a blur
// silently fell off (and a blurred component instance rendered nothing at all). The
// oracle is the SCREEN, not attributes: every case is rotated, faded or blurred, the
// pixels before and after must match, and one undo must restore them. Ink is measured
// against a blank shot of the same region, so nothing else on the canvas dilutes it.
{
  const rbFailures = [];
  const rb = async (...a) => { const r = await rbCase(...a); if (r) rbFailures.push(r); };
  await rb('boolean flatten', async () => {
    const h = window.__rb, s = window.state;
    const a = h.add('rect', { x: 200, y: 150, width: 160, height: 90, fill: '#39f' });
    const b = h.add('rect', { x: 290, y: 190, width: 120, height: 120, fill: '#39f' });
    s.selectMultiple([a, b]);
    await s.booleanSelection('unite');
    await new Promise(r => setTimeout(r, 300));
    const id = s.selectedShapeIds[0];
    h.turn(id, 30, 0.5);
    return { measure: id };
  }, (ctx) => { window.state.flattenBoolean(ctx.measure); return window.state.selectedShapeIds[0]; });
  await rb('outline stroke (fill + blur)', () => {
    const h = window.__rb, s = window.state;
    const id = h.add('rect', { x: 220, y: 160, width: 180, height: 100, fill: '#39f', stroke: '#e33', 'stroke-width': 10 });
    h.turn(id, 30, 0.6);
    s.selectShape(id); s.setSelectionBlur(3, true);
    return { measure: id };
  }, async () => { await window.state.outlineSelectedStroke(); return window.state.selectedShapeIds[0]; });
  await rb('outline text (blur)', async () => {
    const h = window.__rb, s = window.state;
    const id = h.add('text', { x: 220, y: 220, 'font-family': 'Roboto', 'font-size': 48, fill: '#ffcc00' }, 'Rotate me');
    await document.fonts.load('48px Roboto');
    h.turn(id, 30, 0.7);
    s.selectShape(id); s.setSelectionBlur(2, true);
    return { measure: id };
    // Text and its outline anti-alias differently, by an amount that depends on the
    // zoom, and the blur spreads that over every pixel of the halo — so the mean
    // can't judge text. The >40 count does: a lost blur is 76%, a lost 0.7 opacity ~100%.
  }, async () => { await window.state.outlineSelectedText(); return window.state.selectedShapeIds[0]; }, { mean: 30 });
  await rb('detach (rotated, faded instance)', () => {
    const h = window.__rb, s = window.state;
    const src = h.add('rect', { x: 220, y: 160, width: 160, height: 90, fill: '#2a2' });
    s.createSymbolFromShape(src, 'Box');
    const use = s.selectedShapeIds[0];
    h.turn(use, 30, 0.5);
    return { measure: use };
  }, (ctx) => { window.state.detachSymbolInstance(ctx.measure); return window.state.selectedShapeIds[0]; });
  await rb('detach (rotated source, moved instance)', () => {
    const h = window.__rb, s = window.state;
    const src = h.add('rect', { x: 220, y: 160, width: 160, height: 90, fill: '#2a2' });
    h.turn(src, 30);
    s.createSymbolFromShape(src, 'Box');
    const use = s.selectedShapeIds[0];
    const el = s.findShapeById(use).element;
    el.setAttribute('x', String(parseFloat(el.getAttribute('x') || '0') + 60));
    s.rebuildShapesFromDOM(); s.saveHistory();
    return { measure: use };
  }, (ctx) => { window.state.detachSymbolInstance(ctx.measure); return window.state.selectedShapeIds[0]; });
  await rb('detach (non-uniform resize)', () => {
    const h = window.__rb, s = window.state;
    const src = h.add('rect', { x: 220, y: 160, width: 160, height: 90, fill: '#2a2' });
    s.createSymbolFromShape(src, 'Box');
    const use = s.selectedShapeIds[0];
    const el = s.findShapeById(use).element;
    el.setAttribute('width', String(parseFloat(el.getAttribute('width')) * 2));
    s.rebuildShapesFromDOM(); s.saveHistory();
    return { measure: use };
  }, (ctx) => { window.state.detachSymbolInstance(ctx.measure); return window.state.selectedShapeIds[0]; });
  await rb('detach (blurred, faded instance)', () => {
    const h = window.__rb, s = window.state;
    const src = h.add('rect', { x: 220, y: 160, width: 160, height: 90, fill: '#2a2' });
    s.createSymbolFromShape(src, 'Box');
    const use = s.selectedShapeIds[0];
    h.turn(use, 20, 0.6);
    s.selectShape(use); s.setSelectionBlur(4, true);
    return { measure: use };
  }, (ctx) => { window.state.detachSymbolInstance(ctx.measure); return window.state.selectedShapeIds[0]; });
  await rb('mask flatten', () => {
    const h = window.__rb, s = window.state;
    const content = h.add('rect', { x: 200, y: 150, width: 200, height: 140, fill: '#39f' });
    const cutter = h.add('ellipse', { cx: 300, cy: 220, rx: 80, ry: 60, fill: '#000' });
    s.selectMultiple([content, cutter]);
    s.makeClippingMask();
    const id = s.selectedShapeIds[0];
    h.turn(id, 30, 0.5);
    return { measure: id };
  }, async (ctx) => { await window.state.flattenMask(ctx.measure); return window.state.selectedShapeIds[0]; });
  // An imported percentage opacity is a fraction, not fifty.
  await rb('detach (instance at 50%)', () => {
    const h = window.__rb, s = window.state;
    const src = h.add('rect', { x: 220, y: 160, width: 160, height: 90, fill: '#2a2' });
    s.createSymbolFromShape(src, 'Box');
    const use = s.selectedShapeIds[0];
    s.findShapeById(use).element.setAttribute('opacity', '50%');
    s.rebuildShapesFromDOM(); s.saveHistory();
    return { measure: use };
  }, (ctx) => { window.state.detachSymbolInstance(ctx.measure); return window.state.selectedShapeIds[0]; });
  // Releasing a one-shape pattern unwraps it: what the wrapper carried comes along.
  await rb('repeat release (faded)', () => {
    const h = window.__rb, s = window.state;
    const cell = h.add('rect', { x: 220, y: 160, width: 160, height: 90, fill: '#39f' });
    const rg = s.makeRepeatGrid(cell, { cols: 1, rows: 1 });
    s.selectShape(rg); s.setSelectionOpacity(0.4, true);
    return { measure: rg };
  }, (ctx) => { window.state.releaseRepeat(ctx.measure); return window.state.selectedShapeIds[0]; });
  rbFailures.length ? fail('guard:rebuilds-keep-what-is-rendered', rbFailures.join(' || ').slice(0, 900))
    : pass('guard:rebuilds-keep-what-is-rendered');
}

// --- A rename lands where it was typed ----------------------------------------------
// The rename commit waits for the press that ended it (#287). It waited for the
// click's BUBBLE phase, so a document tab's own click handler switched documents
// first and the name landed on a same-id shape in the OTHER document; and a 400 ms
// fallback timer fired mid-drag, snapshotting a half-moved shape as an undo step.
{
  const hist = () => page.evaluate(() => window.state.historyMgr.index);
  const setup = await page.evaluate(() => {
    const d = window.docs, s = window.state, NS = 'http://www.w3.org/2000/svg';
    const add = (id, name, x) => {
      const el = document.createElementNS(NS, 'rect');
      el.id = id; el.setAttribute('x', String(x)); el.setAttribute('y', '160');
      el.setAttribute('width', '90'); el.setAttribute('height', '70'); el.setAttribute('fill', '#39f');
      el.setAttribute('data-name', name);
      (document.querySelector('[data-frame]') || document.getElementById('drawing-layer')).appendChild(el);
      s.rebuildShapesFromDOM(); s.saveHistory();
    };
    const tabA = d.activeId;
    add('rl_a', 'Alpha', 200);
    add('rl_b', 'Beta', 420);
    d.newTab();
    const tabB = d.activeId;
    add('rl_a', 'Bravo', 200);
    d.switchTo(tabA);
    s.selectShape('rl_a'); s.onChange_public();
    return { tabA, tabB };
  });
  await page.waitForTimeout(250);
  const startRename = async (text) => {
    await page.evaluate(() => { window.state.selectShape('rl_a'); window.state.onChange_public(); });
    await page.waitForTimeout(150);
    await page.locator('#layers-list li[data-id="rl_a"] .layer-name').click();
    await page.waitForTimeout(250);
    const open = await page.locator('#layers-list input.layer-rename').count();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(text);
    return open;
  };
  const nameIn = (tab) => page.evaluate((tab) => { window.docs.switchTo(tab); return window.state.findShapeById('rl_a')?.name; }, tab);

  // 1. rename in A, then click B's tab
  const open1 = await startRename('Renamed In A');
  await page.locator(`.doc-tab[data-tab-id="${setup.tabB}"]`).click();
  await page.waitForTimeout(400);
  const inA = await nameIn(setup.tabA), inB = await nameIn(setup.tabB);
  await page.evaluate((s) => { window.docs.switchTo(s.tabA); window.docs.closeTab(s.tabB); }, setup);
  await page.waitForTimeout(250);

  // 2. rename, then drag ANOTHER shape slowly (longer than any grace timer)
  const open2 = await startRename('Renamed Again');
  const h0 = await hist();
  const xOf = () => page.evaluate(() => Math.round(document.getElementById('rl_b').getBoundingClientRect().x));
  const x0 = await xOf();
  const c = await page.evaluate(() => { const r = document.getElementById('rl_b').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(c.x, c.y); await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(c.x + i * 10, c.y); await page.waitForTimeout(80); }
  await page.mouse.up(); await page.waitForTimeout(300);
  // (History is capped at 100 entries, so late in the suite the index stops moving:
  // the two undos below are the check, not the index.)
  const steps = (await hist()) - h0, x1 = await xOf();
  await page.evaluate(() => window.state.undo()); await page.waitForTimeout(100);
  const afterUndo1 = { x: await xOf(), name: await page.evaluate(() => window.state.findShapeById('rl_a')?.name) };
  await page.evaluate(() => window.state.undo()); await page.waitForTimeout(100);
  const afterUndo2 = await xOf();
  await page.evaluate(() => { for (const id of ['rl_a', 'rl_b']) if (window.state.findShapeById(id)) window.state.removeShape(id); });

  const ok = open1 === 1 && inA === 'Renamed In A' && inB === 'Bravo'
    && open2 === 1 && x1 > x0 + 40 && afterUndo1.x === x1 && afterUndo1.name === 'Renamed In A' && afterUndo2 === x0;
  ok ? pass('guard:rename-lands-where-it-was-typed')
    : fail('guard:rename-lands-where-it-was-typed', JSON.stringify({ open1, inA, inB, open2, steps, x0, x1, afterUndo1, afterUndo2 }));
}

// --- Transform fields show, and take, the decimals --------------------------------------
// X/Y/W/H showed whole numbers, so two paths a third of a unit apart both read "8"
// and the offset was invisible. Typing the value a field already showed did nothing:
// "untouched" was inferred from "equals the rounded readout", and the browser fires
// no `change` for a same-value commit anyway. And a frame with a fractional size took
// an X edit as a resize (its sides were compared rounded), leaving its children behind.
{
  const r = await page.evaluate(async () => {
    const s = window.state, NS = 'http://www.w3.org/2000/svg';
    const frame = document.querySelector('[data-frame]');
    const home = frame || document.getElementById('drawing-layer');
    const el = document.createElementNS(NS, 'rect');
    el.id = 'tfd_a';
    for (const [k, v] of Object.entries({ x: 200.4, y: 160, width: 80.25, height: 60, fill: '#39f' })) el.setAttribute(k, String(v));
    home.appendChild(el);
    s.rebuildShapesFromDOM(); s.saveHistory();
    s.selectShape('tfd_a'); s.onChange_public();
    await new Promise(r => setTimeout(r, 120));
    const shownX = document.getElementById('prop-x').value, shownW = document.getElementById('prop-w').value;
    el.setAttribute('x', '200.003'); s.onChange_public();
    await new Promise(r => setTimeout(r, 120));
    return { shownX, shownW, frameId: frame?.id ?? null, retype: document.getElementById('prop-x').value };
  });
  // "One undo step" by entry identity — the index stops moving at the 100-entry cap.
  await page.evaluate(() => { const h = window.state.historyMgr; window.__top = h.entries[h.index]; });
  await page.locator('#prop-x').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(r.retype);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab'); // a blur after Enter must not commit a second time
  await page.waitForTimeout(150);
  const afterRetype = await page.evaluate(() => document.getElementById('tfd_a').getAttribute('x'));
  const oneStep = await page.evaluate(() => {
    const h = window.state.historyMgr, top = window.__top; delete window.__top;
    return h.entries[h.index] !== top && h.entries[h.index - 1] === top;
  });

  // A frame 0.5 taller than a whole number: an X edit must move it AND its children.
  let frameCase = null;
  if (r.frameId) {
    const ab0 = await page.evaluate((id) => { const a = window.state.getArtboardById(id); return { x: a.x, y: a.y, width: a.width, height: a.height }; }, r.frameId);
    await page.evaluate(({ id, ab }) => {
      window.state.updateArtboard(id, { ...ab, height: ab.height + 0.5 });
      window.state.selectShape(id); window.state.onChange_public();
    }, { id: r.frameId, ab: ab0 });
    await page.waitForTimeout(120);
    const childX0 = await page.evaluate(() => document.getElementById('tfd_a').getBoundingClientRect().x);
    await page.locator('#prop-x').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(String(ab0.x + 30));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    const out = await page.evaluate((id) => ({ childX: document.getElementById('tfd_a').getBoundingClientRect().x, h: window.state.getArtboardById(id).height }), r.frameId);
    frameCase = { moved: out.childX - childX0, keptHeight: out.h === ab0.height + 0.5 };
    await page.evaluate(({ id, ab }) => { window.state.updateArtboard(id, ab); }, { id: r.frameId, ab: ab0 });
  }
  await page.evaluate(() => { if (window.state.findShapeById('tfd_a')) window.state.removeShape('tfd_a'); });

  const ok = r.shownX.endsWith('.4') && r.shownW === '80.25' && afterRetype === '200' && oneStep
    && (!frameCase || (frameCase.moved > 10 && frameCase.keptHeight));
  ok ? pass('guard:transform-fields-show-and-take-decimals')
    : fail('guard:transform-fields-show-and-take-decimals', JSON.stringify({ ...r, afterRetype, oneStep, frameCase }));
}

// --- Double-click inserts a point wherever the edited path is --------------------------
// While editing a path's points, the FIRST click of a double-click ran the "clicked a
// different shape" rule against whatever was topmost under the pointer. So a point
// could only be added by landing exactly on the 1px line with nothing else drawn there:
// a hair beside it, over a traced background image, selected the image (and the
// double-click opened Crop); on a section two track layouts share, it switched editing
// to the layout drawn on top. A press within reach of the edited path's own outline is
// now a press on it. Driven with real double-clicks.
{
  const setup = await page.evaluate(() => {
    const s = window.state, NS = 'http://www.w3.org/2000/svg';
    const home = document.querySelector('[data-frame]') || document.getElementById('drawing-layer');
    const c = document.createElement('canvas'); c.width = 4; c.height = 4;
    const g = c.getContext('2d'); g.fillStyle = '#556'; g.fillRect(0, 0, 4, 4);
    const img = document.createElementNS(NS, 'image'); img.id = 'dci_img';
    for (const [k, v] of Object.entries({ x: 20, y: 20, width: 500, height: 320, href: c.toDataURL(), preserveAspectRatio: 'none' })) img.setAttribute(k, String(v));
    home.appendChild(img);
    const mk = (id, d) => { const p = document.createElementNS(NS, 'path'); p.id = id; p.setAttribute('d', d); p.setAttribute('fill', 'none'); p.setAttribute('stroke', '#ff0'); home.appendChild(p); };
    mk('dci_a', 'M 60 60 C 160 30 260 90 360 60 C 420 50 450 200 380 280');
    mk('dci_b', 'M 60 60 C 160 30 260 90 360 60 C 330 160 200 230 100 280'); // same first segment, on top
    s.rebuildShapesFromDOM(); s.saveHistory(); s.selectShape(null);
    return true;
  });
  await page.waitForTimeout(150);
  // Screen point at t on segment `seg` of dci_a (negative counts from the end — an
  // insert renumbers the segments after it), `off` px off the line along its normal.
  const at = (seg, t, off) => page.evaluate(([seg, t, off]) => {
    const el = document.getElementById('dci_a'), n = el.getAttribute('d').match(/-?[\d.]+/g).map(Number);
    if (seg < 0) seg += (n.length - 2) / 6;
    const k = 2 + 6 * seg, p0 = seg ? [n[k - 2], n[k - 1]] : [n[0], n[1]];
    const P = [p0, [n[k], n[k + 1]], [n[k + 2], n[k + 3]], [n[k + 4], n[k + 5]]];
    const bz = (t) => { const u = 1 - t, w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]; return [0, 1].map(j => w.reduce((a, wi, i) => a + wi * P[i][j], 0)); };
    const m = el.getScreenCTM(), A = new DOMPoint(...bz(t)).matrixTransform(m), B = new DOMPoint(...bz(t + 0.001)).matrixTransform(m);
    const len = Math.hypot(B.x - A.x, B.y - A.y) || 1;
    return { x: A.x - (B.y - A.y) / len * off, y: A.y + (B.x - A.x) / len * off };
  }, [seg, t, off]);
  const anchorsOfA = () => page.evaluate(() => (document.getElementById('dci_a').getAttribute('d').match(/[MC]/g) || []).length);
  const attempt = async (seg, off) => {
    await page.keyboard.press('v');
    const e = await at(-1, 0.5, 0);                     // A's last segment: only A covers it
    await page.mouse.dblclick(e.x, e.y); await page.waitForTimeout(200);
    const n0 = await anchorsOfA();
    const p = await at(seg, 0.5, off);
    await page.mouse.dblclick(p.x, p.y); await page.waitForTimeout(200);
    const r = await page.evaluate(() => ({ editing: window.state.editingPathId, tool: window.state.currentTool }));
    const added = (await anchorsOfA()) - n0;
    await page.keyboard.press('Escape'); await page.waitForTimeout(100);
    return { added, ...r };
  };
  const shared = await attempt(0, 0);   // on the line where B is drawn on top
  const beside = await attempt(-1, 2);  // 2px beside the line, over the image
  await page.keyboard.press('Escape'); await page.keyboard.press('v');
  await page.evaluate(() => { for (const id of ['dci_a', 'dci_b', 'dci_img']) if (window.state.findShapeById(id)) window.state.removeShape(id); });

  const ok = setup && shared.added === 1 && shared.editing === 'dci_a' && beside.added === 1 && beside.editing === 'dci_a';
  ok ? pass('guard:double-click-inserts-on-the-edited-path')
    : fail('guard:double-click-inserts-on-the-edited-path', JSON.stringify({ shared, beside }));
}

// --- Locked shapes stay put on the canvas ---------------------------------------------
// Lock was honoured by the marquee and arrow nudges only. A locked shape picked in the
// Layers panel kept its handles, and since it sat in a frame, the "press on the
// selection" shortcut dragged it on the first press; a fresh click selected and moved
// it like anything else, so a locked tracing image slid around under the pen. Now a
// press goes through locked artwork to what's beneath, and a locked selection has no
// handles. Driven with the real mouse, on screen.
{
  const ids = await page.evaluate(() => {
    const s = window.state, NS = 'http://www.w3.org/2000/svg';
    const home = document.querySelector('[data-frame]') || document.getElementById('drawing-layer');
    const mk = (id, x, w, fill) => {
      const el = document.createElementNS(NS, 'rect'); el.id = id;
      for (const [k, v] of Object.entries({ x, y: 120, width: w, height: 120, fill })) el.setAttribute(k, String(v));
      home.appendChild(el); return el;
    };
    mk('lk_under', 160, 60, '#3a3');          // beneath the locked shape
    mk('lk_bg', 120, 240, '#c33');            // the locked "tracing image"
    s.rebuildShapesFromDOM(); s.saveHistory();
    s.toggleLock('lk_bg');
    s.selectShape('lk_bg'); s.onChange_public(); // as if picked in the Layers panel
    return true;
  });
  await page.waitForTimeout(150);
  const box = (id) => page.evaluate((id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, id);
  const drag = async (x, y, dx) => {
    await page.mouse.move(x, y); await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(x + dx * i / 6, y);
    await page.mouse.up(); await page.waitForTimeout(120);
  };
  const handles = await page.evaluate(() => document.querySelectorAll('[data-handle]').length);
  const bg0 = await box('lk_bg');
  await drag(bg0.x + bg0.w - 30, bg0.y + bg0.h / 2, 50);       // on the locked shape only
  const bg1 = await box('lk_bg');
  const un0 = await box('lk_under');
  await drag(un0.x + un0.w / 2, un0.y + un0.h / 2, 40);       // through it, onto the shape beneath
  const un1 = await box('lk_under');
  const bg2 = await box('lk_bg');
  await page.evaluate(() => { for (const id of ['lk_under', 'lk_bg']) if (window.state.findShapeById(id)) window.state.removeShape(id); });

  const ok = ids && handles === 0 && Math.round(bg1.x) === Math.round(bg0.x)
    && un1.x - un0.x > 20 && Math.round(bg2.x) === Math.round(bg0.x); // zoom/snap shift the exact distance
  ok ? pass('guard:locked-shapes-stay-put')
    : fail('guard:locked-shapes-stay-put', JSON.stringify({ handles, bg0: bg0.x, bg1: bg1.x, un0: un0.x, un1: un1.x, bg2: bg2.x }));
}

// --- A hidden or locked container shows on its children's rows -------------------------
// Hiding a group hides everything inside it on the canvas, and locking it locks
// everything inside it — but the Layers panel read each row's OWN flag, so the
// children of a hidden group looked like ordinary, live layers. Now a row under a
// hidden container dims like a hidden row, and one under a locked container shows a
// quieter padlock; the row's own toggle still flips only its own flag, so unlocking
// the container leaves a child that was locked itself still locked. Two levels deep,
// inside a frame, with real clicks on the panel's eye and padlock.
{
  await page.evaluate(() => {
    const s = window.state, NS = 'http://www.w3.org/2000/svg';
    const home = document.querySelector('[data-frame]') || document.getElementById('drawing-layer');
    const g = (id, name) => { const el = document.createElementNS(NS, 'g'); el.id = id; el.setAttribute('data-name', name); el.setAttribute('data-collapsed', 'false'); return el; };
    const r = (id, x) => { const el = document.createElementNS(NS, 'rect'); el.id = id; for (const [k, v] of Object.entries({ x, y: 120, width: 40, height: 40, fill: '#39c' })) el.setAttribute(k, String(v)); return el; };
    const outer = g('ih_outer', 'IH Outer'), inner = g('ih_inner', 'IH Inner');
    inner.append(r('ih_deep', 200)); outer.append(r('ih_kid', 140), inner);
    home.appendChild(outer);
    s.rebuildShapesFromDOM(); s.saveHistory();
    s.selectShape('ih_deep'); s.onChange_public(); // reveals + scrolls the rows into view
  });
  await page.waitForTimeout(150);
  const row = (id) => page.evaluate((id) => {
    const li = document.querySelector(`#layers-list li[data-id="${id}"]`);
    if (!li) return null;
    return {
      cls: [...li.classList].filter(c => /^is-(ancestor-)?(hidden|locked)$/.test(c)).sort().join(' '),
      nameOpacity: getComputedStyle(li.querySelector('.layer-name')).opacity,
      visTitle: li.querySelector('.layer-vis').title,
      lockTitle: li.querySelector('.layer-lock').title,
    };
  }, id);
  const clickIcon = async (id, sel) => {
    const c = await page.evaluate(({ id, sel }) => {
      const r = document.querySelector(`#layers-list li[data-id="${id}"] ${sel}`).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, { id, sel });
    await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(150);
  };
  const flags = () => page.evaluate(() => Object.fromEntries(['ih_outer', 'ih_kid', 'ih_inner', 'ih_deep']
    .map(id => { const s = window.state.findShapeById(id); return [id, `${s.visible ? 'v' : 'h'}${s.locked ? 'L' : ''}`]; })));

  const before = { kid: await row('ih_kid'), deep: await row('ih_deep') };
  await clickIcon('ih_outer', '.layer-vis');                          // hide the outer group
  const hidden = { kid: await row('ih_kid'), deep: await row('ih_deep'), flags: await flags() };
  await clickIcon('ih_outer', '.layer-vis');                          // show it again
  await clickIcon('ih_inner', '.layer-lock');                         // the inner group locks itself…
  await clickIcon('ih_outer', '.layer-lock');                         // …then the outer one
  const locked = { kid: await row('ih_kid'), inner: await row('ih_inner'), deep: await row('ih_deep') };
  await clickIcon('ih_outer', '.layer-lock');                         // unlock the outer group
  const unlocked = { kid: await row('ih_kid'), deep: await row('ih_deep'), flags: await flags() };
  await page.evaluate(() => { if (window.state.findShapeById('ih_outer')) window.state.removeShape('ih_outer'); });

  const ok = before.kid?.cls === '' && before.deep?.cls === ''
    && hidden.kid?.cls === 'is-ancestor-hidden' && hidden.deep?.cls === 'is-ancestor-hidden'
    && hidden.deep.nameOpacity === '0.4' && /^Hidden by “IH Outer”/.test(hidden.deep.visTitle)
    && hidden.flags.ih_kid === 'v' && hidden.flags.ih_deep === 'v' && hidden.flags.ih_outer === 'h'
    && locked.kid?.cls === 'is-ancestor-locked' && locked.inner?.cls === 'is-locked'
    && /^Locked by “IH Inner”/.test(locked.deep?.lockTitle) && locked.kid.nameOpacity === '1'
    && unlocked.kid?.cls === '' && unlocked.deep?.cls === 'is-ancestor-locked'
    && unlocked.flags.ih_inner === 'vL' && unlocked.flags.ih_outer === 'v';
  ok ? pass('guard:container-state-shows-on-children')
    : fail('guard:container-state-shows-on-children', JSON.stringify({ before, hidden, locked, unlocked }));
}

// --- Track layouts are exactly what TraceCraft reads ------------------------------------
// TraceCraft draws a race track from one file per circuit layout and asked for a fixed
// shape: a bare viewBox root (no size, only the SVG namespace); ONE closed path for the
// circuit; an optional OPEN <path id="pit-lane"> with both ends on it; nothing else; every
// transform baked; coordinates in the FRAME's own space (shared by every layout of the
// circuit, never re-origined); viewBox = the circuit's true bbox + 4; absolute M/L/C/Q/Z
// only, arcs as cubics. The fixture is the awkward version of a real document: a frame
// away from the origin, a rotated group holding two loops (one with relative commands,
// an arc and a quadratic) and one pit lane, a hidden + locked group whose loop is a
// transformed <rect>, and a background image. Opened from the real File menu.
{
  const setup = await page.evaluate(() => {
    const s = window.state, NS = 'http://www.w3.org/2000/svg';
    const fid = s.addFrame(1700, 60, 600, 400, 'TC Track');
    const frame = document.getElementById(fid);
    const mk = (tag, attrs, parent) => {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      parent.appendChild(el); return el;
    };
    mk('image', { id: 'tc_bg', 'data-name': 'BG Image', x: 0, y: 0, width: 600, height: 400, href: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }, frame);
    const alt = mk('g', { id: 'tc_alt', 'data-name': 'Alt Pit Lane', transform: 'translate(40 30) rotate(15)' }, frame);
    mk('path', { id: 'tc_mia', 'data-name': 'MIA Loop', d: 'm 50 50 a 40 30 0 0 1 80 0 q 20 40 0 80 l -80 0 z', fill: 'none', stroke: '#000' }, alt);
    mk('polygon', { id: 'tc_marina', 'data-name': 'MarinaLoop', points: '220,40 320,40 320,140 220,140', transform: 'scale(1.25)', fill: 'none', stroke: '#000' }, alt);
    mk('path', { id: 'tc_pit', 'data-name': 'pit-lane', d: 'M 50 50 C 70 20 110 20 130 50', fill: 'none', stroke: '#c00' }, alt);
    const gp = mk('g', { id: 'tc_gp', 'data-name': 'GP', transform: 'translate(5 7)', style: 'display:none', 'data-locked': 'true' }, frame);
    mk('rect', { id: 'tc_gprect', 'data-name': 'GP', x: 300, y: 200, width: 120, height: 80, transform: 'translate(10 0)', fill: 'none', stroke: '#000' }, gp);
    mk('path', { id: 'tc_gppit', 'data-name': 'pit-lane', d: 'M 310 200 L 350 180 L 400 200', fill: 'none' }, gp);
    s.rebuildShapesFromDOM(); s.saveHistory();
    s.selectShape('tc_alt'); s.selectedShapeIds = ['tc_alt', 'tc_gp'];
    s.onChange_public();
    // Where TraceCraft's coordinates must land: frame-local, from the live CTMs.
    const fm = frame.getCTM().inverse();
    const at = (id, x, y) => { const p = new DOMPoint(x, y).matrixTransform(fm.multiply(document.getElementById(id).getCTM())); return [p.x, p.y]; };
    return { fid, miaStart: at('tc_mia', 50, 50), pitEnd: at('tc_pit', 130, 50) };
  });
  await page.waitForTimeout(150);

  // The real gesture: File ▸ Export Track Layouts (TraceCraft)…
  await page.locator('button.menu-trigger', { hasText: /^File$/ }).click();
  await page.waitForTimeout(120);
  await page.locator('.menu-panel[aria-label="File"] [role=menuitem]', { hasText: 'Export Track Layouts' }).click();
  await page.waitForTimeout(200);
  await page.locator('.track-layout-name').fill('Miami');
  const dialog = await page.evaluate(() => ({
    files: [...document.querySelectorAll('.track-layout-file')].map(e => e.textContent),
    notes: [...document.querySelectorAll('.track-layout-note')].map(e => e.textContent),
    button: document.querySelector('.track-layout-dialog .btn--primary')?.textContent,
  }));
  await page.locator('.track-layout-dialog .btn', { hasText: 'Cancel' }).click();

  // The files themselves, from the same scan the dialog ran.
  const check = await page.evaluate(async (setup) => {
    const s = window.state;
    const { collectTrackLayouts, distanceToSubPath } = await import('/src/core/track-layout.ts');
    const { parsePath } = await import('/src/core/path-model.ts');
    const sib = (x) => (x.parentId ? s.findShapeById(x.parentId)?.children : s.shapes) ?? [];
    const scan = collectTrackLayouts(s.getSelectedShapes(), true, sib);
    const solo = collectTrackLayouts([s.findShapeById('tc_mia')], true, sib); // its pit lane found by name
    const NS = 'http://www.w3.org/2000/svg';
    const out = {};
    for (const l of scan.layouts) {
      const doc = new DOMParser().parseFromString(l.svg, 'image/svg+xml');
      const root = doc.documentElement;
      const all = [...root.querySelectorAll('*')];
      const paths = [...root.children];
      const circuit = paths.find(p => !p.id), pit = root.querySelector('#pit-lane');
      const cd = circuit?.getAttribute('d') ?? '';
      const pd = pit?.getAttribute('d') ?? '';
      // True bbox of the written circuit, measured by the browser.
      const probe = document.createElementNS(NS, 'path'); probe.setAttribute('d', cd);
      const host = document.getElementById('drawing-layer'); host.appendChild(probe);
      const bb = probe.getBBox(); probe.remove();
      const vb = root.getAttribute('viewBox').split(' ').map(Number);
      const circuitSp = parsePath(cd).subpaths[0];
      const pitSp = pd ? parsePath(pd).subpaths[0] : null;
      out[l.name] = {
        wellFormed: !doc.querySelector('parsererror') && !/--/.test(l.svg.replace(/<!--|-->/g, '')),
        rootAttrs: [...root.attributes].map(a => a.name).sort().join(','),
        onlyPaths: all.every(e => e.localName === 'path') && paths.length >= 1 && paths.length <= 2,
        noTransform: !/transform/.test(l.svg),
        noEditorAttrs: !/data-|inkscape|sodipodi|<defs|<g|<rect|<image|clipPath|mask/.test(l.svg),
        circuitOk: /^M [^MZ]+ Z$/.test(cd),
        pitOk: pit ? (/^M [^MZ]+$/.test(pd) && pit.getAttribute('id') === 'pit-lane') : null,
        absoluteOnly: /^[MLCQZ0-9 .-]+$/.test(cd + ' ' + pd),
        twoDecimals: !/\.\d{3}/.test(cd + ' ' + pd),
        viewBoxOk: Math.abs(vb[0] - (bb.x - 4)) < 0.02 && Math.abs(vb[1] - (bb.y - 4)) < 0.02
          && Math.abs(vb[2] - (bb.width + 8)) < 0.03 && Math.abs(vb[3] - (bb.height + 8)) < 0.03,
        pitEnds: pitSp ? [0, pitSp.anchors.length - 1].map(i => +distanceToSubPath(pitSp.anchors[i].x, pitSp.anchors[i].y, circuitSp).toFixed(2)) : null,
        start: circuitSp.anchors[0] && [circuitSp.anchors[0].x, circuitSp.anchors[0].y],
        pitLast: pitSp && [pitSp.anchors.at(-1).x, pitSp.anchors.at(-1).y],
        notes: l.notes,
      };
    }
    return { names: scan.layouts.map(l => l.name), soloPit: solo.layouts[0]?.pitLane?.id ?? null, out, setup };
  }, setup);
  await page.evaluate((fid) => { if (window.state.findShapeById(fid)) { window.state.removeShape(fid); window.state.onChange_public(); } }, setup.fid);

  const near = (a, b) => !!a && !!b && Math.abs(a[0] - b[0]) < 0.011 && Math.abs(a[1] - b[1]) < 0.011;
  const mia = check.out['MIA Loop'], marina = check.out['MarinaLoop'], gp = check.out['GP'];
  const fileOk = (f) => f && f.wellFormed && f.rootAttrs === 'viewBox,xmlns' && f.onlyPaths && f.noTransform
    && f.noEditorAttrs && f.circuitOk && f.pitOk !== false && f.absoluteOnly && f.twoDecimals && f.viewBoxOk;
  const ok = check.names.join('|') === 'MIA Loop|MarinaLoop|GP'
    && [mia, marina, gp].every(fileOk)
    && mia.pitOk === true && mia.pitEnds.every(d => d <= 0.01) && mia.notes.length === 0
    && near(mia.start, setup.miaStart) && near(mia.pitLast, setup.pitEnd)   // frame-local, not world
    && marina.pitOk === true && marina.notes.length === 2                    // shared pit lane, ends off this loop
    && gp.pitOk === true && near(gp.start, [315, 207])                       // hidden group's transforms baked too
    && check.soloPit === 'tc_pit'
    && dialog.files.join('|') === 'miami-mia-loop.layout.svg|miami-marinaloop.layout.svg|miami-gp.layout.svg'
    && dialog.notes.length === 2 && dialog.button === 'Export 3 files';
  ok ? pass('guard:track-layouts-are-what-tracecraft-reads')
    : fail('guard:track-layouts-are-what-tracecraft-reads', JSON.stringify({ dialog, check }));
}

// --- A field commits to its own selection ---------------------------------------------
// Two ways a panel field wrote the wrong objects: stepping a blank "Mixed" field
// started from zero (ArrowUp set every selected object to the minimum), and a value
// typed for shape A landed on shape B when the press that ended the edit was a
// canvas click selecting B (the canvas selects on pointerdown, before the blur).
{
  const setup = await page.evaluate(() => {
    const s = window.state, NS = 'http://www.w3.org/2000/svg';
    const home = document.querySelector('[data-frame]') || document.getElementById('drawing-layer');
    const add = (id, x, fo) => {
      const el = document.createElementNS(NS, 'rect');
      el.id = id; el.setAttribute('x', String(x)); el.setAttribute('y', '160');
      el.setAttribute('width', '80'); el.setAttribute('height', '60'); el.setAttribute('fill', '#39f');
      el.setAttribute('fill-opacity', String(fo));
      home.appendChild(el);
    };
    add('fc_a', 200, 0.3); add('fc_b', 420, 0.8);
    s.rebuildShapesFromDOM(); s.saveHistory();
    s.selectMultiple(['fc_a', 'fc_b']); s.onChange_public();
    return true;
  });
  await page.waitForTimeout(200);
  const fo = () => page.evaluate(() => ['fc_a', 'fc_b'].map(id => document.getElementById(id).getAttribute('fill-opacity')));
  const field = page.locator('#prop-fill-opacity + .slider-field .slider-field-input');
  const mixed = await field.getAttribute('placeholder');
  // "No new undo step" = the top history entry is the same object. (The index alone
  // stops moving once history reaches its 100-entry cap.)
  await page.evaluate(() => { const h = window.state.historyMgr; window.__top = h.entries[h.index]; });
  await field.focus();
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(80);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(120);
  const afterArrow = await fo();
  const sameTop = await page.evaluate(() => { const h = window.state.historyMgr; const same = h.entries[h.index] === window.__top; delete window.__top; return same; });

  await page.evaluate(() => { window.state.selectShape('fc_a'); window.state.onChange_public(); });
  await page.waitForTimeout(150);
  await page.locator('#prop-w').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('33');
  const b = await page.evaluate(() => { const r = document.getElementById('fc_b').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(200);
  const widths = await page.evaluate(() => ['fc_a', 'fc_b'].map(id => document.getElementById(id).getAttribute('width')));
  await page.evaluate(() => { for (const id of ['fc_a', 'fc_b']) if (window.state.findShapeById(id)) window.state.removeShape(id); });

  const ok = setup && mixed === 'Mixed' && afterArrow[0] === '0.3' && afterArrow[1] === '0.8' && sameTop
    && widths[0] === '33' && widths[1] === '80';
  ok ? pass('guard:fields-commit-to-their-own-selection')
    : fail('guard:fields-commit-to-their-own-selection', JSON.stringify({ mixed, afterArrow, sameTop, widths }));
}

// --- Round Corners leaves no trace where it does nothing ---------------------------------
// Three ways rounding went wrong beyond the untransformed rect the first guard uses:
// a no-op (an ellipse has no corners) still converted the shape to a <path> with no
// undo step; a per-corner-radius rect kept its data-rect markers, so the next resize
// regenerated the box over the rounding; and the radius was applied in the shape's
// own units, so a rect scaled 4x got four times the radius the dialog showed.
{
  const r = await page.evaluate(() => {
    const s = window.state, NS = 'http://www.w3.org/2000/svg';
    const home = document.querySelector('[data-frame]') || document.getElementById('drawing-layer');
    const add = (tag, id, attrs) => {
      const el = document.createElementNS(NS, tag);
      el.id = id;
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      home.appendChild(el);
    };
    add('ellipse', 'cn_e', { cx: 260, cy: 700, rx: 60, ry: 40, fill: '#39f' });
    add('rect', 'cn_r', { x: 380, y: 660, width: 160, height: 90, fill: '#39f' });
    add('rect', 'cn_s', { x: 0, y: 0, width: 40, height: 30, fill: '#39f', transform: 'translate(600 660) scale(4)' });
    s.rebuildShapesFromDOM(); s.saveHistory();
    const top = () => s.historyMgr.entries[s.historyMgr.index]; // identity survives the 100-entry cap

    // 1. a no-op leaves the shape and the history alone — direct and via the preview
    s.selectShape('cn_e');
    const top0 = top();
    const direct = s.roundSelectedCorners(20);
    s.selectShape('cn_e');
    s.beginCornerPreview();
    const livePreview = s.hasLivePreview();
    s.previewCornerRadius(20);
    const committed = s.commitCornerPreview();
    const eTag = s.findShapeById('cn_e').element.tagName.toLowerCase();
    const noop = { direct, committed, eTag, same: top() === top0, livePreview, liveAfter: s.hasLivePreview() };

    // 2. a per-corner rect rounds to a PLAIN path
    s.selectShape('cn_r');
    s.setSelectionRectRadii([0, 24, 0, 24]);
    s.roundSelectedCorners(12);
    s.rebuildShapesFromDOM();
    const rEl = s.findShapeById('cn_r').element;
    const plain = { type: s.findShapeById('cn_r').type, markers: [...rEl.attributes].map(a => a.name).filter(n => /^data-(rect|shape)/.test(n)) };

    // 3. a world radius of 15 on a 4x rect = 3.75 local: the fillet passes 3.75(√2−1) from the corner
    s.selectShape('cn_s');
    s.roundSelectedCorners(15);
    const p = s.findShapeById('cn_s').element;
    let gap = Infinity;
    const L = p.getTotalLength();
    for (let i = 0; i <= 800; i++) { const q = p.getPointAtLength((i / 800) * L); gap = Math.min(gap, Math.hypot(q.x, q.y)); }
    for (const id of ['cn_e', 'cn_r', 'cn_s']) if (s.findShapeById(id)) s.removeShape(id);
    return { noop, plain, gap, expected: 3.75 * (Math.SQRT2 - 1) };
  });
  const ok = r.noop.direct === false && r.noop.committed === false && r.noop.eTag === 'ellipse' && r.noop.same
    && r.noop.livePreview && !r.noop.liveAfter
    && r.plain.type === 'path' && r.plain.markers.length === 0
    && Math.abs(r.gap - r.expected) < 0.2;
  ok ? pass('guard:corners-leave-no-trace') : fail('guard:corners-leave-no-trace', JSON.stringify(r));
}

// --- A crop session stays out of the document ------------------------------------------
// The session hid the real image with display:none ON the element, so a reload or a
// tab switch mid-session saved it hidden (and the overlay outlived the switch, so
// Enter committed into the next document). Undo reached past the uncommitted session
// to the previous document action. And a blurred crop wasn't cropped at all: Chrome
// drops a nested <svg>'s viewport clip once that same svg is filtered.
{
  const PNG = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 160; c.height = 120;
    const g = c.getContext('2d');
    g.fillStyle = '#e33'; g.fillRect(0, 0, 80, 120);
    g.fillStyle = '#33e'; g.fillRect(80, 0, 80, 120);
    return c.toDataURL();
  });
  await page.evaluate((PNG) => {
    const s = window.state, NS = 'http://www.w3.org/2000/svg';
    const el = document.createElementNS(NS, 'image');
    el.id = 'cs_img';
    for (const [k, v] of Object.entries({ x: 450, y: 150, width: 160, height: 120, preserveAspectRatio: 'none', href: PNG })) el.setAttribute(k, String(v));
    (document.querySelector('[data-frame]') || document.getElementById('drawing-layer')).appendChild(el);
    s.rebuildShapesFromDOM(); s.saveHistory();
    s.selectShape('cs_img'); s.setSelectionBlur(2, true);
    s.selectShape(null); s.onChange_public();
  }, PNG);
  await page.waitForTimeout(200);
  const layer = () => page.evaluate(() => document.getElementById('drawing-layer').innerHTML);
  const center = () => page.evaluate(() => { const r = document.getElementById('cs_img').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const enter = async () => {
    await page.evaluate(() => { window.state.selectShape('cs_img'); window.state.onChange_public(); });
    const c = await center();
    await page.mouse.dblclick(c.x, c.y);
    await page.waitForTimeout(300);
  };

  // The FULL picture's screen box, taken now: a failed clip grows the element's own
  // box to the whole picture, so it can't be what the check measures against.
  const full = await page.evaluate(() => { const r = document.getElementById('cs_img').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });

  // 1. during a session the markup is untouched, and Undo is off
  const markup0 = await layer();
  const h0 = await page.evaluate(() => window.state.historyMgr.index);
  await enter();
  const tool1 = await page.evaluate(() => window.state.currentTool);
  const markupDuring = await layer();
  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(150);
  const afterUndo = { tool: await page.evaluate(() => window.state.currentTool), h: await page.evaluate(() => window.state.historyMgr.index) };

  // 2. a tab switch ends the session, and the image isn't left hidden
  const tabA = await page.evaluate(() => window.docs.activeId);
  const tabB = await page.evaluate(() => { window.docs.newTab(); return window.docs.activeId; });
  await page.waitForTimeout(200);
  const handlesOnB = await page.locator('#guides-layer [data-crop-handle]').count();
  await page.evaluate((ids) => { window.docs.switchTo(ids.tabA); window.docs.closeTab(ids.tabB); }, { tabA, tabB });
  await page.waitForTimeout(200);
  const styleAfterSwitch = await page.evaluate(() => document.getElementById('cs_img')?.getAttribute('style') ?? null);

  // 3. a real crop of the blurred image to its left (red) half really clips
  await enter();
  const h = await page.evaluate(() => {
    const o = {};
    for (const el of document.querySelectorAll('#guides-layer [data-crop-handle]')) {
      const r = el.getBoundingClientRect(); o[el.getAttribute('data-crop-handle')] = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return o;
  });
  let blue = -1, red = -1;
  if (h.e && h.w) {
    await page.mouse.move(h.e.x, h.e.y); await page.mouse.down();
    await page.mouse.move((h.e.x + h.w.x) / 2, h.e.y, { steps: 6 }); await page.mouse.up();
    await page.keyboard.press('Enter'); await page.waitForTimeout(300);
    await page.evaluate(() => { window.state.selectShape(null); window.state.onChange_public(); document.querySelectorAll('#selection-layer,#guides-layer').forEach(e => { e.style.visibility = 'hidden'; }); });
    await page.waitForTimeout(100);
    // The picture's right (blue) half, clear of the blur's soft spill past the crop
    // edge — and its left (red) half, which the crop keeps.
    const half = full.w / 2;
    const buf = await page.screenshot({ clip: { x: full.x + half + 12, y: full.y + 10, width: half - 16, height: full.h - 20 } });
    const inside = await page.screenshot({ clip: { x: full.x + 10, y: full.y + 10, width: half - 20, height: full.h - 20 } });
    await page.evaluate(() => document.querySelectorAll('#selection-layer,#guides-layer').forEach(e => { e.style.visibility = ''; }));
    const count = (b64, blueWanted) => page.evaluate(async ([b64, blueWanted]) => {
      const i = new Image(); await new Promise(r => { i.onload = r; i.src = 'data:image/png;base64,' + b64; });
      const c = document.createElement('canvas'); c.width = i.width; c.height = i.height;
      const g = c.getContext('2d'); g.drawImage(i, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0;
      for (let k = 0; k < d.length; k += 4) {
        if (blueWanted ? (d[k + 2] > 150 && d[k] < 120) : (d[k] > 150 && d[k + 2] < 120)) n++;
      }
      return n;
    }, [b64, blueWanted]);
    blue = await count(buf.toString('base64'), true);
    red = await count(inside.toString('base64'), false);
  }
  await page.evaluate(() => { if (window.state.findShapeById('cs_img')) window.state.removeShape('cs_img'); });

  const ok = tool1 === 'crop' && markupDuring === markup0 && afterUndo.tool === 'crop' && afterUndo.h === h0
    && handlesOnB === 0 && styleAfterSwitch === null && blue === 0 && red > 500;
  ok ? pass('guard:crop-session-stays-out-of-the-document')
    : fail('guard:crop-session-stays-out-of-the-document', JSON.stringify({ tool1, markupSame: markupDuring === markup0, afterUndo, h0, handlesOnB, styleAfterSwitch, blue, red }));
}

// --- Effect regions follow the geometry --------------------------------------------------
// A blur/shadow region is absolute (userSpaceOnUse), fitted once from getBBox. Only a
// full rebuild refitted it, so a keyboard nudge or a Transform-panel edit left it
// behind: the shape was clipped, then vanished. And a group's stroke lives on its
// children, so a thick-stroked group under a light blur lost the outer half of it.
{
  await page.evaluate(() => {
    const s = window.state, NS = 'http://www.w3.org/2000/svg';
    const home = document.querySelector('[data-frame]') || document.getElementById('drawing-layer');
    const r = document.createElementNS(NS, 'rect');
    r.id = 'er_r';
    for (const [k, v] of Object.entries({ x: 200, y: 300, width: 80, height: 60, fill: '#39f' })) r.setAttribute(k, String(v));
    const g = document.createElementNS(NS, 'g');
    g.id = 'er_g';
    const c = document.createElementNS(NS, 'rect');
    c.id = 'er_gc';
    for (const [k, v] of Object.entries({ x: 420, y: 300, width: 80, height: 60, fill: '#39f', stroke: '#e33', 'stroke-width': 40 })) c.setAttribute(k, String(v));
    g.appendChild(c);
    home.append(r, g);
    s.rebuildShapesFromDOM(); s.saveHistory();
    s.selectShape('er_r'); s.setSelectionShadow({ dx: 4, dy: 4, blur: 2, color: '#000000', opacity: 1 }, true);
    s.selectShape('er_g'); s.setSelectionBlur(0.3, true);
    s.selectShape('er_r'); s.onChange_public();
    document.activeElement?.blur?.();
  });
  await page.waitForTimeout(150);
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight');
  await page.waitForTimeout(250);
  const r = await page.evaluate(() => {
    const region = (id) => { const f = document.getElementById('fx-' + id); return ['x', 'y', 'width', 'height'].map(a => parseFloat(f?.getAttribute(a) ?? 'NaN')); };
    const el = document.getElementById('er_r'), bb = el.getBBox();
    const [fx, fy, fw, fh] = region('er_r');
    const covers = fx <= bb.x && fy <= bb.y && fx + fw >= bb.x + bb.width && fy + fh >= bb.y + bb.height;
    const gb = document.getElementById('er_g').getBBox();
    const [gx] = region('er_g');
    for (const id of ['er_r', 'er_g']) if (window.state.findShapeById(id)) window.state.removeShape(id);
    return { moved: bb.x !== 200, covers, bb: [bb.x, bb.y, bb.width, bb.height], region: [fx, fy, fw, fh], groupPad: gb.x - gx };
  });
  (r.moved && r.covers && r.groupPad >= 20)
    ? pass('guard:effect-regions-follow-geometry')
    : fail('guard:effect-regions-follow-geometry', JSON.stringify(r));
}

// --- Replacing shapes keeps ids unique, hidden things hidden, and effects in place ------
// Detach cloned a grouped component with its OWN inner ids, so two detached copies
// shared shape-N ids and a rename or delete hit the wrong one; a hidden instance came
// back visible; a component renamed in the Symbols panel reverted on the next
// rebuild; and mask flatten baked its transform into the geometry, leaving its
// effects (defined in the mask's own space) turned and scaled wrong.
{
  const r = await page.evaluate(() => {
    const s = window.state, NS = 'http://www.w3.org/2000/svg';
    const home = document.querySelector('[data-frame]') || document.getElementById('drawing-layer');
    const add = (tag, attrs) => {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      home.appendChild(el);
      s.rebuildShapesFromDOM();
      const all = []; const w = (x) => { all.push(x); (x.children ?? []).forEach(w); }; s.shapes.forEach(w);
      return all.find(x => x.element === el)?.id;
    };
    const made = [];
    // 1. two detached copies of a grouped component
    const a = add('rect', { x: 200, y: 640, width: 60, height: 40, fill: '#39f' });
    const b = add('rect', { x: 280, y: 640, width: 60, height: 40, fill: '#e33' });
    s.selectMultiple([a, b]); s.groupSelectedShapes();
    const sym = s.createSymbolFromShape(s.selectedShapeIds[0], 'Pair');
    const use1 = s.selectedShapeIds[0];
    s.placeSymbolInstance(sym.id);
    const use2 = s.selectedShapeIds[0];
    s.detachSymbolInstance(use1); made.push(s.selectedShapeIds[0]);
    s.detachSymbolInstance(use2); made.push(s.selectedShapeIds[0]);
    const ids = [...document.getElementById('drawing-layer').querySelectorAll('[id^="shape-"]')].map(n => n.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);

    // 2. a hidden instance stays hidden
    const c = add('rect', { x: 420, y: 640, width: 60, height: 40, fill: '#3a3' });
    s.createSymbolFromShape(c, 'Hidden');
    const use3 = s.selectedShapeIds[0];
    s.findShapeById(use3).element.style.display = 'none';
    s.rebuildShapesFromDOM(); s.saveHistory();
    s.detachSymbolInstance(use3);
    const hid = s.selectedShapeIds[0]; made.push(hid);
    const hidden = s.findShapeById(hid)?.element.style.display === 'none' && s.findShapeById(hid)?.visible === false;

    // 3. mask flatten carries its transform instead of baking it
    const content = add('rect', { x: 520, y: 640, width: 120, height: 80, fill: '#39f' });
    const cutter = add('ellipse', { cx: 580, cy: 680, rx: 50, ry: 30, fill: '#000' });
    s.selectMultiple([content, cutter]); s.makeClippingMask();
    const mask = s.selectedShapeIds[0];
    s.findShapeById(mask).element.setAttribute('transform', 'rotate(90 580 680)');
    s.rebuildShapesFromDOM(); s.saveHistory();
    s.selectShape(mask); s.setSelectionShadow({ dx: 20, dy: 0, blur: 0, color: '#000000', opacity: 1 }, true);
    made.push(s.selectedShapeIds[0]); // the group that took the shadow (it holds the mask)
    return { dupes, hidden, mask, made };
  });
  await page.evaluate((id) => window.state.flattenMask(id), r.mask);
  await page.waitForTimeout(200);
  const flat = await page.evaluate((id) => {
    const el = window.state.findShapeById(id)?.element;
    const bb = el?.getBBox();
    return el && { tag: el.tagName.toLowerCase(), transform: el.getAttribute('transform'), shadow: !!el.parentElement.getAttribute('data-fx-shadow'),
      // in the mask's OWN space the result sits inside the cutter's box (530..630 × 650..710)
      inside: bb.x >= 529 && bb.x + bb.width <= 631 && bb.y >= 649 && bb.y + bb.height <= 711 };
  }, r.mask);

  // 4. a component renamed in the Symbols panel keeps the name through a rebuild
  const symId = await page.evaluate(() => {
    const s = window.state, NS = 'http://www.w3.org/2000/svg';
    const el = document.createElementNS(NS, 'rect');
    for (const [k, v] of Object.entries({ x: 700, y: 640, width: 60, height: 40, fill: '#39f' })) el.setAttribute(k, String(v));
    (document.querySelector('[data-frame]') || document.getElementById('drawing-layer')).appendChild(el);
    s.rebuildShapesFromDOM();
    const all = []; const w = (x) => { all.push(x); (x.children ?? []).forEach(w); }; s.shapes.forEach(w);
    const id = all.find(x => x.element === el)?.id;
    return s.createSymbolFromShape(id, 'Widget').id;
  });
  await page.waitForTimeout(150);
  let renamed = null;
  const li = page.locator(`#symbols-list li[data-id="${symId}"]`);
  if (await li.count()) {
    await li.dispatchEvent('dblclick');
    await page.waitForTimeout(150);
    if (await page.locator('#symbols-list input.layer-rename').count()) {
      await page.locator('#symbols-list input.layer-rename').fill('Gadget');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
      await page.evaluate(() => window.state.rebuildShapesFromDOM());
      renamed = await page.evaluate((id) => window.state.symbols.find(x => x.id === id)?.name, symId);
    }
  }
  await page.evaluate((ids) => {
    const s = window.state;
    for (const id of ids) if (id && s.findShapeById(id)) s.removeShape(id);
    for (const sym of [...s.symbols]) if (['Pair', 'Hidden', 'Gadget', 'Widget'].includes(sym.name)) s.removeSymbol(sym.id);
  }, [...r.made, r.mask]);
  const ok = r.dupes.length === 0 && r.hidden && !!flat && flat.tag === 'path' && flat.transform === 'rotate(90 580 680)'
    && flat.shadow && flat.inside && renamed === 'Gadget';
  ok ? pass('guard:replacements-keep-ids-visibility-and-space')
    : fail('guard:replacements-keep-ids-visibility-and-space', JSON.stringify({ ...r, flat, renamed }));
}

// --- Reversing a path changes what's written, not what's drawn -------------------------
// Which way a path runs is invisible, so a reversal that moved anything is a bug nobody
// asked for: a width profile left behind on the wrong end, a sideways stroke jumping to
// the other side of the line, a hole filled in because only one run was flipped. Each
// case is rotated, faded or blurred so a dropped attribute shows too. `happened` proves
// the written order really did change — the pixels alone would pass a no-op.
await rbGuard('guard:reverse-keeps-what-is-rendered', async (rb) => {
  const reverse = () => { window.state.reverseSelectedPaths(); return window.state.selectedShapeIds[0]; };
  const reversed = (ctx) => {
    const el = window.state.findShapeById(ctx.out).element;
    const src = el.querySelector(':scope > [data-width-src], :scope > [data-ap-src]') ?? el;
    return (src.getAttribute('d') ?? src.getAttribute('points') ?? `${src.getAttribute('x1')},${src.getAttribute('y1')}`) !== ctx.before;
  };
  await rb('an open curve, rotated and faded', () => {
    const d = 'M 200 240 C 260 140 340 140 400 220 L 460 180';
    const id = window.__rb.add('path', { d, fill: 'none', stroke: '#e33', 'stroke-width': 8 });
    window.__rb.turn(id, 25, 0.6);
    return { measure: id, before: d };
  }, reverse, { happened: reversed });
  await rb('a compound path keeps its hole under nonzero', () => {
    const d = 'M 200 150 L 400 150 L 400 300 L 200 300 Z M 250 190 L 250 260 L 350 260 L 350 190 Z';
    const id = window.__rb.add('path', { d, fill: '#2a7', stroke: '#111', 'stroke-width': 3, 'fill-rule': 'nonzero' });
    window.state.saveHistory();
    return { measure: id, before: d };
  }, reverse, { happened: reversed });
  await rb('a rotated rounded rect', () => {
    const id = window.__rb.add('rect', { x: 220, y: 170, width: 180, height: 100, rx: 18, fill: '#fa0', stroke: '#111', 'stroke-width': 3 });
    window.__rb.turn(id, 15, 0.8);
    return { measure: id, before: null };
  }, reverse, { happened: reversed });
  await rb('an ellipse', () => {
    const id = window.__rb.add('ellipse', { cx: 300, cy: 220, rx: 110, ry: 70, fill: '#0af', stroke: '#111', 'stroke-width': 4 });
    window.state.saveHistory();
    return { measure: id, before: null };
  }, reverse, { happened: reversed });
  await rb('a polygon', () => {
    const points = '220,160 400,180 360,300 240,280';
    const id = window.__rb.add('polygon', { points, fill: '#c6f', stroke: '#111', 'stroke-width': 4, 'stroke-linejoin': 'round' });
    window.state.saveHistory();
    return { measure: id, before: points };
  }, reverse, { happened: reversed });
  await rb('an inside-aligned stroke', () => {
    const d = 'M 220 160 L 400 160 L 400 300 L 220 300 Z';
    const id = window.__rb.add('path', { d, fill: '#fd6', stroke: '#111', 'stroke-width': 12 });
    window.state.selectShape(id);
    window.state.setSelectionStrokeAlign('inside');
    window.state.saveHistory();
    return { measure: id, before: d };
  }, reverse, { happened: reversed });
  await rb('a variable-width stroke keeps its thick end', () => {
    const d = 'M 200 220 C 280 120 360 320 440 220';
    const id = window.__rb.add('path', { d, fill: 'none', stroke: '#35e', 'stroke-width': 10 });
    window.state.setWidthProfile(id, [{ t: 0, w: 44 }, { t: 0.3, w: 8 }, { t: 1, w: 2 }], 10);
    return { measure: id, before: d };
  }, reverse, { happened: reversed });
  await rb('an offset stroke stays on its side of an open line', async () => {
    const d = 'M 200 220 C 280 150 360 290 440 220';
    const id = window.__rb.add('path', { d, fill: 'none', stroke: '#111', 'stroke-width': 2 });
    const { ensureOffsetEngine } = await import('/src/core/boolean.ts');
    await ensureOffsetEngine();
    window.state.setAppearance(id, [
      { t: 'stroke', paint: '#e33', width: 6, offset: 24 },
      { t: 'stroke', paint: '#111', width: 2 },
    ]);
    return { measure: id, before: d };
  }, reverse, { happened: reversed });
  await rb('an offset stroke stays on its side of a closed loop', async () => {
    const d = 'M 220 170 L 400 170 L 400 290 L 220 290 Z';
    const id = window.__rb.add('path', { d, fill: 'none', stroke: '#111', 'stroke-width': 2 });
    const { ensureOffsetEngine } = await import('/src/core/boolean.ts');
    await ensureOffsetEngine();
    window.state.setAppearance(id, [
      { t: 'stroke', paint: '#e33', width: 6, offset: 22 },
      { t: 'stroke', paint: '#111', width: 2 },
    ]);
    return { measure: id, before: d };
  }, reverse, { happened: reversed });
});

// --- Outline Stroke outlines the stroke that was drawn (#292) --------------------------
// It used to widen the centre line and stop: arrowheads vanished, a dash pattern came
// out solid, and an inside/outside-aligned stroke (drawn doubled, half hidden) became
// a centred ring of the wrong width. Each case is what was on screen, as geometry.
await rbGuard('guard:outline-stroke-is-what-rendered', async (rb) => {
  const outline = async () => { await window.state.outlineSelectedStroke(); return window.state.selectedShapeIds[0]; };
  await rb('arrowheads', () => {
    const h = window.__rb, s = window.state;
    const id = h.add('line', { x1: 200, y1: 180, x2: 420, y2: 220, stroke: '#e33', 'stroke-width': 6 });
    s.selectShape(id); s.setSelectionMarker('end', 'mk-arrow'); s.setSelectionMarker('start', 'mk-dot');
    return { measure: id };
  }, outline);
  await rb('a marker clipped to its own viewport', () => {
    const h = window.__rb, s = window.state, NS = 'http://www.w3.org/2000/svg';
    const m = document.createElementNS(NS, 'marker');
    m.id = 'rb-bar';
    for (const [k, v] of Object.entries({ viewBox: '0 0 10 10', markerWidth: 4, markerHeight: 4, refX: 5, refY: 5, orient: 'auto' })) m.setAttribute(k, String(v));
    m.innerHTML = '<rect x="-20" y="2" width="50" height="6" fill="context-stroke"/>'; // 5x wider than the viewBox
    document.querySelector('#svg-canvas defs').appendChild(m);
    const id = h.add('line', { x1: 220, y1: 200, x2: 380, y2: 240, stroke: '#2a7', 'stroke-width': 8, 'marker-end': 'url(#rb-bar)' });
    s.saveHistory();
    return { measure: id };
  }, outline);
  await page.evaluate(() => document.getElementById('rb-bar')?.remove());
  await rb('dashes, one wrapping the start corner', () => {
    const id = window.__rb.add('rect', { x: 200, y: 160, width: 200, height: 100, fill: 'none', stroke: '#35e', 'stroke-width': 8, 'stroke-dasharray': '30 10', 'stroke-dashoffset': 15 });
    window.state.saveHistory();
    return { measure: id };
    // The dash that runs through the start corner is one dash with a mitered corner,
    // not two butt ends: the corner's outer tip (16 pixels no percentage notices) is ink.
  }, outline, { happened: (ctx) => window.state.findShapeById(ctx.out).element.isPointInFill(new DOMPoint(197, 157)) });
  await rb('square caps, a sharp corner', () => {
    const id = window.__rb.add('polyline', { points: '220,280 290,180 330,280 410,190', fill: 'none', stroke: '#e80', 'stroke-width': 12, 'stroke-linecap': 'square' });
    window.state.saveHistory();
    return { measure: id };
  }, outline);
  await rb('a corner past the miter limit', () => {
    const id = window.__rb.add('polyline', { points: '240,290 300,190 281,290', fill: 'none', stroke: '#08c', 'stroke-width': 14 });
    window.state.saveHistory();
    return { measure: id };
  }, outline);
  // Dashes on a curve: each is cut from the path (and an ellipse is dashed from 3
  // o'clock, clockwise), laid out on the renderer's own path length. Sixty-odd short
  // dashes are mostly edge pixels, hence the looser mean.
  await rb('dashes on an ellipse', () => {
    const id = window.__rb.add('ellipse', { cx: 300, cy: 220, rx: 90, ry: 50, fill: 'none', stroke: '#c5c', 'stroke-width': 6, 'stroke-dasharray': '14 6 3' });
    window.state.saveHistory();
    return { measure: id };
  }, outline, { mean: 10 });
  await rb('outside-aligned, with a fill', () => {
    const h = window.__rb, s = window.state;
    const id = h.add('rect', { x: 220, y: 170, width: 160, height: 90, fill: '#cccccc', stroke: '#e33', 'stroke-width': 16 });
    s.selectShape(id); s.setSelectionStrokeAlign('outside');
    return { measure: id };
  }, outline);
  await rb('inside-aligned, no fill', () => {
    const h = window.__rb, s = window.state;
    const id = h.add('rect', { x: 220, y: 170, width: 160, height: 90, fill: 'none', stroke: '#e33', 'stroke-width': 16 });
    s.selectShape(id); s.setSelectionStrokeAlign('inside');
    return { measure: id };
  }, outline);
});

// --- A mask's effects, and flattening a mask (#293) ------------------------------------
// One element can't both clip and cast a shadow: SVG filters first, then clips, so a
// mask's own shadow was cut off at the mask's outline. An effect set on a mask now
// lands on a plain group around it. And Flatten Mask must not change the picture: a
// stroke inside a mask is cut, not redrawn along the cut edge, and content that can't
// become a plain path (it has an effect of its own) keeps its clip instead.
{
  const made = await page.evaluate(() => {
    const h = window.__rb, s = window.state;
    const content = h.add('rect', { x: 200, y: 150, width: 200, height: 140, fill: '#39f' });
    const cutter = h.add('ellipse', { cx: 300, cy: 220, rx: 80, ry: 60, fill: '#000' });
    s.selectMultiple([content, cutter]); s.makeClippingMask();
    const mask = s.selectedShapeIds[0];
    s.saveHistory();
    s.selectShape(mask);
    s.setSelectionShadow({ dx: 30, dy: 30, blur: 0, color: '#ff0000', opacity: 1 }, true);
    const host = s.selectedShapeIds[0], g = s.findShapeById(host).element, m = s.findShapeById(mask).element;
    s.selectShape(mask); s.setSelectionBlur(1, true); // with the mask selected again: same group, not another
    const r = m.getBoundingClientRect();
    return { mask, host, again: s.selectedShapeIds[0],
      plainGroup: g.tagName.toLowerCase() === 'g' && !g.hasAttribute('data-clip-group') && m.parentElement === g && g.children.length === 1,
      onGroup: !!g.getAttribute('data-fx-shadow') && !m.getAttribute('data-fx-shadow') && !m.getAttribute('filter'),
      clip: { x: r.left - 10, y: r.top - 10, width: r.width + 60, height: r.height + 60 } };
  });
  await page.waitForTimeout(250);
  const red = await page.evaluate(async (b64) => {
    const i = new Image(); await new Promise(r => { i.onload = r; i.src = 'data:image/png;base64,' + b64; });
    const c = document.createElement('canvas'); c.width = i.width; c.height = i.height;
    const g = c.getContext('2d'); g.drawImage(i, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0;
    for (let k = 0; k < d.length; k += 4) if (d[k] > 150 && d[k + 1] < 90 && d[k + 2] < 90) n++;
    return n;
  }, await rbShot(made.clip));
  await page.evaluate((ids) => { for (const id of ids) if (window.state.findShapeById(id)) window.state.removeShape(id); }, [made.host, made.mask]);

  const flatFailures = [];
  const rb = async (...a) => { const r = await rbCase(...a); if (r) flatFailures.push(r); };
  const flatten = async (ctx) => { await window.state.flattenMask(ctx.measure); return window.state.selectedShapeIds[0]; };
  const notAMask = (ctx) => !window.state.findShapeById(ctx.out).element.hasAttribute('data-clip-group');
  await rb('flatten: dashed stroke, faded content', () => {
    const h = window.__rb, s = window.state;
    const content = h.add('rect', { x: 230, y: 170, width: 120, height: 90, fill: '#39f', stroke: '#222', 'stroke-width': 10, 'stroke-dasharray': '24 10', opacity: 0.7 });
    const cutter = h.add('ellipse', { cx: 300, cy: 220, rx: 80, ry: 60, fill: '#000' });
    s.selectMultiple([content, cutter]); s.makeClippingMask();
    return { measure: s.selectedShapeIds[0] };
  }, flatten, { happened: notAMask });
  await rb('flatten: blurred content keeps its clip', () => {
    const h = window.__rb, s = window.state;
    const content = h.add('rect', { x: 250, y: 190, width: 100, height: 60, fill: '#39f' }); // edges inside the mask
    s.selectShape(content); s.setSelectionBlur(4, true);
    const cutter = h.add('ellipse', { cx: 300, cy: 220, rx: 80, ry: 60, fill: '#000' });
    s.selectMultiple([content, cutter]); s.makeClippingMask();
    return { measure: s.selectedShapeIds[0] };
  }, flatten, { happened: notAMask });

  const ok = made.plainGroup && made.onGroup && made.again === made.host && red > 1500 && flatFailures.length === 0;
  ok ? pass('guard:mask-effects-and-flatten')
    : fail('guard:mask-effects-and-flatten', (JSON.stringify({ ...made, clip: undefined, red }) + ' ' + flatFailures.join(' || ')).slice(0, 900));
}

// --- Detaching an imported component keeps all of it (#294, #295) -------------------------
// Imported <symbol>s aren't shaped like the ones the app makes: several children, a
// <title> first, a <circle>, a viewport that clips its content, no size on the
// instance. Detach took the first child and guessed 100×100. And deleting a component
// detached only the instances on the canvas, not the one inside another component.
{
  const importOne = `(defs, use, box = '0 0 300 200') => {
    const s = window.state;
    s.appendSVGContent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + box + '"><defs>' + defs + '</defs>' + use + '</svg>', 'rb import');
    const el = s.findShapeById(s.selectedShapeIds[0]).element.querySelector('use'); // inside the group just appended
    return { measure: el.id, size: el.getAttribute('width') + 'x' + el.getAttribute('height') };
  }`;
  const setup = (defs, use, box) => new Function(`return (${importOne})(${JSON.stringify(defs)}, ${JSON.stringify(use)}${box ? ', ' + JSON.stringify(box) : ''})`);
  const detach = (ctx) => { window.state.detachSymbolInstance(ctx.measure); return window.state.selectedShapeIds[0]; };
  await rbGuard('guard:imported-components-detach-whole', async (rb) => {
    await rb('several children, <title> first', setup(
      '<symbol id="rb-multi" viewBox="0 0 100 100"><title>two</title><rect width="100" height="50" fill="#e33"/><rect y="50" width="100" height="50" fill="#33e"/></symbol>',
      '<use href="#rb-multi" x="20" y="20" width="120" height="120"/>'), detach);
    await rb('a <title>, then a <circle>', setup(
      '<symbol id="rb-dot" viewBox="0 0 100 100"><title>dot</title><circle cx="50" cy="50" r="40" fill="#fc0" stroke="#630" stroke-width="6"/></symbol>',
      '<use href="#rb-dot" x="20" y="20" width="120" height="120"/>'), detach,
      { happened: (ctx) => window.state.findShapeById(ctx.out).element.tagName.toLowerCase() === 'ellipse' });
    await rb('slice: clipped to the viewport', setup(
      '<symbol id="rb-slice" viewBox="0 0 100 100" preserveAspectRatio="xMinYMin slice"><rect width="100" height="100" fill="#3a3"/><circle cx="50" cy="50" r="40" fill="#ff0"/></symbol>',
      '<use href="#rb-slice" x="20" y="20" width="160" height="80"/>'), detach,
      { happened: (ctx) => window.state.findShapeById(ctx.out).element.hasAttribute('data-clip-group') });
    await rb('no width/height on the instance', setup(
      '<symbol id="rb-bare" viewBox="0 0 100 100"><path d="M10 10 H 90 V 90 H 10 Z" fill="#f80"/></symbol>',
      '<use href="#rb-bare"/>', '0 0 200 150'), detach,
      // …and it was sized at import (100% of the FILE's viewport), not left to follow the zoom.
      { happened: (ctx) => ctx.size === '200x150' && window.state.findShapeById(ctx.out).element.tagName.toLowerCase() === 'path' });
    await rb('deleting a component used inside another', () => {
      const h = window.__rb, s = window.state;
      const src = h.add('rect', { x: 220, y: 180, width: 60, height: 40, fill: '#25a' });
      const inner = s.createSymbolFromShape(src, 'rb Inner');
      const innerUse = s.selectedShapeIds[0];
      const other = h.add('ellipse', { cx: 330, cy: 200, rx: 30, ry: 20, fill: '#a25' });
      s.selectMultiple([innerUse, other]); s.groupSelectedShapes();
      s.createSymbolFromShape(s.selectedShapeIds[0], 'rb Outer');
      return { measure: s.selectedShapeIds[0], inner: inner.id };
    }, (ctx) => { window.state.removeSymbol(ctx.inner); return ctx.measure; },
    { happened: () => [...document.querySelectorAll('defs symbol use')].every(u => document.querySelector(u.getAttribute('href'))) });
  });
  await page.evaluate(() => {
    const s = window.state;
    for (const sym of [...s.symbols]) if (/^rb-|^rb /.test(sym.id) || /^rb /.test(sym.name) || /rb-/.test(sym.name)) s.removeSymbol(sym.id);
  });
}

// --- Ungroup hands each child what the group carried (#296) -------------------------------
// It composed the group's transform onto the children and dropped the rest: a faded,
// shadowed group came apart fully opaque with no shadow. (The children here don't
// overlap — overlapping ones can't match a group pixel for pixel once they composite
// separately.) One child is rotated, so the shadow's offset has to be turned for it.
{
  const failures = [];
  const r = await rbCase('faded, shadowed, scaled group', () => {
    const h = window.__rb, s = window.state;
    const a = h.add('rect', { x: 200, y: 180, width: 80, height: 50, fill: '#e33' });
    const b = h.add('rect', { x: 330, y: 170, width: 60, height: 70, fill: '#39f', transform: 'rotate(90 360 205)' });
    s.selectMultiple([a, b]); s.groupSelectedShapes();
    const id = s.selectedShapeIds[0];
    s.selectShape(id); s.setSelectionOpacity(0.5, true);
    s.setSelectionShadow({ dx: 16, dy: 0, blur: 0, color: '#ffffff', opacity: 1 }, true);
    s.findShapeById(id).element.setAttribute('transform', 'translate(-40 -20) scale(1.2)');
    s.rebuildShapesFromDOM(); s.saveHistory();
    return { measure: id };
  }, (ctx) => { window.state.ungroupShape(ctx.measure); return window.state.selectedShapeIds[0]; });
  if (r) failures.push(r);
  // Every replace gives an effect a new element id, hence a new <filter>; the old
  // ones used to pile up in <defs> and in every saved file.
  const orphans = await page.evaluate(() => [...document.querySelectorAll('#svg-canvas defs > filter[id^="fx-"]')]
    .filter(f => !document.querySelector(`#svg-canvas [filter="url(#${f.id})"]`)).map(f => f.id));
  (failures.length === 0 && orphans.length === 0)
    ? pass('guard:ungroup-keeps-what-the-group-carried')
    : fail('guard:ungroup-keeps-what-the-group-carried', (failures.join(' || ') + ' orphans=' + JSON.stringify(orphans)).slice(0, 900));
}
await page.evaluate(() => { delete window.__rb; });

// --- Object attributes travel as one set (#297, #298) -------------------------------------
// What an object carries beyond geometry and paint — transform, opacity, effects, blend,
// lock, name, links, hidden — has to move together whenever its element is wrapped,
// unwrapped, replaced or dissolved. Two things used to make that fragile: blend mode
// lived only in inline style, so each site needed a special case for it (and the two
// wrapper modules forgot the hidden state); and nothing noticed a NEW replace site.
{
  const { readFileSync, readdirSync } = await import('node:fs');
  const srcDir = new globalThis.URL('../src/', import.meta.url);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(new globalThis.URL(`${e.name}/`, dir)) : [new globalThis.URL(e.name, dir)]);
  const sources = walk(srcDir).filter((u) => u.pathname.endsWith('.ts'))
    .map((u) => ({ file: u.pathname.split('/src/')[1], code: readFileSync(u, 'utf8') }));

  // 1. Blend mode is written in ONE place. Anything else touching the inline style
  //    is a second source of truth waiting to disagree with data-blend.
  const BLEND_FILES = ['core/wrapper-attrs.ts', 'core/compositing.ts', 'core/appearance.ts', 'core/types.ts'];
  const strayBlend = sources.filter((f) => /mixBlendMode|mix-blend-mode/.test(f.code) && !BLEND_FILES.includes(f.file)).map((f) => f.file);
  // …and the carry list is walked in one place, not re-looped per module.
  const strayCarry = sources.filter((f) => /import[^;]*\bCARRY_ATTRS\b/.test(f.code)).map((f) => f.file);

  const r = await page.evaluate(() => {
    const s = window.state, NS = 'http://www.w3.org/2000/svg';
    const home = document.querySelector('[data-frame]') || document.getElementById('drawing-layer');
    const add = (id, attrs) => {
      const el = document.createElementNS(NS, 'rect');
      el.id = id;
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      home.appendChild(el);
    };
    add('bl_a', { x: 200, y: 640, width: 80, height: 50, fill: '#39f' });
    add('bl_b', { x: 320, y: 640, width: 80, height: 50, fill: '#e33', style: 'mix-blend-mode: screen' }); // inline only, as imported
    s.rebuildShapesFromDOM(); s.saveHistory();
    const el = (id) => s.findShapeById(id).element;
    const look = (e) => ({ attr: e.getAttribute('data-blend'), style: e.style.mixBlendMode, opacity: e.getAttribute('opacity'), hidden: e.style.display === 'none' });

    s.selectShape('bl_a'); s.setSelectionBlendMode('multiply');
    const set = { ...look(el('bl_a')), read: s.getBlendMode('bl_a') };
    const adopted = { ...look(el('bl_b')), read: s.getBlendMode('bl_b') };

    // wrap (a second fill) and unwrap: everything moves to the wrapper, and back
    s.setSelectionOpacity(0.6, true);
    s.toggleVisibility('bl_a');
    s.setAppearance('bl_a', [{ t: 'fill', paint: '#3399ff', opacity: 1 }, { t: 'fill', paint: '#ee3333', opacity: 0.5 }]);
    const w = el('bl_a'), inner = w.querySelector('[data-ap-src]');
    const wrapped = { tag: w.tagName.toLowerCase(), wrapper: look(w), inner: inner && look(inner), visible: s.findShapeById('bl_a').visible };
    s.setAppearance('bl_a', [{ t: 'fill', paint: '#3399ff', opacity: 1 }]);
    const unwrapped = { tag: el('bl_a').tagName.toLowerCase(), ...look(el('bl_a')) };

    s.selectShape('bl_a'); s.setSelectionBlendMode('normal');
    const cleared = look(el('bl_a'));
    for (const id of ['bl_a', 'bl_b']) if (s.findShapeById(id)) s.removeShape(id);
    return { set, adopted, wrapped, unwrapped, cleared };
  });
  const ok = strayBlend.length === 0 && strayCarry.length === 0
    && r.set.attr === 'multiply' && r.set.style === 'multiply' && r.set.read === 'multiply'
    && r.adopted.attr === 'screen' && r.adopted.read === 'screen'
    && r.wrapped.tag === 'g' && r.wrapped.wrapper.attr === 'multiply' && r.wrapped.wrapper.style === 'multiply'
    && r.wrapped.wrapper.opacity === '0.6' && r.wrapped.wrapper.hidden && r.wrapped.visible === false
    && !!r.wrapped.inner && !r.wrapped.inner.attr && !r.wrapped.inner.style && !r.wrapped.inner.opacity && !r.wrapped.inner.hidden
    && r.unwrapped.tag === 'rect' && r.unwrapped.attr === 'multiply' && r.unwrapped.style === 'multiply' && r.unwrapped.opacity === '0.6' && r.unwrapped.hidden
    && !r.cleared.attr && !r.cleared.style;
  ok ? pass('guard:object-attributes-travel-as-one')
    : fail('guard:object-attributes-travel-as-one', JSON.stringify({ strayBlend, strayCarry, ...r }).slice(0, 900));

  // 1b. WHERE the document lives (core/doc-source.ts) has one writer path. Identity
  //     used to be two hand-synced singletons (a file handle and a cloud tether), and
  //     every open/save/import path cleared one and set the other by hand — forget a
  //     site and ⌘S wrote to the previous document's file. Now project-file's
  //     adoptSource is the funnel, and the tab swap restores a cached value; a new
  //     caller fails here until reviewed. DocumentManager also completes a save
    //     against its captured owning tab (covered by save-ownership/Drive tests).
  const DOC_SOURCE_WRITERS = { 'core/doc-source.ts': 1, 'ui/project-file.ts': 1, 'core/document-manager.ts': 2 };
  const writers = Object.fromEntries(sources
    .map((f) => [f.file, (f.code.match(/\bsetDocSource\(/g) ?? []).length])
    .filter(([, n]) => n > 0));
  const writerDrift = [...new Set([...Object.keys(DOC_SOURCE_WRITERS), ...Object.keys(writers)])]
    .filter((f) => (DOC_SOURCE_WRITERS[f] ?? 0) !== (writers[f] ?? 0))
    .map((f) => `${f}: allowed ${DOC_SOURCE_WRITERS[f] ?? 0}, found ${writers[f] ?? 0}`);
  // …and the retired singletons stay retired.
  const retired = sources.filter((f) => /\b(get|set)CurrentFileHandle\b|\b(get|set|clear)CloudDoc\b/.test(f.code)).map((f) => f.file);
  (writerDrift.length === 0 && retired.length === 0)
    ? pass('guard:doc-source-has-one-writer')
    : fail('guard:doc-source-has-one-writer', JSON.stringify({ writerDrift, retired }));

  // 2. Every place that swaps one element for another has been looked at. The counts
  //    below are those sites; a new one fails here until someone has decided what the
  //    old element carried and used carryObjectAttrs / moveObjectAttrs / dissolveOnto
  //    (and added a pixel case to the oracle above). Then update the count.
  const REVIEWED = {
    'core/appearance.ts': 2,       // wrap / unwrap: moveObjectAttrs, carryObjectAttrs
    'core/corners.ts': 1,          // a cancelled preview puts the original markup back
    'core/effects.ts': 1,          // a mask gains the group its effects live on
    'core/pathfinder.ts': 5,       // boolean flatten, mask flatten, outline stroke (x3)
    'core/rect-shape.ts': 1,       // rect -> per-corner path: every attribute copied
    'core/repeat.ts': 2,           // release (foldOnto), bake (instance offset composed)
    'core/state.ts': 3,            // circle -> ellipse, outlined text, shape -> path: all attributes copied
    'core/symbol-registry.ts': 3,  // circle -> ellipse in a clone, shape -> instance, detach (dissolveOnto)
    'core/text-outline.ts': 1,     // text -> path on export (carryObjectAttrs)
    'core/text-stroke.ts': 1,      // a regenerated cache child, not an object
    'core/width-stroke.ts': 2,     // wrap / release: carryObjectAttrs
    'tools/crop.ts': 1,            // crop commit: carryAttrs (wholesale)
    'ui/image-actions.ts': 1,      // reset crop: uncropToImage (wholesale)
    'ui/panel-helpers.ts': 2, 'ui/properties.ts': 1, // UI, not artwork
  };
  const found = Object.fromEntries(sources
    .map((f) => [f.file, (f.code.match(/\.replaceWith\(|\.replaceChild\(|\.outerHTML\s*=[^=]/g) || []).length])
    .filter(([, n]) => n > 0));
  const drift = [...new Set([...Object.keys(REVIEWED), ...Object.keys(found)])]
    .filter((f) => (REVIEWED[f] ?? 0) !== (found[f] ?? 0))
    .map((f) => `${f}: reviewed ${REVIEWED[f] ?? 0}, found ${found[f] ?? 0}`);
  drift.length === 0 ? pass('guard:element-replacements-are-reviewed')
    : fail('guard:element-replacements-are-reviewed', drift.join('; '));
}

// --- Outline Text matches a variable font as the canvas drew it (#303) ----------------
// Inter at 48px renders with its opsz-32 display design; the outliner used the static
// file, which is the opsz-14 text design — the letters visibly changed shape. Outlines
// of a variable family now come from the same face at the axis values the browser
// used (opsz from the size, wght from the weight, explicit variation settings).
// Text and a filled path anti-alias differently, so the pixels are compared after a
// blur that erases the AA; a different DESIGN still moves ink by whole pixels.
{
  const blurDiff = (a, b) => page.evaluate(async ([a, b]) => {
    const load = (src) => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height;
    const g = c.getContext('2d');
    const read = (im) => { g.clearRect(0, 0, c.width, c.height); g.filter = 'blur(1.5px)'; g.drawImage(im, 0, 0); g.filter = 'none'; return g.getImageData(0, 0, c.width, c.height).data; };
    const da = read(ia), db = read(ib);
    const bg = [da[0], da[1], da[2]];
    let ink = 0, changed = 0;
    for (let i = 0; i < da.length; i += 4) {
      const cov = (d) => (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2])) / 3;
      if (cov(da) > 10 || cov(db) > 10) ink++;
      if (Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2])) > 24) changed++;
    }
    return Math.round(1000 * changed / Math.max(1, ink)) / 10;
  }, [a, b]);
  // [name, attributes, allowed % changed]. Roboto carries TrueType hinting that
  // Chrome applies to text and no path fill can, hence its looser allowance; the
  // width is what's under test there (the old outline was ~40% off). The others
  // allow a little for the zoom the run happens to be at; a wrong design is 18-77%.
  const CASES = [
    ['Inter 48px (opsz 32)', { 'font-family': 'Inter', 'font-size': 48 }, 5],
    ['Inter 40px bold italic', { 'font-family': 'Inter', 'font-size': 40, 'font-weight': 700, 'font-style': 'italic' }, 5],
    ['DM Sans 36px (opsz 36)', { 'font-family': 'DM Sans', 'font-size': 36 }, 5],
    ['Roboto, width 80', { 'font-family': 'Roboto', 'font-size': 48, style: "font-variation-settings: 'wdth' 80" }, 12],
  ];
  const off = [];
  for (const [name, attrs, allowed] of CASES) {
    const id = await page.evaluate(async (attrs) => {
      const s = window.state, NS = 'http://www.w3.org/2000/svg';
      const t = document.createElementNS(NS, 'text');
      t.id = 'ot_text';
      for (const [k, v] of Object.entries({ x: 220, y: 240, fill: '#ffcc00', ...attrs })) t.setAttribute(k, String(v));
      t.textContent = 'Handgloves 0123';
      (document.querySelector('[data-frame]') || document.getElementById('drawing-layer')).appendChild(t);
      s.rebuildShapesFromDOM(); s.saveHistory();
      await document.fonts.ready;
      return t.id;
    }, attrs);
    await page.waitForTimeout(300);
    const clip = await page.evaluate((id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.left - 10, y: r.top - 10, width: r.width + 20, height: r.height + 20 }; }, id);
    const before = await rbShot(clip);
    const kind = await page.evaluate(async (id) => { window.state.selectShape(id); await window.state.outlineSelectedText(); return window.state.findShapeById(id)?.element.tagName.toLowerCase(); }, id);
    await page.waitForTimeout(250);
    const pct = await blurDiff(before, await rbShot(clip));
    if (kind !== 'path' || pct > allowed) off.push(`${name}: ${kind}, ${pct}% changed (allowed ${allowed})`);
    await page.evaluate((id) => { if (window.state.findShapeById(id)) window.state.removeShape(id); }, id);
  }
  off.length === 0 ? pass('guard:outline-text-matches-variable-fonts')
    : fail('guard:outline-text-matches-variable-fonts', off.join('; '));
}

// --- Every slider that appeared during the run had its field (#302) -----------------
// Counted from the watcher installed before the page loaded: the panels, popovers
// and dialogs this run opened, not just what was on the page at load.
{
  const r = await page.evaluate(() => ({
    seen: window.__ranges.length,
    bare: window.__ranges.filter((el) => !el.nextElementSibling?.classList.contains('slider-field'))
      .map((el) => el.id || el.className || el.outerHTML.slice(0, 80)),
  }));
  (r.seen >= 8 && r.bare.length === 0) ? pass('guard:every-slider-seen-had-its-field')
    : fail('guard:every-slider-seen-had-its-field', JSON.stringify(r));
}

// --- Desktop gate: phones get the gate, never the editor -------------------------
// entry.ts decides before the editor loads, so every page load now runs through it.
// Both halves matter: a phone must not boot (or even request) the editor, and a
// desktop must never see the gate — this whole run already proved the editor boots,
// so the desktop half only has to prove the gate stayed away.
{
  const onDesktop = await page.evaluate(() => ({
    gate: !!document.getElementById('desktop-gate'),
    phoneClass: document.documentElement.classList.contains('is-phone'),
  }));
  (!onDesktop.gate && !onDesktop.phoneClass)
    ? pass('gate:desktop-gets-editor') : fail('gate:desktop-gets-editor', JSON.stringify(onDesktop));

  const ctx = await browser.newContext({ ...pw.devices['iPhone 13'] });
  // Headless Chromium has no share sheet; every real phone does. Stand one in, and
  // record what it was handed, so the guard proves the button shares the address.
  await ctx.addInitScript(() => {
    window.__shared = [];
    navigator.share = (data) => { window.__shared.push(data); return Promise.resolve(); };
  });
  const phone = await ctx.newPage();
  const phoneErrors = [];
  const editorRequests = [];
  phone.on('pageerror', (e) => phoneErrors.push(String(e.message)));
  phone.on('console', (m) => { if (m.type() === 'error') phoneErrors.push(m.text()); });
  // In dev each module is its own request, so the editor's modules are directly visible.
  phone.on('request', (r) => { if (/\/src\/(main|core\/state)\.ts/.test(r.url())) editorRequests.push(r.url()); });
  await phone.goto(URL, { waitUntil: 'networkidle' });
  const g = await phone.evaluate(() => {
    const gate = document.getElementById('desktop-gate');
    const btn = gate && gate.querySelector('.dg-btn');
    const r = btn && btn.getBoundingClientRect();
    return {
      gate: !!gate,
      appHidden: getComputedStyle(document.getElementById('app')).display === 'none',
      editorBooted: !!window.state,
      title: gate ? gate.querySelector('h1').textContent : null,
      // The one action must be on screen without scrolling, and big enough to tap.
      buttonOnScreen: !!r && r.bottom <= innerHeight && r.height >= 44,
      scrolls: !!gate && gate.scrollHeight > gate.clientHeight + 1,
      label: btn ? btn.textContent : null,
    };
  });
  await phone.click('.dg-btn');
  const shared = await phone.evaluate(() => window.__shared);
  await ctx.close();
  (g.gate && g.appHidden && !g.editorBooted && editorRequests.length === 0
     && g.title === 'Built forthe desktop' && g.buttonOnScreen && !g.scrolls && phoneErrors.length === 0
     && g.label === 'Share the link'
     && shared.length === 1 && shared[0].url === new globalThis.URL(URL).origin + '/')
    ? pass('gate:phone-never-loads-editor')
    : fail('gate:phone-never-loads-editor', JSON.stringify({ ...g, shared, editorRequests, phoneErrors }));
}

await browser.close();

// Report.
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} passed.`);
const unexpectedErrors = consoleErrors.filter((e) => !expectedConsoleErrors.includes(e));
if (unexpectedErrors.length) { console.log('\nConsole errors seen:'); for (const e of unexpectedErrors) console.log('  • ' + e); }
if (expectedConsoleErrors.length) {
  const n = expectedConsoleErrors.length;
  console.log(`(${n} expected console error${n > 1 ? 's' : ''} from deliberate fixtures, asserted above.)`);
}
process.exit(failed.length ? 1 : 0);
