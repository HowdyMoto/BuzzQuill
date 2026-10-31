/**
 * SVG namespace handling.
 *
 * SVGs are parsed as XML when opened standalone (file://, <img>, DOMParser),
 * and XML requires every attribute prefix (xlink:, inkscape:, sodipodi:, …) to
 * be declared on an ancestor element. Files imported from Inkscape carry such
 * prefixed attributes; if we re-emit them without declarations the resulting
 * file is invalid XML and won't load. These helpers keep the declarations in
 * sync on both read and write.
 */

/** Namespace declarations to place on the root <svg> of anything we write. */
export const SVG_NS_DECLS =
  'xmlns:xlink="http://www.w3.org/1999/xlink" ' +
  'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ' +
  'xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.0.dtd"';

/**
 * Inject any missing standard namespace declarations into the root <svg> tag,
 * so older files (saved before this fix, or hand-made) still parse and render.
 */
export function ensureSvgNamespaces(svgString: string): string {
  return svgString.replace(/<svg\b([^>]*)>/i, (_match, attrs: string) => {
    let a = attrs;
    if (!/\bxmlns:xlink\s*=/.test(a)) a += ' xmlns:xlink="http://www.w3.org/1999/xlink"';
    if (!/\bxmlns:inkscape\s*=/.test(a)) a += ' xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"';
    if (!/\bxmlns:sodipodi\s*=/.test(a)) a += ' xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.0.dtd"';
    return `<svg${a}>`;
  });
}
