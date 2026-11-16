import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const validator = createRequire(import.meta.url)('gltf-validator');

test('frame GLB target: sidebar settings, material editor, saved SVG roundtrip and named export', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => { delete (window as any).showSaveFilePicker; delete (window as any).showDirectoryPicker; });
  await page.goto('/'); await page.waitForFunction(() => (window as any).state);
  await page.evaluate(() => {
    const s = (window as any).state;
    const fid = s.addFrame(100,100,100,50,'Badge');
    const rect = document.createElementNS('http://www.w3.org/2000/svg','rect'); rect.id = s.nextId();
    rect.setAttribute('width','100'); rect.setAttribute('height','50'); rect.setAttribute('fill','#d84c33'); rect.setAttribute('data-name','Badge pivot');
    document.getElementById(fid)!.append(rect); s.rebuildShapesFromDOM();
    s.setFrameExportTargets(fid,[{format:'svg',name:'badge-model',scale:1}],true); s.selectShape(fid);
  });
  const row = page.locator('.fp-target-wrap').first();
  await row.locator('.fp-target-fmt').click();
  await page.locator('.context-menu-item').filter({ hasText: /^GLB$/ }).click();
  await expect(row.locator('.fp-target-fmt')).toHaveText('GLB');
  await expect(row.locator('.fp-target-size')).toHaveValue('3D');
  await row.getByRole('button', {name:'Export options',exact:true}).click();
  await row.getByLabel('Width', {exact:true}).fill('100'); await row.getByLabel('Thickness',{exact:true}).click();
  await row.getByLabel('Thickness',{exact:true}).fill('5');
  await row.getByRole('button',{name:'Materials & 3D preview'}).click();
  const dialog = page.locator('#glb-dialog-overlay');
  await expect(dialog.getByLabel('Scope',{exact:true})).toBeDisabled();
  await expect(dialog.getByLabel('Thickness',{exact:true})).toHaveValue('5');
  await dialog.locator('summary').filter({hasText: /^Pivot/}).click();
  await dialog.getByLabel('Pivot object',{exact:true}).selectOption({label:'Badge pivot'});
  const pivotId=await dialog.getByLabel('Pivot object',{exact:true}).inputValue();
  await dialog.locator('summary').filter({hasText: /^Details/}).click();
  await dialog.getByLabel('Texture resolution',{exact:true}).selectOption('512');
  await dialog.getByLabel('Metallic value',{exact:true}).fill('0.8');
  await dialog.getByRole('button',{name:'Build preview'}).click();
  await expect(dialog.getByRole('button',{name:'Save frame settings'})).toBeEnabled();
  await dialog.getByRole('button',{name:'Save frame settings'}).click();
  await expect(dialog).toHaveCount(0);
  const settings = await page.evaluate(async () => {
    const s = (window as any).state;
    const {serializeDocumentSVG,loadDocumentSVG} = await import('/src/core/document-codec.ts');
    const xml = serializeDocumentSVG(s); loadDocumentSVG(s,xml);
    const frame = s.artboards.find((f: any) => f.name === 'Badge'); s.selectShape(frame.id);
    return s.getFrameExportTargets(frame.id)[0];
  });
  expect(settings.glb.pivot).toBe(pivotId);
  expect(settings.format).toBe('glb'); expect(settings.glb.width).toBe(100); expect(settings.glb.thickness).toBe(5); expect(settings.glb.metallic.fallback).toBe(.8);
  await page.screenshot({path:'test-results/frame-glb-options.png'});
  const downloaded = page.waitForEvent('download'); await page.locator('#fp-export-btn').click(); const file = await downloaded;
  expect(file.suggestedFilename()).toBe('badge-model.glb');
  const chunks: Buffer[] = []; for await (const chunk of await file.createReadStream()) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks); const report = await validator.validateBytes(bytes);
  expect(report.issues.numErrors,JSON.stringify(report.issues)).toBe(0);
  const jsonLength = bytes.readUInt32LE(12); const gltf = JSON.parse(bytes.subarray(20,20+jsonLength).toString());
  const positions = gltf.meshes.flatMap((m: any) => m.primitives.map((p: any) => gltf.accessors[p.attributes.POSITION]));
  expect(Math.max(...positions.map((p: any) => p.max[0])) - Math.min(...positions.map((p: any) => p.min[0]))).toBeCloseTo(.1,6);
  expect(Math.max(...positions.map((p: any) => p.max[2])) - Math.min(...positions.map((p: any) => p.min[2]))).toBeCloseTo(.005,6);
  expect(gltf.materials.find((m: any) => m.name === 'Artwork').pbrMetallicRoughness.metallicFactor).toBe(.8);
  expect(errors).toEqual([]);
});

test('duplicating a frame remaps internal material and geometry references', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => (window as any).state);
  const result = await page.evaluate(async () => {
    const s = (window as any).state; const fid = s.addFrame(0,0,100,100,'Original');
    const el = document.createElementNS('http://www.w3.org/2000/svg','rect'); el.id = s.nextId(); el.setAttribute('width','100'); el.setAttribute('height','100'); document.getElementById(fid)!.append(el); s.rebuildShapesFromDOM();
    const {frameGlbOptions} = await import('/src/core/glb-options.ts'); const o = frameGlbOptions(fid,100); o.geometry=el.id; o.color=el.id; o.pivot=el.id; o.roughness.source=el.id; o.metallic.source='external-reference';
    s.setFrameExportTargets(fid,[{format:'glb',name:'duplicate',scale:1,glb:o},{format:'glb',name:'whole-frame',scale:1,glb:{...o,geometry:fid,color:fid,pivot:fid}}],true); s.selectShape(fid); s.duplicateSelected();
    const copy = s.selectedShapeIds[0], target = s.getFrameExportTargets(copy)[0];
    return { copy, child: document.getElementById(copy)!.querySelector('rect[id]')!.id, glb: target.glb, whole: s.getFrameExportTargets(copy)[1].glb };
  });
  expect(result.glb.pivot).toBe(result.child); expect(result.whole.pivot).toBe(result.copy); expect(result.glb.scope).toBe(result.copy); expect(result.glb.geometry).toBe(result.child); expect(result.glb.color).toBe(result.child); expect(result.glb.roughness.source).toBe(result.child); expect(result.glb.metallic.source).toBe('external-reference');
  expect(result.whole.geometry).toBe(result.copy); expect(result.whole.color).toBe(result.copy);
});

test('mixed GLB and SVG targets share the initiating document snapshot', async ({ page }) => {
  await page.addInitScript(() => { delete (window as any).showSaveFilePicker; delete (window as any).showDirectoryPicker; });
  await page.goto('/'); await page.waitForFunction(() => (window as any).state);
  const downloads: import('@playwright/test').Download[] = []; page.on('download', file => downloads.push(file));
  await page.evaluate(async () => {
    const s=(window as any).state; const fid=s.addFrame(0,0,100,50,'Captured');
    const rect=document.createElementNS('http://www.w3.org/2000/svg','rect'); rect.id=s.nextId(); rect.setAttribute('width','100'); rect.setAttribute('height','50'); rect.setAttribute('fill','#123456'); document.getElementById(fid)!.append(rect); s.rebuildShapesFromDOM();
    const {frameGlbOptions}=await import('/src/core/glb-options.ts'); const glb=frameGlbOptions(fid,100); glb.color='solid'; glb.resolution=512;
    const {exportFrameTargets}=await import('/src/ui/export-dialog.ts');
    const exporting=exportFrameTargets(s,s.getArtboardById(fid),[{format:'glb',name:'captured',scale:1,glb},{format:'svg',name:'captured',scale:1}]);
    rect.setAttribute('fill','#abcdef'); s.rebuildShapesFromDOM(); s.saveHistory();
    await exporting;
  });
  await expect.poll(() => downloads.length).toBe(2);
  const file = downloads.find(d => d.suggestedFilename().endsWith('.svg'))!;
  const chunks: Buffer[]=[]; for await(const c of await file.createReadStream()) chunks.push(c as Buffer);
  const svg=Buffer.concat(chunks).toString(); expect(svg).toContain('#123456'); expect(svg).not.toContain('#abcdef');
});
