import { test, expect, type Page } from '@playwright/test';

/**
 * A copy you mean to keep registered with its source — an alternate layout of the
 * same track, a variant of an icon — must be able to land EXACTLY on it:
 *
 *  - ⌘D duplicates in place for every shape type (it used to put a path or group in
 *    place but a rect, ellipse, polygon, line or text 10 units off), and still learns
 *    a step-and-repeat offset once the fresh copy is moved.
 *  - ⌘D on a frame tiles the copy beside it, with a clip named after the copy.
 *  - Paste in Place (⌘⇧V) puts the copy where its source was, even when the
 *    source's frame is gone; ordinary ⌘V still cascades.
 *  - A drag grabbed by an anchor snaps that anchor onto another shape's anchor, so
 *    a TWEAKED copy (whose bounding box no longer matches its source's) can be
 *    dropped back exactly. Box snapping alone left it a fraction of a unit off.
 */

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyState = any;

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });
  return errors;
}

/** World (drawing-layer) top-left of an element's bbox. */
const worldBox = (page: Page, id: string) => page.evaluate((id) => {
  const el = document.getElementById(id) as unknown as SVGGraphicsElement;
  const L = document.getElementById('drawing-layer') as unknown as SVGGraphicsElement;
  const b = el.getBBox();
  const p = new DOMPoint(b.x, b.y).matrixTransform(L.getScreenCTM()!.inverse().multiply(el.getScreenCTM()!));
  return [p.x, p.y];
}, id);

const selectedId = (page: Page) =>
  page.evaluate(() => [...(window as unknown as { state: AnyState }).state.selectedShapeIds][0] as string);

test('⌘D duplicates every shape type in place, then steps by the move you make', async ({ page }) => {
  const errors = await boot(page);
  const ids: string[] = await page.evaluate(() => {
    const s = (window as unknown as { state: AnyState }).state;
    const NS = 'http://www.w3.org/2000/svg';
    const frame = document.getElementById(s.artboards[0].id)!;
    const specs: [string, Record<string, string | number>][] = [
      ['rect', { x: 40, y: 40, width: 50, height: 30 }],
      ['ellipse', { cx: 160, cy: 60, rx: 20, ry: 10 }],
      ['path', { d: 'M 240 40 L 290 40 L 290 80 Z' }],
      ['polygon', { points: '340,40 390,40 360,80' }],
      ['line', { x1: 440, y1: 40, x2: 490, y2: 80 }],
      ['text', { x: 540, y: 60 }],
    ];
    const out: string[] = [];
    for (const [tag, at] of specs) {
      const el = document.createElementNS(NS, tag);
      el.id = s.nextId();
      for (const [k, v] of Object.entries(at)) el.setAttribute(k, String(v));
      if (tag === 'text') el.textContent = 'Hi';
      el.setAttribute('stroke', '#000');
      frame.appendChild(el);
      out.push(el.id);
    }
    const g = document.createElementNS(NS, 'g');
    g.id = s.nextId();
    const c = document.createElementNS(NS, 'rect');
    c.id = s.nextId();
    for (const [k, v] of Object.entries({ x: 40, y: 140, width: 20, height: 20 })) c.setAttribute(k, String(v));
    g.appendChild(c);
    frame.appendChild(g);
    out.push(g.id);
    s.rebuildShapesFromDOM();
    s.saveHistory();
    return out;
  });

  for (const id of ids) {
    await page.evaluate((id) => (window as unknown as { state: AnyState }).state.selectMultiple([id]), id);
    const before = await worldBox(page, id);
    await page.keyboard.press('Control+d');
    const copy = await selectedId(page);
    expect(copy, `⌘D on ${id} selects a new shape`).not.toBe(id);
    const after = await worldBox(page, copy);
    expect(after[0], `${id} copy x`).toBeCloseTo(before[0], 6);
    expect(after[1], `${id} copy y`).toBeCloseTo(before[1], 6);
  }

  // Step and repeat: move the fresh copy (a real drag, snapping off), ⌘D repeats it.
  // A shape of its own, so the copies above aren't stacked under the pointer.
  const src: string = await page.evaluate(() => {
    const s = (window as unknown as { state: AnyState }).state;
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.id = s.nextId();
    for (const [k, v] of Object.entries({ x: 300, y: 300, width: 60, height: 40, fill: '#39f' })) r.setAttribute(k, String(v));
    document.getElementById(s.artboards[0].id)!.appendChild(r);
    s.rebuildShapesFromDOM();
    s.saveHistory();
    s.snapEnabled = false;
    s.selectMultiple([r.id]);
    return r.id;
  });
  await page.keyboard.press('Control+d');
  const first = await selectedId(page);
  const r = await page.locator(`#${first}`).boundingBox();
  await page.mouse.move(r!.x + r!.width / 2, r!.y + r!.height / 2);
  await page.mouse.down();
  await page.mouse.move(r!.x + r!.width / 2 + 40, r!.y + r!.height / 2 + 15, { steps: 8 });
  await page.mouse.up();
  const p0 = await worldBox(page, src);
  const p1 = await worldBox(page, first);
  await page.keyboard.press('Control+d');
  const p2 = await worldBox(page, await selectedId(page));
  expect(p1[0] - p0[0]).toBeGreaterThan(1);
  expect(p2[0] - p1[0]).toBeCloseTo(p1[0] - p0[0], 6);
  expect(p2[1] - p1[1]).toBeCloseTo(p1[1] - p0[1], 6);

  expect(errors).toEqual([]);
});

test('⌘D on a frame tiles the copy beside it with its own clip', async ({ page }) => {
  const errors = await boot(page);
  const fid = await page.evaluate(() => (window as unknown as { state: AnyState }).state.artboards[0].id as string);
  await page.evaluate((id) => (window as unknown as { state: AnyState }).state.selectMultiple([id]), fid);
  await page.keyboard.press('Control+d');
  const r = await page.evaluate(() => {
    const s = (window as unknown as { state: AnyState }).state;
    const [a, b] = s.artboards;
    return {
      n: s.artboards.length,
      overlap: b.x < a.x + a.width && a.x < b.x + b.width && b.y < a.y + a.height && a.y < b.y + b.height,
      clips: [...document.querySelectorAll('#drawing-layer g[data-frame] > clipPath')]
        .map(c => [c.id, c.parentElement!.id.replace('shape-', '')]),
    };
  });
  expect(r.n).toBe(2);
  expect(r.overlap).toBe(false);
  for (const [clip, num] of r.clips) expect(clip).toBe(`frameclip-${num}`);
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => (window as unknown as { state: AnyState }).state.artboards.length)).toBe(1);
  expect(errors).toEqual([]);
});

test('Paste in Place lands on the source; ⌘V still cascades', async ({ page }) => {
  const errors = await boot(page);
  const src = await page.evaluate(() => {
    const s = (window as unknown as { state: AnyState }).state;
    const NS = 'http://www.w3.org/2000/svg';
    const p = document.createElementNS(NS, 'path');
    p.id = s.nextId();
    p.setAttribute('d', 'M 60 60 C 90 20 140 20 170 70 L 120 150 Z');
    p.setAttribute('stroke', '#f60');
    document.getElementById(s.artboards[0].id)!.appendChild(p);
    s.rebuildShapesFromDOM();
    s.saveHistory();
    s.selectMultiple([p.id]);
    return p.id;
  });
  const at = await worldBox(page, src);
  await page.keyboard.press('Control+c');

  await page.keyboard.press('Control+Shift+v');
  const inPlace = await selectedId(page);
  expect(inPlace).not.toBe(src);
  expect(await worldBox(page, inPlace)).toEqual(at);
  expect(await page.evaluate((id) => document.getElementById(id)!.parentElement!.id, inPlace))
    .toBe(await page.evaluate((id) => document.getElementById(id)!.parentElement!.id, src));

  await page.keyboard.press('Control+v');
  const cascaded = await worldBox(page, await selectedId(page));
  expect(cascaded[0]).toBeCloseTo(at[0] + 10, 6);
  expect(cascaded[1]).toBeCloseTo(at[1] + 10, 6);

  // The menu route (no native paste event) does the same.
  await page.evaluate(() => (window as unknown as { state: AnyState }).state.pasteClipboard(true));
  expect(await worldBox(page, await selectedId(page))).toEqual(at);
  expect(errors).toEqual([]);
});

test('Paste in Place keeps the position when the source frame is gone', async ({ page }) => {
  const errors = await boot(page);
  const { src, at } = await page.evaluate(() => {
    const s = (window as unknown as { state: AnyState }).state;
    const NS = 'http://www.w3.org/2000/svg';
    // A second frame, away from the origin, holding the shape.
    const far = { id: s.addFrame(1200, 300, 400, 300, 'Far') as string };
    const p = document.createElementNS(NS, 'path');
    p.id = s.nextId();
    p.setAttribute('d', 'M 20 20 L 120 20 L 70 90 Z');
    p.setAttribute('stroke', '#f60');
    document.getElementById(far.id)!.appendChild(p);
    s.rebuildShapesFromDOM();
    s.saveHistory();
    s.selectMultiple([p.id]);
    s.copySelected();
    const L = document.getElementById('drawing-layer') as unknown as SVGGraphicsElement;
    const b = (p as unknown as SVGGraphicsElement).getBBox();
    const q = new DOMPoint(b.x, b.y).matrixTransform(L.getScreenCTM()!.inverse().multiply((p as unknown as SVGGraphicsElement).getScreenCTM()!));
    // Delete the frame (and the shape with it).
    s.selectMultiple([far.id]);
    s.removeSelected();
    return { src: p.id, at: [q.x, q.y] };
  });
  expect(await page.evaluate((id) => !!document.getElementById(id), src)).toBe(false);
  await page.evaluate(() => (window as unknown as { state: AnyState }).state.pasteClipboard(true));
  const got = await worldBox(page, await selectedId(page));
  expect(got[0]).toBeCloseTo(at[0], 6);
  expect(got[1]).toBeCloseTo(at[1], 6);
  expect(errors).toEqual([]);
});

test('a tweaked copy dragged back by an anchor lands exactly on its source', async ({ page }) => {
  const errors = await boot(page);
  // The copy's last curve pulls further out, so its bbox is not the source's.
  const SRC = 'M 100 200 C 140 120 200 120 260 160 C 320 200 360 260 300 300 C 240 340 140 320 100 200 Z';
  const TWEAK = 'M 100 200 C 140 120 200 120 260 160 C 320 200 360 260 300 300 C 240 340 80 340 100 200 Z';
  const OFF = [37.3, 21.7];

  const setup = () => page.evaluate(({ SRC, TWEAK, OFF }) => {
    const s = (window as unknown as { state: AnyState }).state;
    const NS = 'http://www.w3.org/2000/svg';
    const frame = document.getElementById(s.artboards[0].id)!;
    frame.querySelectorAll(':scope > g[data-name]').forEach(g => g.remove());
    const mk = (d: string, dx: number, dy: number, name: string) => {
      const g = document.createElementNS(NS, 'g');
      g.id = s.nextId();
      g.setAttribute('data-name', name);
      if (dx || dy) g.setAttribute('transform', `translate(${dx} ${dy})`);
      const p = document.createElementNS(NS, 'path');
      p.id = s.nextId();
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', '#f60');
      p.setAttribute('stroke-width', '3');
      g.appendChild(p);
      frame.appendChild(g);
      return p.id;
    };
    const a = mk(SRC, 0, 0, 'Source');
    const b = mk(TWEAK, OFF[0], OFF[1], 'Copy');
    s.rebuildShapesFromDOM();
    s.saveHistory();
    return { a, b };
  }, { SRC, TWEAK, OFF });

  const toScreen = (x: number, y: number) => page.evaluate(([x, y]) => {
    const L = document.getElementById('drawing-layer') as unknown as SVGGraphicsElement;
    const p = new DOMPoint(x, y).matrixTransform(L.getScreenCTM()!);
    return [p.x, p.y];
  }, [x, y]);
  const anchors = (id: string) => page.evaluate((id) => {
    const el = document.getElementById(id) as unknown as SVGGraphicsElement;
    const L = document.getElementById('drawing-layer') as unknown as SVGGraphicsElement;
    const m = L.getScreenCTM()!.inverse().multiply(el.getScreenCTM()!);
    const n = el.getAttribute('d')!.match(/-?\d*\.?\d+/g)!.map(Number);
    const out: number[][] = [];
    for (let i = 0; i + 1 < n.length; i += 2) {
      const p = new DOMPoint(n[i], n[i + 1]).matrixTransform(m);
      out.push([p.x, p.y]);
    }
    return out;
  }, id);
  /** Largest gap between source and copy over the points the tweak left alone. */
  const drift = async (a: string, b: string) => {
    const A = await anchors(a), B = await anchors(b);
    return Math.max(...[0, 1, 2, 3, 4, 5, 6, 7, 9].map(i => Math.hypot(B[i][0] - A[i][0], B[i][1] - A[i][1])));
  };
  const drag = async (from: number[], to: number[]) => {
    const s0 = await toScreen(from[0], from[1]);
    const s1 = await toScreen(to[0], to[1]);
    await page.mouse.move(s0[0], s0[1]);
    await page.mouse.down();
    // Let go 3 screen px off the target, as a hand does.
    await page.mouse.move(s1[0] + 2.5, s1[1] - 2, { steps: 12 });
    const guides = await page.locator('[data-snap-guide]').count();
    await page.mouse.up();
    return guides;
  };

  // Grabbed by the anchor at (300,300): it snaps onto the source's (300,300).
  let { a, b } = await setup();
  const guides = await drag([300 + OFF[0], 300 + OFF[1]], [300, 300]);
  expect(guides, 'a point snap draws its marker').toBeGreaterThan(0);
  expect(await drift(a, b)).toBeLessThan(1e-6);
  await page.keyboard.press('Control+z');
  expect(await drift(a, b)).toBeCloseTo(Math.hypot(OFF[0], OFF[1]), 6);
  await page.keyboard.press('Control+Shift+z');
  expect(await drift(a, b)).toBeLessThan(1e-6);

  // Grabbed mid-stroke, there is no anchor to snap — only box alignment, which
  // can't register shapes whose boxes differ (the drift this feature exists for).
  ({ a, b } = await setup());
  const mid = await page.evaluate((id) => {
    const el = document.getElementById(id) as unknown as SVGPathElement;
    const L = document.getElementById('drawing-layer') as unknown as SVGGraphicsElement;
    const p = el.getPointAtLength(el.getTotalLength() * 0.62)
      .matrixTransform(L.getScreenCTM()!.inverse().multiply(el.getScreenCTM()!));
    return [p.x, p.y];
  }, b);
  await drag(mid, [mid[0] - OFF[0], mid[1] - OFF[1]]);
  expect(await drift(a, b)).toBeGreaterThan(0.1);

  expect(errors).toEqual([]);
});
