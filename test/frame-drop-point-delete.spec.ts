import { test, expect, type Page } from '@playwright/test';

async function setup(page: Page, background = false, rotated = false) {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).docs);
  return page.evaluate(({ background, rotated }) => {
    const s = (window as any).state;
    const frame = document.getElementById(s.artboards[0].id)!;
    const ns = 'http://www.w3.org/2000/svg';
    let backgroundId = '';
    if (background) {
      const rect = document.createElementNS(ns, 'rect');
      backgroundId = rect.id = s.nextId();
      for (const [key, value] of Object.entries({ x: '120', y: '30', width: '400', height: '300', fill: '#ddd' })) rect.setAttribute(key, value);
      frame.append(rect);
    }
    const group = document.createElementNS(ns, 'g'); group.id = s.nextId();
    group.setAttribute('transform', 'translate(20 10)'); frame.append(group);
    const path = document.createElementNS(ns, 'path'); path.id = s.nextId();
    path.setAttribute('d', 'M 220 100 L 300 100 L 380 100 L 380 220 L 300 220 L 220 220 Z');
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#555');
    if (rotated) path.setAttribute('transform', 'rotate(35 300 160)');
    group.append(path);
    s.rebuildShapesFromDOM(); s.saveHistory(); s.selectShape(path.id);
    return { path: path.id, group: group.id, frame: frame.id, background: backgroundId };
  }, { background, rotated });
}

async function marqueeTopPoints(page: Page, id: string) {
  const box = await page.evaluate(id => {
    const el = document.getElementById(id) as unknown as SVGGraphicsElement;
    const m = el.getScreenCTM()!;
    const a = new DOMPoint(210, 90).matrixTransform(m), b = new DOMPoint(310, 110).matrixTransform(m);
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  }, id);
  await page.mouse.move(box.x1, box.y1); await page.mouse.down();
  await page.mouse.move(box.x2, box.y2, { steps: 5 }); await page.mouse.up();
}

for (const background of [false, true]) {
  test(`marquee deletes only selected points, including repeated Delete (background: ${background})`, async ({ page }) => {
    const ids = await setup(page, background);
    await page.keyboard.press('a');
    await marqueeTopPoints(page, ids.path);
    expect(await page.evaluate(() => (window as any).state.pathEdit?.selected.size)).toBe(2);
    await page.keyboard.down('Delete');
    await page.keyboard.down('Delete'); // browser autorepeat
    await page.keyboard.up('Delete');
    await page.keyboard.press('Backspace');
    await expect(page.locator(`[id="${ids.path}"]`)).toHaveCount(1);
    await expect(page.locator('[data-node-anchor]')).toHaveCount(4);
    await page.keyboard.press('Control+z');
    expect(await page.locator(`[id="${ids.path}"]`).getAttribute('d')).toContain('220 100');
  });
}

test('rotated path marquee selects only anchors inside the visible rectangle', async ({ page }) => {
  const ids = await setup(page, true, true);
  await page.keyboard.press('a');
  const boxes = await Promise.all([0, 4, 5].map(i => page.locator(`[data-node-anchor="0:${i}"]`).boundingBox()));
  const left = Math.min(...boxes.map(b => b!.x)) - 10;
  const right = Math.max(...boxes.map(b => b!.x + b!.width)) + 10;
  const top = Math.min(...boxes.map(b => b!.y)) - 10;
  const bottom = Math.max(...boxes.map(b => b!.y + b!.height)) + 10;
  await page.mouse.move(left, top); await page.mouse.down();
  await page.mouse.move(right, bottom, { steps: 4 }); await page.mouse.up();
  expect(await page.evaluate(() => [...(window as any).state.pathEdit.selected])).toEqual(['0:0', '0:4', '0:5']);
  await page.keyboard.press('Delete');
  await expect(page.locator(`[id="${ids.path}"]`)).toHaveCount(1);
  await expect(page.locator('[data-node-anchor]')).toHaveCount(3);
});

for (const kind of ['path', 'group'] as const) {
  test(`dropping a nested ${kind} onto its frame makes it a direct child without moving it`, async ({ page }) => {
    const ids = await setup(page);
    if (kind === 'group') await page.evaluate(ids => {
      const s = (window as any).state;
      const wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'g'); wrapper.id = s.nextId();
      wrapper.setAttribute('transform', 'translate(10 15)');
      const group = document.getElementById(ids.group)!; group.parentElement!.append(wrapper); wrapper.append(group);
      s.rebuildShapesFromDOM(); s.saveHistory(); s.selectShape(ids.group);
    }, ids);
    const id = ids[kind];
    const before = (await page.locator(`[id="${id}"]`).boundingBox())!;
    const source = page.locator(`.layer-item[data-id="${id}"]`);
    const target = page.locator(`.layer-item[data-id="${ids.frame}"]`);
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await source.dispatchEvent('dragstart', { dataTransfer });
    const targetBox = (await target.boundingBox())!;
    const event = { dataTransfer, clientX: targetBox.x + 70, clientY: targetBox.y + targetBox.height / 2 };
    await target.dispatchEvent('dragover', event);
    await expect(target).toHaveClass(/drop-inside/);
    await expect(target).not.toHaveClass(/drop-illegal/);
    await target.dispatchEvent('drop', event);
    expect(await page.locator(`[id="${id}"]`).evaluate(el => el.parentElement!.id)).toBe(ids.frame);
    const after = (await page.locator(`[id="${id}"]`).boundingBox())!;
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(after[key]).toBeCloseTo(before[key], 2);
    await page.keyboard.press('Control+z');
    expect(await page.locator(`[id="${id}"]`).evaluate(el => el.parentElement!.id)).not.toBe(ids.frame);
  });
}

test('frames still cannot be nested or grouped', async ({ page }) => {
  const ids = await setup(page);
  expect(await page.evaluate(ids => {
    const s = (window as any).state;
    return [s.canDrop(ids.frame, ids.group, 'inside'), s.canDrop(ids.path, ids.frame, 'onto')];
  }, ids)).toEqual([false, false]);
});

test('a plain click can still leave point editing to select background artwork', async ({ page }) => {
  const ids = await setup(page, true);
  await page.keyboard.press('a');
  const point = await page.evaluate(id => {
    const el = document.getElementById(id) as unknown as SVGGraphicsElement;
    const p = new DOMPoint(150, 60).matrixTransform(el.getScreenCTM()!);
    return { x: p.x, y: p.y };
  }, ids.background);
  await page.mouse.click(point.x, point.y);
  expect(await page.evaluate(() => (window as any).state.editingPathId)).toBeNull();
  expect(await page.evaluate(() => (window as any).state.selectedShapeIds)).toEqual([ids.background]);
});

test('deleting every point removes the empty path and undo restores it', async ({ page }) => {
  const ids = await setup(page);
  await page.keyboard.press('a');
  await page.evaluate(() => {
    const s = (window as any).state;
    s.pathEdit.model.subpaths[0].anchors.forEach((_: unknown, i: number) => s.pathEdit.addSelect(0, i));
    s.onChange_public();
  });
  await page.keyboard.press('Delete');
  await expect(page.locator(`[id="${ids.path}"]`)).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator(`[id="${ids.path}"]`)).toHaveCount(1);
});

async function dropOnFrame(page: Page, sourceId: string, frameId: string, allowed = true) {
  const source = page.locator(`.layer-item[data-id="${sourceId}"]`);
  const target = page.locator(`.layer-item[data-id="${frameId}"]`);
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent('dragstart', { dataTransfer });
  const box = (await target.boundingBox())!;
  const event = { dataTransfer, clientX: box.x + 60, clientY: box.y + box.height / 2 };
  await target.dispatchEvent('dragover', event);
  await expect(target).toHaveClass(allowed ? /drop-inside/ : /drop-illegal/);
  await target.dispatchEvent('drop', event);
}

test('a frame drop moves the whole selection in paint order with one undo step', async ({ page }) => {
  const ids = await setup(page);
  const extra = await page.evaluate(ids => {
    const s = (window as any).state;
    const first = document.getElementById(ids.path)!;
    const second = first.cloneNode(true) as Element; second.id = s.nextId();
    second.setAttribute('transform', 'translate(50 30)'); first.parentElement!.append(second);
    s.rebuildShapesFromDOM(); s.saveHistory(); s.selectMultiple([second.id, first.id]);
    return second.id;
  }, ids);
  const before = await page.locator(`[id="${extra}"]`).boundingBox();
  await dropOnFrame(page, ids.path, ids.frame);
  const moved = await page.evaluate(({ ids, extra }) => ({
    parents: [ids.path, extra].map(id => document.getElementById(id)!.parentElement!.id),
    order: Array.from(document.getElementById(ids.frame)!.children).map(el => el.id).filter(id => id === ids.path || id === extra),
    selection: (window as any).state.selectedShapeIds,
  }), { ids, extra });
  expect(moved).toEqual({ parents: [ids.frame, ids.frame], order: [ids.path, extra], selection: [ids.path, extra] });
  expect(await page.locator(`[id="${extra}"]`).boundingBox()).toEqual(before);
  await page.keyboard.press('Control+z');
  for (const id of [ids.path, extra]) expect(await page.locator(`[id="${id}"]`).evaluate(el => el.parentElement!.id)).toBe(ids.group);
  await page.keyboard.press('Control+Shift+z');
  for (const id of [ids.path, extra]) expect(await page.locator(`[id="${id}"]`).evaluate(el => el.parentElement!.id)).toBe(ids.frame);
});

test('selected descendants travel with their selected group', async ({ page }) => {
  const ids = await setup(page);
  await page.evaluate(ids => (window as any).state.selectMultiple([ids.path, ids.group]), ids);
  await dropOnFrame(page, ids.path, ids.frame);
  expect(await page.locator(`[id="${ids.path}"]`).evaluate(el => el.parentElement!.id)).toBe(ids.group);
  expect(await page.evaluate(() => (window as any).state.selectedShapeIds)).toEqual([ids.group]);
});

test('one illegal selected root rejects the whole frame drop', async ({ page }) => {
  const ids = await setup(page);
  await page.evaluate(ids => {
    const s = (window as any).state;
    const frame = document.getElementById(ids.frame)!;
    const other = frame.cloneNode(false) as Element; other.id = s.nextId();
    frame.parentElement!.append(other); s.rebuildShapesFromDOM(); s.saveHistory();
    s.selectMultiple([ids.path, other.id]);
  }, ids);
  await dropOnFrame(page, ids.path, ids.frame, false);
  expect(await page.locator(`[id="${ids.path}"]`).evaluate(el => el.parentElement!.id)).toBe(ids.group);
  expect(await page.evaluate(() => (window as any).state.selectedShapeIds.length)).toBe(2);
});

for (const zone of ['before', 'after'] as const) {
  test(`multi-item ${zone} drops preserve sibling order`, async ({ page }) => {
    const ids = await setup(page);
    const result = await page.evaluate(({ ids, zone }) => {
      const s = (window as any).state, original = document.getElementById(ids.path)!;
      const all = [original.id];
      for (let i = 0; i < 3; i++) {
        const copy = original.cloneNode(true) as Element; copy.id = s.nextId();
        original.parentElement!.append(copy); all.push(copy.id);
      }
      s.rebuildShapesFromDOM(); s.saveHistory();
      const moved = s.moveShape([all[3], all[1]], zone === 'before' ? all[0] : all[2], zone);
      return { moved, order: Array.from(original.parentElement!.children).map(el => el.id),
        expected: [all[0], all[1], all[3], all[2]] };
    }, { ids, zone });
    expect(result.moved).toBe(true);
    expect(result.order).toEqual(result.expected);
  });
}
