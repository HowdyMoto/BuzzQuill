import { test, expect } from '@playwright/test';

test('interactive rendering coalesces and settled edits synchronously cancel the queued frame', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).state);
  const result = await page.evaluate(() => {
    const state = (window as any).state;
    const methods = ['devCheckFramesInvariant', 'devCheckStyleLinksInvariant', 'devCheckShapesMatchDOM',
      'refreshStrokeAlignClips', 'refreshEffectRegions', 'polishTextStrokes', 'refreshTextStrokeOutlines', 'syncRepeats'];
    const calls: string[] = [];
    const originals = methods.map(name => state[name]);
    methods.forEach((name, index) => { state[name] = function () { calls.push(name); return originals[index].call(state); }; });
    const request = window.requestAnimationFrame;
    const cancel = window.cancelAnimationFrame;
    const queued = new Map<number, FrameRequestCallback>();
    const cancelled: number[] = [];
    let next = 0;
    window.requestAnimationFrame = callback => { queued.set(++next, callback); return next; };
    window.cancelAnimationFrame = id => { cancelled.push(id); queued.delete(id); };
    try {
      state.setInteractive(true);
      state.onChange_public(); state.onChange_public(); state.onChange_public();
      const before = { calls: calls.length, queued: queued.size };
      const [id, callback] = queued.entries().next().value!;
      queued.delete(id); callback(0);
      const interactive = [...calls];
      calls.length = 0;
      state.onChange_public();
      const pendingRender = next;
      state.setInteractive(false);
      state.onChange_public();
      return { before, interactive, settled: calls, cancelledPending: cancelled.includes(pendingRender) };
    } finally {
      window.requestAnimationFrame = request; window.cancelAnimationFrame = cancel;
      methods.forEach((name, index) => { state[name] = originals[index]; });
      state.setInteractive(false);
    }
  });
  const order = ['devCheckFramesInvariant', 'devCheckStyleLinksInvariant', 'devCheckShapesMatchDOM',
    'refreshStrokeAlignClips', 'refreshEffectRegions', 'polishTextStrokes', 'refreshTextStrokeOutlines', 'syncRepeats'];
  expect(result.before).toEqual({ calls: 0, queued: 1 });
  expect(result.interactive).toEqual(order);
  expect(result.settled).toEqual(order);
  expect(result.cancelledPending).toBe(true);
  expect(errors).toEqual([]);
});
