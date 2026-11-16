import { Box3, Color, HemisphereLight, DirectionalLight, PerspectiveCamera, Scene, Vector3, WebGLRenderer, Mesh, MeshStandardMaterial, MeshBasicMaterial, PMREMGenerator } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { GlbModel } from '../core/glb-export';

export function createGlbPreview(host: HTMLElement) {
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  host.append(renderer.domElement);
  renderer.domElement.setAttribute('aria-label', '3D model preview. Drag to orbit; scroll to zoom.');
  const scene = new Scene(); scene.background = new Color('#252a32');
  const camera = new PerspectiveCamera(35, 1, .00001, 10000);
  const controls = new OrbitControls(camera, renderer.domElement);
  const environment = new RoomEnvironment(); const pmrem = new PMREMGenerator(renderer);
  const env = pmrem.fromScene(environment); scene.environment = env.texture; environment.dispose(); pmrem.dispose();
  scene.add(new HemisphereLight(0xffffff, 0x444455, 2));
  const lamp = new DirectionalLight(0xffffff, 3); lamp.position.set(1, 2, 3); scene.add(lamp);
  let model: GlbModel | null = null;
  let span = 1;
  const originals = new Map<Mesh, MeshStandardMaterial[]>();
  const inspection: MeshBasicMaterial[] = [];
  const render = () => renderer.render(scene, camera);
  const resize = () => {
    const height = Math.max(host.clientHeight, 240);
    renderer.setSize(Math.max(host.clientWidth, 1), height); camera.aspect = Math.max(host.clientWidth, 1) / height; camera.updateProjectionMatrix(); render();
  };
  const observer = new ResizeObserver(resize); observer.observe(host); controls.addEventListener('change', render); resize();
  const mode = (value: string) => {
    inspection.splice(0).forEach(m => m.dispose());
    originals.forEach((mats, mesh) => {
      mesh.material = value === 'material' ? mats : mats.map(m => {
        const material = new MeshBasicMaterial({ color: value === 'color' ? m.color : 0xffffff,
          map: value === 'color' ? m.map : value === 'roughness' ? m.roughnessMap : value === 'metallic' ? m.metalnessMap : null,
          wireframe: value === 'wireframe' });
        if (value === 'roughness' || value === 'metallic') {
          const channel = value === 'roughness' ? 'g' : 'b';
          if (!material.map) material.color.setRGB(...Array(3).fill(value === 'roughness' ? m.roughness : m.metalness) as [number, number, number]);
          else material.onBeforeCompile = shader => { shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>\ndiffuseColor.rgb = vec3(diffuseColor.${channel});`); };
        }
        inspection.push(material); return material;
      });
    });
    render();
  };
  const view = (v: string) => {
    camera.position.set(v === 'perspective' ? span * .8 : 0, v === 'perspective' ? span * .5 : 0, v === 'back' ? -span * 2.4 : span * 2.4);
    controls.target.set(0, 0, 0); controls.update(); render();
  };
  return {
    setModel(next: GlbModel) {
      mode('material');
      if (model) scene.remove(model.object);
      model = next; originals.clear();
      next.object.traverse(n => { if (n instanceof Mesh) originals.set(n, n.material as MeshStandardMaterial[]); });
      scene.add(next.object);
      const size = new Box3().setFromObject(next.object).getSize(new Vector3()); span = Math.max(size.x, size.y, size.z);
      camera.near = span / 10000; camera.far = span * 1000; camera.updateProjectionMatrix(); view('perspective');
    }, mode, view,
    dispose() { mode('material'); observer.disconnect(); controls.dispose(); env.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); },
  };
}
