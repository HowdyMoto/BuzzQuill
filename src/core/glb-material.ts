import { CanvasTexture, SRGBColorSpace } from 'three';
import { portableSvg } from './raster-assets';
import type { MaterialMap } from './glb-options';
import type { GlbRect } from './glb-geometry';

export async function bakeGlbTexture(svg: SVGSVGElement, rect: GlbRect, resolution: number): Promise<HTMLCanvasElement> {
  if (svg.querySelector('[data-bq-image-href]')) throw new Error('Resolve linked images before exporting material textures.');
  const w = Math.max(1, Math.round(resolution * rect.width / Math.max(rect.width, rect.height)));
  const h = Math.max(1, Math.round(resolution * rect.height / Math.max(rect.width, rect.height)));
  svg.setAttribute('viewBox', `${rect.x} ${rect.y} ${rect.width} ${rect.height}`);
  svg.setAttribute('width', String(w)); svg.setAttribute('height', String(h));
  const blob = await portableSvg(new XMLSerializer().serializeToString(svg));
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    canvas.getContext('2d')!.drawImage(image, 0, 0);
    return canvas;
  } catch { throw new Error('Unable to bake material artwork. Check image and font sources.'); }
  finally { URL.revokeObjectURL(url); }
}

export function materialValue(data: Uint8ClampedArray, i: number, map: MaterialMap): number {
  const value = map.channel === 'gray' ? (data[i]! * .2126 + data[i + 1]! * .7152 + data[i + 2]! * .0722) / 255
    : data[i + ({ r: 0, g: 1, b: 2, a: 3 }[map.channel])]! / 255;
  const alpha = map.channel === 'a' ? 1 : data[i + 3]! / 255;
  return alpha * (map.invert ? 1 - value : value) + (1 - alpha) * map.fallback;
}
export function packGlbMaterial(rough: HTMLCanvasElement | null, metal: HTMLCanvasElement | null, r: MaterialMap, m: MaterialMap): CanvasTexture | null {
  const source = rough || metal;
  if (!source) return null;
  const canvas = document.createElement('canvas'); canvas.width = source.width; canvas.height = source.height;
  const ctx = canvas.getContext('2d')!;
  const pixels = ctx.createImageData(canvas.width, canvas.height);
  const rd = rough?.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
  const md = metal?.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 0; i < pixels.data.length; i += 4) {
    pixels.data[i] = 255;
    pixels.data[i + 1] = Math.round(255 * (rd ? materialValue(rd, i, r) : r.fallback));
    pixels.data[i + 2] = Math.round(255 * (md ? materialValue(md, i, m) : m.fallback));
    pixels.data[i + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  return new CanvasTexture(canvas);
}
export function colorTexture(canvas: HTMLCanvasElement): CanvasTexture {
  // Dilate RGB into transparent neighbours to avoid dark filtering seams; preserve alpha.
  const ctx = canvas.getContext('2d')!;
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const original = new Uint8ClampedArray(pixels.data);
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const i = (y * canvas.width + x) * 4;
    if (original[i + 3]) continue;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nx = x + dx!, ny = y + dy!;
      if (nx < 0 || nx >= canvas.width || ny < 0 || ny >= canvas.height) continue;
      const j = (ny * canvas.width + nx) * 4;
      if (original[j + 3]) { pixels.data.set(original.subarray(j, j + 3), i); break; }
    }
  }
  ctx.putImageData(pixels, 0, 0);
  const texture = new CanvasTexture(canvas); texture.colorSpace = SRGBColorSpace;
  return texture;
}
