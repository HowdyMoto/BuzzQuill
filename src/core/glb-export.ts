import { ExtrudeGeometry, Group, Mesh, MeshStandardMaterial, type Texture } from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { sourceSvg, glbPivot, type GlbSnapshot } from './glb-source';
import { unitMetres, validateGlbOptions, type GlbOptions } from './glb-options';
import { glbGeometry } from './glb-geometry';
import { bakeGlbTexture, colorTexture, packGlbMaterial } from './glb-material';
import { outlineText } from './text-outline';
import { pinAssets } from './raster-assets';

export interface GlbModel {
  object: Group;
  warnings: string[];
  triangles: number;
  height: number;
  dispose(): void;
  encode(): Promise<Blob>;
}
export async function buildGlb(snapshot: GlbSnapshot, options: GlbOptions): Promise<GlbModel> {
  const release = pinAssets(snapshot.svg);
  try { return await buildGlbModel(snapshot, options); } finally { release(); }
}
async function buildGlbModel(snapshot: GlbSnapshot, options: GlbOptions): Promise<GlbModel> {
  const o = structuredClone(options);
  validateGlbOptions(o);
  const scoped = o.scope === 'document' ? null : o.scope === 'selection' ? snapshot.selected : [o.scope];
  if (scoped?.length === 0) throw new Error('Select at least one shape before exporting the selection.');
  const materialIds = [o.roughness.source, o.metallic.source].filter(Boolean);
  const makeSource = (id: string, geometry = false) => sourceSvg(snapshot, id ? [id] : scoped,
    id ? [] : [...materialIds, ...(geometry && o.color && o.color !== 'solid' ? [o.color] : [])], !!id);
  const frame = snapshot.frames.find(f => f.id === o.scope);
  const geom = makeSource(o.geometry, true);
  const outlined = await outlineText(geom.innerHTML, snapshot.fonts);
  if (outlined.warnings.length) throw new Error(`Text could not be outlined: ${outlined.warnings.join('; ')}`);
  geom.innerHTML = outlined.content;
  const result = await glbGeometry(geom, o.quality, frame, o.geometryMode);
  const { rect } = result;
  let pivot = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  if (o.pivot) {
    const guide = sourceSvg(snapshot, [o.pivot], [], true);
    const text = await outlineText(guide.innerHTML, snapshot.fonts);
    if (text.warnings.length) throw new Error(`Pivot text could not be outlined: ${text.warnings.join('; ')}`);
    guide.innerHTML = text.content;
    pivot = glbPivot(guide, o.pivot);
  }
  const object = new Group(); object.name = 'BuzzQuill extrusion';
  const materials: MeshStandardMaterial[] = [];
  const textures: Texture[] = [];
  const dispose = () => { object.traverse(n => { if (n instanceof Mesh) n.geometry.dispose(); }); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose()); };
  try {
    const bake = async (id: string) => {
      const svg = makeSource(id);
      const text = await outlineText(svg.innerHTML, snapshot.fonts);
      if (text.warnings.length) throw new Error(`Material text could not be outlined: ${text.warnings.join('; ')}`);
      svg.innerHTML = text.content;
      return bakeGlbTexture(svg, rect, o.resolution);
    };
    const base = o.color === 'solid' ? null : colorTexture(await bake(o.color));
    if (base) textures.push(base);
    const rough = o.roughness.source ? await bake(o.roughness.source) : null;
    const metal = o.metallic.source ? await bake(o.metallic.source) : null;
    const packed = packGlbMaterial(rough, metal, o.roughness, o.metallic);
    if (packed) textures.push(packed);
    const front = new MeshStandardMaterial({ name: 'Artwork', color: base ? '#ffffff' : o.colorValue, map: base,
      roughness: packed ? 1 : o.roughness.fallback, metalness: packed ? 1 : o.metallic.fallback,
      roughnessMap: packed, metalnessMap: packed, transparent: !!base });
    const side = new MeshStandardMaterial({ name: 'Side walls', color: o.sideColor, roughness: o.sideRoughness, metalness: o.sideMetallic });
    const back = o.back === 'artwork' ? front : new MeshStandardMaterial({ name: 'Back', color: o.backColor, roughness: o.roughness.fallback, metalness: o.metallic.fallback });
    materials.push(front, side); if (back !== front) materials.push(back);
    const scale = o.width * unitMetres[o.unit] / rect.width;
    const depth = o.thickness * unitMetres[o.unit];
    let triangles = 0;
    for (const shape of result.shapes) {
      const geometry = new ExtrudeGeometry(shape, { depth: depth / scale, bevelEnabled: false, steps: 1, curveSegments: o.quality === 'high' ? 48 : o.quality === 'draft' ? 8 : 24 });
      const p = geometry.getAttribute('position');
      const uv = geometry.getAttribute('uv');
      const normal = geometry.getAttribute('normal');
      for (let i = 0; i < p.count; i++) {
        uv.setXY(i, (p.getX(i) - rect.x) / rect.width, 1 - (p.getY(i) - rect.y) / rect.height);
        // Rotate SVG's Y-down space around X (also reverses Z), preserving winding.
        p.setXYZ(i, (p.getX(i) - pivot.x) * scale, -(p.getY(i) - pivot.y) * scale, depth / 2 - p.getZ(i) * scale);
        normal.setXYZ(i, normal.getX(i), -normal.getY(i), -normal.getZ(i));
      }
      geometry.clearGroups();
      let start = 0, current = -1;
      for (let i = 0; i < p.count; i += 3) {
        const material = normal.getZ(i) > .99 ? 0 : normal.getZ(i) < -.99 ? 2 : 1;
        if (material !== current) { if (i > start) geometry.addGroup(start, i - start, current); start = i; current = material; }
      }
      geometry.addGroup(start, p.count - start, current);
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      triangles += p.count / 3;
      object.add(new Mesh(geometry, [front, side, back]));
    }
    if (!triangles || triangles > 1_000_000) throw new Error('Geometry is empty or exceeds one million triangles. Simplify the artwork.');
    return { object, warnings: result.warnings, triangles, height: o.width * rect.height / rect.width, dispose,
      async encode() {
        const data = await new GLTFExporter().parseAsync(object, { binary: true, onlyVisible: true });
        if (!(data instanceof ArrayBuffer)) throw new Error('GLB serialization failed.');
        return new Blob([data], { type: 'model/gltf-binary' });
      } };
  } catch (error) { dispose(); throw error; }
}
