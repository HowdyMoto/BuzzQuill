/**
 * The clipping viewport inside a cropped image.
 *
 * A crop is `<svg data-crop viewBox>` around the full `<image>` (tools/crop.ts).
 * Chrome drops a nested `<svg>`'s viewport clip when that same svg carries a
 * `filter`, so a blurred or shadowed crop showed the whole uncropped picture. The
 * clip therefore lives one level down, on an inner `<svg data-crop-clip>` whose box
 * IS its viewBox (a 1:1 mapping) and which only clips. The outer element keeps the
 * coordinate mapping and any effect, and filters the already-clipped picture — a
 * blur spills softly past the crop edge and a shadow falls outside it, as they
 * would on any other object. Readers are unaffected: they find the image with
 * `querySelector('image')` and map through CTMs, and an identity step changes
 * neither. Carries no id, so the crop stays a single layer.
 */

const NS = 'http://www.w3.org/2000/svg';

/** Give a crop its inner clip if it lacks one (a crop saved before it existed).
 *  Safe to call on anything: non-crops and crops already clipped are left alone. */
export function ensureCropClip(crop: Element): void {
  if (crop.tagName.toLowerCase() !== 'svg' || !crop.hasAttribute('data-crop')) return;
  if (Array.from(crop.children).some(c => c.hasAttribute('data-crop-clip'))) return;
  const vb = (crop.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || !vb.every(Number.isFinite)) return;
  const clip = document.createElementNS(NS, 'svg');
  clip.setAttribute('data-crop-clip', '');
  clip.setAttribute('x', String(vb[0]));
  clip.setAttribute('y', String(vb[1]));
  clip.setAttribute('width', String(vb[2]));
  clip.setAttribute('height', String(vb[3]));
  clip.setAttribute('viewBox', vb.join(' '));
  clip.setAttribute('preserveAspectRatio', 'none');
  clip.setAttribute('overflow', 'hidden');
  clip.append(...Array.from(crop.childNodes));
  crop.appendChild(clip);
  // The outer viewport no longer clips: were a browser to apply its clip AFTER the
  // filter, it would cut the blur off at the crop edge and hide the shadow.
  crop.setAttribute('overflow', 'visible');
}
