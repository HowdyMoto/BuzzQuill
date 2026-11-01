import { test, expect, type Page } from '@playwright/test';

/**
 * A point edit entered by double-clicking in the Selection tool hands control back
 * to Select however it ends. Only the node tool's own exits (Esc, click-away) used
 * to: picking a layer in the Layers panel or undoing ended the edit but left the
 * node tool active with nothing to edit — no toolbar button lit, and a press there
 * only selects. A raster pasted next came in selected, handles and all, yet a drag
 * neither moved nor resized it, and only a reload (which boots into Select) cured it.
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

/** Two filled paths in the first frame, committed as one undo step. */
const addTwoPaths = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as { state: AnyState }).state;
  const NS = 'http://www.w3.org/2000/svg';
  const frame = document.querySelector('[data-frame]')!;
  const ids: string[] = [];
  for (const [x, name] of [[40, 'Track A'], [400, 'Track B']] as const) {
    const p = document.createElementNS(NS, 'path');
    p.id = s.nextId();
    p.setAttribute('data-name', name);
    p.setAttribute('d', `M ${x} 40 L ${x + 200} 40 L ${x + 200} 160 L ${x} 160 Z`);
    p.setAttribute('fill', '#9c6');
    frame.appendChild(p);
    ids.push(p.id);
  }
  s.rebuildShapesFromDOM();
  s.saveHistory();
  s.notify();
  return ids;
});

const centreOf = (page: Page, id: string) => page.evaluate((id) => {
  const r = document.getElementById(id)!.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, id);

/** The live tool, as the model and as the toolbar show it. */
const toolState = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as { state: AnyState }).state;
  return {
    tool: s.currentTool as string,
    editing: s.editingPathId as string | null,
    lit: [...document.querySelectorAll('.tool-btn.active')].map(b => b.getAttribute('data-tool')),
  };
});

/** Double-click a path in the Selection tool: its points open in the node tool. */
async function enterPointEdit(page: Page, id: string): Promise<void> {
  const c = await centreOf(page, id);
  await page.mouse.dblclick(c.x, c.y);
  await expect.poll(() => toolState(page)).toEqual({ tool: 'directSelect', editing: id, lit: [] });
}

const BACK_IN_SELECT = { tool: 'select', editing: null, lit: ['select'] };

/** Paste a real PNG with Ctrl+V and drag it; returns how far its x moved. */
async function pasteAndDrag(page: Page): Promise<number> {
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 300; c.height = 200;
    const g = c.getContext('2d')!;
    g.fillStyle = '#36c'; g.fillRect(0, 0, 300, 200);
    const blob = await new Promise<Blob>(r => c.toBlob(b => r(b!), 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  });
  await page.keyboard.press('Control+V');
  await page.waitForSelector('#drawing-layer image');
  const id = await page.evaluate(() => document.querySelector('#drawing-layer image')!.id);
  const x0 = await page.evaluate((id) => document.getElementById(id)!.getBoundingClientRect().x, id);
  const c = await centreOf(page, id);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 50, c.y + 30, { steps: 8 });
  await page.mouse.up();
  const x1 = await page.evaluate((id) => document.getElementById(id)!.getBoundingClientRect().x, id);
  return x1 - x0;
}

test('picking a layer in the Layers panel ends a point edit back in Select', async ({ page }) => {
  const errors = await boot(page);
  const [a] = await addTwoPaths(page);
  await enterPointEdit(page, a);

  await page.locator('.layer-item', { hasText: 'Track B' }).first().click();
  expect(await toolState(page)).toEqual(BACK_IN_SELECT);

  // The symptom: a raster pasted next must move like any other.
  expect(await pasteAndDrag(page)).toBeGreaterThan(40);
  expect(errors).toEqual([]);
});

test('an undo that ends a point edit lands back in Select', async ({ page }) => {
  const errors = await boot(page);
  const [a] = await addTwoPaths(page);
  await enterPointEdit(page, a);

  await page.keyboard.press('Control+Z'); // the edited path didn't exist one step back
  expect(await toolState(page)).toEqual(BACK_IN_SELECT);

  expect(await pasteAndDrag(page)).toBeGreaterThan(40);
  expect(errors).toEqual([]);
});

test('Esc and a click on empty canvas still return to Select', async ({ page }) => {
  const errors = await boot(page);
  const [a] = await addTwoPaths(page);

  await enterPointEdit(page, a);
  await page.keyboard.press('Escape');
  expect(await toolState(page)).toEqual(BACK_IN_SELECT);

  await enterPointEdit(page, a);
  const box = await page.locator('#svg-canvas').boundingBox();
  await page.mouse.click(box!.x + 20, box!.y + box!.height - 20); // pasteboard
  expect(await toolState(page)).toEqual(BACK_IN_SELECT);
  expect(errors).toEqual([]);
});

test('switching tools mid-edit goes to the tool picked, once', async ({ page }) => {
  const errors = await boot(page);
  const [a] = await addTwoPaths(page);
  await enterPointEdit(page, a);

  await page.locator('.tool-btn[data-tool="rect"]').click();
  expect(await toolState(page)).toEqual({ tool: 'rect', editing: null, lit: ['rect'] });
  expect(await page.evaluate(() => (window as unknown as { state: AnyState }).state.nodeEditReturnTool)).toBeNull();
  expect(errors).toEqual([]);
});

test('a node tool picked directly stays put when its edit ends', async ({ page }) => {
  const errors = await boot(page);
  const [a] = await addTwoPaths(page);
  await page.locator('#svg-canvas').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('a'); // Direct Selection, no double-click entry
  const c = await centreOf(page, a);
  await page.mouse.dblclick(c.x, c.y);
  await expect.poll(async () => (await toolState(page)).editing).toBe(a);

  await page.locator('.layer-item', { hasText: 'Track B' }).first().click();
  expect(await toolState(page)).toEqual({ tool: 'directSelect', editing: null, lit: [] });
  expect(errors).toEqual([]);
});

/** Hold Space and let go, as a pan does. `during` runs while it's held. */
async function springPan(page: Page, during?: () => Promise<void>): Promise<void> {
  await page.keyboard.down(' ');
  await expect.poll(async () => (await toolState(page)).tool).toBe('hand');
  await during?.();
  await page.keyboard.up(' ');
}

test('a pan mid-edit keeps the edit, and it still ends back in Select', async ({ page }) => {
  const errors = await boot(page);
  const [a] = await addTwoPaths(page);

  await enterPointEdit(page, a);
  await springPan(page);
  expect(await toolState(page)).toEqual({ tool: 'directSelect', editing: a, lit: [] });
  await page.keyboard.press('Escape');
  expect(await toolState(page)).toEqual(BACK_IN_SELECT);

  await enterPointEdit(page, a);
  await springPan(page);
  await page.locator('#svg-canvas').click({ position: { x: 20, y: 20 } });
  expect(await toolState(page)).toEqual(BACK_IN_SELECT);
  expect(errors).toEqual([]);
});

test('a pan that leaves nothing to edit lands in Select', async ({ page }) => {
  const errors = await boot(page);
  const [a] = await addTwoPaths(page);
  await enterPointEdit(page, a);

  // The frame can't be point-edited, so there is no edit to reopen on release.
  await springPan(page, () => page.locator('.layer-item', { hasText: 'Frame' }).first().click());
  expect(await toolState(page)).toEqual(BACK_IN_SELECT);
  expect(errors).toEqual([]);
});

test('a pan in a node tool picked directly stays in it', async ({ page }) => {
  const errors = await boot(page);
  const [a] = await addTwoPaths(page);
  await page.locator('#svg-canvas').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('a');
  const c = await centreOf(page, a);
  await page.mouse.dblclick(c.x, c.y);
  await expect.poll(async () => (await toolState(page)).editing).toBe(a);

  await springPan(page);
  expect(await toolState(page)).toEqual({ tool: 'directSelect', editing: a, lit: [] });
  await page.keyboard.press('Escape');
  expect(await toolState(page)).toEqual({ tool: 'directSelect', editing: null, lit: [] });
  expect(errors).toEqual([]);
});

test('a new tab ends the edit back in Select, and the new document works', async ({ page }) => {
  const errors = await boot(page);
  const [a] = await addTwoPaths(page);
  await enterPointEdit(page, a);

  await page.locator('#tab-new').click();
  expect(await toolState(page)).toEqual(BACK_IN_SELECT);
  const moved = await pasteAndDrag(page);
  expect(moved).toBeGreaterThan(40);
  expect(errors).toEqual([]);
});

test('switching tabs ends the edit back in Select, in both directions', async ({ page }) => {
  const errors = await boot(page);
  await page.locator('#tab-new').click();
  const [a] = await addTwoPaths(page);
  await enterPointEdit(page, a);

  await page.locator('#tab-list > *').first().click();
  expect(await toolState(page)).toEqual(BACK_IN_SELECT);
  await page.locator('#tab-list > *').last().click();
  expect(await toolState(page)).toEqual(BACK_IN_SELECT);
  expect(errors).toEqual([]);
});

test('a new tab in a node tool picked directly stays in it, with no edit open', async ({ page }) => {
  const errors = await boot(page);
  const [a] = await addTwoPaths(page);
  await page.locator('#svg-canvas').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('a');
  const c = await centreOf(page, a);
  await page.mouse.dblclick(c.x, c.y);
  await expect.poll(async () => (await toolState(page)).editing).toBe(a);

  await page.locator('#tab-new').click();
  expect(await toolState(page)).toEqual({ tool: 'directSelect', editing: null, lit: [] });
  expect(errors).toEqual([]);
});

test('opening a file over the current document ends the edit back in Select', async ({ page }) => {
  const errors = await boot(page);
  const [a] = await addTwoPaths(page);
  await enterPointEdit(page, a);

  await page.evaluate(async () => {
    const m = await import('/src/ui/project-file.ts');
    m.loadDocumentSVG(
      (window as unknown as { state: AnyState }).state,
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 H90 V90 Z"/></svg>',
    );
  });
  expect(await toolState(page)).toEqual(BACK_IN_SELECT);
  expect(errors).toEqual([]);
});
