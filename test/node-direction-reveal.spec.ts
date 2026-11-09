import { test, expect, type Page } from '@playwright/test';

async function setup(page: Page, d = 'M 260 80 L 420 80 L 420 220 L 260 220 Z M 300 120 L 300 180 L 380 180') {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).docs);
  return page.evaluate(d => {
    const s = (window as any).state;
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.id = s.nextId(); el.setAttribute('d', d);
    el.setAttribute('fill', 'none'); el.setAttribute('stroke', '#888');
    document.getElementById(s.artboards[0].id)!.append(el);
    s.rebuildShapesFromDOM(); s.saveHistory(); s.selectShape(el.id);
    return el.id;
  }, d);
}

test('A pulses all anchors together without changing the path or restarting on render', async ({ page }) => {
  const id = await setup(page);
  const original = await page.locator(`[id="${id}"]`).getAttribute('d');
  await page.keyboard.press('a');
  await expect(page.locator('[data-node-anchor]')).toHaveCount(7);
  const result = await page.evaluate(() => {
    const halos = Array.from(document.querySelectorAll<SVGElement>('[data-node-direction]'));
    const delays = halos.map(el => parseFloat(el.style.animationDelay));
    const before = delays[1];
    (window as any).state.onChange_public();
    const after = parseFloat(document.querySelector<SVGElement>('[data-node-direction="0:1"]')!.style.animationDelay);
    return { ids: halos.map(el => el.getAttribute('data-node-direction')), delays, before, after,
      inert: halos.every(el => el.getAttribute('pointer-events') === 'none') };
  });
  expect(result.ids).toEqual(['0:0', '0:1', '0:2', '0:3', '1:0', '1:1', '1:2']);
  expect(new Set(result.delays).size).toBe(1);
  expect(result.delays[4]).toBe(result.delays[0]);
  expect(result.after).toBeLessThanOrEqual(result.before);
  expect(result.inert).toBe(true);
  await expect(page.locator('[data-node-direction]')).toHaveCount(0);
  await expect(page.locator('[data-node-direction-arrow]')).toHaveCount(0);
  await page.evaluate(() => (window as any).state.onChange_public());
  await expect(page.locator('[data-node-direction]')).toHaveCount(0);
  await expect(page.locator('[data-node-direction-arrow]')).toHaveCount(0);
  expect(await page.locator(`[id="${id}"]`).getAttribute('d')).toBe(original);
  await page.keyboard.press('v');
  await page.keyboard.press('a');
  await expect(page.locator('[data-node-direction]')).not.toHaveCount(0);
});

test('anchors can be dragged immediately and the reveal stops', async ({ page }) => {
  await setup(page);
  await page.keyboard.press('a');
  const anchor = page.locator('[data-node-anchor="0:1"]');
  const box = (await anchor.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20, { steps: 3 });
  await expect(page.locator('[data-node-direction]')).toHaveCount(0);
  await expect(page.locator('[data-node-direction-arrow]')).toHaveCount(0);
  await page.mouse.up();
  const moved = (await anchor.boundingBox())!;
  expect(moved.x).toBeGreaterThan(box.x + 20);
  await expect(page.locator('[data-node-direction]')).toHaveCount(0);
});

test('point reveal leaves nearby raster pixels unchanged', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 100;
    const ctx = canvas.getContext('2d')!;
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#2385c7' : '#f6a72c';
      ctx.fillRect(x * 10, y * 10, 10, 10);
    }
    const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
    img.id = 'raster-reveal-test';
    img.setAttribute('href', canvas.toDataURL());
    img.setAttribute('x', '120'); img.setAttribute('y', '100');
    img.setAttribute('width', '100'); img.setAttribute('height', '100');
    document.getElementById((window as any).state.artboards[0].id)!.append(img);
    (window as any).state.rebuildShapesFromDOM();
  });
  const raster = page.locator('#raster-reveal-test');
  const before = await raster.screenshot();
  await page.keyboard.press('a');
  await page.evaluate(() => {
    document.querySelectorAll('[data-node-overlay] *').forEach(el => {
      el.getAnimations().forEach(animation => animation.pause());
    });
  });
  for (const time of [40, 84, 180, 300]) {
    await page.evaluate(time => {
      document.querySelectorAll('[data-node-overlay] *').forEach(el => {
        el.getAnimations().forEach(animation => { animation.currentTime = time; });
      });
    }, time);
    expect((await raster.screenshot({ animations: 'allow' })).equals(before)).toBe(true);
  }
});

test('dense paths finish promptly; reduced motion shows editable anchors immediately', async ({ page }) => {
  await setup(page, 'M 260 80 ' + Array.from({ length: 100 }, (_, i) => `L ${261 + i} ${80 + i % 2}`).join(' '));
  await page.keyboard.press('a');
  const timings = await page.locator('[data-node-direction]').evaluateAll(els => els.map(el => {
    const style = getComputedStyle(el);
    return parseFloat(style.animationDelay) + parseFloat(style.animationDuration);
  }));
  expect(timings.length).toBeGreaterThan(0);
  expect(Math.max(...timings)).toBeLessThanOrEqual(0.4);
  await page.keyboard.press('v');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.keyboard.press('a');
  await expect(page.locator('[data-node-anchor]')).toHaveCount(101);
  await expect(page.locator('[data-node-direction]')).toHaveCount(0);
  await expect(page.locator('[data-node-direction-arrow]')).toHaveCount(0);
});

for (const scenario of [
  { name: 'line', d: 'M 260 80 L 420 80', transform: '', dx: 1, dy: 0 },
  { name: 'mirrored curve', d: 'M 260 80 C 360 180 420 20 420 120 Z', transform: 'translate(800 0) scale(-1 1)', dx: -Math.SQRT1_2, dy: Math.SQRT1_2 },
  { name: 'collapsed first handle', d: 'M 260 80 C 260 80 260 180 420 120', transform: '', dx: 0, dy: 1 },
  { name: 'duplicate first point', d: 'M 260 80 L 260 80 L 420 80', transform: '', dx: 1, dy: 0 },
]) {
  test(`start arrow follows the ${scenario.name} tangent`, async ({ page }) => {
    const id = await setup(page, scenario.d);
    await page.evaluate(({ id, transform }) => document.getElementById(id)!.setAttribute('transform', transform), { id, transform: scenario.transform });
    await page.keyboard.press('a');
    const arrow = page.locator('[data-node-direction-arrow="0"]');
    const geometry = await arrow.evaluate(el => {
      const path = el as SVGPathElement;
      const start = path.getPointAtLength(0);
      const marker = document.querySelector<SVGGraphicsElement>('[data-node-anchor="0:0"]')!.getBBox();
      return { start: { x: start.x, y: start.y },
        origin: { x: marker.x + marker.width / 2, y: marker.y + marker.height / 2 } };
    });
    const dx = geometry.start.x - geometry.origin.x, dy = geometry.start.y - geometry.origin.y;
    const length = Math.hypot(dx, dy);
    expect(dx / length).toBeCloseTo(scenario.dx);
    expect(dy / length).toBeCloseTo(scenario.dy);
    expect(await arrow.getAttribute('pointer-events')).toBe('none');
    expect(await page.locator('#drawing-layer [data-node-direction-arrow]').count()).toBe(0);
    await expect(arrow).toHaveCount(0);
  });
}
