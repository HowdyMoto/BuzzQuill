import { test, expect } from '@playwright/test';

/**
 * Arrow-key nudge (Figma/Illustrator-style): with the Select tool and a
 * selection, arrows move it 1 unit, Shift+arrow 10 units, and each press is its
 * own undo step. Locked shapes don't move.
 */

const RECT = '<svg xmlns="http://www.w3.org/2000/svg"><rect id="r1" x="100" y="100" width="20" height="10" fill="red"/></svg>';

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });
}

test('arrows nudge 1, Shift+arrow nudges 10, and it is undoable', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  await page.evaluate((svg) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as unknown as { state: any }).state;
    s.importSVGContent(svg);
    s.selectMultiple(['r1']);
  }, RECT);

  const rect = page.locator('#r1');
  const x = async () => parseFloat((await rect.getAttribute('x'))!);
  const y = async () => parseFloat((await rect.getAttribute('y'))!);

  expect(await x()).toBe(100);
  await page.keyboard.press('ArrowRight');
  expect(await x()).toBe(101);                 // 1px
  await page.keyboard.press('Shift+ArrowRight');
  expect(await x()).toBe(111);                 // +10px
  await page.keyboard.press('ArrowUp');
  expect(await y()).toBe(99);                  // up = -y, 1px
  await page.keyboard.press('Shift+ArrowDown');
  expect(await y()).toBe(109);                 // +10px

  // Each press is a discrete undo step: undo the last (Shift+Down) → y back to 99.
  await page.evaluate(() => (window as unknown as { state: any }).state.undo());
  expect(await y()).toBe(99);

  expect(errors).toEqual([]);
});

test('nudging shows the gesture-hint HUD with the modifier options', async ({ page }) => {
  await boot(page);
  await page.evaluate((svg) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as unknown as { state: any }).state;
    s.importSVGContent(svg);
    s.selectMultiple(['r1']);
  }, RECT);

  await page.keyboard.press('ArrowRight');
  const hud = page.locator('#tool-hint.gesturing');
  await expect(hud).toBeVisible();
  await expect(hud).toContainText('move 10px'); // the Shift hint
  await expect(hud).toContainText('faster');    // the hold/accelerate hint
});

test('holding a key accelerates and coalesces into one undo step', async ({ page }) => {
  await boot(page);
  const moved = await page.evaluate((svg) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as unknown as { state: any }).state;
    s.importSVGContent(svg);
    s.selectMultiple(['r1']);
    const x0 = parseFloat(s.findShapeById('r1').element.getAttribute('x'));
    // Simulate a held key: one fresh keydown, then auto-repeats.
    const fire = (repeat: boolean) => window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', repeat, bubbles: true, cancelable: true }));
    fire(false);
    for (let i = 0; i < 15; i++) fire(true);
    const x1 = parseFloat(s.findShapeById('r1').element.getAttribute('x'));
    return { presses: 16, distance: x1 - x0 };
  }, RECT);

  // 16 non-accelerated presses would move 16; acceleration must move clearly more.
  expect(moved.distance).toBeGreaterThan(moved.presses * 1.5);

  // Let the held run commit via its timer, then one undo returns to the start —
  // proving the whole hold was a single, coalesced undo step.
  await page.waitForTimeout(300);
  const backToStart = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as unknown as { state: any }).state;
    s.undo();
    return parseFloat(s.findShapeById('r1').element.getAttribute('x'));
  });
  expect(backToStart).toBe(100);
});

test('locked shapes are not nudged', async ({ page }) => {
  await boot(page);
  await page.evaluate((svg) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as unknown as { state: any }).state;
    s.importSVGContent(svg);
    const shape = s.findShapeById('r1');
    shape.locked = true;
    shape.element.setAttribute('data-locked', 'true');
    s.selectMultiple(['r1']);
  }, RECT);

  const rect = page.locator('#r1');
  await page.keyboard.press('ArrowRight');
  expect(parseFloat((await rect.getAttribute('x'))!)).toBe(100); // unchanged
});

test('switching tools settles a held nudge once and clears its timers and HUD', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await boot(page);
  const before = await page.evaluate(svg => {
    const state = (window as any).state;
    state.importSVGContent(svg);
    state.selectMultiple(['r1']);
    const entries = state.exportHistory().entries.length;
    const fire = (repeat: boolean) => window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowRight', repeat, bubbles: true, cancelable: true,
    }));
    fire(false);
    for (let i = 0; i < 12; i++) fire(true);
    return { entries, x: Number(state.findShapeById('r1').element.getAttribute('x')) };
  }, RECT);
  await page.locator('.tool-btn[data-tool="rect"]').click();
  await page.waitForTimeout(1100); // past both the commit and HUD timers
  const after = await page.evaluate(() => {
    const state = (window as any).state;
    const entries = state.exportHistory().entries.length;
    const interactive = state.interactive;
    const tool = state.currentTool;
    state.undo();
    const undoX = Number(state.findShapeById('r1').element.getAttribute('x'));
    state.redo();
    return { entries, interactive, tool, undoX, redoX: Number(state.findShapeById('r1').element.getAttribute('x')) };
  });
  expect(after).toEqual({ entries: before.entries + 1, interactive: false, tool: 'rect', undoX: 100, redoX: before.x });
  await expect(page.locator('#tool-hint')).not.toHaveClass(/gesturing/);
  expect(errors).toEqual([]);
});

test('a delayed nudge commit cannot amend the history entry reached by undo', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await boot(page);
  const expected = await page.evaluate(svg => {
    const state = (window as any).state;
    state.importSVGContent(svg);
    state.selectMultiple(['r1']);
    for (const repeat of [false, true, true, true]) window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowRight', repeat, bubbles: true, cancelable: true,
    }));
    state.undo();
    return { history: state.exportHistory(), markup: state.getDrawingLayerSVG() };
  }, RECT);
  await page.waitForTimeout(350);
  const actual = await page.evaluate(() => {
    const state = (window as any).state;
    return { history: state.exportHistory(), markup: state.getDrawingLayerSVG(), interactive: state.interactive };
  });
  expect(actual).toEqual({ ...expected, interactive: false });
  expect(errors).toEqual([]);
});


for (const angle of [90, 180, 270]) {
  test(`pasted raster arrows follow canvas axes after ${angle} degree rotation`, async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!(window as any).docs);
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 120; canvas.height = 80;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#2385c7'; ctx.fillRect(0, 0, 120, 80);
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!)));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'pasted.png', { type: 'image/png' }));
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    const image = page.locator('#drawing-layer image');
    await expect(image).toHaveCount(1);
    await page.locator('#prop-rotation').fill(String(angle));
    await page.locator('#prop-rotation').press('Enter');
    await page.locator('#prop-rotation').blur();
    const position = () => page.evaluate(async () => {
      const { localBBoxInLayer } = await import('/src/core/coords.ts');
      return localBBoxInLayer(document.querySelector('#svg-canvas')!, document.querySelector('#drawing-layer image')!)!;
    });
    for (const [key, dx, dy] of [['ArrowUp', 0, -1], ['ArrowRight', 1, 0], ['Shift+ArrowDown', 0, 10], ['Shift+ArrowLeft', -10, 0]] as const) {
      const before = await position();
      await page.keyboard.press(key);
      const after = await position();
      expect(after.x - before.x).toBeCloseTo(dx, 5);
      expect(after.y - before.y).toBeCloseTo(dy, 5);
    }
  });
}

test('vertically flipped raster moves up in canvas space and supports undo/redo', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).docs);
  await page.evaluate(() => {
    const s = (window as any).state;
    s.importSVGContent('<svg xmlns="http://www.w3.org/2000/svg"><image id="raster" x="100" y="100" width="120" height="80" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="/></svg>');
    s.selectShape('raster');
    s.flipSelected('vertical');
  });
  const image = page.locator('#raster');
  const before = (await image.boundingBox())!;
  await page.keyboard.press('ArrowUp');
  const after = (await image.boundingBox())!;
  expect(after.y).toBeLessThan(before.y);
  await page.evaluate(() => (window as any).state.undo());
  expect((await image.boundingBox())!.y).toBeCloseTo(before.y, 5);
  await page.evaluate(() => (window as any).state.redo());
  expect((await image.boundingBox())!.y).toBeCloseTo(after.y, 5);
});

test('image and paths rotated together with canvas handle nudge along canvas axes', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).docs);
  await page.evaluate(() => {
    const s = (window as any).state;
    s.importSVGContent('<svg xmlns="http://www.w3.org/2000/svg"><image id="raster" x="200" y="200" width="120" height="80" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="/><path id="path1" d="M 350 200 L 400 250 L 350 280 Z"/></svg>');
    s.selectMultiple(['raster', 'path1']);
  });
  const bounds = await page.locator('#drawing-layer').boundingBox();
  const handle = (await page.locator('#selection-layer [data-handle="rotate"]').boundingBox())!;
  const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x, 2 * (bounds!.y + bounds!.height / 2) - y, { steps: 10 });
  await page.mouse.up();
  for (const key of ['ArrowUp', 'ArrowRight']) {
    const before = await page.locator('#raster').boundingBox();
    await page.keyboard.press(key);
    const after = (await page.locator('#raster').boundingBox())!;
    if (key === 'ArrowUp') expect(after.y).toBeLessThan(before!.y);
    else expect(after.x).toBeGreaterThan(before!.x);
  }
});
