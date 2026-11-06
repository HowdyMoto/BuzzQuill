import type { AppState } from '../core/state';
import { LINKED_IMAGE_ATTR, linkedImages, matchLinkedImages, embedImage, applyEmbeddedImage, type ImageMatch } from '../core/linked-images';
import { createButton, createSelect } from './components';
import { openModal } from './modal';
import { showToast } from './toast';

const size = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
let updateBanner: (() => void) | undefined;
export function updateLinkedImages(): void { updateBanner?.(); }

export function setupLinkedImages(state: AppState, owner: () => string): void {
  const root = document.getElementById('drawing-layer')!;
  const banner = document.createElement('div'); banner.className = 'linked-images-banner'; banner.hidden = true;
  banner.setAttribute('role', 'status');
  const copy = document.createElement('div');
  const title = document.createElement('strong'); const detail = document.createElement('span');
  detail.textContent = 'Choose their folder to show them in this document.'; copy.append(title, detail);
  const locate = createButton('Locate images…', { small: true, onClick: () => openRecovery() });
  banner.append(copy, locate); document.getElementById('canvas-area')!.appendChild(banner);
  updateBanner = () => {
    const count = linkedImages(root).length; banner.hidden = count === 0;
    title.textContent = `${count} linked ${count === 1 ? 'image needs' : 'images need'} locating`;
  };
  updateBanner();

  function openRecovery(): void {
    const images = linkedImages(root); if (!images.length) return;
    const ownerId = owner(); let cancelled = false; let busy = false;
    const modal = openModal({ id: 'linked-images-dialog', ariaLabel: 'Locate linked images', dialogClass: 'linked-images-dialog', onClose: () => { cancelled = true; } });
    if (!modal) return;
    const close = modal.close;
    const current = () => !cancelled && owner() === ownerId && images.every(i => i.element.isConnected && root.contains(i.element) && i.element.getAttribute(LINKED_IMAGE_ATTR) === i.reference);
    const h = document.createElement('h2'); h.textContent = 'Locate linked images';
    const intro = document.createElement('p'); intro.textContent = 'Choose the SVG’s folder or the folder containing these images.';
    const examples = document.createElement('ul'); examples.className = 'linked-image-paths';
    for (const ref of [...new Set(images.map(i => i.reference))].slice(0, 3)) { const li = document.createElement('li'); li.textContent = ref; examples.append(li); }
    const portable = document.createElement('p'); portable.className = 'linked-images-note'; portable.textContent = 'Added images are included in your document when you save. The original image files stay unchanged.';
    const status = document.createElement('p'); status.setAttribute('role', 'status'); status.className = 'linked-images-status';
    const unresolved = document.createElement('details'); unresolved.hidden = true;
    const summary = document.createElement('summary'); const remaining = document.createElement('ul'); remaining.className = 'linked-image-paths'; unresolved.append(summary, remaining);
    const quality = document.createElement('div'); quality.className = 'linked-images-quality'; quality.hidden = true;
    const qualityLabel = document.createElement('label'); qualityLabel.textContent = 'Image quality'; qualityLabel.htmlFor = 'linked-image-quality';
    const select = createSelect([{ value: 'lighter', label: 'Smaller images — up to 1,024 px' }, { value: 'original', label: 'Full resolution' }]); select.id = 'linked-image-quality';
    const qualityNote = document.createElement('p'); qualityNote.className = 'linked-images-note'; qualityNote.id = 'linked-image-quality-note'; select.setAttribute('aria-describedby', qualityNote.id);
    const qualityCopy = () => { qualityNote.textContent = select.value === 'lighter' ? 'Limits each image’s longest edge to 1,024 px for easier editing. Original files stay unchanged.' : 'Keeps full resolution. Large image sets may take longer to open and save.'; };
    select.addEventListener('change', qualityCopy); qualityCopy(); quality.append(qualityLabel, select, qualityNote);
    const progress = document.createElement('progress'); progress.hidden = true; progress.setAttribute('aria-label', 'Adding linked images');
    const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.setAttribute('webkitdirectory', ''); input.hidden = true;
    let matches: ImageMatch[] = [];
    const choose = createButton('Choose folder…', { variant: 'primary', onClick: () => input.click() });
    const add = createButton('Add images', { variant: 'primary', onClick: () => { void addImages(); } }); add.hidden = true;
    const cancel = createButton('Cancel', { onClick: () => close() });
    const actions = document.createElement('div'); actions.className = 'modal-actions'; actions.append(cancel, choose, add);
    modal.dialog.append(h, intro, examples, portable, status, unresolved, quality, progress, input, actions);
    input.addEventListener('change', () => {
      if (!current()) { close(); return; }
      const files = Array.from(input.files ?? []); input.value = ''; if (!files.length) return;
      matches = matchLinkedImages(images, files);
      const found = matches.filter(m => m.file); const missing = matches.filter(m => !m.file);
      const bytes = [...new Set(found.map(m => m.file!))].reduce((n, f) => n + f.size, 0);
      status.textContent = found.length ? `${found.length} of ${images.length} images found · ${size(bytes)}` : 'No matching images in this folder. Try the SVG’s folder or a folder containing the files listed above.';
      choose.textContent = 'Choose another folder…'; choose.classList.toggle('btn--primary', !found.length);
      add.hidden = !found.length; add.textContent = `Add ${found.length} ${found.length === 1 ? 'image' : 'images'}`;
      quality.hidden = bytes < 64 * 1024 * 1024;
      remaining.replaceChildren(); unresolved.hidden = !missing.length;
      const ambiguous = missing.filter(m => m.ambiguous).length;
      if (ambiguous) status.textContent += ` ${ambiguous} references match more than one file. Choose a more specific folder.`;
      summary.textContent = `${missing.length} still missing`;
      for (const m of missing) { const li = document.createElement('li'); li.textContent = m.reference + (m.ambiguous ? ' — more than one match' : ''); remaining.append(li); }
    });
    async function addImages(): Promise<void> {
      if (busy || !current()) return;
      busy = true; choose.disabled = true; add.disabled = true; select.disabled = true; cancel.textContent = 'Cancel';
      progress.hidden = false;
      const found = matches.filter(m => m.file); progress.max = found.length;
      const data = new Map<File, string>(); const prepared: { match: ImageMatch; data: string }[] = []; const failed: string[] = [];
      for (const [i, match] of found.entries()) {
        if (!current()) { close(); return; }
        status.textContent = `Adding images · ${i + 1} of ${found.length}`; progress.value = i;
        // Yield before each decode so progress/cancel remain responsive.
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (!current()) { close(); return; }
        try {
          const file = match.file!;
          if (!data.has(file)) data.set(file, await embedImage(file, !quality.hidden && select.value === 'lighter'));
          prepared.push({ match, data: data.get(file)! });
        } catch { failed.push(match.reference); }
      }
      if (!current()) { close(); return; }
      // Publish once, to the captured live elements only. Cancel never leaves half a repair.
      for (const entry of prepared) applyEmbeddedImage(entry.match, entry.data);
      if (prepared.length) { state.rebuildShapesFromDOM(); state.saveHistory(); state.onChange_public(); }
      if (!prepared.length) {
        busy = false; choose.disabled = false; add.disabled = false; select.disabled = false; progress.hidden = true;
        status.textContent = 'These files could not be read as images. Choose another folder to try again.';
        return;
      }
      close();
      showToast(`${prepared.length} images added. Save to keep them with this document.${failed.length ? ` ${failed.length} could not be read; try another folder.` : ''}`, 8000, undefined, failed.length ? 'warning' : 'info');
    }
  }
}
