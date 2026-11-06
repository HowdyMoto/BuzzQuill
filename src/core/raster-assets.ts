import { detailEvictions } from './raster-detail-budget';
/** Image bytes live once, outside editable SVG/history. Only previews enter the live DOM. */
export const ASSET_ATTR = 'data-bq-raster';
export interface RasterAsset { id: string; original: Blob; preview: Blob; width: number; height: number; previewPending?: boolean; }
interface LiveAsset extends RasterAsset { url: string; }
const assets = new Map<string, LiveAsset>();
const roots = new Set<() => Iterable<string>>();
const preparing = new Set<string>();
const pins = new Map<string, number>();
const XLINK = 'http://www.w3.org/1999/xlink';
export const PREVIEW_EDGE = 512;
export function assetRoots(get: () => Iterable<string>): void { roots.add(get); }
export function assetIds(markup: string): string[] {
  return [...markup.matchAll(/data-bq-raster=\\?(?:"|&quot;)([a-zA-Z0-9-]+)\\?(?:"|&quot;)/g)].map(m => m[1]);
}
export function assetSnapshot(markups: Iterable<string>): RasterAsset[] {
  const ids = new Set([...markups].flatMap(assetIds));
  return [...ids].map(id => {
    const a = assets.get(id); if (!a) throw new Error('An original image is unavailable. Please locate it again before saving.');
    return { id, original: a.original, preview: a.preview, width: a.width, height: a.height, previewPending: a.previewPending };
  });
}
export function restoreAssets(records: RasterAsset[]): void {
  for (const a of records) if (!assets.has(a.id)) {
    assets.set(a.id, { ...a, url: URL.createObjectURL(a.preview) });
    if (a.previewPending) { previewQueue.add(a.id); void drainPreviews(); }
  }
}
export function collectAssets(): void {
  const retained = new Set<string>([...pins.keys(), ...preparing]);
  for (const get of roots) for (const text of get()) for (const id of assetIds(text)) retained.add(id);
  for (const el of document.querySelectorAll(`[${ASSET_ATTR}]`)) retained.add(el.getAttribute(ASSET_ATTR)!);
  for (const [id, a] of assets) if (!retained.has(id)) { URL.revokeObjectURL(a.url); discardDetails(id); assets.delete(id); }
}
export function pinAssets(markup: string): () => void {
  const ids = [...new Set(assetIds(markup))];
  for (const id of ids) pins.set(id, (pins.get(id) ?? 0) + 1);
  return () => { for (const id of ids) { const n = (pins.get(id) ?? 1) - 1; if (n) pins.set(id, n); else pins.delete(id); } };
}
export function forgetAsset(id: string): void {
  preparing.delete(id);
  const a = assets.get(id); if (a) URL.revokeObjectURL(a.url); discardDetails(id); assets.delete(id);
}
export function bindAssets(root: Element): void {
  const images = [...root.querySelectorAll(`image[${ASSET_ATTR}]`)];
  if (root.localName === 'image' && root.hasAttribute(ASSET_ATTR)) images.push(root);
  for (const el of images) {
    const a = assets.get(el.getAttribute(ASSET_ATTR)!);
    if (el.isConnected && a) preparing.delete(a.id);
    if (!a) continue;
    const detail = details.get(el);
    const url = detail?.id === a.id ? detail.url : a.url;
    if (el.getAttribute('href') !== url) el.setAttribute('href', url);
    el.removeAttributeNS(XLINK, 'href');
  }
}
export function attachAsset(el: Element, id: string): void {
  preparing.delete(id);
  el.setAttribute(ASSET_ATTR, id); el.removeAttribute('data-bq-image-href'); bindAssets(el);
}
export async function dimensions(file: Blob): Promise<{ width: number; height: number; orientation?: number } | null> {
  return dimensionsFromBytes(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()));
}
function dimensionsFromBytes(b: Uint8Array): { width: number; height: number; orientation?: number } | null {
  const view = new DataView(b.buffer);
  if (b.length >= 10 && b[0] === 71 && b[1] === 73 && b[2] === 70) return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (b.length >= 24 && view.getUint32(0) === 0x89504e47) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2, orientation = 1;
    while (i + 8 < b.length) {
      if (b[i++] !== 0xff) break;
      while (b[i] === 0xff) i++;
      const marker = b[i++];
      if (marker === 0xda || marker === 0xd9) break;
      const length = view.getUint16(i);
      if (marker === 0xe1 && i + length <= b.length && length > 16 && view.getUint32(i + 2) === 0x45786966) {
        const tiff = i + 8; const little = view.getUint16(tiff) === 0x4949;
        const ifd = tiff + view.getUint32(tiff + 4, little);
        if (ifd + 2 <= i + length) {
          const count = view.getUint16(ifd, little);
          for (let n = 0; n < count; n++) {
            const entry = ifd + 2 + n * 12; if (entry + 12 > i + length) break;
            if (view.getUint16(entry, little) === 0x0112) orientation = view.getUint16(entry + 8, little);
          }
        }
      }
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker))
        return orientation >= 5 && orientation <= 8
          ? { width: view.getUint16(i + 3), height: view.getUint16(i + 5), orientation }
          : { width: view.getUint16(i + 5), height: view.getUint16(i + 3), orientation };
      if (length < 2) break; i += length;
    }
  }
  return null;
}
async function makePreview(file: Blob, edge = PREVIEW_EDGE): Promise<{ preview: Blob; width: number; height: number }> {
  const size = await dimensions(file);
  const scale = size ? Math.min(1, edge / Math.max(size.width, size.height)) : 1;
  const bitmap = await createImageBitmap(file, size ? {
    resizeWidth: Math.max(1, Math.round(size.width * scale)), resizeHeight: Math.max(1, Math.round(size.height * scale)), resizeQuality: 'high',
  } : undefined);
  const width = size?.width ?? bitmap.width, height = size?.height ?? bitmap.height;
  const actualScale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * actualScale)); canvas.height = Math.max(1, Math.round(bitmap.height * actualScale));
  try {
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const preview = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Image preview failed')), 'image/png'));
    return { preview, width, height };
  } finally { bitmap.close(); canvas.width = canvas.height = 0; }
}
export async function prepareAsset(file: File): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const mime = ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif' } as Record<string, string>)[ext];
  if (!mime) throw new Error('Unsupported image format');
  const result = await makePreview(file);
  const id = crypto.randomUUID(); preparing.add(id);
  restoreAssets([{ id, original: file.slice(0, file.size, mime), ...result }]); return id;
}
/** Runtime URLs are neither durable nor portable. Keep only the asset identity. */
export function compactAssets(markup: string): string {
  return markup.replace(/<(?:[\w-]+:)?image\b[^>]*>/g, tag => tag.includes(`${ASSET_ATTR}=`)
    ? tag.replace(/\s(?:xlink:)?href="[^"]*"/g, '') : tag);
}
/** Build a portable SVG as Blob parts, avoiding a single enormous JS string. */
export async function portableSvg(markup: string, previews = false): Promise<Blob> {
  const records = new Map(assetSnapshot([markup]).map(a => [a.id, a]));
  markup = markup.replace(/<[^>]*>/g, tag => /^<(?:[\w-]+:)?image\b/.test(tag) ? tag : tag.replace(/\sdata-bq-raster="[^"]*"/g, ''));
  // Library paint/pattern presets carry escaped SVG inside their JSON metadata.
  for (const match of [...markup.matchAll(/<metadata\b[^>]*\bdata-assets="[^"]*"[^>]*>/g)]) {
    const carrier = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${match[0]}</metadata></svg>`, 'image/svg+xml').querySelector('metadata');
    if (!carrier || !assetIds(carrier.getAttribute('data-assets') ?? '').length) continue;
    const expand = async (value: unknown): Promise<unknown> => {
      if (typeof value === 'string' && value.includes('data-bq-raster=')) return await (await portableSvg(value, previews)).text();
      if (Array.isArray(value)) return await Promise.all(value.map(expand));
      if (value && typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) result[key] = await expand(child);
        return result;
      }
      return value;
    };
    const payload = await expand(JSON.parse(carrier.getAttribute('data-assets')!));
    carrier.setAttribute('data-assets', JSON.stringify(payload));
    markup = markup.replace(match[0], carrier.outerHTML.replace(/<\/metadata>$/, ''));
  }
  const parts: BlobPart[] = []; let offset = 0;
  for (const match of markup.matchAll(/<(?:[\w-]+:)?image\b[^>]*>/g)) {
    const tag = match[0], id = assetIds(tag)[0]; if (!id) continue;
    const a = records.get(id)!;
    parts.push(markup.slice(offset, match.index));
    const clean = tag.replace(/\s(?:xlink:)?href="[^"]*"/g, '').replace(/\sdata-bq-raster="[^"]*"/g, '');
    const end = clean.endsWith('/>') ? '/>' : '>';
    parts.push(clean.slice(0, -end.length), ' href="');
    // Each original is encoded independently and immediately moved into a Blob.
    // Even a >512MB SVG never requires a >512MB string.
    const encoded = await new Promise<string>((resolve, reject) => {
      const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(previews ? a.preview : a.original);
    });
    parts.push(new Blob([encoded]), '"', end); offset = match.index! + tag.length;
  }
  parts.push(markup.slice(offset)); return new Blob(parts, { type: 'image/svg+xml' });
}
export function assetStats() {
  return { detailPixels: [...details.values()].reduce((n, d) => n + d.pixels, 0), detailBudget: DETAIL_PIXELS, detailCount: details.size, count: assets.size, originalBytes: [...assets.values()].reduce((n, a) => n + a.original.size, 0),
    previewPixelUpperBound: assets.size * PREVIEW_EDGE * PREVIEW_EDGE + [...details.values()].reduce((n, d) => n + d.pixels, 0), urls: assets.size + details.size };
}

/** Cached detail is per visible image instance, never a full-resolution document-wide bitmap. */
const DETAIL_PIXELS = 32 * 1024 * 1024;
interface DetailPlan { id: string; x: number; y: number; w: number; h: number; width: number; height: number; key: string; }
const details = new Map<Element, { id: string; url: string; key: string; pixels: number }>();
let detailTimer: number | undefined;
let detailGeneration = 0;
let detailWorking = false;
function discardDetails(id?: string): void {
  for (const [el, detail] of details) if (!id || detail.id === id) {
    URL.revokeObjectURL(detail.url); details.delete(el);
  }
}
export function scheduleRasterDetail(): void {
  detailGeneration++;
  window.clearTimeout(detailTimer);
  detailTimer = window.setTimeout(() => { void refreshDetail(); }, 180);
}
/** Map the viewport through the image's full transform, including aspect-ratio fitting. */
function detailPlan(el: SVGImageElement, asset: LiveAsset, viewport: DOMRect): DetailPlan | null {
  if (asset.previewPending || !asset.width || !asset.height) return null;
  const box = el.getBoundingClientRect();
  if (box.right <= viewport.left || box.left >= viewport.right || box.bottom <= viewport.top || box.top >= viewport.bottom) return null;
  const matrix = el.getScreenCTM(); if (!matrix) return null;
  const w = el.width.baseVal.value, h = el.height.baseVal.value;
  if (w <= 0 || h <= 0) return null;
  let sx = w / asset.width, sy = h / asset.height;
  let x = el.x.baseVal.value, y = el.y.baseVal.value;
  const fit = el.preserveAspectRatio.baseVal;
  if (fit.align !== 1) { // SVG_PRESERVEASPECTRATIO_NONE
    sx = sy = fit.meetOrSlice === 2 ? Math.max(sx, sy) : Math.min(sx, sy);
    const align = Math.max(0, fit.align - 2);
    x += (w - asset.width * sx) * (align % 3) / 2;
    y += (h - asset.height * sy) * Math.floor(align / 3) / 2;
  }
  const pixelsToScreen = matrix.translate(x, y).scale(sx, sy);
  const { a, b, c, d } = pixelsToScreen;
  const sum = a*a + b*b + c*c + d*d;
  const density = Math.sqrt((sum + Math.sqrt(Math.max(0, sum*sum - 4*(a*d-b*c)**2))) / 2) * devicePixelRatio;
  if (!Number.isFinite(density) || density <= 0 || Math.max(asset.width, asset.height) * density <= PREVIEW_EDGE) return null;
  const inverse = pixelsToScreen.inverse();
  // A little overscan avoids showing a soft edge during short pans.
  const corners = [[viewport.left-24, viewport.top-24], [viewport.right+24, viewport.top-24],
    [viewport.left-24, viewport.bottom+24], [viewport.right+24, viewport.bottom+24]]
    .map(([px, py]) => new DOMPoint(px, py).matrixTransform(inverse));
  const left = Math.max(0, Math.floor(Math.min(...corners.map(p => p.x))));
  const top = Math.max(0, Math.floor(Math.min(...corners.map(p => p.y))));
  const right = Math.min(asset.width, Math.ceil(Math.max(...corners.map(p => p.x))));
  const bottom = Math.min(asset.height, Math.ceil(Math.max(...corners.map(p => p.y))));
  const cw = right-left, ch = bottom-top;
  if (![left, top, cw, ch].every(Number.isFinite) || cw <= 0 || ch <= 0) return null;
  // Never enlarge source pixels, and never cap close-up detail at an arbitrary edge length.
  const width = Math.max(1, Math.ceil(cw * Math.min(1, density)));
  const height = Math.max(1, Math.ceil(ch * Math.min(1, density)));
  return { id: asset.id, x: left, y: top, w: cw, h: ch, width, height,
    key: [asset.id, left, top, cw, ch, width, height].join(':') };
}
function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(blob); });
}
async function detailSvg(asset: LiveAsset, plan: DetailPlan): Promise<Blob> {
  // Decode one source at a time. Browser codecs may transiently decode the whole source;
  // only the cropped output survives this operation, and its bitmap is always closed.
  const options: ImageBitmapOptions = { resizeWidth: plan.width, resizeHeight: plan.height, resizeQuality: 'high' };
  const orientation = (await dimensions(asset.original))?.orientation ?? 1;
  let bitmap: ImageBitmap;
  if (orientation !== 1) {
    // Chromium's Blob crop coordinates are inconsistent for EXIF-rotated JPEGs.
    // Canvas source rectangles use the displayed orientation; a second bitmap crop does not.
    bitmap = await createImageBitmap(asset.original);
  } else bitmap = await createImageBitmap(asset.original, plan.x, plan.y, plan.w, plan.h, options);
  const canvas = document.createElement('canvas'); canvas.width = plan.width; canvas.height = plan.height;
  let crop: Blob;
  try {
    const context = canvas.getContext('2d')!;
    if (orientation !== 1) context.drawImage(bitmap, plan.x, plan.y, plan.w, plan.h, 0, 0, plan.width, plan.height);
    else context.drawImage(bitmap, 0, 0);
    crop = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Image detail failed')), 'image/png'));
  } finally { bitmap.close(); canvas.width = canvas.height = 0; }
  const preview = await dataUrl(asset.preview), patch = await dataUrl(crop);
  const { x, y, w, h } = plan;
  // Exclude the crop from the base preview: overlapping translucent pixels would darken.
  const hole = `M0 0H${asset.width}V${asset.height}H0Z M${x} ${y}v${h}h${w}v${-h}Z`;
  return new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="${asset.width}" height="${asset.height}" viewBox="0 0 ${asset.width} ${asset.height}"><defs><clipPath id="outside"><path d="${hole}" clip-rule="evenodd"/></clipPath></defs><image width="${asset.width}" height="${asset.height}" preserveAspectRatio="none" href="${preview}" clip-path="url(#outside)"/><image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none" href="${patch}"/></svg>`], { type: 'image/svg+xml' });
}
async function refreshDetail(): Promise<void> {
  if (detailWorking) { detailTimer = window.setTimeout(() => { void refreshDetail(); }, 180); return; }
  const root = document.getElementById('drawing-layer'); if (!root) return;
  const viewport = document.getElementById('canvas-area')!.getBoundingClientRect();
  const wanted = new Map<Element, DetailPlan>(); let remaining = DETAIL_PIXELS;
  for (const el of root.querySelectorAll<SVGImageElement>(`image[${ASSET_ATTR}]`)) {
    const asset = assets.get(el.getAttribute(ASSET_ATTR)!); if (!asset) continue;
    const plan = detailPlan(el, asset, viewport); if (!plan) continue;
    const pixels = plan.width * plan.height;
    if (pixels > remaining) continue;
    remaining -= pixels; wanted.set(el, plan);
  }
  for (const [el, detail] of details) if (!wanted.has(el) || wanted.get(el)!.id !== detail.id) {
    URL.revokeObjectURL(detail.url); details.delete(el);
  }
  bindAssets(root);
  const generation = detailGeneration; detailWorking = true;
  try {
    for (const [el, plan] of wanted) {
      if (generation !== detailGeneration) break;
      if (details.get(el)?.key === plan.key) continue;
      const asset = assets.get(plan.id); if (!asset) continue;
      const evictions = detailEvictions([...details].map(([key, detail]) => ({ key, pixels: detail.pixels,
        stale: wanted.get(key)?.key !== detail.key })), plan.width * plan.height, DETAIL_PIXELS);
      if (!evictions) continue;
      for (const key of evictions) {
        const detail = details.get(key)!; details.delete(key); bindAssets(key); URL.revokeObjectURL(detail.url);
      }
      try {
        const blob = await detailSvg(asset, plan);
        if (generation !== detailGeneration || !el.isConnected || assets.get(plan.id) !== asset) break;
        const previous = details.get(el);
        details.set(el, { id: plan.id, url: URL.createObjectURL(blob), key: plan.key, pixels: plan.width * plan.height });
        bindAssets(el);
        if (previous) URL.revokeObjectURL(previous.url);
      } catch { /* The base preview remains available if the source cannot decode. */ }
    }
  } finally { detailWorking = false; }
}
export function originalAsset(el: Element): Blob | undefined { return assets.get(el.getAttribute(ASSET_ATTR) ?? '')?.original; }

export function releasePrepared(ids: string[]): void { ids.forEach(id => preparing.delete(id)); }
/** Read large UTF-8 SVGs incrementally, extracting embedded rasters before XML parsing. */
export async function readAssetSvg(file: Blob): Promise<string> {
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  const output: string[] = []; const created: string[] = [];
  let pending = '';
  let scanOffset = 1; let quote = '';
  try {
    while (true) {
      const { value, done } = await reader.read(); if (value) pending += value;
      while (true) {
        const start = pending.indexOf('<');
        if (start < 0) { output.push(pending); pending = ''; break; }
        output.push(pending.slice(0, start)); pending = pending.slice(start);
        let end = -1;
        if (pending.startsWith('<!--')) { const i = pending.indexOf('-->', Math.max(4, scanOffset - 2)); if (i >= 0) end = i + 2; }
        else if (pending.startsWith('<![CDATA[')) { const i = pending.indexOf(']]>', Math.max(9, scanOffset - 2)); if (i >= 0) end = i + 2; }
        else {
          for (let i = scanOffset; i < pending.length; i++) {
            const c = pending[i];
            if (quote) { if (c === quote) quote = ''; }
            else if (c === '"' || c === "'") quote = c;
            else if (c === '>') { end = i; break; }
          }
        }
        if (end < 0) { scanOffset = pending.length; break; }
        scanOffset = 1; quote = '';
        let tag = pending.slice(0, end + 1);
        if (!/^<(?:[\w-]+:)?image\b/.test(tag)) { output.push(tag); pending = pending.slice(end + 1); continue; }
        const data = /(?:\s)(?:xlink:)?href\s*=\s*(["'])(data:image\/(png|jpeg|webp|bmp|avif);base64,[^"']+)\1/i.exec(tag);
        if (data && data[2].length > 256 * 1024) {
          const body = data[2].slice(data[2].indexOf(',') + 1).replace(/\s/g, '');
          const parts: Uint8Array<ArrayBuffer>[] = [];
          for (let i = 0; i < body.length; i += 65536) {
            const binary = atob(body.slice(i, i + 65536)); parts.push(Uint8Array.from(binary, c => c.charCodeAt(0)));
          }
          const mime = `image/${data[3].toLowerCase()}`;
          const id = await prepareAsset(new File(parts, `image.${data[3].toLowerCase()}`, { type: mime })); created.push(id);
          tag = tag.replace(/\s(?:xlink:)?href\s*=\s*(["'])[^"']*\1/g, '').replace(/\sdata-bq-raster\s*=\s*(["'])[^"']*\1/g, '');
          tag = tag.replace(/(\/?>)$/, ` ${ASSET_ATTR}="${id}"$1`);
        }
        output.push(tag); pending = pending.slice(end + 1);
      }
      if (done) break;
    }
    output.push(pending); return output.join('');
  } catch (e) { created.forEach(forgetAsset); throw e; }
  finally { reader.releaseLock(); }
}

// Inert import normalization also covers legacy sessions, pasted SVG and small
// highly-compressed images. No original URL is attached to the live canvas.
const previewQueue = new Set<string>();
let previewWorking = false;
const emptyPreview = new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1cAAAAASUVORK5CYII='), c => c.charCodeAt(0))], { type: 'image/png' });
export function adoptEmbeddedRaster(el: Element): void {
  if (el.localName !== 'image') return;
  const existing = el.getAttribute(ASSET_ATTR);
  if (existing && assets.has(existing)) return;
  const href = el.getAttribute('href') || el.getAttributeNS(XLINK, 'href') || '';
  const comma = href.indexOf(','); const header = href.slice(0, comma).toLowerCase();
  if (!header.startsWith('data:') || !header.endsWith(';base64') || header.includes('image/svg')) return;
  let mime = header.slice(5).split(';')[0];
  if (mime && mime !== 'application/octet-stream' && !/^image\/(png|jpe?g|webp|gif|bmp|avif)$/.test(mime)) return;
  try {
    const header = href.slice(comma + 1, comma + 1 + 65536).replace(/\s/g, '');
    const prefix = atob(header.slice(0, header.length - header.length % 4));
    const bytes = Uint8Array.from(prefix, c => c.charCodeAt(0));
    const size = dimensionsFromBytes(bytes);
    if (href.length < 256 * 1024 && size && size.width * size.height <= 512 * 512) return;
    if (!mime || mime === 'application/octet-stream') mime = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : '';
    if (!mime) return;
    const payload = href.slice(comma + 1).replace(/\s/g, '');
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (let i = 0; i < payload.length; i += 65536) parts.push(Uint8Array.from(atob(payload.slice(i, i + 65536)), c => c.charCodeAt(0)));
    const id = crypto.randomUUID();
    restoreAssets([{ id, original: new Blob(parts, { type: mime }), preview: emptyPreview,
      width: size?.width ?? 0, height: size?.height ?? 0, previewPending: true }]);
    el.setAttribute(ASSET_ATTR, id); el.removeAttribute('href'); el.removeAttributeNS(XLINK, 'href');
  } catch { /* Invalid image bytes remain subject to normal SVG sanitization. */ }
}
async function drainPreviews(): Promise<void> {
  if (previewWorking) return;
  previewWorking = true;
  try {
    while (previewQueue.size) {
      const id = previewQueue.values().next().value!; previewQueue.delete(id);
      const asset = assets.get(id); if (!asset) continue;
      try {
        const preview = await makePreview(asset.original);
        if (assets.get(id) !== asset) continue;
        URL.revokeObjectURL(asset.url); Object.assign(asset, preview, { previewPending: false, url: URL.createObjectURL(preview.preview) });
        const canvas = document.getElementById('svg-canvas'); if (canvas) bindAssets(canvas);
        scheduleRasterDetail();
      } catch { /* Preserve original bytes even if preview decoding fails. */ }
    }
  } finally { previewWorking = false; }
}
