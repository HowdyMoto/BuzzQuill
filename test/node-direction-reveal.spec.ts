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

test('A pulses anchors in stored order per subpath without changing the path or restarting on render', async ({ page }) => {
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
  expect(result.delays[1] - result.delays[0]).toBeCloseTo(90);
  expect(result.delays[3] - result.delays[0]).toBeCloseTo(270);
  expect(result.delays[4]).toBe(result.delays[0]);
  expect(result.after).toBeLessThanOrEqual(result.before);
  expect(result.inert).toBe(true);
  await expect(page.locator('[data-node-direction]')).toHaveCount(0);
  await expect(page.locator('[data-node-direction-stroke]')).toHaveCount(0);
  await page.evaluate(() => (window as any).state.onChange_public());
  await expect(page.locator('[data-node-direction]')).toHaveCount(0);
  await expect(page.locator('[data-node-direction-stroke]')).toHaveCount(0);
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
  await expect(page.locator('[data-node-direction-stroke]')).toHaveCount(0);
  await page.mouse.up();
  const moved = (await anchor.boundingBox())!;
  expect(moved.x).toBeGreaterThan(box.x + 20);
  await expect(page.locator('[data-node-direction]')).toHaveCount(0);
});

test('dense paths finish promptly; reduced motion shows editable anchors immediately', async ({ page }) => {
  await setup(page, 'M 260 80 ' + Array.from({ length: 100 }, (_, i) => `L ${261 + i} ${80 + i % 2}`).join(' '));
  await page.keyboard.press('a');
  const timings = await page.locator('[data-node-direction]').evaluateAll(els => els.map(el => {
    const style = getComputedStyle(el);
    return parseFloat(style.animationDelay) + parseFloat(style.animationDuration);
  }));
  expect(timings.length).toBeGreaterThan(0);
  expect(Math.max(...timings)).toBeLessThanOrEqual(1.08);
  await page.keyboard.press('v');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.keyboard.press('a');
  await expect(page.locator('[data-node-anchor]')).toHaveCount(101);
  await expect(page.locator('[data-node-direction]')).toHaveCount(0);
  await expect(page.locator('[data-node-direction-stroke]')).toHaveCount(0);
});

test('stroke head meets every pulsing point on a mirrored curve and completes the closing segment', async ({ page }) => {
  const id = await setup(page, 'M 260 80 C 260 280 420 20 420 120 L 460 180 Z');
  await page.evaluate(id => document.getElementById(id)!.setAttribute('transform', 'translate(800 0) scale(-1 1)'), id);
  await page.keyboard.press('a');
  const samples = await page.locator('[data-node-direction-stroke="0"]').first().evaluate(el => {
    const path = el as SVGPathElement;
    const animation = path.getAnimations()[0];
    animation.pause();
    const frames = animation.effect!.getKeyframes();
    const duration = Number(animation.effect!.getTiming().duration);
    const tail = parseFloat(path.getAttribute('stroke-dasharray')!);
    return frames.slice(1, -1).map((frame, index) => {
      animation.currentTime = frame.computedOffset * duration;
      const distance = tail - parseFloat(getComputedStyle(path).strokeDashoffset);
      const head = path.getPointAtLength(distance * path.getTotalLength());
      const marker = document.querySelector<SVGGraphicsElement>(`[data-node-anchor="0:${index % 3}"]`)!;
      const box = marker.getBBox();
      return { x: head.x, y: head.y, anchorX: box.x + box.width / 2, anchorY: box.y + box.height / 2,
        time: frame.computedOffset * duration };
    });
  });
  expect(samples).toHaveLength(4); // three written points, then back to start
  for (const [i, sample] of samples.entries()) {
    expect(sample.x).toBeCloseTo(sample.anchorX, 0);
    expect(sample.y).toBeCloseTo(sample.anchorY, 0);
    expect(sample.time).toBeCloseTo(84 + i * 90, 0);
  }
  expect(await page.locator('[data-node-direction-stroke]').first().getAttribute('pointer-events')).toBe('none');
  expect(await page.locator('#drawing-layer [data-node-direction-stroke]').count()).toBe(0);
  await page.keyboard.press('v');
  await expect(page.locator('[data-node-direction-stroke]')).toHaveCount(0);
});
