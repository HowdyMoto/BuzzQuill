/** Serializable 3D export settings. Lengths in the UI are converted to metres. */
export type MapChannel = 'gray' | 'r' | 'g' | 'b' | 'a';
export interface MaterialMap { source: string; channel: MapChannel; invert: boolean; fallback: number }
export interface GlbOptions {
  scope: string;
  geometry: string;
  geometryMode: 'silhouette' | 'painted';
  color: string;
  colorValue: string;
  unit: 'mm' | 'cm' | 'in';
  width: number;
  thickness: number;
  resolution: number;
  quality: 'draft' | 'standard' | 'high';
  roughness: MaterialMap;
  metallic: MaterialMap;
  back: 'artwork' | 'solid';
  backColor: string;
  sideColor: string;
  sideRoughness: number;
  sideMetallic: number;
}
export const unitMetres = { mm: .001, cm: .01, in: .0254 };
export function frameGlbOptions(scope: string, widthPx: number, saved?: GlbOptions): GlbOptions {
  return { ...defaultGlbOptions(), width: widthPx * 25.4 / 96, ...structuredClone(saved), scope };
}
/** Only accept known, typed configuration fields from saved SVG metadata. */
export function readGlbOptions(value: unknown): GlbOptions | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const out = defaultGlbOptions();
  for (const key of Object.keys(out) as (keyof GlbOptions)[]) {
    const v = (value as Record<string, unknown>)[key];
    if (key === 'roughness' || key === 'metallic') {
      if (v && typeof v === 'object') for (const k of Object.keys(out[key]) as (keyof MaterialMap)[]) {
        const field = (v as Record<string, unknown>)[k];
        if (typeof field === typeof out[key][k]) Object.assign(out[key], { [k]: field });
      }
    } else if (typeof v === typeof out[key]) Object.assign(out, { [key]: v });
  }
  try { validateGlbOptions(out); return out; } catch { return undefined; }
}
export function defaultGlbOptions(): GlbOptions {
  return { scope: 'document', geometry: '', geometryMode: 'silhouette', color: '', colorValue: '#ffffff', unit: 'mm', width: 100,
    thickness: 2, resolution: 2048, quality: 'standard',
    roughness: { source: '', channel: 'gray', invert: false, fallback: .5 },
    metallic: { source: '', channel: 'gray', invert: false, fallback: 0 },
    back: 'artwork', backColor: '#ffffff', sideColor: '#808080', sideRoughness: .5, sideMetallic: 0 };
}
export function validateGlbOptions(o: GlbOptions): void {
  if (![o.width, o.thickness].every(n => Number.isFinite(n) && n > 0)) throw new Error('Width and thickness must be positive finite numbers.');
  if (!Object.hasOwn(unitMetres, o.unit) || ![512, 1024, 2048, 4096].includes(o.resolution)) throw new Error('Invalid units or texture resolution.');
  if (!['draft', 'standard', 'high'].includes(o.quality) || !['artwork', 'solid'].includes(o.back)) throw new Error('Invalid geometry or back-face option.');
  if (!['silhouette', 'painted'].includes(o.geometryMode)) throw new Error('Invalid geometry mode.');
  for (const map of [o.roughness, o.metallic]) if (!['gray', 'r', 'g', 'b', 'a'].includes(map.channel)) throw new Error('Invalid material channel.');
  for (const color of [o.colorValue, o.backColor, o.sideColor]) if (!/^#[\da-f]{6}$/i.test(color)) throw new Error('Choose a valid material color.');
  for (const n of [o.roughness.fallback, o.metallic.fallback, o.sideRoughness, o.sideMetallic]) {
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error('Material values must be between 0 and 1.');
  }
}
