import type { AppState } from '../core/state';
import { captureGlbSnapshot, type GlbSnapshot } from '../core/glb-source';
import { defaultGlbOptions, unitMetres, type GlbOptions, type MapChannel } from '../core/glb-options';
import { buildGlb, type GlbModel } from '../core/glb-export';
import { createGlbPreview } from './glb-preview';
import { openModal } from './modal';
import { createButton, createSelect, createField, createModalHeader, createModalBody, createModalFooter, createCheckRow } from './components';
import { saveFilePicker, writeHandle, supportsFileSystemAccess } from '../core/file-access';
import { pulse, playExportSuccess } from './feedback';
import { sliderField, setSliderValue } from './slider-field';

const remembered = new WeakMap<AppState, Map<string, GlbOptions>>();
export interface GlbTargetEditor { options: GlbOptions; apply(options: GlbOptions): void }
export function showGlbDialog(state: AppState, snapshot: GlbSnapshot = captureGlbSnapshot(state), target?: GlbTargetEditor): void {
  let closed = false, revision = 0, busy = false, saving = false;
  let model: GlbModel | null = null, blob: Blob | null = null;
  let previewPivot = '';
  let preview: ReturnType<typeof createGlbPreview> | null = null;
  const modal = openModal({ id: 'glb-dialog-overlay', ariaLabel: 'Export 3D GLB', dialogClass: 'glb-dialog', onClose() {
    closed = true; revision++; preview?.dispose(); model?.dispose(); snapshot.release?.();
  } });
  if (!modal) { snapshot.release?.(); return; }
  const o = defaultGlbOptions();
  o.scope = snapshot.selected.length ? 'selection' : snapshot.frames[0]?.id || 'document';
  const targetKey = (scope: string) => `${snapshot.generation ?? 0}:${scope}:${scope === 'selection' ? snapshot.selected.join(',') : ''}`;
  const frame = snapshot.frames.find(f => f.id === o.scope);
  if (frame) o.width = frame.width * 25.4 / 96;
  Object.assign(o, structuredClone(remembered.get(state)?.get(targetKey(o.scope)) ?? {}));
  if (target) Object.assign(o, structuredClone(target.options));
  const header = createModalHeader(target ? 'Shape your 3D export' : 'Export in 3D');
  const context = document.createElement('p'); context.className = 'glb-context';
  context.textContent = target ? `Settings for ${snapshot.frames.find(f => f.id === o.scope)?.name || 'this frame'} · apply when you’re happy` : 'Give your artwork a little depth.';
  header.append(context); modal.dialog.append(header);
  const body = createModalBody(); const controls = document.createElement('div'); controls.className = 'glb-controls';
  const panel = document.createElement('div'); panel.className = 'glb-preview-panel';
  panel.tabIndex = -1; controls.tabIndex = -1;
  const jumpTo = (el: HTMLElement) => { el.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'}); el.focus({preventScroll:true}); };
  const jump = createButton('Jump to preview ↓', {small:true,onClick:()=>jumpTo(panel)}); jump.classList.add('glb-jump'); header.append(jump);
  const host = document.createElement('div'); host.className = 'glb-preview'; panel.append(host);
  const badge = document.createElement('span'); badge.className = 'glb-state-badge';
  const previewHeading = document.createElement('div'); previewHeading.className = 'glb-preview-heading';
  const previewTitle = document.createElement('strong'); previewTitle.textContent = 'Your model'; previewHeading.append(previewTitle, badge); panel.prepend(previewHeading);
  const backToSettings = createButton('Settings ↑', {small:true,onClick:()=>jumpTo(controls)}); backToSettings.classList.add('glb-jump'); previewHeading.insertBefore(backToSettings,badge);
  const empty = document.createElement('div'); empty.className = 'glb-empty';
  empty.innerHTML = '<svg width="80" height="76" viewBox="0 0 90 82" aria-hidden="true"><path class="glb-empty-side" d="M16 30L45 46L74 30V45L45 62L16 45Z"/><path class="glb-empty-top" d="M16 30L45 13L74 30L45 46Z"/><path class="glb-empty-guide" d="M16 15L45 0L74 15L45 32Z"/></svg><strong>From flat to a little fabulous</strong><p>Choose your outline and artwork.<br>Build a preview to bring them together.</p>';
  const stage = document.createElement('div'); stage.className = 'glb-stage'; panel.append(stage); stage.append(host, empty);
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = 'Set the physical size and material sources, then build the preview.'; panel.append(status);
  const fields: (() => void)[] = [], conditions: (() => void)[] = [], summaries: (() => void)[] = [];
  const fieldRows = new Map<string, HTMLElement>();
  const field = (label: string, input: HTMLElement) => {
    input.setAttribute('aria-label', label); input.id = `glb-option-${fieldRows.size}`;
    const row = createField(label, input); row.querySelector('label')!.htmlFor = input.id;
    fieldRows.set(label, row); controls.append(row);
  };
  const select = (label: string, choices: { value: string; label: string }[], get: () => string, set: (v: string) => void) => {
    const el = createSelect(choices); const sync = () => { el.value = get(); }; sync(); fields.push(sync);
    el.addEventListener('change', () => { set(el.value); invalidate(); pulse(el); }); field(label, el); return el;
  };
  const number = (label: string, get: () => number, set: (v: number) => void, min = 0, max?: number) => {
    if (max === 1) {
      const range = document.createElement('input'); range.type = 'range'; range.min = '0'; range.max = '1'; range.step = '.01'; range.value = String(get()); range.title = label;
      range.className = 'glb-finish-slider';
      range.setAttribute('aria-label', `${label} slider`);
      const row = document.createElement('div'); row.className = 'glb-finish-row';
      row.append(range, sliderField(range)); field(label, row);
      row.removeAttribute('aria-label'); fieldRows.get(label)!.querySelector('label')!.htmlFor = range.id = `${row.id}-slider`;
      fields.push(() => setSliderValue(range, get()));
      range.addEventListener('input', () => { set(Number(range.value)); invalidate(); }); return;
    }
    const el = document.createElement('input'); el.type = 'number'; el.min = String(min); el.step = 'any'; if (max !== undefined) el.max = String(max);
    const sync = () => { el.value = String(get()); }; sync(); fields.push(sync);
    el.addEventListener('input', () => { set(el.value === '' ? NaN : Number(el.value)); invalidate(); }); field(label, el);
  };
  const color = (label: string, key: 'colorValue' | 'backColor' | 'sideColor') => {
    const el = document.createElement('input'); el.type = 'color'; el.value = o[key]; fields.push(() => { el.value = o[key]; });
    el.addEventListener('input', () => { o[key] = el.value; invalidate(); }); field(label, el);
  };
  const layers = snapshot.layers.map(l => ({ value: l.id, label: l.name }));
  const chooseLayer = (label: string, initial: string, get: () => string, set: (v: string) => void, solid = false) => select(label,
    [{ value: '', label: initial }, ...(solid ? [{ value: 'solid', label: 'Solid color' }] : []), ...layers], get, set);
  const scopes = [{ value: 'document', label: 'Document' }, { value: 'selection', label: 'Selection at dialog open' }, ...snapshot.frames.map(f => ({ value: f.id, label: f.name }))];
  const scopeSelect = select('Scope', scopes, () => o.scope, value => {
    const saved = remembered.get(state)?.get(targetKey(value)); if (saved) Object.assign(o, structuredClone(saved)); o.scope = value; fields.forEach(f => f());
  });
  scopeSelect.disabled = !!target;
  chooseLayer('Pivot object', 'Model center', () => o.pivot, v => { o.pivot = v; });
  chooseLayer('Geometry source', 'Visible vectors in scope', () => o.geometry, v => { o.geometry = v; });
  select('Geometry mode', [{ value: 'silhouette', label: 'Solid silhouette — fill closed outlines' }, { value: 'painted', label: 'Visible fills and strokes — preserve hollow outlines' }], () => o.geometryMode, v => { o.geometryMode = v as GlbOptions['geometryMode']; });
  select('Units', [{ value: 'mm', label: 'Millimetres' }, { value: 'cm', label: 'Centimetres' }, { value: 'in', label: 'Inches' }], () => o.unit, v => {
    const unit = v as GlbOptions['unit']; const ratio = unitMetres[o.unit] / unitMetres[unit]; o.width *= ratio; o.thickness *= ratio; o.unit = unit; fields.forEach(f => f());
  });
  number('Width (aspect ratio locked)', () => o.width, v => { o.width = v; }, .0001);
  number('Thickness', () => o.thickness, v => { o.thickness = v; }, .0001);
  chooseLayer('Base color source', 'Visible artwork in scope', () => o.color, v => { o.color = v; }, true); color('Base solid color', 'colorValue');
  for (const key of ['roughness', 'metallic'] as const) {
    const name = key === 'roughness' ? 'Roughness' : 'Metallic';
    chooseLayer(`${name} source`, 'Constant value', () => o[key].source, v => { o[key].source = v; });
    number(`${name} fallback`, () => o[key].fallback, v => { o[key].fallback = v; }, 0, 1);
    select(`${name} channel`, ['gray', 'r', 'g', 'b', 'a'].map(v => ({ value: v, label: v === 'gray' ? 'Grayscale' : v.toUpperCase() })), () => o[key].channel, v => { o[key].channel = v as MapChannel; });
    const check = createCheckRow(`Invert ${key}`, o[key].invert); controls.append(check.row); fields.push(() => { check.input.checked = o[key].invert; });
    check.input.addEventListener('change', () => { o[key].invert = check.input.checked; invalidate(); });
  }
  select('Texture resolution', [512, 1024, 2048, 4096].map(n => ({ value: String(n), label: `${n} px` })), () => String(o.resolution), v => { o.resolution = Number(v); });
  select('Curve quality', ['draft', 'standard', 'high'].map(v => ({ value: v, label: v })), () => o.quality, v => { o.quality = v as GlbOptions['quality']; });
  select('Back face', [{ value: 'artwork', label: 'Same projection (mirrored text from behind)' }, { value: 'solid', label: 'Solid color' }], () => o.back, v => { o.back = v as GlbOptions['back']; });
  color('Back color', 'backColor'); color('Side color', 'sideColor');
  number('Side roughness', () => o.sideRoughness, v => { o.sideRoughness = v; }, 0, 1);
  number('Side metallic', () => o.sideMetallic, v => { o.sideMetallic = v; }, 0, 1);
  const hint = document.createElement('p'); hint.className = 'glb-help'; hint.textContent = 'Layer maps stay aligned with your artwork. Hidden layers work too; they do not become part of the solid.'; controls.append(hint);
  const help = (parent: HTMLElement, text: string) => { const p = document.createElement('p'); p.className = 'glb-help'; p.textContent = text; parent.append(p); return p; };
  const section = (parent: HTMLElement, title: string, open: boolean, describe: () => string) => {
    const details = document.createElement('details'); details.className = 'glb-section'; details.open = open;
    const summary = document.createElement('summary');
    const name = document.createElement('span'); name.className = 'glb-section-title'; name.textContent = title;
    const description = document.createElement('span'); description.className = 'glb-section-summary';
    summary.append(name, description);
    const content = document.createElement('div'); content.className = 'glb-section-content'; details.append(summary, content); parent.append(details);
    summaries.push(() => { description.textContent = describe(); }); return { details, content };
  };
  const layerName = (id: string, fallback: string) => snapshot.layers.find(l => l.id === id)?.name || fallback;
  const move = (parent: HTMLElement, key: string, label?: string) => {
    const row = fieldRows.get(key)!; parent.append(row);
    if (label) row.querySelector('label')!.textContent = label;
    return row;
  };
  const pair = (parent: HTMLElement, className = 'glb-field-pair') => { const row = document.createElement('div'); row.className = className; parent.append(row); return row; };
  const showWhen = (el: HTMLElement, when: () => boolean) => { conditions.push(() => { el.hidden = !when(); }); };
  const shape = section(controls, 'Shape & size', true, () => `${layerName(o.geometry, 'Visible outlines')} · ${Number.isFinite(o.thickness) ? o.thickness : '—'} ${o.unit} thick`).content;
  move(shape, 'Scope', 'Export from').hidden = !!target;
  const sourceChoices = pair(shape);
  move(sourceChoices, 'Geometry source', 'Shape outline'); move(sourceChoices, 'Geometry mode', 'Make it');
  const shapeMode = fieldRows.get('Geometry mode')!.querySelector('select')!;
  shapeMode.options[0].text = 'Solid silhouette'; shapeMode.options[1].text = 'Visible fills & strokes';
  const shapeHelp = help(shape, ''); conditions.push(() => { shapeHelp.textContent = o.geometryMode === 'silhouette' ? 'Fill closed outlines without changing your drawing.' : 'Keep unfilled outlines hollow, like a frame.'; });
  const dims = pair(shape, 'glb-dimensions'); move(dims, 'Width (aspect ratio locked)', 'Width'); move(dims, 'Thickness'); move(dims, 'Units');
  const units = fieldRows.get('Units')!.querySelector('select')!; [...units.options].forEach(opt => { opt.text = opt.value; });
  help(shape, 'Height follows the artwork’s proportions.');
  const pivot = section(shape, 'Pivot', !!o.pivot, () => layerName(o.pivot, o.pivot ? 'Missing object' : 'Model center'));
  move(pivot.content, 'Pivot object', 'Center on object');
  help(pivot.content, 'The object’s center becomes the rotation and scaling pivot, halfway through the thickness. Hide a guide object to keep it out of the model.');
  const pivotHint = help(panel, '');
  conditions.push(() => { pivotHint.textContent = model && o.pivot !== previewPivot ? 'Pivot change pending · update the preview to move it' : o.pivot ? `Pivot: ${layerName(o.pivot, 'missing object')} · axes mark the exported origin` : 'Pivot: model center · axes mark the exported origin'; });

  const surface = section(controls, 'Surface', true, () => `${o.color === 'solid' ? 'Solid color' : layerName(o.color, 'Visible artwork')} · ${o.metallic.source ? 'metallic map' : o.metallic.fallback > 0 ? `${Math.round(o.metallic.fallback * 100)}% metallic` : 'nonmetal'}`).content;
  move(surface, 'Base color source', 'Artwork on faces'); showWhen(move(surface, 'Base solid color', 'Face color'), () => o.color === 'solid');
  const finish = pair(surface);
  help(move(finish, 'Roughness fallback', 'Roughness'), '0 smooth ↔ 1 rough');
  help(move(finish, 'Metallic fallback', 'Metallic'), '0 nonmetal ↔ 1 metal');
  for (const key of ['roughness', 'metallic'] as const) {
    const name = key === 'roughness' ? 'Roughness' : 'Metallic';
    conditions.push(() => {
      const label = o[key].source ? `Unpainted ${key}` : name;
      const row = fieldRows.get(`${name} fallback`)!; row.querySelector('label')!.textContent = label;
      row.querySelector('input[type="number"]')!.setAttribute('aria-label',`${label} value`);
      row.querySelector('.glb-finish-slider')!.setAttribute('aria-label',`${label} slider`);
    });
    const map = section(surface, `${name} from a layer`, !!o[key].source, () => o[key].source ? layerName(o[key].source, 'Missing layer') : 'Optional'); map.details.classList.add('glb-map-section');
    move(map.content, `${name} source`, 'Use layer');
    showWhen(move(map.content, `${name} channel`, 'Read channel'), () => !!o[key].source);
    const invert = [...controls.querySelectorAll<HTMLLabelElement>('.check-row')].find(row => row.textContent === `Invert ${key}`)!;
    map.content.append(invert); showWhen(invert, () => !!o[key].source);
    const note = help(map.content, `Black = ${key === 'roughness' ? 'smooth' : 'nonmetal'}; white = ${key === 'roughness' ? 'rough' : 'metal'}. Unpainted areas use the ${key} value above.`);
    showWhen(note, () => !!o[key].source);
  }
  const details = section(controls, 'Details', false, () => `${o.back === 'artwork' ? 'Artwork on back' : 'Solid back'} · ${o.resolution} px textures`).content;
  move(details, 'Back face'); showWhen(move(details, 'Back color'), () => o.back === 'solid'); move(details, 'Side color', 'Edge color');
  const edges = pair(details); move(edges, 'Side roughness', 'Edge roughness'); move(edges, 'Side metallic', 'Edge metallic');
  const quality = pair(details); move(quality, 'Texture resolution', 'Texture size'); move(quality, 'Curve quality', 'Curves'); details.append(hint);
  help(details, 'Larger textures and finer curves add detail—and file size. Textures travel inside the GLB.');
  const view = createSelect(['perspective', 'front', 'back'].map(v => ({ value: v, label: v }))); view.setAttribute('aria-label', 'Preview view'); view.addEventListener('change', () => preview?.view(view.value));
  const mode = createSelect(['material', 'color', 'roughness', 'metallic', 'wireframe'].map(v => ({ value: v, label: v === 'material' ? 'Shaded' : v[0].toUpperCase() + v.slice(1) }))); mode.setAttribute('aria-label', 'Preview mode'); mode.addEventListener('change', () => preview?.mode(mode.value));
  const toolbar = document.createElement('div'); toolbar.className = 'glb-preview-toolbar';
  const views = document.createElement('div'); views.className = 'btn-group glb-views'; views.setAttribute('role','group'); views.setAttribute('aria-label','Preview view');
  for (const [value, label] of [['perspective','3D'],['front','Front'],['back','Back']]) {
    const button = createButton(label, {small:true, onClick: () => { view.value = value; preview?.view(value); for (const b of views.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === button)); }});
    button.setAttribute('aria-pressed',String(value === view.value)); views.append(button);
  }
  const inspect = document.createElement('label'); inspect.className='glb-inspect'; inspect.append('Inspect',mode); toolbar.append(views,inspect);
  panel.append(toolbar); const gesture = help(panel,'Drag to orbit · scroll to zoom'); gesture.classList.add('glb-gesture');
  body.append(controls, panel); modal.dialog.append(body);
  const footer = createModalFooter();
  const build = createButton('Build preview', { onClick: () => { void generate(); } });
  build.classList.add('glb-build-button'); panel.append(build);
  const save = createButton('Export GLB', { variant: target ? 'default' : 'primary', onClick: () => { void download(); } }); save.disabled = true;
  const apply = target ? createButton('Save frame settings', { variant: 'primary', onClick: () => {
    if (!blob || busy || saving) return;
    try { target.apply(structuredClone(o)); modal.close(); }
    catch (error) { setPreviewState('error'); status.textContent = String(error); }
  } }) : null;
  const footerHint = document.createElement('span'); footerHint.className='glb-footer-hint'; footerHint.textContent = target ? 'Save these settings to your frame.' : 'One file. Shape and textures included.';
  footer.append(footerHint,createButton('Cancel', { onClick: modal.close }),save);
  if (apply) { apply.disabled = true; footer.append(apply); }
  modal.dialog.append(footer);
  conditions.forEach(f=>f()); summaries.forEach(f=>f()); setPreviewState('idle');
  function setPreviewState(value: 'idle'|'stale'|'building'|'ready'|'error'|'saving') {
    modal!.dialog.dataset.previewState=value;
    badge.textContent=({idle:'Not built yet',stale:'Changes not previewed',building:'Building…',ready:'✓ Preview ready',error:'Needs attention',saving:'Saving…'})[value];
    panel.setAttribute('aria-busy',String(value==='building'||value==='saving'));
    build.textContent=value==='building'?'Building…':model?'Update preview':'Build preview';
    empty.hidden=!!model; toolbar.hidden=!model; gesture.hidden=!model;
  }
  function invalidate() { revision++; blob = null; save.disabled = true; if (apply) apply.disabled = true; conditions.forEach(f=>f()); summaries.forEach(f=>f()); setPreviewState(model?'stale':'idle'); status.textContent = model ? 'Showing the previous model. Update the preview to include your changes.' : 'Ready when you are. Build a preview to see this in 3D.'; }
  async function generate() {
    if (busy || saving) return;
    busy = true; build.disabled = true; save.disabled = true; if (apply) apply.disabled=true; blob=null; const version = ++revision;
    setPreviewState('building');
    status.textContent = 'Building geometry and baking materials…';
    let next: GlbModel | null = null;
    try {
      next = await buildGlb(snapshot, o);
      const encoded = await next.encode();
      if (closed || version !== revision) { next.dispose(); return; }
      status.textContent = '';
      try { preview ??= createGlbPreview(host); preview.setModel(next); preview.mode(mode.value); preview.view(view.value); }
      catch { status.textContent = '3D preview unavailable on this device. The GLB is ready to export. '; }
      model?.dispose(); model = next; next = null; blob = encoded; previewPivot = o.pivot; conditions.forEach(f => f());
      setPreviewState('ready');
      status.textContent += `${o.width.toFixed(2)} × ${model.height.toFixed(2)} × ${o.thickness.toFixed(2)} ${o.unit} · ${model.triangles.toLocaleString()} triangles · ${(blob.size / 1024).toFixed(0)} KB. ${model.warnings.join(' ')}`;
      let targets = remembered.get(state); if (!targets) { targets = new Map(); remembered.set(state, targets); } targets.set(targetKey(o.scope), structuredClone(o));
      save.disabled = false;
      if (apply) apply.disabled = false;
    } catch (error) { next?.dispose(); if (!closed) {setPreviewState('error'); status.textContent = error instanceof Error ? error.message : String(error);} }
    finally { busy = false; if (!closed) build.disabled = false; }
  }
  async function download() {
    if (!blob || busy || saving) return;
    const file = blob, savedRevision = revision; saving=true; save.disabled = true; build.disabled=true; if(apply)apply.disabled=true; setPreviewState('saving');
    let success=false;
    try {
      if (supportsFileSystemAccess()) {
        const handle = await saveFilePicker('model.glb', [{ description: '3D GLB model', accept: { 'model/gltf-binary': ['.glb'] } }]);
        if (handle) {await writeHandle(handle, file); success=true;}
      } else {
        const url = URL.createObjectURL(file); const a = document.createElement('a'); a.href = url; a.download = 'model.glb'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); success=true;
      }
      if(!closed && savedRevision===revision) {setPreviewState('ready'); if(success)playExportSuccess(save,{label:'Exported'});}
    } catch (error) { if (!closed && (error as DOMException).name !== 'AbortError') {setPreviewState('error');status.textContent = String(error);} }
    finally { saving=false; if (!closed) {save.disabled = !blob;build.disabled=false;if(apply)apply.disabled=!blob;} }
  }
}
