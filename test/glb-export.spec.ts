import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const validator = require('gltf-validator');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { delete (window as any).showSaveFilePicker; });
  await page.goto('/');
  await page.waitForFunction(() => (window as any).state);
});

test('closed ring: holes, physical size, outward winding, self-contained valid GLB', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { buildGlb } = await import('/src/core/glb-export.ts');
    const { defaultGlbOptions } = await import('/src/core/glb-options.ts');
    const options = defaultGlbOptions(); options.resolution = 512; options.width = 100; options.thickness = 2;
    const snapshot = { svg: '<svg xmlns="http://www.w3.org/2000/svg"><g data-glb-content="true"><path fill="red" fill-rule="evenodd" d="M0 0H100V100H0Z M25 25H75V75H25Z"/></g></svg>', fonts: [], selected: [], layers: [], frames: [] };
    const model = await buildGlb(snapshot, options);
    const mesh = model.object.children[0] as any;
    const p = mesh.geometry.getAttribute('position'); const n = mesh.geometry.getAttribute('normal');
    let area = 0, volume = 0, wrongNormals = 0;
    const edges = new Map<string, number>();
    const key = (i: number) => [p.getX(i), p.getY(i), p.getZ(i)].map(n => n.toFixed(7)).join(',');
    for (let i = 0; i < p.count; i += 3) {
      const a = [p.getX(i), p.getY(i), p.getZ(i)], b = [p.getX(i+1),p.getY(i+1),p.getZ(i+1)], c = [p.getX(i+2),p.getY(i+2),p.getZ(i+2)];
      const ab = b.map((v,j) => v-a[j]), ac = c.map((v,j) => v-a[j]);
      const cross = [ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];
      if (cross[0]*n.getX(i)+cross[1]*n.getY(i)+cross[2]*n.getZ(i) < -1e-12) wrongNormals++;
      if (n.getZ(i) > .99) area += Math.abs(cross[2])/2;
      volume += (a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
      for (const [j,k] of [[i,i+1],[i+1,i+2],[i+2,i]]) { const e = [key(j),key(k)].sort().join('|'); edges.set(e,(edges.get(e)||0)+1); }
    }
    const bytes = Array.from(new Uint8Array(await (await model.encode()).arrayBuffer()));
    const bounds = mesh.geometry.boundingBox;
    const out = { bytes, area, volume, wrongNormals, badEdges: [...edges.values()].filter(n => n !== 2).length, width: bounds.max.x-bounds.min.x, depth: bounds.max.z-bounds.min.z };
    model.dispose(); return out;
  });
  expect(result.width).toBeCloseTo(.1, 6); expect(result.depth).toBeCloseTo(.002, 6);
  expect(result.area).toBeCloseTo(.0075, 7); expect(result.volume).toBeCloseTo(.000015, 8);
  expect(result.wrongNormals).toBe(0); expect(result.badEdges).toBe(0);
  const report = await validator.validateBytes(new Uint8Array(result.bytes));
  expect(report.issues.numErrors, JSON.stringify(report.issues)).toBe(0);
  expect(report.issues.numWarnings, JSON.stringify(report.issues)).toBe(0);
});

test('maps retain alignment, hidden explicit layers work, raster and vector sources pack independently', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { buildGlb } = await import('/src/core/glb-export.ts'); const { defaultGlbOptions } = await import('/src/core/glb-options.ts');
    const bitmap = document.createElement('canvas'); bitmap.width = 2; bitmap.height = 1;
    const ctx = bitmap.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0,0,1,1); ctx.fillStyle = '#000'; ctx.fillRect(1,0,1,1);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><g data-glb-content="true"><rect id="shape-base" width="100" height="50" fill="red"/><g id="shape-r" style="display:none"><rect x="50" width="50" height="50" fill="#808080"/></g><image id="shape-m" style="display:none" width="100" height="50" href="${bitmap.toDataURL()}"/></g></svg>`;
    const o = defaultGlbOptions(); o.resolution = 512; o.roughness.source = 'shape-r'; o.roughness.fallback = .25; o.metallic.source = 'shape-m';
    const m = await buildGlb({ svg, fonts: [], selected: [], layers: [], frames: [] }, o);
    const mat = (m.object.children[0] as any).material[0];
    const c = mat.roughnessMap.image as HTMLCanvasElement;
    const pixel = (x: number) => [...c.getContext('2d')!.getImageData(x,128,1,1).data];
    const color = [...mat.map.image.getContext('2d').getImageData(400,128,1,1).data];
    const out = { left: pixel(100), right: pixel(400), color, height: m.height }; m.dispose(); return out;
  });
  expect(result.left).toEqual([255,64,255,255]); expect(result.right).toEqual([255,128,0,255]);
  expect(result.color).toEqual([255,0,0,255]); expect(result.height).toBe(50);
});

test('transformed frame clipping and overlapping shapes produce one solid', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { buildGlb } = await import('/src/core/glb-export.ts'); const { defaultGlbOptions } = await import('/src/core/glb-options.ts');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g data-glb-content="true"><g transform="translate(100 50)"><defs><clipPath id="clip"><rect width="100" height="50"/></clipPath></defs><g clip-path="url(#clip)"><rect x="-20" y="-20" width="100" height="100"/><rect x="30" y="-20" width="100" height="100"/></g></g></g></svg>';
    const o = defaultGlbOptions(); o.color = 'solid'; o.resolution = 512;
    const m = await buildGlb({ svg, fonts: [], selected: [], layers: [], frames: [] }, o);
    const result = { height: m.height, islands: m.object.children.length }; m.dispose(); return result;
  });
  expect(result.height).toBeCloseTo(50); expect(result.islands).toBe(1);
});

test('real dialog downloads GLB and cancel preserves artwork', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const before = await page.evaluate(async () => {
    const s = (window as any).state;
    const el = document.createElementNS('http://www.w3.org/2000/svg','rect'); el.id = s.nextId(); el.setAttribute('width','100'); el.setAttribute('height','80'); el.setAttribute('fill','#ed7631');
    document.getElementById('drawing-layer')!.append(el); s.rebuildShapesFromDOM(); s.saveHistory();
    const { showExportDialog } = await import('/src/ui/export-dialog.ts'); showExportDialog(s);
    return document.getElementById('drawing-layer')!.innerHTML;
  });
  await page.locator('#export-dialog-overlay select').first().selectOption('glb');
  const dialog = page.locator('#glb-dialog-overlay');
  await dialog.getByLabel('Scope', { exact: true }).selectOption('document');
  await dialog.locator('summary').filter({hasText: /^Details/}).click();
  await dialog.getByLabel('Texture resolution', { exact: true }).selectOption('512');
  await dialog.getByLabel('Thickness', { exact: true }).fill('0');
  await dialog.getByRole('button', { name: 'Build preview' }).click();
  await expect(dialog.getByRole('status')).toContainText('positive finite');
  await dialog.getByLabel('Thickness', { exact: true }).fill('2');
  await dialog.getByRole('button', { name: 'Build preview' }).click();
  await expect(dialog.getByRole('status')).toContainText('triangles');
  await expect(dialog.getByRole('button', { name: 'Export GLB' })).toBeEnabled();
  await page.screenshot({ path: 'test-results/glb-dialog.png' });
  const download = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Export GLB' }).click();
  expect((await download).suggestedFilename()).toBe('model.glb');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.locator('#drawing-layer').innerHTML()).toBe(before); expect(errors).toEqual([]);
});

test('outlined strokes, text, object-bounding-box clips and validation errors', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { buildGlb } = await import('/src/core/glb-export.ts'); const { defaultGlbOptions } = await import('/src/core/glb-options.ts');
    const o = defaultGlbOptions(); o.color = 'solid'; o.resolution = 512;
    const make = async (content: string) => buildGlb({ svg: `<svg xmlns="http://www.w3.org/2000/svg"><g data-glb-content="true">${content}</g></svg>`, fonts: [], selected: [], layers: [], frames: [] }, o);
    const stroke = await make('<path fill="none" stroke="black" stroke-width="10" stroke-linecap="round" d="M0 0H100"/>');
    const strokeHeight = stroke.height; stroke.dispose();
    const dashed = await make('<path fill="none" stroke="black" stroke-width="10" stroke-dasharray="10 10" d="M0 0H100"/>');
    const dashes = dashed.object.children.length; dashed.dispose();
    const clipped = await make('<defs><clipPath id="c" clipPathUnits="objectBoundingBox"><rect width=".5" height="1"/></clipPath></defs><rect x="10" y="20" width="100" height="50" transform="rotate(90)" clip-path="url(#c)"/>');
    const clipHeight = clipped.height; clipped.dispose();
    const text = await make('<text x="0" y="40" font-family="Inter" font-size="40">B</text>'); const textTriangles = text.triangles; text.dispose();
    const failures: string[] = [];
    o.geometry = 'deleted'; try { await make('<rect width="10" height="10"/>'); } catch (e) { failures.push(String(e)); }
    o.geometry = ''; o.thickness = NaN; try { await make('<rect width="10" height="10"/>'); } catch (e) { failures.push(String(e)); }
    return { strokeHeight, clipHeight, textTriangles, failures, dashes };
  });
  expect(result.strokeHeight).toBeCloseTo(100 * 10 / 110, 2); expect(result.clipHeight).toBeCloseTo(100, 2);
  expect(result.textTriangles).toBeGreaterThan(12); expect(result.failures[0]).toContain('missing'); expect(result.failures[1]).toContain('positive finite');
  expect(result.dashes).toBe(5);
});

test('channel inversion and transparency fallback are numerical data', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { materialValue } = await import('/src/core/glb-material.ts');
    const data = new Uint8ClampedArray([0,128,255,128]);
    return ['r','g','b','a'].map(channel => materialValue(data, 0, { source: 'map', channel: channel as any, invert: true, fallback: .25 }));
  });
  expect(result[0]).toBeCloseTo(128/255 + 127/255*.25, 6);
  expect(result[1]).toBeCloseTo(128/255*(1-128/255)+127/255*.25, 6);
  expect(result[2]).toBeCloseTo(127/255*.25, 6); expect(result[3]).toBeCloseTo(127/255, 6);
});

test('adversarial cases: nested clips, SVG viewports, lengths and visibility overrides', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { buildGlb } = await import('/src/core/glb-export.ts'); const { defaultGlbOptions } = await import('/src/core/glb-options.ts');
    const o = defaultGlbOptions(); o.color = 'solid'; o.resolution = 512;
    const cases = [
      '<defs><clipPath id="a"><rect width="100" height="100"/></clipPath><clipPath id="b" clip-path="url(#a)"><rect width="200" height="100"/></clipPath></defs><rect width="200" height="100" clip-path="url(#b)"/>',
      '<svg width="50" height="100"><rect width="100" height="100"/></svg>',
      '<rect width="100%" height="100%"/>',
      '<rect width="20mm" height="10mm"/>',
      '<g visibility="hidden"><rect width="100" height="100" visibility="visible"/></g>',
    ];
    const heights = [];
    for (const content of cases) {
      const m = await buildGlb({ svg: `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><g data-glb-content="true">${content}</g></svg>`, fonts: [], selected: [], layers: [], frames: [] }, o);
      heights.push(m.height); m.dispose();
    }
    return heights;
  });
  expect(result).toEqual([100,200,50,50,100]);
});

test('solid silhouette caps an unfilled closed outline for raster artwork; painted mode stays hollow', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { buildGlb } = await import('/src/core/glb-export.ts'); const { defaultGlbOptions } = await import('/src/core/glb-options.ts');
    const image = document.createElement('canvas'); image.width = 2; image.height = 1;
    const ctx = image.getContext('2d')!; ctx.fillStyle = '#336699'; ctx.fillRect(0,0,2,1);
    const snapshot = { svg: `<svg xmlns="http://www.w3.org/2000/svg"><g data-glb-content="true"><image id="photo" width="100" height="50" href="${image.toDataURL()}"/><path id="outline" fill="none" stroke="magenta" stroke-width=".5" d="M0 0H100V50H0Z"/></g></svg>`, fonts: [], selected: [], layers: [], frames: [] };
    const o = defaultGlbOptions(); o.geometry = 'outline'; o.color = 'photo'; o.resolution = 512;
    const areas = [];
    for (const mode of ['silhouette','painted'] as const) {
      o.geometryMode = mode; const m = await buildGlb(snapshot,o); let front = 0, back = 0;
      for (const object of m.object.children) {
        const mesh = object as any, p = mesh.geometry.getAttribute('position'), n = mesh.geometry.getAttribute('normal');
        for(let i=0;i<p.count;i+=3) {
          const area = Math.abs((p.getX(i+1)-p.getX(i))*(p.getY(i+2)-p.getY(i))-(p.getY(i+1)-p.getY(i))*(p.getX(i+2)-p.getX(i)))/2;
          if(n.getZ(i)>.99) front+=area; if(n.getZ(i)<-.99) back+=area;
        }
      }
      const material = (m.object.children[0] as any).material[0];
      const pixel = [...material.map.image.getContext('2d').getImageData(256,128,1,1).data];
      areas.push({front,back,pixel}); m.dispose();
    }
    return areas;
  });
  expect(result[0].front).toBeCloseTo(.005,7); expect(result[0].back).toBeCloseTo(.005,7);
  expect(result[0].pixel).toEqual([51,102,153,255]); expect(result[1].front).toBeLessThan(result[0].front/20);
});
