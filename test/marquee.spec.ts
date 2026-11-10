import { test, expect } from '@playwright/test';

const artwork = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200">
  <rect id="left" x="20" y="20" width="20" height="20"/>
  <g id="group"><rect id="child" x="60" y="60" width="20" height="20"/></g>
  <rect id="right" x="150" y="20" width="20" height="20"/>
  <rect id="locked" data-locked="true" x="25" y="60" width="10" height="10"/>
  <rect id="hidden" style="display:none" x="40" y="40" width="10" height="10"/>
</svg>`;

test('marquee selects frame contents and groups without editing history, including reverse and additive drags', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).state);
  const initialHistory = await page.evaluate(async svg => {
    const { loadDocumentSVG } = await import('/src/ui/project-file.ts');
    const state = (window as any).state;
    loadDocumentSVG(state, svg);
    return state.exportHistory();
  }, artwork);
  await page.keyboard.press('Control+0'); // fit the imported frame before screen-space pointer input
  const drag = async (from: [number, number], to: [number, number]) => {
    const points = await page.evaluate(([a,b]) => {
      const matrix = (document.getElementById('drawing-layer') as unknown as SVGGraphicsElement).getScreenCTM()!;
      return [a,b].map(([x,y]) => { const p = new DOMPoint(x,y).matrixTransform(matrix); return { x:p.x, y:p.y }; });
    }, [from,to]);
    await page.mouse.move(points[0].x,points[0].y);
    await page.mouse.down();
    await page.mouse.move(points[1].x,points[1].y,{steps:5});
    await page.mouse.up();
  };
  const selection = () => page.evaluate(() => [...(window as any).state.selectedShapeIds].sort());
  await drag([90,90],[10,10]);
  expect(await selection()).toEqual(['group','left']);
  await page.keyboard.down('Shift');
  await drag([140,10],[180,50]);
  await page.keyboard.up('Shift');
  expect(await selection()).toEqual(['group','left','right']);
  expect(await page.evaluate(() => (window as any).state.exportHistory())).toEqual(initialHistory);
  expect(errors).toEqual([]);
});
