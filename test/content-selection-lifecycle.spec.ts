import { test, expect, type Page } from '@playwright/test';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="100"><path fill="#49a" d="M 420 220 L 540 220 L 540 320 L 420 320 Z"/></svg>';

async function boot(page: Page, entry: 'A' | 'double-click' | 'empty-A' = 'A') {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).docs);
  const old = await page.evaluate(() => {
    const s = (window as any).state, el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.id = s.nextId(); el.setAttribute('d', 'M 240 70 L 360 70 L 360 170 L 240 170 Z');
    el.setAttribute('fill', '#a65'); document.getElementById(s.artboards[0].id)!.append(el);
    s.rebuildShapesFromDOM(); s.saveHistory(); s.selectShape(el.id); s.snapEnabled = false;
    s.copySelected();
    return el.id;
  });
  if (entry === 'double-click') {
    const box = (await page.locator(`[id="${old}"]`).boundingBox())!;
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  } else {
    if (entry === 'empty-A') await page.evaluate(() => (window as any).state.selectShape(null));
    await page.keyboard.press('a');
  }
  expect(await page.evaluate(() => (window as any).state.editingPathId)).toBe(entry === 'empty-A' ? null : old);
  return old;
}

async function appendFromPicker(page: Page) {
  const previous = await selectedId(page);
  await page.locator('.menu-trigger', { hasText: 'File' }).click();
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Append…', exact: true }).click();
  await (await picker).setFiles({ name: 'added.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
  // setFiles dispatches the change event; it does not await the async SVG import.
  // With empty-A, null already differs from the old path and is not readiness.
  await expect.poll(async () => {
    const id = await selectedId(page);
    return !!id && id !== previous;
  }).toBe(true);
}

async function selectedId(page: Page) {
  return page.evaluate(() => (window as any).state.selectedShapeId as string | null);
}

async function transformImmediately(page: Page) {
  await expect.poll(() => selectedId(page)).toBeTruthy();
  await expect.poll(() => page.evaluate(() => (window as any).state.editingPathId)).toBeNull();
  await expect(page.locator('[data-node-anchor]')).toHaveCount(0);
  const id = await selectedId(page);
  const shape = page.locator(`[id="${id}"]`);
  const before = (await shape.boundingBox())!;
  const frame = await shape.getAttribute('data-frame');
  const handle = frame === null ? shape : page.locator(`[data-frame-select="${id}"]`).first();
  const hit = (await handle.boundingBox())!;
  await page.mouse.move(hit.x + hit.width / 2, hit.y + hit.height / 2); await page.mouse.down();
  await page.mouse.move(hit.x + hit.width / 2 + 25, hit.y + hit.height / 2 + 15, { steps: 5 }); await page.mouse.up();
  const moved = (await shape.boundingBox())!;
  expect(moved.x - before.x).toBeCloseTo(25, 0);
  const east = page.locator('#selection-layer [data-handle="se"]').first();
  const edge = (await east.boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2); await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 + 30, edge.y + edge.height / 2 + 25, { steps: 5 }); await page.mouse.up();
  expect((await shape.boundingBox())!.width).toBeGreaterThan(moved.width + 5);
  return id;
}

for (const entry of ['A', 'double-click', 'empty-A'] as const) {
  test(`File Append is immediately transformable after ${entry}`, async ({ page }) => {
    const old = await boot(page, entry);
    const original = await page.locator(`[id="${old}"]`).getAttribute('d');
    await appendFromPicker(page);
    await expect.poll(() => selectedId(page)).not.toBe(old);
    await transformImmediately(page);
    expect(await page.locator(`[id="${old}"]`).getAttribute('d')).toBe(original);
  });
}

for (const route of ['drop', 'foreign-paste', 'internal-paste', 'paste-in-place', 'duplicate', 'batched-selection', 'multi-selection'] as const) {
  test(`${route} clears stale point editing and supports transforms`, async ({ page }) => {
    const old = await boot(page);
    if (route === 'drop') {
      const dt = await page.evaluateHandle(svg => {
        const dt = new DataTransfer(); dt.items.add(new File([svg], 'dropped.svg', { type: 'image/svg+xml' })); return dt;
      }, svg);
      await page.locator('#canvas-area').dispatchEvent('drop', { dataTransfer: dt, clientX: 600, clientY: 380 });
    } else if (route === 'foreign-paste') {
      await page.evaluate(svg => {
        const data = new DataTransfer(); data.setData('text/plain', svg);
        document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }, svg);
    } else if (route === 'internal-paste' || route === 'paste-in-place') {
      await page.locator('.menu-trigger', { hasText: 'Edit', exact: true }).click();
      await page.locator(`[data-action="edit.${route === 'paste-in-place' ? 'paste-in-place' : 'paste'}"]`).click();
    } else if (route === 'duplicate') {
      await page.keyboard.press('Control+d');
    } else {
      await page.evaluate(({ old, multi }) => {
        const s = (window as any).state;
        const el = document.getElementById(old)!.cloneNode(true) as Element; el.id = s.nextId();
        el.setAttribute('transform', 'translate(180 150)'); document.getElementById(old)!.parentElement!.append(el);
        s.rebuildShapesFromDOM();
        s.runBatched(() => { s.selectMultiple(multi ? [old, el.id] : [el.id]); });
      }, { old, multi: route === 'multi-selection' });
    }
    await expect.poll(() => selectedId(page)).not.toBe(old);
    await transformImmediately(page);
  });
}

test('the same session survives style changes and a batched temporary selection', async ({ page }) => {
  const old = await boot(page);
  const result = await page.evaluate(old => {
    const s = (window as any).state, session = s.pathEdit;
    s.runBatched(() => { s.selectMultiple([]); s.selectShape(old); });
    s.setSelectionOpacity(0.7, true);
    return { same: s.pathEdit === session, id: s.editingPathId };
  }, old);
  expect(result).toEqual({ same: true, id: old });
  await expect(page.locator('[data-node-anchor]')).toHaveCount(4);
});

test('removing or replacing the edited source cannot leave a dangling session', async ({ page }) => {
  const old = await boot(page);
  await page.evaluate(old => (window as any).state.removeShape(old), old);
  expect(await page.evaluate(() => (window as any).state.editingPathId)).toBeNull();
  await appendFromPicker(page);
  await transformImmediately(page);
});

for (const route of ['text-paste', 'raster-append', 'new-frame', 'open', 'raw-import', 'undo-redo'] as const) {
  test(`${route} leaves the current content immediately editable`, async ({ page }) => {
    const old = await boot(page);
    if (route === 'text-paste') {
      await page.evaluate(() => {
        const data = new DataTransfer(); data.setData('text/plain', 'New artwork');
        document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      });
    } else if (route === 'raster-append' || route === 'new-frame') {
      const png = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 100;
        const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#49a'; ctx.fillRect(0, 0, 120, 100);
        return canvas.toDataURL().split(',')[1];
      });
      await page.locator('.menu-trigger', { hasText: 'File' }).click();
      const picker = page.waitForEvent('filechooser');
      await page.getByRole('menuitem', { name: route === 'new-frame' ? 'Append as New Frame…' : 'Append…', exact: true }).click();
      await (await picker).setFiles({ name: 'image.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    } else if (route === 'open' || route === 'raw-import') {
      await page.evaluate(async ({ svg, raw }) => {
        const s = (window as any).state;
        if (raw) s.importSVGContent(svg);
        else { const { loadDocumentSVG } = await import('/src/ui/project-file.ts'); loadDocumentSVG(s, svg); }
        const path = document.querySelector('#drawing-layer path')!;
        s.selectShape(path.id);
      }, { svg, raw: route === 'raw-import' });
    } else {
      await appendFromPicker(page);
      await expect.poll(() => selectedId(page)).not.toBe(old);
      await page.keyboard.press('Control+z');
      await page.keyboard.press('Control+Shift+z');
    }
    await expect.poll(() => selectedId(page)).not.toBe(old);
    await expect.poll(() => selectedId(page)).toBeTruthy();
    await transformImmediately(page);
  });
}

test('same-id replacement invalidates the old geometry session', async ({ page }) => {
  const old = await boot(page);
  await page.evaluate(old => {
    const s = (window as any).state, path = document.getElementById(old)!;
    const replacement = path.cloneNode(true) as Element;
    replacement.setAttribute('d', 'M 420 220 L 540 220 L 540 320 L 420 320 Z');
    path.replaceWith(replacement); s.rebuildShapesFromDOM(); s.onChange_public();
  }, old);
  await transformImmediately(page);
});

test('rotation and keyboard nudge work immediately after append while A stays selected', async ({ page }) => {
  await boot(page);
  await appendFromPicker(page);
  const id = await transformImmediately(page);
  const shape = page.locator(`[id="${id}"]`);
  const original = await shape.getAttribute('transform');
  const box = (await shape.boundingBox())!;
  const rotate = (await page.locator('#selection-layer [data-handle="rotate"]').first().boundingBox())!;
  await page.mouse.move(rotate.x + rotate.width / 2, rotate.y + rotate.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width + 30, box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
  expect(await shape.getAttribute('transform')).not.toBe(original);
  const beforeNudge = (await shape.boundingBox())!;
  await page.keyboard.press('ArrowRight');
  expect((await shape.boundingBox())!.x - beforeNudge.x).toBeCloseTo(1, 0);
  expect(await page.evaluate(() => (window as any).state.currentTool)).toBe('directSelect');
});

for (const target of ['path', 'parent'] as const) {
  test(`hiding the edited ${target} removes point editing until visible again`, async ({ page }) => {
    const id = await boot(page);
    await expect(page.locator('[data-node-anchor]')).not.toHaveCount(0);
    const hiddenId = target === 'path' ? id : await page.evaluate(id => document.getElementById(id)!.parentElement!.id, id);
    const eye = page.locator(`li[data-id="${hiddenId}"] .layer-vis`);
    await eye.click();
    await expect(page.locator('[data-node-overlay]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).state.editingPathId)).toBeNull();
    expect(await page.evaluate(id => (window as any).state.enterPathEdit(id), id)).toBe(false);
    await eye.click();
    await page.keyboard.press('a');
    await expect(page.locator('[data-node-anchor]')).not.toHaveCount(0);
    await page.evaluate(id => (window as any).state.toggleVisibility(id), hiddenId);
    await expect(page.locator('[data-node-overlay]')).toHaveCount(0);
    await page.evaluate(() => (window as any).state.undo());
    await page.keyboard.press('a');
    await expect(page.locator('[data-node-anchor]')).not.toHaveCount(0);
  });
}
