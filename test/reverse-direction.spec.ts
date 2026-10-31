import { test, expect, type Page } from '@playwright/test';

/**
 * Reverse Path Direction and the Direction tool, driven with real clicks and keys:
 *  - the written point order changes and the picture doesn't, for every shape type
 *    and everything that hangs off a path (width profile, sideways offset, text);
 *  - a closed loop keeps its start, an open path swaps its ends;
 *  - one undo step, no chrome in the document, locked and hidden shapes left alone;
 *  - the tool shows direction on everything, picks forgivingly, reads out how a path
 *    runs, and survives undo and tab switches.
 */

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

/** Add elements (markup in frame-local coords) to the first frame; returns their ids. */
const add = (page: Page, markup: string) => page.evaluate((markup) => {
  const s = (window as unknown as { state: AnyState }).state;
  const frame = document.getElementById(s.artboards[0].id)!;
  const holder = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  holder.innerHTML = markup;
  const ids: string[] = [];
  for (const el of Array.from(holder.children)) { el.id = s.nextId(); ids.push(el.id); frame.appendChild(el); }
  s.rebuildShapesFromDOM();
  s.saveHistory();
  s.onChange_public();
  return ids;
}, markup);

const select = (page: Page, ids: string[]) =>
  page.evaluate((ids) => (window as unknown as { state: AnyState }).state.selectMultiple(ids), ids);
const attr = (page: Page, id: string, name: string) =>
  page.evaluate(([id, name]) => document.getElementById(id)?.getAttribute(name) ?? null, [id, name]);
const tag = (page: Page, id: string) =>
  page.evaluate((id) => document.getElementById(id)?.tagName.toLowerCase() ?? null, id);
const undo = (page: Page) => page.evaluate(() => (window as unknown as { state: AnyState }).state.undo());
const historyLength = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as { state: AnyState }).state;
  let n = 0;
  while (s.canUndo && n < 500) { s.undo(); n++; }
  for (let i = 0; i < n; i++) s.redo();
  return n;
});

/** The screen position `f` of the way along a shape's outline. */
const along = (page: Page, id: string, f: number) => page.evaluate(([id, f]) => {
  const el = document.getElementById(id as string) as unknown as SVGGeometryElement;
  const p = el.getPointAtLength(el.getTotalLength() * (f as number)).matrixTransform(el.getScreenCTM()!);
  return { x: p.x, y: p.y };
}, [id, f] as [string, number]);

/** World points along a shape, walked in its written order. */
const walk = (page: Page, id: string, n = 120) => page.evaluate(([id, n]) => {
  const el = document.getElementById(id as string) as unknown as SVGGeometryElement;
  const L = document.getElementById('drawing-layer') as unknown as SVGGraphicsElement;
  const m = L.getScreenCTM()!.inverse().multiply(el.getScreenCTM()!);
  const len = el.getTotalLength();
  const out: number[][] = [];
  for (let i = 0; i <= (n as number); i++) {
    const p = el.getPointAtLength((len * i) / (n as number)).matrixTransform(m);
    out.push([p.x, p.y]);
  }
  return out;
}, [id, n] as [string, number]);

const CIRCUIT = 'M 100 200 C 100 80 260 60 340 120 C 420 180 500 90 540 170 C 580 260 480 340 380 310 C 280 280 200 360 140 320 Z';
const OPEN = 'M 100 100 C 200 40 300 160 400 100 L 500 180';

test.describe('Reverse Path Direction', () => {
  test('an open path swaps its ends and walks the same curve backwards', async ({ page }) => {
    const errors = await boot(page);
    const [id] = await add(page, `<path d="${OPEN}" fill="none" stroke="#000" stroke-width="3"/>`);
    const before = await walk(page, id);
    await select(page, [id]);
    await page.keyboard.press('Control+Alt+r');
    await expect.poll(() => attr(page, id, 'd')).not.toBe(OPEN);
    expect(await attr(page, id, 'd')).toBe('M 500 180 L 400 100 C 300 160 200 40 100 100');
    const after = await walk(page, id);
    const back = [...after].reverse();
    for (let i = 0; i < before.length; i++) {
      expect(Math.hypot(before[i][0] - back[i][0], before[i][1] - back[i][1])).toBeLessThan(0.05);
    }
    expect(errors).toEqual([]);
  });

  test('a closed loop keeps its start point and runs the other way', async ({ page }) => {
    const errors = await boot(page);
    const [id] = await add(page, `<path d="${CIRCUIT}" fill="none" stroke="#000" stroke-width="3"/>`);
    const before = await walk(page, id);
    await select(page, [id]);
    await page.keyboard.press('Control+Alt+r');
    const after = await walk(page, id);
    expect(Math.hypot(after[0][0] - before[0][0], after[0][1] - before[0][1])).toBeLessThan(0.01);
    // Same start, opposite way round: position i is the old position n − i.
    const n = before.length - 1;
    for (let i = 0; i <= n; i++) {
      expect(Math.hypot(before[i][0] - after[n - i][0], before[i][1] - after[n - i][1])).toBeLessThan(0.05);
    }
    expect(errors).toEqual([]);
  });

  test('reversing twice is the same path, and each is one undo step', async ({ page }) => {
    const errors = await boot(page);
    const [id] = await add(page, `<path d="M0 0 L100 0 L100 100" fill="none" stroke="#000"/>`);
    const steps = await historyLength(page);
    await select(page, [id]);
    await page.keyboard.press('Control+Alt+r');
    expect(await attr(page, id, 'd')).toBe('M 100 100 L 100 0 L 0 0');
    expect(await historyLength(page)).toBe(steps + 1);
    await page.keyboard.press('Control+Alt+r');
    expect(await attr(page, id, 'd')).toBe('M 0 0 L 100 0 L 100 100');
    await undo(page);
    expect(await attr(page, id, 'd')).toBe('M 100 100 L 100 0 L 0 0');
    await undo(page);
    expect(await attr(page, id, 'd')).toBe('M0 0 L100 0 L100 100'); // the very text it started as
    expect(errors).toEqual([]);
  });

  test('lines and polylines stay what they are; a polygon keeps its first point', async ({ page }) => {
    const errors = await boot(page);
    const [line, poly, gon] = await add(page, `
      <line x1="10" y1="20" x2="110" y2="60" stroke="#000"/>
      <polyline points="10,100 60,140 110,100" fill="none" stroke="#000"/>
      <polygon points="200,100 300,100 300,200 200,200" fill="#0af"/>`);
    await select(page, [line, poly, gon]);
    await page.keyboard.press('Control+Alt+r');
    expect(await tag(page, line)).toBe('line');
    expect(await attr(page, line, 'x1')).toBe('110');
    expect(await attr(page, line, 'y2')).toBe('20');
    expect(await tag(page, poly)).toBe('polyline');
    expect(await attr(page, poly, 'points')).toBe('110,100 60,140 10,100');
    expect(await tag(page, gon)).toBe('polygon');
    expect(await attr(page, gon, 'points')).toBe('200,100 200,200 300,200 300,100');
    expect(errors).toEqual([]);
  });

  test('a rect becomes a path — only then can it say which way it runs — and undoes back', async ({ page }) => {
    const errors = await boot(page);
    const [rect, oval] = await add(page, `
      <rect x="50" y="50" width="100" height="60" fill="#fa0" transform="rotate(20 100 80)"/>
      <ellipse cx="300" cy="100" rx="60" ry="40" fill="#0af"/>`);
    await select(page, [rect, oval]);
    await page.keyboard.press('Control+Alt+r');
    expect(await tag(page, rect)).toBe('path');
    expect(await tag(page, oval)).toBe('path');
    expect(await attr(page, rect, 'transform')).toBe('rotate(20 100 80)');
    await expect(page.locator('.toast, #toast, [class*="toast"]').first()).toContainText('point order');
    await undo(page);
    expect(await tag(page, rect)).toBe('rect');
    expect(await tag(page, oval)).toBe('ellipse');
    expect(errors).toEqual([]);
  });

  test('a variable-width stroke keeps its thick end where it was', async ({ page }) => {
    const errors = await boot(page);
    const [id] = await add(page, `<path d="M 100 100 L 500 100" fill="none" stroke="#000" stroke-width="10"/>`);
    await page.evaluate((id) => {
      const s = (window as unknown as { state: AnyState }).state;
      s.setWidthProfile(id, [{ t: 0, w: 40 }, { t: 1, w: 2 }], 10);
    }, id);
    const outline = () => page.evaluate((id) => {
      const r = document.getElementById(id)!.querySelector('[data-width-render]') as unknown as SVGGeometryElement;
      return { d: r.getAttribute('d'), profile: document.getElementById(id)!.getAttribute('data-width-profile') };
    }, id);
    const before = await outline();
    await select(page, [id]);
    await page.keyboard.press('Control+Alt+r');
    const after = await outline();
    expect(JSON.parse(after.profile!)).toEqual([{ t: 0, w: 2 }, { t: 1, w: 40 }]);
    const src = await page.evaluate((id) => document.getElementById(id)!.querySelector('[data-width-src]')!.getAttribute('d'), id);
    expect(src).toBe('M 500 100 L 100 100');
    // The outline is the same shape: same box, thick end still at x = 100.
    const box = (d: string) => {
      const n = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
      const xs = n.filter((_, i) => i % 2 === 0), ys = n.filter((_, i) => i % 2 === 1);
      return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)].map(v => Math.round(v));
    };
    expect(box(after.d!)).toEqual(box(before.d!));
    expect(errors).toEqual([]);
  });

  test('a sideways stroke stays on its side, and so does its on-canvas handle', async ({ page }) => {
    const errors = await boot(page);
    const [id] = await add(page, `<path d="M 200 220 C 280 150 360 290 440 220" fill="none" stroke="#000" stroke-width="2"/>`);
    await page.evaluate(async (id) => {
      const s = (window as unknown as { state: AnyState }).state;
      const dyn = '/src/core/boolean.ts';
      await (await import(/* @vite-ignore */ dyn)).ensureOffsetEngine();
      s.setAppearance(id, [{ t: 'stroke', paint: '#e33', width: 6, offset: 24 }, { t: 'stroke', paint: '#000', width: 2 }]);
      s.selectShape(id);
    }, id);
    const read = () => page.evaluate((id) => {
      const render = document.getElementById(id)!.querySelector('[data-ap][stroke="#e33"]')!; // the offset one
      const hit = document.querySelector('#selection-layer [data-handle="offset-0"]')!;
      const r = hit.getBoundingClientRect();
      return { d: render.getAttribute('d'), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }, id);
    const before = await read();
    await page.keyboard.press('Control+Alt+r');
    const after = await read();
    expect(after).toEqual(before); // the engine saw the same input, so the very same curve
    const layers = await page.evaluate((id) => JSON.parse(document.getElementById(id)!.getAttribute('data-appearance')!), id);
    expect(layers[0].offset).toBe(24); // the panel's number doesn't change either
    await page.keyboard.press('Control+Alt+r');
    expect(await read()).toEqual(before);
    const twice = await page.evaluate((id) => JSON.parse(document.getElementById(id)!.getAttribute('data-appearance')!), id);
    expect(twice[0].offsetReversed).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test('text on the path follows the path, and the Text panel\'s flip stays in step', async ({ page }) => {
    const errors = await boot(page);
    const [pathId, textId] = await add(page, `
      <path d="M 100 200 L 500 200" fill="none" stroke="#000"/>
      <text x="0" y="0" font-size="30" fill="#000">Hello</text>`);
    await select(page, [pathId, textId]);
    await page.evaluate(() => (window as unknown as { state: AnyState }).state.typeTextOnPath());
    await select(page, [pathId]);
    await page.keyboard.press('Control+Alt+r');
    const tp = await page.evaluate((textId) => {
      const t = document.getElementById(textId)!.querySelector('textPath')!;
      return { flip: t.getAttribute('data-flip'), offset: parseFloat(t.getAttribute('startOffset') ?? '0') };
    }, textId);
    expect(tp.flip).toBe('1');
    expect(tp.offset).toBeGreaterThan(50); // text at the old start is now near the new end
    expect(errors).toEqual([]);
  });

  test('a group stands for what is in it, except locked and hidden layers', async ({ page }) => {
    const errors = await boot(page);
    const [g] = await add(page, `
      <g data-name="Set">
        <path d="M 0 0 L 100 0" stroke="#000" fill="none"/>
        <path d="M 0 50 L 100 50" stroke="#000" fill="none" data-locked="true"/>
        <path d="M 0 90 L 100 90" stroke="#000" fill="none" style="display:none"/>
      </g>`);
    const kids = await page.evaluate((g) => {
      const s = (window as unknown as { state: AnyState }).state;
      const group = document.getElementById(g)!;
      const out: string[] = [];
      for (const c of Array.from(group.children)) { c.id = s.nextId(); out.push(c.id); }
      s.rebuildShapesFromDOM();
      s.findShapeById(out[1]).locked || s.toggleLock(out[1]);
      return out;
    }, g);
    await select(page, [g]);
    await page.keyboard.press('Control+Alt+r');
    expect(await attr(page, kids[0], 'd')).toBe('M 100 0 L 0 0');
    expect(await attr(page, kids[1], 'd')).toBe('M 0 50 L 100 50');
    expect(await attr(page, kids[2], 'd')).toBe('M 0 90 L 100 90');
    expect(errors).toEqual([]);
  });

  test('while editing points: the picked point stays picked, and the edit stays live', async ({ page }) => {
    const errors = await boot(page);
    const [id] = await add(page, `<path d="M 100 100 L 200 100 L 300 200" fill="none" stroke="#000"/>`);
    await select(page, [id]);
    await page.keyboard.press('a');
    const picked = await page.evaluate((id) => {
      const s = (window as unknown as { state: AnyState }).state;
      if (s.editingPathId !== id) s.enterPathEdit(id);
      s.pathEdit.selectOnly(0, 0); // (100,100)
      s.onChange_public();
      return s.editingPathId;
    }, id);
    expect(picked).toBe(id);
    await page.keyboard.press('Control+Alt+r');
    const r = await page.evaluate(() => {
      const s = (window as unknown as { state: AnyState }).state;
      const ref = s.pathEdit.selectedRefs()[0];
      const a = s.pathEdit.anchor(ref);
      return { i: ref.i, x: a.x, y: a.y, editing: s.editingPathId };
    });
    expect(r).toEqual({ i: 2, x: 100, y: 100, editing: id });
    expect(await attr(page, id, 'd')).toBe('M 300 200 L 200 100 L 100 100');
    expect(errors).toEqual([]);
  });

  test('reachable from the Path menu, the right-click menu and the path bar', async ({ page }) => {
    const errors = await boot(page);
    const [id] = await add(page, `<path d="M 100 100 L 400 100 L 400 300" fill="none" stroke="#000" stroke-width="4"/>`);
    const forward = 'M 100 100 L 400 100 L 400 300', back = 'M 400 300 L 400 100 L 100 100';

    const p = await along(page, id, 0.3);
    await page.mouse.click(p.x, p.y);
    await page.locator('[data-path-action="reverse"]').click();
    expect(await attr(page, id, 'd')).toBe(back);

    await page.locator('.menu-trigger', { hasText: /^Path$/ }).click();
    await page.locator('.menu-dropdown.open .menu-panel button[data-action="path.reverse"]').click();
    expect(await attr(page, id, 'd')).toBe(forward);

    await page.mouse.click(p.x, p.y, { button: 'right' });
    await page.locator('.context-menu, [class*="context-menu"]').getByText('Reverse Path Direction').click();
    expect(await attr(page, id, 'd')).toBe(back);
    expect(errors).toEqual([]);
  });

  test('a shape with no path of its own turns the command off; in a mix it says why', async ({ page }) => {
    const errors = await boot(page);
    const [txt, path] = await add(page, `
      <text x="100" y="100" font-size="30" fill="#000" data-name="Label">Hi</text>
      <path d="M 100 200 L 400 200" fill="none" stroke="#000"/>`);
    await select(page, [txt]);
    expect(await page.evaluate(() => (window as unknown as { state: AnyState }).state.canReversePaths())).toBe(false);
    const d = await attr(page, path, 'd');
    await page.keyboard.press('Control+Alt+r'); // disabled: nothing happens, nothing throws
    expect(await attr(page, path, 'd')).toBe(d);
    await select(page, [txt, path]);
    await page.keyboard.press('Control+Alt+r');
    expect(await attr(page, path, 'd')).toBe('M 400 200 L 100 200');
    await expect(page.locator('[class*="toast"]').first()).toContainText('“Label” has no path');
    expect(errors).toEqual([]);
  });

  test('what the other app reads changes: the TraceCraft file runs the new way', async ({ page }) => {
    const errors = await boot(page);
    const [circuit, pit] = await add(page, `
      <path d="M 100 100 L 400 100 L 400 300 L 100 300 Z" fill="none" stroke="#000" data-name="Loop"/>
      <path d="M 100 100 L 250 150 L 400 100" fill="none" stroke="#d33" data-name="pit-lane"/>`);
    const file = () => page.evaluate(async (ids) => {
      const s = (window as unknown as { state: AnyState }).state;
      const mod = '/src/core/track-layout.ts';
      const { collectTrackLayouts } = await import(/* @vite-ignore */ mod);
      return collectTrackLayouts(ids.map((id: string) => s.findShapeById(id)), true, () => []).layouts[0].svg as string;
    }, [circuit, pit]);
    expect(await file()).toContain('id="pit-lane" d="M 100 100 L 250 150 L 400 100"');
    await select(page, [pit]);
    await page.keyboard.press('Control+Alt+r');
    expect(await file()).toContain('id="pit-lane" d="M 400 100 L 250 150 L 100 100"'); // entry and exit swap
    await select(page, [circuit]);
    await page.keyboard.press('Control+Alt+r');
    expect(await file()).toContain('d="M 100 100 L 100 300 L 400 300 L 400 100 Z"'); // same start line, other way round
    expect(errors).toEqual([]);
  });

  test('the overlay never reaches the document', async ({ page }) => {
    const errors = await boot(page);
    const [id] = await add(page, `<path d="${CIRCUIT}" fill="none" stroke="#000"/>`);
    await select(page, [id]);
    await page.keyboard.press('r');
    await page.keyboard.press('Control+Alt+r');
    const r = await page.evaluate(() => {
      const docs = (window as unknown as { docs: AnyState }).docs;
      return {
        layer: document.getElementById('drawing-layer')!.innerHTML,
        session: JSON.stringify(docs.serializeSession?.() ?? ''),
      };
    });
    expect(r.layer).not.toContain('data-direction');
    expect(r.session).not.toContain('data-direction');
    expect(errors).toEqual([]);
  });
});

test.describe('Direction tool', () => {
  const flows = (page: Page) => page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-direction-flow]')).map(f => f.getAttribute('data-direction-flow')));

  test('R shows every path; Esc leaves and clears it', async ({ page }) => {
    const errors = await boot(page);
    const ids = await add(page, `
      <path d="${OPEN}" fill="none" stroke="#000"/>
      <path d="${CIRCUIT}" fill="none" stroke="#000"/>`);
    await page.keyboard.press('r');
    await expect.poll(() => flows(page)).toEqual(ids);
    await expect(page.locator('.tool-btn[data-tool="direction"]')).toHaveClass(/active/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.tool-btn[data-tool="select"]')).toHaveClass(/active/);
    await expect.poll(() => flows(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('a click near a line reverses it, without touching the selection', async ({ page }) => {
    const errors = await boot(page);
    const [a, b] = await add(page, `
      <path d="M 100 100 L 500 100" fill="none" stroke="#000"/>
      <path d="M 100 300 L 500 300" fill="none" stroke="#000"/>`);
    await select(page, [b]);
    await page.keyboard.press('r');
    const p = await along(page, a, 0.5);
    await page.mouse.move(p.x, p.y + 6); // near, not on
    await page.mouse.down();
    await page.mouse.up();
    expect(await attr(page, a, 'd')).toBe('M 500 100 L 100 100');
    expect(await attr(page, b, 'd')).toBe('M 100 300 L 500 300');
    expect(await page.evaluate(() => (window as unknown as { state: AnyState }).state.selectedShapeIds)).toEqual([b]);
    expect(errors).toEqual([]);
  });

  test('a click on a filled shape reverses it; a click on nothing does nothing', async ({ page }) => {
    const errors = await boot(page);
    const [id] = await add(page, `<polygon points="100,100 300,100 300,300 100,300" fill="#0af"/>`);
    await page.keyboard.press('r');
    const before = await attr(page, id, 'points');
    const box = await page.evaluate((id) => document.getElementById(id)!.getBoundingClientRect().toJSON(), id);
    await page.mouse.click(box.x + box.width + 200, box.y + box.height + 150);
    expect(await attr(page, id, 'points')).toBe(before);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    expect(await attr(page, id, 'points')).toBe('100,100 100,300 300,300 300,100');
    expect(errors).toEqual([]);
  });

  test('a locked path is left alone, even under the pointer', async ({ page }) => {
    const errors = await boot(page);
    const [id] = await add(page, `<path d="M 100 100 L 500 100" fill="none" stroke="#000" stroke-width="6"/>`);
    await page.evaluate((id) => (window as unknown as { state: AnyState }).state.toggleLock(id), id);
    await page.keyboard.press('r');
    await expect.poll(() => flows(page)).toEqual([]);
    const p = await along(page, id, 0.5);
    await page.mouse.click(p.x, p.y);
    expect(await attr(page, id, 'd')).toBe('M 100 100 L 500 100');
    expect(errors).toEqual([]);
  });

  test('the strip reads out how the hovered path runs, and it changes on the click', async ({ page }) => {
    const errors = await boot(page);
    const [id] = await add(page, `<path d="M 100 100 L 400 100 L 400 300 L 100 300 Z" fill="none" stroke="#000" data-name="Loop"/>`);
    await page.keyboard.press('r');
    const p = await along(page, id, 0.1);
    await page.mouse.move(p.x, p.y);
    const strip = page.locator('#tool-hint');
    await expect(strip).toContainText('Loop');
    await expect(strip).toContainText('clockwise · 4 points');
    await expect(strip).not.toContainText('counterclockwise');
    await page.mouse.down();
    await page.mouse.up();
    await expect(strip).toContainText('counterclockwise · 4 points');
    expect(errors).toEqual([]);
  });

  test('it reads what is on screen: a mirrored path reads the opposite way round', async ({ page }) => {
    const errors = await boot(page);
    const [id] = await add(page, `<path d="M 100 100 L 400 100 L 400 300 L 100 300 Z" fill="none" stroke="#000"
      transform="matrix(-1 0 0 1 700 0)"/>`);
    await page.keyboard.press('r');
    const p = await along(page, id, 0.1);
    await page.mouse.move(p.x, p.y);
    await expect(page.locator('#tool-hint')).toContainText('counterclockwise');
    expect(errors).toEqual([]);
  });

  test('undo in the tool puts the flow back the way it was', async ({ page }) => {
    const errors = await boot(page);
    const [id] = await add(page, `<path d="M 100 100 L 500 100" fill="none" stroke="#000"/>`);
    await page.keyboard.press('r');
    const start = () => page.evaluate((id) => {
      const g = document.querySelector(`[data-direction-flow="${id}"] [data-direction-start]`)!;
      return g.getAttribute('transform')!.match(/translate\(([-\d.]+)/)![1];
    }, id);
    await expect.poll(start).toBeTruthy();
    const x0 = parseFloat(await start());
    const p = await along(page, id, 0.5);
    await page.mouse.click(p.x, p.y);
    await expect.poll(async () => parseFloat(await start())).toBeGreaterThan(x0 + 100);
    await page.keyboard.press('Control+z');
    await expect.poll(async () => parseFloat(await start())).toBeCloseTo(x0, 3);
    expect(errors).toEqual([]);
  });

  test('a reversal in Select plays, then the overlay clears itself', async ({ page }) => {
    const errors = await boot(page);
    const [id] = await add(page, `<path d="M 100 100 L 500 100" fill="none" stroke="#000"/>`);
    await select(page, [id]);
    await page.keyboard.press('Control+Alt+r');
    await expect.poll(() => flows(page)).toEqual([id]);
    await expect.poll(() => flows(page), { timeout: 6000 }).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('prefers-reduced-motion gets the same answer without the comet', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = await boot(page);
    const [id] = await add(page, `<path d="M 100 100 L 500 100" fill="none" stroke="#000"/>`);
    await page.keyboard.press('r');
    const p = await along(page, id, 0.5);
    await page.mouse.click(p.x, p.y);
    expect(await attr(page, id, 'd')).toBe('M 500 100 L 100 100');
    await page.waitForTimeout(150);
    const r = await page.evaluate((id) => {
      const flow = document.querySelector(`[data-direction-flow="${id}"]`)!;
      return { circles: flow.querySelectorAll(':scope > circle').length, chevrons: flow.querySelectorAll('path')[2].getAttribute('d')?.length ?? 0 };
    }, id);
    expect(r.circles).toBe(0);     // no comet head
    expect(r.chevrons).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});
