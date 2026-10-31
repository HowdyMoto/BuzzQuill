/**
 * Security sanitization for untrusted SVG entering the live DOM.
 *
 * BuzzQuill opens arbitrary `.svg` / `.svgmaker` files and pastes SVG from the
 * system clipboard. That content is injected into the live document (via
 * `innerHTML` and `importNode` + `appendChild`), so it must be treated as
 * untrusted: a crafted file must not be able to run script in our origin or
 * silently phone home.
 *
 * Note: assigning markup through `innerHTML` does NOT run `<script>`, but it
 * DOES wire up inline event-handler attributes (`onload`, `onerror`, `onclick`,
 * SMIL `onbegin`, …) — e.g. `<image href="x" onerror="…">` fires with no user
 * interaction. We therefore strip:
 *   - every `on*` event-handler attribute,
 *   - `href` / `xlink:href` whose scheme isn't safe (blocks `javascript:` and
 *     external `http(s):` references used for tracking/exfiltration),
 *   - `url(...)` / `expression(...)` / `javascript:` inside inline `style`,
 *   - whole disallowed elements (`<script>`, `<foreignObject>`, SMIL
 *     animation, `<iframe>`, …).
 *
 * This is SVG-specific hardening, not a general HTML sanitizer; it runs on the
 * SVG subtrees BuzzQuill actually imports.
 */

import { SVG_NS_DECLS } from './svg-ns';

/**
 * Elements removed wholesale (with their subtree) on import. BuzzQuill never
 * produces these and has no model for them, so dropping them loses no user data.
 * `<a>` and `<use>` are deliberately NOT here — they carry legitimate content
 * (wrapped shapes / symbol instances); their only risk is an unsafe `href`,
 * which the href allow-list below neutralizes while keeping the element.
 */
const BLOCKED_ELEMENTS = new Set([
  'script', 'foreignobject', 'iframe',
  'animate', 'animatetransform', 'animatemotion', 'animatecolor',
  'set', 'handler', 'listener',
]);

/** href schemes that are safe to keep on imported elements. */
function isSafeHref(value: string): boolean {
  const v = value.replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();
  if (v === '') return true;
  if (v.startsWith('#')) return true;                 // internal fragment ref
  if (v.startsWith('data:image/')) return true;       // embedded raster
  // Typeless / binary base64 blobs: Adobe Illustrator embeds PNGs as
  // `data:;base64,…` (empty MIME, defaults to text/plain) and some tools use
  // application/octet-stream. These decode to inert bytes — never script — in an
  // <image>/<a> context, so allow them or the embedded artwork won't render.
  if (/^data:(;|application\/octet-stream;)base64,/.test(v)) return true;
  // Anything with an explicit scheme other than the above is rejected
  // (javascript:, vbscript:, http:, https:, file:, blob:, non-image data:, …).
  if (/^[a-z][a-z0-9+.-]*:/.test(v)) return false;
  // Protocol-relative (//evil.com/x) is an EXTERNAL ref despite having no scheme.
  if (v.replace(/\\/g, '/').startsWith('//')) return false;
  return true;                                        // scheme-less relative ref
}

/** Strip active/external constructs from an inline `style` attribute value.
 *  `\/\/` catches protocol-relative refs (url(//evil.com/x)) — external despite
 *  having no scheme; CSP backstops this, the strip is belt-and-suspenders. */
function sanitizeStyle(css: string): string {
  return css
    .replace(/url\s*\(\s*['"]?\s*(?:https?:|\/\/|javascript:|vbscript:|data:(?!image\/)|file:|blob:)[^)]*\)/gi, '')
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/javascript:/gi, '');
}

/**
 * Clean a `<style>` element's CSS text: the inline-style rules above plus
 * `@import` (which can pull in external stylesheets). The element is kept so
 * class-based styling on imported artwork still renders.
 */
function sanitizeStyleSheet(css: string): string {
  // Parse before wrapping: concatenating untrusted text would let a stray `}`
  // escape the scope. CSSOM serializes only complete, balanced rules.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(sanitizeStyle(css).replace(/@import[^;]*;?/gi, ''));
  const scope = '@scope (#svg-canvas, svg:root, .lib-preview svg)';
  let rules = Array.from(sheet.cssRules);
  // Idempotent on save/reopen: unwrap only our exact outer scope.
  if (rules.length === 1 && rules[0].cssText.startsWith(scope + ' {') && 'cssRules' in rules[0]) {
    rules = Array.from((rules[0] as CSSGroupingRule).cssRules);
  }
  const text = rules.filter(r => r.type !== CSSRule.IMPORT_RULE).map(r => r.cssText).join('\n');
  return text ? `${scope} {\n${text}\n}` : '';
}

/**
 * Sanitize a parsed SVG subtree in place: removes blocked descendants and
 * unsafe attributes from `el` and everything under it.
 */
export function sanitizeSvgElement(el: Element): boolean {
  const toRemove: Element[] = [];

  const blocked = (node: Element) => node.namespaceURI !== 'http://www.w3.org/2000/svg'
    || BLOCKED_ELEMENTS.has(node.localName.toLowerCase());
  // A detached node cannot be rejected merely by remove(): callers still hold
  // its reference. Return acceptance and leave rejected references inert too.
  if (blocked(el)) {
    el.replaceChildren();
    for (const attr of Array.from(el.attributes)) el.removeAttributeNode(attr);
    el.remove();
    return false;
  }

  const visit = (node: Element) => {
    if (blocked(node)) {
      toRemove.push(node);
      return; // drop the whole subtree; no need to descend
    }
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (attr.localName.toLowerCase().startsWith('on')) {
        node.removeAttribute(attr.name);
      } else if (name === 'href' || name === 'xlink:href' || name.endsWith(':href')) {
        if (!isSafeHref(attr.value)) node.removeAttribute(attr.name);
      } else if (name === 'style' || /url\s*\(/i.test(attr.value)) {
        const cleaned = sanitizeStyle(attr.value);
        if (cleaned !== attr.value) node.setAttribute(attr.name, cleaned);
      }
    }
    // A <style> block's CSS text can carry @import / url(...) external refs.
    if (node.localName.toLowerCase() === 'style' && node.textContent) {
      const cleaned = sanitizeStyleSheet(node.textContent);
      if (cleaned !== node.textContent) node.textContent = cleaned;
    }
    for (const child of Array.from(node.children)) visit(child);
  };

  visit(el);
  for (const n of toRemove) n.remove();
  return true;
}

/**
 * Sanitize a raw SVG-fragment markup string (zero or more sibling elements),
 * returning safe markup suitable for `innerHTML`. Returns '' if the fragment
 * can't be parsed, so malformed input is dropped rather than injected raw.
 */
export function sanitizeSvgMarkup(markup: string): string {
  // Declare the standard prefixes (xlink/inkscape/sodipodi) so strict XML
  // parsing doesn't reject valid markup that uses e.g. xlink:href. DOMParser
  // produces an inert document, so this never fetches external resources.
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg" ${SVG_NS_DECLS}>${markup}</svg>`,
    'image/svg+xml',
  );
  if (doc.getElementsByTagName('parsererror').length > 0) return '';
  const root = doc.documentElement;
  sanitizeSvgElement(root);
  const serializer = new XMLSerializer();
  let out = '';
  for (const child of Array.from(root.children)) out += serializer.serializeToString(child);
  return out;
}
