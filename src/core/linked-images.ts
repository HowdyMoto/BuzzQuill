/** External image references remain inert until the user supplies local files. */
export const LINKED_IMAGE_ATTR = 'data-bq-image-href';
const XLINK = 'http://www.w3.org/1999/xlink';
export function preserveLinkedImage(el: Element): void {
  if (el.localName.toLowerCase() !== 'image') return;
  const href = el.getAttribute('href') || el.getAttributeNS(XLINK, 'href') || '';
  if (!href || /^(data:|#)/i.test(href.trim())) return;
  // Keep file/relative/web locations as labels only; never fetch them on import.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href) || /^(https?:|file:|[a-z]:[\\/])/i.test(href)) {
    el.setAttribute(LINKED_IMAGE_ATTR, href);
  }
  el.removeAttribute('href'); el.removeAttributeNS(XLINK, 'href');
}
export interface LinkedImage { element: Element; reference: string; }
export function linkedImages(root: Element): LinkedImage[] {
  return Array.from(root.querySelectorAll(`image[${LINKED_IMAGE_ATTR}]`))
    .map(element => ({ element, reference: element.getAttribute(LINKED_IMAGE_ATTR)! }));
}
function pathParts(value: string): string {
  let path = value.replace(/\\/g, '/');
  if (/^(https?:|file:)/i.test(path)) { try { path = new URL(path).pathname; } catch { return ''; } }
  else path = path.split(/[?#]/)[0];
  try { path = decodeURIComponent(path); } catch { /* literal filename */ }
  const parts: string[] = [];
  for (const part of path.replace(/^[a-z]:/i, '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  return parts.join('/');
}
export interface ImageMatch extends LinkedImage { file?: File; ambiguous: boolean; }
export function matchLinkedImages(images: LinkedImage[], files: File[]): ImageMatch[] {
  const entries = files.map(file => ({ file, path: pathParts(file.webkitRelativePath || file.name) }));
  return images.map(image => {
    const wanted = pathParts(image.reference), basename = wanted.split('/').pop();
    let candidates = entries.filter(e => e.path === wanted);
    // A folder picker may start above or below the SVG's original directory.
    // Prefer the longest shared path suffix; never guess among duplicate names.
    if (!candidates.length && basename) {
      const parts = wanted.split('/');
      const ranked = entries.map(e => {
        const other = e.path.split('/'); let score = 0;
        while (score < parts.length && score < other.length && parts[parts.length - 1 - score] === other[other.length - 1 - score]) score++;
        return { ...e, score };
      });
      const best = Math.max(0, ...ranked.map(e => e.score));
      candidates = best ? ranked.filter(e => e.score === best) : [];
    }
    return { ...image, file: candidates.length === 1 ? candidates[0].file : undefined, ambiguous: candidates.length > 1 };
  });
}
export async function embedImage(file: File, lighter: boolean): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const mime = ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif' } as Record<string, string>)[ext];
  if (!mime) throw new Error('Choose a PNG, JPEG, WebP, GIF, BMP or AVIF image.');
  // Decoding validates the selected bytes and processes one tile at a time.
  const bitmap = await createImageBitmap(file);
  try {
    if (lighter && Math.max(bitmap.width, bitmap.height) > 1024) {
      const scale = 1024 / Math.max(bitmap.width, bitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      // PNG/WebP may carry transparency; never flatten them onto a JPEG background.
      return canvas.toDataURL(/\.jpe?g$/i.test(file.name) ? 'image/jpeg' : 'image/png', 0.85);
    }
  } finally { bitmap.close(); }
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = () => reject(new Error('Could not read image.'));
    reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(new Blob([file], { type: mime }));
  });
}
export function applyEmbeddedImage(image: LinkedImage, data: string): void {
  image.element.setAttribute('href', data); image.element.removeAttributeNS(XLINK, 'href');
  image.element.removeAttribute(LINKED_IMAGE_ATTR);
}
