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
  for (const [id, a] of assets) if (!retained.has(id)) { URL.revokeObjectURL(a.url); const d = details.get(id); if (d) URL.revokeObjectURL(d.url); details.delete(id); assets.delete(id); }
}
export function pinAssets(markup: string): () => void {
  const ids = [...new Set(assetIds(markup))];
  for (const id of ids) pins.set(id, (pins.get(id) ?? 0) + 1);
  return () => { for (const id of ids) { const n = (pins.get(id) ?? 1) - 1; if (n) pins.set(id, n); else pins.delete(id); } };
}
export function forgetAsset(id: string): void {
  preparing.delete(id);
  const a = assets.get(id); if (a) URL.revokeObjectURL(a.url); const d = details.get(id); if (d) URL.revokeObjectURL(d.url); details.delete(id); assets.delete(id);
}
export function bindAssets(root: Element): void {
  const images = [...root.querySelectorAll(`image[${ASSET_ATTR}]`)];
  if (root.localName === 'image' && root.hasAttribute(ASSET_ATTR)) images.push(root);
  for (const el of images) {
    const a = assets.get(el.getAttribute(ASSET_ATTR)!);
    if (el.isConnected && a) preparing.delete(a.id);
    if (!a) continue;
    const url = details.get(a.id)?.url ?? a.url;
    if (el.getAttribute('href') !== url) el.setAttribute('href', url);
    el.removeAttributeNS(XLINK, 'href');
  }
}
export function attachAsset(el: Element, id: string): void {
  preparing.delete(id);
  el.setAttribute(ASSET_ATTR, id); el.removeAttribute('data-bq-image-href'); bindAssets(el);
}
export async function dimensions(file: Blob): Promise<{ width: number; height: number } | null> {
  return dimensionsFromBytes(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()));
}
function dimensionsFromBytes(b: Uint8Array): { width: number; height: number } | null {
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
          ? { width: view.getUint16(i + 3), height: view.getUint16(i + 5) }
          : { width: view.getUint16(i + 5), height: view.getUint16(i + 3) };
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
  return { count: assets.size, originalBytes: [...assets.values()].reduce((n, a) => n + a.original.size, 0),
    previewPixelUpperBound: assets.size * PREVIEW_EDGE * PREVIEW_EDGE + [...details.values()].reduce((n, d) => n + d.edge * d.edge, 0), urls: assets.size + details.size };
}

/** Sharpen visible tiles after navigation settles, under a separate 32MiB pixel budget. */
const DETAIL_PIXELS = 8 * 1024 * 1024;
const details = new Map<string, { url: string; edge: number }>();
let detailTimer: number | undefined;
let detailGeneration = 0;
let detailWorking = false;
export function scheduleRasterDetail(): void {
  detailGeneration++;
  window.clearTimeout(detailTimer);
  detailTimer = window.setTimeout(() => { void refreshDetail(); }, 350);
}
async function refreshDetail(): Promise<void> {
  if (detailWorking) { scheduleRasterDetail(); return; }
  const root = document.getElementById('drawing-layer'); if (!root) return;
  const wanted = new Map<string, number>();
  const viewport = document.getElementById('canvas-area')!.getBoundingClientRect();
  for (const el of root.querySelectorAll(`image[${ASSET_ATTR}]`)) {
    const rect = el.getBoundingClientRect();
    if (rect.right < viewport.left || rect.left > viewport.right || rect.bottom < viewport.top || rect.top > viewport.bottom) continue;
    const id = el.getAttribute(ASSET_ATTR)!;
    const edge = Math.min(2048, Math.max(512, 2 ** Math.ceil(Math.log2(Math.max(rect.width, rect.height) * Math.min(devicePixelRatio, 2)))));
    if (edge > 512) wanted.set(id, Math.max(wanted.get(id) ?? 0, edge));
  }
  let remaining = DETAIL_PIXELS;
  for (const [id, edge] of wanted) { if (edge * edge > remaining) wanted.delete(id); else remaining -= edge * edge; }
  for (const [id, d] of details) if (wanted.get(id) !== d.edge) { URL.revokeObjectURL(d.url); details.delete(id); }
  bindAssets(root);
  const generation = detailGeneration; detailWorking = true;
  try {
    for (const [id, edge] of wanted) {
      if (generation !== detailGeneration) break;
      if (details.has(id)) continue;
      const asset = assets.get(id); if (!asset || asset.previewPending) continue;
      const preview = await makePreview(asset.original, edge);
      if (generation !== detailGeneration || !assets.has(id)) break;
      details.set(id, { url: URL.createObjectURL(preview.preview), edge }); bindAssets(root);
    }
  } catch { /* Base previews remain usable when a detail decode fails. */ }
  finally { detailWorking = false; }
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
      } catch { /* Preserve original bytes even if preview decoding fails. */ }
    }
  } finally { previewWorking = false; }
}
