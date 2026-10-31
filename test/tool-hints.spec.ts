import { test, expect, type Page } from '@playwright/test';

/**
 * Discoverability: the tool-hint strip at the top of the canvas and the contextual
 * popovers say what the current selection can do. Point editing and Join had no
 * on-screen sign at all — the one thing most people want to do with a path, and
 * the thing two selected end points are for. Driven with the real controls: the
 * popover buttons, the strip's own Join button, anchor clicks, the toolbar, the
 * View menu.
 *
 * Geometry sits at frame-local x ≥ 200: at the default 1280px viewport the frame
 * overhangs the left panel, and a point under the panel can't be clicked.
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
  const reId = (el: Element) => {
    if (el.tagName.toLowerCase() !== 'g' || el.hasAttribute('data-name')) { el.id = s.nextId(); ids.push(el.id); }
    for (const c of Array.from(el.children)) reId(c);
  };
  for (const el of Array.from(holder.children)) { reId(el); frame.appendChild(el); }
  s.rebuildShapesFromDOM();
  s.saveHistory();
  return ids;
}, markup);

const select = (page: Page, ids: string[]) =>
  page.evaluate((ids) => (window as unknown as { state: AnyState }).state.selectMultiple(ids), ids);

/** The strip's text, or '' while it is hidden. */
const hint = (page: Page) => page.evaluate(() => {
  const el = document.getElementById('tool-hint');
  return el && !el.hidden ? (el.textContent ?? '') : '';
});

const tool = (page: Page) => page.evaluate(() => (window as unknown as { state: AnyState }).state.currentTool as string);
const dOf = (page: Page, id: string) => page.evaluate((id) => document.getElementById(id)?.getAttribute('d') ?? '', id);
const OPEN_PATH = '<path d="M 260 60 L 460 60 L 460 220" fill="none" stroke="#06c" stroke-width="3"/>';

const centre = async (page: Page, id: string) => {
  const r = (await page.locator(`#${id}`).boundingBox())!;
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};

test('a selected path teaches point editing; the bar offers it; the edit walks you to Join', async ({ page }) => {
  const errors = await boot(page);
  const [id] = await add(page, OPEN_PATH);
  await select(page, [id]);
  await expect.poll(() => hint(page)).toContain('edit points');
  expect(await hint(page)).toContain('close path'); // ⌘J closes an open path

  const edit = page.locator('#path-actions-popover [data-path-action="edit-points"]');
  await expect(edit).toBeVisible();
  await edit.click();
  expect(await page.evaluate(() => {
    const s = (window as unknown as { state: AnyState }).state;
    return { tool: s.currentTool, editing: s.editingPathId };
  })).toEqual({ tool: 'directSelect', editing: id });

  // Idle in the edit: how to pick points, and that ⌘J closes the path.
  expect(await hint(page)).toContain('select a point');
  expect(await hint(page)).toContain('close path');

  // One end picked on a single run: ⌘J closes it right now — said, and offered.
  await page.locator('[data-node-anchor="0:0"]').click();
  await expect.poll(() => hint(page)).toContain('close path');
  await expect(page.locator('#tool-hint button.accent')).toHaveCount(1);
  // A point in the middle is not an end: no join talk.
  await page.locator('[data-node-anchor="0:1"]').click();
  await expect.poll(() => hint(page)).not.toContain('close path');
  expect(await hint(page)).not.toContain('join');
  // Both ends picked: the Join chip is a button — click it.
  await page.locator('[data-node-anchor="0:0"]').click();
  await page.locator('[data-node-anchor="0:2"]').click({ modifiers: ['Shift'] });
  await expect.poll(() => hint(page)).toContain('close path');
  await page.locator('#tool-hint button.accent').click();
  expect((await dOf(page, id)).trim().endsWith('Z')).toBe(true);
  // Closed now: nothing left to join, and the edit hands back to Select on Esc.
  expect(await hint(page)).not.toContain('close path');
  await page.keyboard.press('Escape');
  await expect.poll(() => tool(page)).toBe('select');
  expect(await hint(page)).toContain('edit points');
  expect(await hint(page)).not.toContain('close path');
  expect(errors).toEqual([]);
});

test('a compound path: one end says which end to add, two ends say "join ends"', async ({ page }) => {
  const errors = await boot(page);
  const [id] = await add(page, '<path d="M 260 60 L 400 60 M 260 200 L 400 200" fill="none" stroke="#06c" stroke-width="3"/>');
  await select(page, [id]);
  await page.locator('#path-actions-popover [data-path-action="edit-points"]').click();
  await page.locator('[data-node-anchor="0:1"]').click();
  await expect.poll(() => hint(page)).toContain('another run');
  await page.locator('[data-node-anchor="1:0"]').click({ modifiers: ['Shift'] });
  await expect.poll(() => hint(page)).toContain('join ends');
  await page.keyboard.press('Control+j');
  expect(((await dOf(page, id)).match(/M/g) ?? []).length).toBe(1);
  expect(errors).toEqual([]);
});

test('two open paths: the strip says join, and the Pathfinder bar leads with it', async ({ page }) => {
  const errors = await boot(page);
  const [a, b] = await add(page, `
    <path d="M 260 60 L 400 120" fill="none" stroke="#06c" stroke-width="3"/>
    <path d="M 420 130 L 560 60" fill="none" stroke="#c60" stroke-width="3"/>`);
  await select(page, [a, b]);
  await expect.poll(() => hint(page)).toContain('join the two paths');
  await expect(page.locator('#tool-hint button.accent')).toHaveCount(1);
  const join = page.locator('#pf-pop-join');
  await expect(join).toBeVisible();
  await expect(page.locator('#pathfinder-popover')).toHaveClass(/join-first/);
  await join.click();
  const left = await page.evaluate(() => (window as unknown as { state: AnyState }).state.shapes[0].children.length);
  expect(left).toBe(1);
  expect(errors).toEqual([]);
});

test('nothing selected and several selected teach the basics', async ({ page }) => {
  const errors = await boot(page);
  const ids = await add(page, `
    <rect x="260" y="60" width="80" height="60" fill="#9c6"/>
    <rect x="360" y="60" width="80" height="60" fill="#69c"/>
    <rect x="460" y="60" width="80" height="60" fill="#c69"/>`);
  await select(page, []);
  await expect.poll(() => hint(page)).toContain('box-select');
  await select(page, ids);
  await expect.poll(() => hint(page)).toContain('group');
  expect(errors).toEqual([]);
});

test('a group teaches double-click to enter and Esc to leave; a path inside keeps its bar', async ({ page }) => {
  const errors = await boot(page);
  const [g, r, p, t] = await add(page, `
    <g data-name="Pair"><rect x="260" y="60" width="120" height="80" fill="#9c6"/><path d="M 420 60 L 560 60 L 560 140" fill="none" stroke="#69c" stroke-width="3"/></g>
    <text x="300" y="300" font-size="28">Hello</text>`);
  await select(page, [g]);
  await expect.poll(() => hint(page)).toContain('select an item inside');
  const c = await centre(page, r);
  await page.mouse.dblclick(c.x, c.y);
  await expect.poll(() => hint(page)).toContain('step back out');
  // A path inside the entered group: its points are still the headline, and the
  // bar is still there to click.
  await select(page, [p]);
  await expect.poll(() => hint(page)).toContain('edit points');
  expect(await hint(page)).toContain('step back out');
  await expect(page.locator('#path-actions-popover [data-path-action="edit-points"]')).toBeVisible();
  // Esc steps out — the group lives in a frame, which is the top.
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => (window as unknown as { state: AnyState }).state.activeGroupId)).toBeNull();
  await select(page, [t]);
  await expect.poll(() => hint(page)).toContain('edit text');
  expect(errors).toEqual([]);
});

test('typing into a text shows how to finish, not how to place text', async ({ page }) => {
  const errors = await boot(page);
  const [t] = await add(page, '<text x="300" y="300" font-size="28">Hello</text>');
  await select(page, [t]);
  const c = await centre(page, t);
  await page.mouse.dblclick(c.x, c.y);
  await expect(page.locator('textarea[data-text-editor]')).toHaveCount(1);
  await expect.poll(() => hint(page)).toContain('new line');
  expect(await hint(page)).not.toContain('point text');
  await page.keyboard.press('Escape');
  await expect(page.locator('textarea[data-text-editor]')).toHaveCount(0);
  await expect.poll(() => tool(page)).toBe('select');
  expect(errors).toEqual([]);
});

test('a shape tool: the strip shows the modifiers, the drag lights them, the bar lands with the shape', async ({ page }) => {
  const errors = await boot(page);
  const box = (await page.locator('#svg-canvas').boundingBox())!;
  await page.click('[data-tool="rect"]');
  await expect.poll(() => hint(page)).toContain('square'); // the drag's own chips, at rest
  await page.mouse.move(box.x + 420, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 470, box.y + 350, { steps: 6 });
  // Mid-drag the SAME strip is in gesture style, and a held Shift lights its chip.
  const strip = page.locator('#tool-hint.gesturing');
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('square');
  await page.keyboard.down('Shift');
  await expect(page.locator('#tool-hint .gesture-hud-chip.active')).toHaveCount(1);
  await page.keyboard.up('Shift');
  await page.mouse.up();
  await expect.poll(() => tool(page)).toBe('select');
  await expect(page.locator('#tool-hint.gesturing')).toHaveCount(0);
  // No click after the draw: the bar is already up.
  await expect(page.locator('#path-actions-popover')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the bar never covers the strip: near the top it flips below the selection', async ({ page }) => {
  const errors = await boot(page);
  // Right under the top edge of the frame, where "above the selection" is the strip's band.
  const [id] = await add(page, '<path d="M 300 10 L 500 10 L 500 130" fill="none" stroke="#06c" stroke-width="3"/>');
  await select(page, [id]);
  await expect(page.locator('#path-actions-popover')).toBeVisible();
  await expect.poll(() => hint(page)).toContain('edit points');
  const [bar, strip, shape] = await Promise.all([
    page.locator('#path-actions-popover').boundingBox(), page.locator('#tool-hint').boundingBox(), page.locator(`#${id}`).boundingBox(),
  ]);
  const overlap = bar!.y < strip!.y + strip!.height && bar!.y + bar!.height > strip!.y;
  expect(overlap).toBe(false);
  expect(bar!.y).toBeGreaterThan(shape!.y); // it went below rather than onto the strip
  expect(errors).toEqual([]);
});

test('the pen offers to close only once three points could enclose something', async ({ page }) => {
  const errors = await boot(page);
  const box = (await page.locator('#svg-canvas').boundingBox())!;
  await page.click('[data-tool="pen"]');
  await page.mouse.click(box.x + 420, box.y + 300);
  await page.mouse.move(box.x + 500, box.y + 260);
  await expect.poll(() => hint(page)).not.toContain('close');
  // Clicking the start point with one point down is nothing — the path survives.
  await page.mouse.click(box.x + 420, box.y + 300);
  await page.mouse.click(box.x + 520, box.y + 240);
  await page.mouse.move(box.x + 560, box.y + 300);
  await expect.poll(() => hint(page)).not.toContain('close');
  await page.mouse.click(box.x + 620, box.y + 320);
  await page.mouse.move(box.x + 560, box.y + 340);
  await expect.poll(() => hint(page)).toContain('close');
  await page.mouse.click(box.x + 420, box.y + 300); // the start point: closes
  await expect.poll(() => tool(page)).toBe('select');
  const d = await page.evaluate(() => (window as unknown as { state: AnyState }).state.getSelectedShape()?.element.getAttribute('d') ?? '');
  expect(d.trim().endsWith('Z')).toBe(true);
  expect(errors).toEqual([]);
});

test('a jittery click never swaps the strip for the drag chips', async ({ page }) => {
  const errors = await boot(page);
  const [id] = await add(page, OPEN_PATH);
  await select(page, [id]);
  await expect.poll(() => hint(page)).toContain('edit points');
  // A point ON the stroke of the right edge, clear of the handles (the element's
  // bounding box pads the geometry, so it is mapped through the CTM instead).
  const at = await page.evaluate((id) => {
    const el = document.getElementById(id) as unknown as SVGGraphicsElement;
    const p = new DOMPoint(460, 100).matrixTransform(el.getScreenCTM()!);
    return { x: p.x, y: p.y };
  }, id);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 1, at.y);
  await expect(page.locator('#tool-hint.gesturing')).toHaveCount(0);
  expect(await hint(page)).toContain('edit points');
  await page.mouse.move(at.x + 40, at.y + 30, { steps: 4 });
  await expect(page.locator('#tool-hint.gesturing')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator('#tool-hint.gesturing')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Shape Builder with one shape says what it needs; with two it says what to do; Esc leaves', async ({ page }) => {
  const errors = await boot(page);
  const [a, b] = await add(page, `
    <rect x="260" y="60" width="160" height="120" fill="#9c6"/>
    <ellipse cx="420" cy="120" rx="90" ry="70" fill="#69c"/>`);
  await select(page, [a]);
  await page.click('[data-tool="shapeBuilder"]');
  await expect.poll(() => hint(page)).toContain('2+ overlapping shapes');
  await page.keyboard.press('Escape'); // Esc leaves even with nothing to build
  await expect.poll(() => tool(page)).toBe('select');
  await select(page, [a, b]);
  await page.click('[data-tool="shapeBuilder"]');
  await expect.poll(() => hint(page), { timeout: 20_000 }).toContain('merge pieces');
  await page.keyboard.press('Escape');
  await expect.poll(() => tool(page)).toBe('select');
  expect(errors).toEqual([]);
});

test('View ▸ Show Tool Hints switches the strip off, and it stays off', async ({ page }) => {
  const errors = await boot(page);
  const [id] = await add(page, OPEN_PATH);
  await select(page, [id]);
  await expect.poll(() => hint(page)).toContain('edit points');
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: /Show Tool Hints/ }).click();
  await expect(page.locator('#tool-hint')).toBeHidden();
  // Off means off: a drag shows no gesture chips either.
  const box = (await page.locator('#svg-canvas').boundingBox())!;
  await page.click('[data-tool="rect"]');
  await page.mouse.move(box.x + 420, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 470, box.y + 350, { steps: 6 });
  await expect(page.locator('#tool-hint')).toBeHidden();
  await page.mouse.up();
  await page.keyboard.press('Delete'); // the rectangle was only a probe
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state);
  const [id2] = await add(page, OPEN_PATH);
  await select(page, [id2]);
  await expect(page.locator('#path-actions-popover')).toBeVisible(); // the bar is not a hint
  await expect(page.locator('#tool-hint')).toBeHidden();
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: /Show Tool Hints/ }).click();
  await expect.poll(() => hint(page)).toContain('edit points');
  expect(errors).toEqual([]);
});
