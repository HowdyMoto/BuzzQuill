import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.waitForFunction(() => !!(window as any).state); });

async function installImage(page: any) {
  await page.evaluate(async () => {
    const createUrl = URL.createObjectURL.bind(URL);
    (window as any).testBlobs = new Map();
    URL.createObjectURL = blob => { const url = createUrl(blob); (window as any).testBlobs.set(url, blob); return url; };
    const a = await import('/src/core/raster-assets.ts');
    const c = document.createElement('canvas'); c.width = 5000; c.height = 1200;
    const ctx = c.getContext('2d')!;
    for (let x = 0; x < c.width; x++) { ctx.fillStyle = x % 2 ? 'rgba(255,255,255,.5)' : 'rgba(0,0,0,.5)'; ctx.fillRect(x, 0, 1, c.height); }
    const blob = await new Promise<Blob>(r => c.toBlob(b => r(b!))); c.width = c.height = 0;
    const id = await a.prepareAsset(new File([blob], 'stripes.png', { type: 'image/png' }));
    const state = (window as any).state;
    state.importSVGContent('<svg xmlns="http://www.w3.org/2000/svg"><image width="5000" height="1200" preserveAspectRatio="none"/></svg>');
    const el = document.querySelector('#drawing-layer image')!; a.attachAsset(el, id);
    (window as any).baseHref = el.getAttribute('href');
    state.saveHistory(); state.onChange_public();
  });
  await page.waitForFunction(() => document.querySelector('#drawing-layer image')!.getAttribute('href') !== (window as any).baseHref);
}

test('close zoom uses native visible pixels, preserves alpha, and never saves display crops', async ({ page }) => {
  await installImage(page);
  const result = await page.evaluate(async () => {
    const a = await import('/src/core/raster-assets.ts');
    const el = document.querySelector('#drawing-layer image')!;
    const href = el.getAttribute('href')!;
    const svg = await (window as any).testBlobs.get(href).text();
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const patch = parsed.querySelectorAll('image')[1];
    const x = Number(patch.getAttribute('x')), y = Number(patch.getAttribute('y'));
    const w = Number(patch.getAttribute('width')), h = Number(patch.getAttribute('height'));
    const image = new Image(); image.src = href; await image.decode();
    const c = document.createElement('canvas'); c.width = 100; c.height = 1;
    c.getContext('2d')!.drawImage(image, x + 10, y + 10, 100, 1, 0, 0, 100, 1);
    const data = c.getContext('2d')!.getImageData(0, 0, 100, 1).data;
    const correct = Array.from({ length: 100 }, (_, i) => Math.abs(data[i*4] - ((x+10+i)%2 ? 255 : 0)) <= 1 && Math.abs(data[i*4+3] - 128) <= 1).every(Boolean);
    const bytes = Uint8Array.from(atob(patch.getAttribute('href')!.split(',')[1]), c => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const native = bitmap.width === w && bitmap.height === h; bitmap.close();
    const compact = (await import('/src/ui/project-file.ts')).serializeDocumentSVG((window as any).state);
    return { correct, native, w, h, stats: a.assetStats(), compact: compact.length, noCrop: !compact.includes('outside') && !compact.includes('blob:') };
  });
  expect(result.correct).toBe(true); expect(result.native).toBe(true);
  expect(result.w).toBeLessThan(5000); expect(result.w * result.h).toBeLessThan(8 * 1024 * 1024);
  expect(result.compact).toBeLessThan(10000); expect(result.noCrop).toBe(true);
});

test('wheel zoom retains sufficient detail and off-screen views release it', async ({ page }) => {
  await installImage(page);
  const box = await page.locator('#svg-canvas').boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -150);
  await expect(page.locator('#drawing-layer image')).not.toHaveAttribute('href', await page.evaluate(() => (window as any).baseHref));
  await page.waitForTimeout(600);
  await page.evaluate(async () => {
    document.getElementById('svg-canvas')!.setAttribute('viewBox', '20000 20000 1000 1000');
    (await import('/src/core/raster-assets.ts')).scheduleRasterDetail();
  });
  await expect(page.locator('#drawing-layer image')).toHaveAttribute('href', await page.evaluate(() => (window as any).baseHref));
  expect(await page.evaluate(async () => (await import('/src/core/raster-assets.ts')).assetStats().urls)).toBe(1);
});


test('transformed copies get their own correctly positioned source crops', async ({ page }) => {
  await installImage(page);
  await page.evaluate(async () => {
    const el = document.querySelector('#drawing-layer image')!;
    const copy = el.cloneNode() as Element; copy.id = 'copy';
    copy.setAttribute('transform', 'translate(700 500) rotate(180)');
    el.parentElement!.append(copy);
    (await import('/src/core/raster-assets.ts')).scheduleRasterDetail();
  });
  await expect.poll(() => page.evaluate(async () => (await import('/src/core/raster-assets.ts')).assetStats().detailCount)).toBe(2);
  const results = await page.evaluate(async () => {
    const images = [...document.querySelectorAll<SVGImageElement>('#drawing-layer image')];
    const results = [];
    for (const el of images) {
      const blob = (window as any).testBlobs.get(el.getAttribute('href'));
      const parsed = new DOMParser().parseFromString(await blob.text(), 'image/svg+xml');
      const patch = parsed.querySelectorAll('image')[1];
      const x = Number(patch.getAttribute('x')), y = Number(patch.getAttribute('y'));
      const width = Number(patch.getAttribute('width')), height = Number(patch.getAttribute('height'));
      const v = document.getElementById('canvas-area')!.getBoundingClientRect();
      const source = new DOMPoint(v.left + v.width/2, v.top + v.height/2).matrixTransform(el.getScreenCTM()!.inverse());
      results.push({ inside: source.x >= x && source.x <= x+width && source.y >= y && source.y <= y+height, width });
    }
    return { results, distinct: images[0].getAttribute('href') !== images[1].getAttribute('href') };
  });
  expect(results.distinct).toBe(true); expect(results.results.every(r => r.inside)).toBe(true);
});


test('actual aerial tiles retain native detail while panning with bounded resident crops', async ({ page }, info) => {
  test.skip(!process.env.BQ_AERIAL_DETAIL, 'Optional local aerial detail check'); test.setTimeout(180000);
  const svg = await readFile('D:/tmp/nurburgring-aerial/out/trace-on-20cm-tiles.svg', 'utf8');
  await page.evaluate(async svg => (await import('/src/ui/project-file.ts')).loadDocumentSVG((window as any).state, svg), svg);
  await page.getByRole('button', { name: 'Locate images…' }).click();
  const picker = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Choose folder…', exact: true }).click();
  await (await picker).setFiles('D:/tmp/nurburgring-aerial/out/full-20cm');
  await page.locator('#linked-image-quality').selectOption('original');
  await page.getByRole('button', { name: 'Add 49 images', exact: true }).click();
  await expect(page.locator('.linked-images-banner')).toBeHidden({ timeout: 90000 });
  const cdp = await page.context().newCDPSession(page);
  const nativeMemory = async () => {
    if (process.platform !== 'win32') return null;
    const browser = await page.context().browser()!.newBrowserCDPSession();
    const processes = await browser.send('SystemInfo.getProcessInfo'); await browser.detach();
    const ids = processes.processInfo.filter((p: any) => p.type === 'renderer').map((p: any) => Number(p.id)).filter(Number.isInteger);
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process -Id ${ids.join(',')} | Select-Object Id,PrivateMemorySize64,WorkingSet64 | ConvertTo-Json -Compress`], { encoding: 'utf8' }));
  };
  await cdp.send('HeapProfiler.collectGarbage'); const before = await nativeMemory();
  const samples = [];
  for (const index of [0, 1, 8, 9, 16, 17, 24, 25, 32, 33, 40, 41]) {
    await page.evaluate(index => {
      const image = document.querySelectorAll<SVGImageElement>('#drawing-layer image')[index];
      const x = image.x.baseVal.value + image.width.baseVal.value / 2;
      const y = image.y.baseVal.value + image.height.baseVal.value / 2;
      document.getElementById('svg-canvas')!.setAttribute('viewBox', `${x-50} ${y-40} 100 80`);
    }, index);
    await page.evaluate(async () => (await import('/src/core/raster-assets.ts')).scheduleRasterDetail());
    await page.waitForTimeout(650);
    const stats = await page.evaluate(async () => (await import('/src/core/raster-assets.ts')).assetStats());
    expect(stats.detailCount).toBeGreaterThan(0); expect(stats.detailPixels).toBeLessThanOrEqual(stats.detailBudget);
    samples.push(stats);
  }
  await cdp.send('HeapProfiler.collectGarbage'); const after = await nativeMemory();
  await info.attach('native-detail-memory', { body: JSON.stringify({ before, after, samples }, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('native-aerial-detail.png') });
  expect(samples.every(s => s.count === 49)).toBe(true);
  expect(samples.at(-1)!.detailPixels).toBeLessThan(2 * 1024 * 1024);
  console.log('AERIAL DETAIL MEMORY', JSON.stringify({ before, after, last: samples.at(-1) }));
});


test('EXIF-rotated JPEG detail uses the same source regions as the displayed image', async ({ page }) => {
  await page.evaluate(async () => {
    const create = URL.createObjectURL.bind(URL); (window as any).testBlobs = new Map();
    URL.createObjectURL = blob => { const url = create(blob); (window as any).testBlobs.set(url, blob); return url; };
    const c = document.createElement('canvas'); c.width = 200; c.height = 100;
    const ctx = c.getContext('2d')!; ctx.fillStyle = 'red'; ctx.fillRect(0,0,100,100); ctx.fillStyle = 'blue'; ctx.fillRect(100,0,100,100);
    const jpeg = await new Promise<Blob>(r => c.toBlob(b => r(b!), 'image/jpeg', 1));
    const raw = new Uint8Array(await jpeg.arrayBuffer());
    const exif = new Uint8Array([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0]);
    const a = await import('/src/core/raster-assets.ts');
    const id = await a.prepareAsset(new File([raw.slice(0,2), exif, raw.slice(2)], 'rotated.jpg', { type: 'image/jpeg' }));
    (window as any).state.importSVGContent('<svg xmlns="http://www.w3.org/2000/svg"><image width="600" height="1200"/></svg>');
    a.attachAsset(document.querySelector('#drawing-layer image')!, id);
  });
  for (const [y, channel] of [[0, 0], [600, 2]]) {
    const before = await page.locator('#drawing-layer image').getAttribute('href');
    await page.evaluate(async y => {
      document.getElementById('svg-canvas')!.setAttribute('viewBox', `0 ${y} 600 300`);
      (await import('/src/core/raster-assets.ts')).scheduleRasterDetail();
    }, y);
    await expect(page.locator('#drawing-layer image')).not.toHaveAttribute('href', before!);
    const pixel = await page.evaluate(async () => {
      const href = document.querySelector('#drawing-layer image')!.getAttribute('href');
      const svg = await (window as any).testBlobs.get(href).text();
      const patch = new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('image')[1];
      const bytes = Uint8Array.from(atob(patch.getAttribute('href')!.split(',')[1]), c => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const c = document.createElement('canvas'); c.width = c.height = 1;
      c.getContext('2d')!.drawImage(bitmap, Math.floor(bitmap.width/2), Math.floor(bitmap.height/2), 1, 1, 0, 0, 1, 1);
      bitmap.close(); return [...c.getContext('2d')!.getImageData(0,0,1,1).data];
    });
    expect(pixel[channel]).toBeGreaterThan(250); expect(pixel[channel === 0 ? 2 : 0]).toBeLessThan(4);
  }
});

test('nearby pans reuse sharp pixels without decoding the source again', async ({ page }) => {
  await installImage(page);
  const href = await page.locator('#drawing-layer image').getAttribute('href');
  await page.evaluate(() => {
    const decode = window.createImageBitmap.bind(window);
    (window as any).panDecodes = 0;
    window.createImageBitmap = ((...args: any[]) => {
      (window as any).panDecodes++;
      return (decode as any)(...args);
    }) as typeof createImageBitmap;
  });
  for (let i = 0; i < 5; i++) {
    await page.evaluate(async () => {
      const svg = document.getElementById('svg-canvas')!;
      const box = svg.getAttribute('viewBox')!.split(/[ ,]+/).map(Number);
      box[0] += 10;
      svg.setAttribute('viewBox', box.join(' '));
      (await import('/src/core/raster-assets.ts')).scheduleRasterDetail();
    });
    await page.waitForTimeout(350); // beyond the settled-view debounce
  }
  const decodes = await page.evaluate(() => (window as any).panDecodes);
  console.log('PAN SOURCE DECODES', decodes);
  expect(decodes).toBe(0);
  await expect(page.locator('#drawing-layer image')).toHaveAttribute('href', href!);
  await page.evaluate(async () => {
    document.getElementById('svg-canvas')!.setAttribute('viewBox', '2500 0 1000 800');
    (await import('/src/core/raster-assets.ts')).scheduleRasterDetail();
  });
  await expect(page.locator('#drawing-layer image')).not.toHaveAttribute('href', href!);
  expect(await page.evaluate(() => (window as any).panDecodes)).toBeGreaterThan(0);
});

test('a view update during decode retains a still-useful result', async ({ page }) => {
  await page.evaluate(() => {
    const decode = window.createImageBitmap.bind(window);
    (window as any).detailDecodes = 0;
    window.createImageBitmap = (async (...args: any[]) => {
      if (args.length >= 5) {
        (window as any).detailDecodes++;
        setTimeout(() => {
          const svg = document.getElementById('svg-canvas')!;
          const box = svg.getAttribute('viewBox')!.split(/[ ,]+/).map(Number); box[0] += 10;
          svg.setAttribute('viewBox', box.join(' '));
          (window as any).state.onChange_public();
        }, 20);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return (decode as any)(...args);
    }) as typeof createImageBitmap;
  });
  await installImage(page);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).detailDecodes)).toBe(1);
});
